import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseOwnerFlags, routeTelegramUpdate } from '../src/owner/telegram-owner-client.mjs';
import { OwnerTaskController } from '../src/owner/owner-task-controller.mjs';
import { normalizeCouncilSpec } from '../src/pm/council/council-contracts.mjs';
import { TRANSPORT_VERSION } from '../src/artifacts/artifact-transport.mjs';

// P24.1G4 — the DSH Telegram transport bridge for P24.1G2's typed
// `payload.workspace_output` product contract. Explicit flags only, never
// task-prose scraping; Telegram builds the shape, OwnerTaskController
// (P24.1G2, unmodified by this change) remains the sole product-gate and
// path-safety authority.

// ---- parseOwnerFlags: shape/grammar --------------------------------------

test('parseOwnerFlags: omitting --report-path/--report-non-empty is byte-for-byte the pre-G4 default (null)', () => {
  const r = parseOwnerFlags('--pm pm-1 plain task');
  assert.equal(r.reportPath, null);
  assert.equal(r.reportNonEmpty, null);
});

test('parseOwnerFlags: --report-path is extracted verbatim, including nested dirs/hyphens/underscores/dots', () => {
  const r = parseOwnerFlags('--report-path reports/qualification/P24-1G4_test.v2.md do the thing');
  assert.equal(r.reportPath, 'reports/qualification/P24-1G4_test.v2.md');
  assert.equal(r.text, 'do the thing');
});

test('parseOwnerFlags: --report-non-empty true/false is coerced to a real boolean, case-insensitively', () => {
  assert.equal(parseOwnerFlags('--report-path x.md --report-non-empty true do it').reportNonEmpty, true);
  assert.equal(parseOwnerFlags('--report-path x.md --report-non-empty FALSE do it').reportNonEmpty, false);
  assert.equal(parseOwnerFlags('--report-path x.md --report-non-empty False do it').reportNonEmpty, false);
});

test('parseOwnerFlags: --report-non-empty without --report-path is refused, never silently dropped', () => {
  assert.throws(() => parseOwnerFlags('--report-non-empty true do it'), /--report-non-empty requires --report-path/);
});

test('parseOwnerFlags: --report-path with no value is refused (existing shared value-flag mechanism)', () => {
  assert.throws(() => parseOwnerFlags('--report-path'), /--report-path requires a value/);
});

test('parseOwnerFlags: --report-non-empty with an invalid value is refused, never coerced to a default', () => {
  assert.throws(() => parseOwnerFlags('--report-path x.md --report-non-empty maybe do it'), /--report-non-empty must be one of: true, false/);
});

test('parseOwnerFlags: duplicate --report-path is refused (matches every other value flag\'s duplicate policy)', () => {
  assert.throws(() => parseOwnerFlags('--report-path a.md --report-path b.md do it'), /--report-path specified more than once/);
});

test('parseOwnerFlags: duplicate --report-non-empty is refused (matches every other value flag\'s duplicate policy)', () => {
  assert.throws(() => parseOwnerFlags('--report-path a.md --report-non-empty true --report-non-empty false do it'), /--report-non-empty specified more than once/);
});

test('parseOwnerFlags: --report-path combines with --pm/--commit/--push in any documented order', () => {
  const r = parseOwnerFlags('--pm pm-1 --commit --push --report-path reports/x.md --report-non-empty true fix it');
  assert.equal(r.pmProfileId, 'pm-1');
  assert.equal(r.commit, true);
  assert.equal(r.push, true);
  assert.equal(r.reportPath, 'reports/x.md');
  assert.equal(r.reportNonEmpty, true);
  assert.equal(r.text, 'fix it');
});

// ---- routeTelegramUpdate: payload construction ---------------------------

function update(text) { return { update_id: 1, message: { from: { id: 1 }, chat: { id: 2 }, text } }; }
const projects = [{ id: 'proj-a' }];

test('a dispatch with no --report-path carries no workspace_output field at all (zero payload noise)', () => {
  const routed = routeTelegramUpdate(update('@proj-a plain task'), { projects, aliasRegistry: null });
  assert.equal('workspace_output' in routed.payload, false);
});

test('--report-path alone produces payload.workspace_output = {report_path} only — no non_empty key, no required key', () => {
  const routed = routeTelegramUpdate(update('@proj-a --report-path reports/qualification/foo.md fix it'), { projects, aliasRegistry: null });
  assert.deepEqual(routed.payload.workspace_output, { report_path: 'reports/qualification/foo.md' });
});

test('--report-path + --report-non-empty true produces the exact combined shape', () => {
  const routed = routeTelegramUpdate(update('@proj-a --report-path reports/qualification/foo.md --report-non-empty true fix it'), { projects, aliasRegistry: null });
  assert.deepEqual(routed.payload.workspace_output, { report_path: 'reports/qualification/foo.md', non_empty: true });
});

test('--report-path + --report-non-empty false produces the exact combined shape (boolean false preserved, never dropped)', () => {
  const routed = routeTelegramUpdate(update('@proj-a --report-path reports/qualification/foo.md --report-non-empty false fix it'), { projects, aliasRegistry: null });
  assert.deepEqual(routed.payload.workspace_output, { report_path: 'reports/qualification/foo.md', non_empty: false });
});

test('a malformed flag combination routes to FLAGS_INVALID, never a partially-built SUBMIT_TASK', () => {
  const routed = routeTelegramUpdate(update('@proj-a --report-non-empty true fix it'), { projects, aliasRegistry: null });
  assert.equal(routed.read, 'FLAGS_INVALID');
  assert.match(routed.detail, /--report-non-empty requires --report-path/);
});

test('the flags also work on a task-file dispatch (workspace_output is orthogonal to source, matching --commit/--durability)', () => {
  const routed = routeTelegramUpdate(update('@proj-a --report-path reports/x.md --commit --task-file main tasks/dsh/X.md'), { projects, aliasRegistry: null });
  assert.equal(routed.operation, 'SUBMIT_TASK');
  assert.deepEqual(routed.payload.task_file, { ref: 'main', path: 'tasks/dsh/X.md' });
  assert.deepEqual(routed.payload.workspace_output, { report_path: 'reports/x.md' });
});

test('task prose that merely mentions a .md path, with no --report-path flag, never produces workspace_output', () => {
  const routed = routeTelegramUpdate(update('@proj-a create reports/qualification/prose-mentioned.md please'), { projects, aliasRegistry: null });
  assert.equal('workspace_output' in routed.payload, false);
  assert.match(routed.payload.body, /reports\/qualification\/prose-mentioned\.md/, 'the prose text itself is untouched, just never parsed as a path directive');
});

test('when task prose names a DIFFERENT path than the explicit flag, the flag wins and prose is inert', () => {
  const routed = routeTelegramUpdate(update('@proj-a --report-path reports/flag-wins.md the task text mentions reports/prose-path.md too'), { projects, aliasRegistry: null });
  assert.deepEqual(routed.payload.workspace_output, { report_path: 'reports/flag-wins.md' });
  assert.match(routed.payload.body, /reports\/prose-path\.md/, 'the prose path stays literal, untouched, never adopted as authority');
});

// ---- end-to-end through OwnerTaskController.submit() ----------------------

function buildController({ repoPath, created, resolveTransportVersion }) {
  const repo = { createOwnerTask: (task) => created.push(task) };
  return new OwnerTaskController({
    repository: repo,
    startPm: async () => null,
    resolveTransportVersion: resolveTransportVersion ?? (() => TRANSPORT_VERSION.ARTIFACT_V1),
  });
}

test('full ingress chain: Telegram shorthand string -> parseOwnerFlags/routeTelegramUpdate -> OwnerTaskController.submit() -> task.context.workspaceOutput', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'p24-1g4-repo-'));
  try {
    const routed = routeTelegramUpdate(
      update('@proj-a --commit --push --report-path reports/qualification/P24_G4_TEST.md --report-non-empty false produce the report'),
      { projects, aliasRegistry: null },
    );
    assert.equal(routed.operation, 'SUBMIT_TASK');
    assert.deepEqual(routed.payload.workspace_output, { report_path: 'reports/qualification/P24_G4_TEST.md', non_empty: false });

    const created = [];
    const controller = buildController({ repoPath: tmp, created });
    const project = { id: 'proj-a', repo_path: tmp, autonomy: { revision: 1, effects: { SUBMIT_TASK: 'ALLOW' } } };
    await controller.submit({ command: { command_id: routed.command_id, client_kind: routed.client_kind, payload: routed.payload }, project, profile: { id: 'pm-1' } });

    assert.deepEqual({ ...created[0].context.workspaceOutput }, { report_path: 'reports/qualification/P24_G4_TEST.md', required: true, non_empty: false });
    assert.equal(created[0].context.gitSync.commit, true);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// ---- G2 product gates still fire correctly when the field arrives through Telegram ----

test('workspace_output arriving through Telegram without --commit is refused by the SAME G2 gate (WORKSPACE_OUTPUT_REQUIRES_GIT_COMMIT)', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'p24-1g4-repo-'));
  try {
    const routed = routeTelegramUpdate(update('@proj-a --report-path reports/x.md produce the report'), { projects, aliasRegistry: null });
    assert.equal('git' in routed.payload, false, 'no --commit was given, so payload.git is absent, exactly as G2 requires for this gate to fire');

    const created = [];
    const controller = buildController({ repoPath: tmp, created });
    const project = { id: 'proj-a', repo_path: tmp, autonomy: { revision: 1, effects: { SUBMIT_TASK: 'ALLOW' } } };
    await assert.rejects(
      controller.submit({ command: { command_id: routed.command_id, client_kind: routed.client_kind, payload: routed.payload }, project, profile: { id: 'pm-1' } }),
      (e) => e.code === 'WORKSPACE_OUTPUT_REQUIRES_GIT_COMMIT',
    );
    assert.equal(created.length, 0);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('P24.2 Telegram Council workspace_output reaches durable context', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'p24-1g4-repo-'));
  try {
    const routed = routeTelegramUpdate(
      update('@proj-a --pm chair-1 --debate p1,p2 --commit --report-path reports/x.md produce the report'),
      { projects, aliasRegistry: null },
    );
    assert.equal(routed.operation, 'SUBMIT_TASK');
    assert.deepEqual(routed.payload.council, { chair_profile_id: 'chair-1', participant_profile_ids: ['p1', 'p2'] });
    assert.deepEqual(routed.payload.workspace_output, { report_path: 'reports/x.md' });

    const council = normalizeCouncilSpec(routed.payload.council, { knownProfileIds: new Set(['chair-1', 'p1', 'p2']) });
    const created = [];
    const controller = buildController({ repoPath: tmp, created });
    const project = { id: 'proj-a', repo_path: tmp, autonomy: { revision: 1, effects: { SUBMIT_TASK: 'ALLOW' } } };
    await controller.submit({ command: { command_id: routed.command_id, client_kind: routed.client_kind, payload: routed.payload }, project, profile: { id: 'chair-1' }, council });
    assert.equal(created.length, 1);
    assert.equal(created[0].context.workspaceOutput.report_path, 'reports/x.md');
    assert.equal(created[0].context.transport_version, 'artifact_v1');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('an unsafe workspace_output.report_path arriving through Telegram is refused by the SAME G2 path-safety authority', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'p24-1g4-repo-'));
  try {
    const routed = routeTelegramUpdate(update('@proj-a --commit --report-path ../../escape.md produce the report'), { projects, aliasRegistry: null });
    assert.deepEqual(routed.payload.workspace_output, { report_path: '../../escape.md' }, 'Telegram forwards the raw value verbatim — it never pre-validates path safety itself');

    const created = [];
    const controller = buildController({ repoPath: tmp, created });
    const project = { id: 'proj-a', repo_path: tmp, autonomy: { revision: 1, effects: { SUBMIT_TASK: 'ALLOW' } } };
    await assert.rejects(
      controller.submit({ command: { command_id: routed.command_id, client_kind: routed.client_kind, payload: routed.payload }, project, profile: { id: 'pm-1' } }),
      (e) => typeof e.code === 'string' && e.code.startsWith('WORKSPACE_OUTPUT_PATH'),
    );
    assert.equal(created.length, 0);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
