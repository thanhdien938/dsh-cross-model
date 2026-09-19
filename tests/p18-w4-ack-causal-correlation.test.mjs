import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOwnerFlags, routeTelegramUpdate, renderOwnerAck } from '../src/owner/telegram-owner-client.mjs';
import { OwnerTaskController } from '../src/owner/owner-task-controller.mjs';
import { OwnerControlError } from '../src/owner/owner-contracts.mjs';

// P18-W4 ACK-causal-correlation remediation (PM review finding, P0): the
// synchronous telegram-mcp send_message() reply is NOT causally
// authoritative -- it can return ANY bot message newer than the sent one,
// including an unrelated prior task's own terminal result (which also
// contains a "Task: <id>" line). This file proves the DSH-side half of the
// fix: a DSH-owned, transport-only `--client-correlation <id>` fact that
// the relay can supply and DSH echoes back verbatim in its own ACK, giving
// an authoritative anchor independent of "some bot message newer than X".
// The relay-side half (bounded post-boundary scan for bot identity +
// boundary + exact ACK shape + exact Correlation line + Task line) lives
// in the companion relay repo.

// ---- parseOwnerFlags: --client-correlation is a strictly-validated value flag ----

test('parseOwnerFlags: --client-correlation is extracted and stripped', () => {
  const r = parseOwnerFlags('--client-correlation rel_abc123 do the thing');
  assert.equal(r.clientCorrelationId, 'rel_abc123');
  assert.equal(r.text, 'do the thing');
});

test('parseOwnerFlags: omitting --client-correlation is byte-for-byte the pre-remediation default (null)', () => {
  assert.equal(parseOwnerFlags('--pm pm-1 plain task').clientCorrelationId, null);
});

test('parseOwnerFlags: --client-correlation combines with other flags in any documented order', () => {
  const r = parseOwnerFlags('--pm pm-1 --client-correlation rel_xyz789 --long fix it');
  assert.equal(r.clientCorrelationId, 'rel_xyz789');
  assert.equal(r.long, true);
  assert.equal(r.pmProfileId, 'pm-1');
  assert.equal(r.text, 'fix it');
});

test('parseOwnerFlags: --client-correlation rejects a value shorter than 6 chars', () => {
  assert.throws(() => parseOwnerFlags('--client-correlation ab do it'), /must match/);
});

test('parseOwnerFlags: --client-correlation rejects a value over 128 chars', () => {
  assert.throws(() => parseOwnerFlags(`--client-correlation ${'a'.repeat(129)} do it`), /must match/);
});

test('parseOwnerFlags: --client-correlation rejects a disallowed character (charset is [A-Za-z0-9_.-] only)', () => {
  for (const bad of ['rel abc123', 'rel/abc123', 'rel$abc123', 'rel;abc123']) {
    assert.throws(() => parseOwnerFlags(`--client-correlation ${bad} do it`), /must match|requires a value/);
  }
});

test('parseOwnerFlags: --client-correlation specified twice is refused', () => {
  assert.throws(() => parseOwnerFlags('--client-correlation rel_abc123 --client-correlation rel_def456 do it'), /specified more than once/);
});

test('parseOwnerFlags: --client-correlation requires a value (bare flag rejected)', () => {
  assert.throws(() => parseOwnerFlags('--client-correlation'), /requires a value/);
});

// ---- routeTelegramUpdate: folds onto payload.client_correlation_id, never task_source/runtime_class/body ----

const projects = [{ id: 'proj-a', display_name: 'A', repo_path: 'C:/a', default_pm_profile_id: 'pm-1' }];
function update(text) { return { message: { from: { id: 1 }, chat: { id: 2 }, text, message_id: 1 } }; }

test('routeTelegramUpdate: --client-correlation compiles to payload.client_correlation_id, task_source/runtime_class stay absent', () => {
  const routed = routeTelegramUpdate(update('@proj-a --client-correlation rel_marker001 do the thing'), { ownerUserId: 1, ownerChatId: 2, projects, aliasRegistry: null });
  assert.equal(routed.payload.client_correlation_id, 'rel_marker001');
  assert.equal('task_source' in routed.payload, false);
  assert.equal('runtime_class' in routed.payload, false);
});

test('routeTelegramUpdate: --client-correlation composes with --long independently (two separate typed facts)', () => {
  const routed = routeTelegramUpdate(update('@proj-a --long --client-correlation rel_marker002 do the thing'), { ownerUserId: 1, ownerChatId: 2, projects, aliasRegistry: null });
  assert.equal(routed.payload.client_correlation_id, 'rel_marker002');
  assert.equal(routed.payload.runtime_class, 'LONG');
});

test('routeTelegramUpdate: omitting --client-correlation never sets payload.client_correlation_id at all', () => {
  const routed = routeTelegramUpdate(update('@proj-a plain task'), { ownerUserId: 1, ownerChatId: 2, projects, aliasRegistry: null });
  assert.equal('client_correlation_id' in routed.payload, false);
});

// ---- OwnerTaskController.submit(): fail-closed validation + durable context (Part A/C) ----

function fixture() {
  const created = [];
  const repo = { createOwnerTask: (task) => created.push(task) };
  const controller = new OwnerTaskController({ repository: repo, startPm: async () => null });
  const project = { id: 'proj-a', repo_path: 'C:/a', autonomy: { revision: 1, effects: { SUBMIT_TASK: 'ALLOW' } } };
  const profile = { id: 'pm-1' };
  return { created, controller, project, profile };
}

test('submit(): a valid client_correlation_id is stored in the durable context AND returned in the canonical result', async () => {
  const { created, controller, project, profile } = fixture();
  const canonical = await controller.submit({ command: { command_id: 'cmd-1', client_kind: 'TELEGRAM', payload: { body: 'x', client_correlation_id: 'rel_marker001' } }, project, profile });
  assert.equal(created[0].context.clientCorrelationId, 'rel_marker001');
  assert.equal(canonical.client_correlation_id, 'rel_marker001');
});

test('submit(): omitting client_correlation_id never adds the field to context or the canonical result (byte-for-byte unaffected)', async () => {
  const { created, controller, project, profile } = fixture();
  const canonical = await controller.submit({ command: { command_id: 'cmd-2', client_kind: 'TELEGRAM', payload: { body: 'x' } }, project, profile });
  assert.equal('clientCorrelationId' in created[0].context, false);
  assert.equal('client_correlation_id' in canonical, false);
});

test('submit(): a malformed client_correlation_id fails closed BEFORE any task is created', async () => {
  const { created, controller, project, profile } = fixture();
  for (const bogus of ['ab', 'a'.repeat(129), 'has space', 'has/slash', 42, true, {}]) {
    await assert.rejects(
      controller.submit({ command: { command_id: `cmd-bogus-${JSON.stringify(bogus)}`, client_kind: 'TELEGRAM', payload: { body: 'x', client_correlation_id: bogus } }, project, profile }),
      (error) => error instanceof OwnerControlError && error.code === 'INVALID_CLIENT_CORRELATION_ID',
    );
  }
  assert.equal(created.length, 0, 'no task may ever be durably created for a rejected malformed client_correlation_id');
});

test('submit(): client_correlation_id never alters runtimeClass/durability -- it is diagnostic/provenance only', async () => {
  const { created, controller, project, profile } = fixture();
  await controller.submit({ command: { command_id: 'cmd-3', client_kind: 'TELEGRAM', payload: { body: 'x', client_correlation_id: 'rel_marker003' } }, project, profile });
  assert.equal(created[0].context.runtimeClass, 'NORMAL');
  await controller.submit({ command: { command_id: 'cmd-4', client_kind: 'TELEGRAM', payload: { body: 'x', client_correlation_id: 'rel_marker004', runtime_class: 'LONG' } }, project, profile });
  assert.equal(created[1].context.runtimeClass, 'LONG'); // driven by runtime_class, not by the mere presence of a correlation id
});

test('submit(): client_correlation_id and task_source/--task-file are independent -- both can be present, neither overrides the other', async () => {
  const { created, controller, project, profile } = fixture();
  await controller.submit({
    command: { command_id: 'cmd-5', client_kind: 'TELEGRAM', payload: { body: 'file content', client_correlation_id: 'rel_marker005', task_source: { type: 'GIT_FILE', resolvedCommitSha: 'a'.repeat(40) } } },
    project, profile,
  });
  assert.equal(created[0].context.clientCorrelationId, 'rel_marker005');
  assert.equal(created[0].context.runtimeClass, 'LONG'); // task_source alone still forces LONG, unchanged
  assert.deepEqual(created[0].context.taskSource, { type: 'GIT_FILE', resolvedCommitSha: 'a'.repeat(40) });
});

// ---- renderOwnerAck(): the bounded transport ACK line (Part B) ----

function ackResult(canonical) { return { canonical_result: canonical }; }

test('renderOwnerAck: SUBMIT_TASK includes "Correlation: <id>" only when client_correlation_id is present', () => {
  const ack = renderOwnerAck('SUBMIT_TASK', ackResult({ task_id: 'task-abc123', pm_profile_id: 'pm-1', client_correlation_id: 'rel_marker001' }), 'proj-a');
  assert.match(ack, /^✅ DSH task accepted/);
  assert.match(ack, /Task: task-abc123/);
  assert.match(ack, /PM: pm-1/);
  assert.match(ack, /Correlation: rel_marker001/);
});

test('renderOwnerAck: SUBMIT_TASK omits the Correlation line entirely for an ordinary dispatch (historical ACK shape preserved byte-for-byte)', () => {
  const ack = renderOwnerAck('SUBMIT_TASK', ackResult({ task_id: 'task-abc123', pm_profile_id: 'pm-1' }), 'proj-a');
  assert.equal(ack, '✅ DSH task accepted\nProject: proj-a\nTask: task-abc123\nPM: pm-1');
  assert.equal(ack.includes('Correlation:'), false);
});

// P18-W5 multimode correlation rendering: this test previously locked in
// the Part B scope boundary ("Council/Debate ack shape unchanged" -- no
// Task:/Correlation: identity at all). That boundary has now been
// deliberately widened -- see tests/p18-w5-multimode-correlation-rendering
// .test.mjs for the full Council/Debate ACK+terminal identity contract --
// so this historical test is updated to the new byte-for-byte expectation
// rather than deleted, documenting the exact before/after.
test('renderOwnerAck: Council ack now carries the same authoritative Task:/Correlation: identity as SINGLE (P18-W5)', () => {
  const ack = renderOwnerAck('SUBMIT_TASK', ackResult({
    task_id: 'task-abc123', pm_profile_id: 'pm-1', client_correlation_id: 'rel_marker001',
    council: { participant_profile_ids: ['p1', 'p2'], rounds: 2 },
  }), 'proj-a');
  assert.match(ack, /DSH council accepted/);
  assert.match(ack, /Task: task-abc123/);
  assert.match(ack, /Correlation: rel_marker001/);
});

test('renderOwnerAck: Correlation value is never sourced from anywhere but the durable canonical_result (never model output, never task text)', () => {
  // A malicious/accidental "Correlation:" substring inside a DIFFERENT
  // canonical field (e.g. pm_profile_id, hypothetically) must never leak
  // into the rendered Correlation line -- the renderer reads ONLY
  // canonical.client_correlation_id, never scans any other field's text.
  const ack = renderOwnerAck('SUBMIT_TASK', ackResult({ task_id: 'task-abc123', pm_profile_id: 'pm-1' }), 'proj-a');
  assert.equal(ack.includes('Correlation:'), false);
});

test('renderOwnerAck: an over-length client_correlation_id is bounded to 128 chars in the rendered ack (M05 discipline)', () => {
  const long = 'r'.repeat(200);
  const ack = renderOwnerAck('SUBMIT_TASK', ackResult({ task_id: 'task-abc123', pm_profile_id: 'pm-1', client_correlation_id: long }), 'proj-a');
  const match = ack.match(/Correlation: (.*)$/m);
  assert.ok(match);
  assert.equal(match[1].length, 128);
});
