import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OwnerTaskController, normalizeWorkspaceOutputRequest } from '../src/owner/owner-task-controller.mjs';
import { TRANSPORT_VERSION } from '../src/artifacts/artifact-transport.mjs';

// P24.1G2 — the typed `workspace_output` request shape and its early
// (submit-time) validation. Root cause this closes:
// reports/P24_1G_REQUESTED_REPORT_GIT_SETTLEMENT_AUDIT_FIX_20260916.md
// (OUTPUT_CONTRACT_GAP — a prose-requested repo report path was never
// authoritative and never produced). This is the APPLICATION-OWNED typed
// replacement: never derived from task prose, always validated against the
// real project.repo_path before any task/pm_run is ever created.

test('normalizeWorkspaceOutputRequest: absent/malformed input is "not requested" (null)', () => {
  assert.equal(normalizeWorkspaceOutputRequest(undefined), null);
  assert.equal(normalizeWorkspaceOutputRequest(null), null);
  assert.equal(normalizeWorkspaceOutputRequest('reports/foo.md'), null);
  assert.equal(normalizeWorkspaceOutputRequest({}), null);
  assert.equal(normalizeWorkspaceOutputRequest({ report_path: '' }), null);
  assert.equal(normalizeWorkspaceOutputRequest({ report_path: 42 }), null);
});

test('normalizeWorkspaceOutputRequest: valid shape defaults required=true, non_empty=true', () => {
  const req = normalizeWorkspaceOutputRequest({ report_path: 'reports/qualification/foo.md' });
  assert.deepEqual({ ...req }, { report_path: 'reports/qualification/foo.md', required: true, non_empty: true });
});

test('normalizeWorkspaceOutputRequest: non_empty:false is preserved; any other value normalizes to true', () => {
  assert.equal(normalizeWorkspaceOutputRequest({ report_path: 'x.md', non_empty: false }).non_empty, false);
  assert.equal(normalizeWorkspaceOutputRequest({ report_path: 'x.md', non_empty: 'no' }).non_empty, true);
});

// ---- end-to-end through OwnerTaskController.submit() -----------------------

function buildController({ repoPath, created, resolveTransportVersion }) {
  const repo = { createOwnerTask: (task) => created.push(task) };
  return new OwnerTaskController({
    repository: repo,
    startPm: async () => null,
    resolveTransportVersion: resolveTransportVersion ?? (() => TRANSPORT_VERSION.ARTIFACT_V1),
  });
}

function baseProject(repoPath) {
  return { id: 'proj-a', repo_path: repoPath, autonomy: { revision: 1, effects: { SUBMIT_TASK: 'ALLOW' } } };
}

test('submit: workspace_output is stamped into the durable context exactly once, alongside gitSync', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'p24-1g2-repo-'));
  try {
    const created = [];
    const controller = buildController({ repoPath: tmp, created });
    const project = baseProject(tmp);
    await controller.submit({
      command: { command_id: 'cmd-1', client_kind: 'LOCAL', payload: { body: 'task', git: { commit: true }, workspace_output: { report_path: 'reports/qualification/foo.md' } } },
      project, profile: { id: 'pm-1' },
    });
    assert.deepEqual({ ...created[0].context.workspaceOutput }, { report_path: 'reports/qualification/foo.md', required: true, non_empty: true });
    assert.equal(created[0].context.gitSync.commit, true);
    assert.equal(created[0].context.transport_version, 'artifact_v1');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('submit: absent workspace_output leaves the durable context byte-for-byte unaffected', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'p24-1g2-repo-'));
  try {
    const created = [];
    const controller = buildController({ repoPath: tmp, created });
    const project = baseProject(tmp);
    await controller.submit({ command: { command_id: 'cmd-1', client_kind: 'LOCAL', payload: { body: 'task', git: { commit: true } } }, project, profile: { id: 'pm-1' } });
    assert.equal('workspaceOutput' in created[0].context, false);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('submit: workspace_output requires git.commit=true — fails closed before task creation', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'p24-1g2-repo-'));
  try {
    const created = [];
    const controller = buildController({ repoPath: tmp, created });
    const project = baseProject(tmp);
    await assert.rejects(
      controller.submit({ command: { command_id: 'cmd-1', client_kind: 'LOCAL', payload: { body: 'task', workspace_output: { report_path: 'reports/foo.md' } } }, project, profile: { id: 'pm-1' } }),
      (e) => e.code === 'WORKSPACE_OUTPUT_REQUIRES_GIT_COMMIT',
    );
    assert.equal(created.length, 0, 'no task/pm_run was ever created');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('submit: workspace_output requires an artifact_v1 task — a legacy-transport task is refused early', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'p24-1g2-repo-'));
  try {
    const created = [];
    const controller = buildController({ repoPath: tmp, created, resolveTransportVersion: () => TRANSPORT_VERSION.LEGACY });
    const project = baseProject(tmp);
    await assert.rejects(
      controller.submit({ command: { command_id: 'cmd-1', client_kind: 'LOCAL', payload: { body: 'task', git: { commit: true }, workspace_output: { report_path: 'reports/foo.md' } } }, project, profile: { id: 'pm-1' } }),
      (e) => e.code === 'WORKSPACE_OUTPUT_REQUIRES_ARTIFACT_TRANSPORT',
    );
    assert.equal(created.length, 0);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('submit: P24.2 Council workspace_output preserves sealed transport and durable request', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'p24-1g2-repo-'));
  try {
    const created = [];
    const controller = buildController({ repoPath: tmp, created });
    const project = baseProject(tmp);
    await controller.submit({
        command: { command_id: 'cmd-1', client_kind: 'LOCAL', payload: { body: 'task', git: { commit: true }, workspace_output: { report_path: 'reports/foo.md' } } },
        project, profile: { id: 'pm-1' },
        // `council`, once normalized/validated, is a SEPARATE parameter to
        // submit() (owner-control-service.mjs does that normalization
        // upstream) — never re-derived from `command.payload.council` here.
        council: { chair_profile_id: 'pm-1', participant_profile_ids: ['a', 'b'], rounds: 1 },
      });
    assert.equal(created.length, 1);
    assert.equal(created[0].context.workspaceOutput.report_path, 'reports/foo.md');
    assert.equal(created[0].context.transport_version, 'artifact_v1');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

const UNSAFE_PATHS = [
  ['absolute Windows path', 'C:\\Windows\\System32\\evil.md'],
  ['UNC path', '\\\\server\\share\\evil.md'],
  ['posix absolute path', '/etc/passwd'],
  ['.. escape', '../../outside.md'],
  ['normalized escape variant', 'reports/../../outside.md'],
  ['.git directory', '.git/hooks/pre-commit'],
  ['.git nested path', '.git/refs/heads/main'],
];

for (const [label, reportPath] of UNSAFE_PATHS) {
  test(`submit: unsafe workspace_output.report_path is rejected before task creation — ${label}`, async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'p24-1g2-repo-'));
    try {
      const created = [];
      const controller = buildController({ repoPath: tmp, created });
      const project = baseProject(tmp);
      await assert.rejects(
        controller.submit({ command: { command_id: 'cmd-1', client_kind: 'LOCAL', payload: { body: 'task', git: { commit: true }, workspace_output: { report_path: reportPath } } }, project, profile: { id: 'pm-1' } }),
        (e) => typeof e.code === 'string' && e.code.startsWith('WORKSPACE_OUTPUT_PATH'),
      );
      assert.equal(created.length, 0);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
}

test('submit: a symlinked ancestor directory that resolves outside the repo root is rejected', { skip: process.platform === 'win32' && !process.env.DSH_TEST_ALLOW_SYMLINKS ? 'symlink creation requires elevated privileges on this Windows runner' : false }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'p24-1g2-repo-'));
  const outside = mkdtempSync(join(tmpdir(), 'p24-1g2-outside-'));
  try {
    mkdirSync(join(tmp, 'reports'), { recursive: true });
    symlinkSync(outside, join(tmp, 'reports', 'linked'), 'dir');
    const created = [];
    const controller = buildController({ repoPath: tmp, created });
    const project = baseProject(tmp);
    await assert.rejects(
      controller.submit({ command: { command_id: 'cmd-1', client_kind: 'LOCAL', payload: { body: 'task', git: { commit: true }, workspace_output: { report_path: 'reports/linked/escaped.md' } } }, project, profile: { id: 'pm-1' } }),
      (e) => e.code === 'WORKSPACE_OUTPUT_PATH_ESCAPE',
    );
    assert.equal(created.length, 0);
  } finally { rmSync(tmp, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('submit: a safe repo-relative path is accepted and normalized into the durable context', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'p24-1g2-repo-'));
  try {
    const created = [];
    const controller = buildController({ repoPath: tmp, created });
    const project = baseProject(tmp);
    await controller.submit({ command: { command_id: 'cmd-1', client_kind: 'LOCAL', payload: { body: 'task', git: { commit: true, push: true }, workspace_output: { report_path: 'reports/qualification/P24.md' } } }, project, profile: { id: 'pm-1' } });
    assert.equal(created[0].context.workspaceOutput.report_path, 'reports/qualification/P24.md');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
