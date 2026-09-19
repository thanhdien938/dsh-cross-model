import test from 'node:test';
import assert from 'node:assert/strict';
import { OwnerTerminalResultNotifier, renderTerminalResult } from '../src/owner/telegram-owner-client.mjs';
import { OwnerControlError, deterministicOwnerId } from '../src/owner/owner-contracts.mjs';

// P7-R0.3 (M03) — real Telegram council forensics summary (see
// docs/p7/04_P7_MANUAL_ACCEPTANCE.md for the full trace): a real Telegram
// council (pm_run_id=pmrun-5QSLNr2r1LJgTV-90X0jwQX2Cq8u4-gq, project
// dsh-p6-test-b) completed durably (run.status='completed', run.output
// 5,517 bytes, run.data.type='council') and its owner_interaction row WAS
// materialized (notification_kind=TERMINAL_PM_RESULT), but
// notification_attempts stayed at 0 forever — proving claimNotifications()
// was never reached. Root cause (E4): OwnerTerminalResultNotifier.flush()'s
// materialization loop called createInteraction() UNGUARDED for every
// still-terminal run within `limit` on every cycle, including runs whose
// interaction already existed from BEFORE this codebase started including
// `data`/`project_id` in runtime_facts (a real, confirmed shape drift —
// verified directly against the real store: an older, already-notified
// interaction's stored runtime_facts has exactly 8 keys, none of them
// `data`/`project_id`). Recomputing facts for that old run now produces a
// DIFFERENT shape, createInteraction()'s semantic-equality check throws
// OWNER_INTERACTION_CONFLICT, and — uncaught — that aborted the entire
// materialization for-loop before claimNotifications() ever ran, on every
// single flush() cycle, for as long as that one old row stayed within the
// `limit` window. This file proves the fix.

function fakeOwnerRepository({ existing = {} } = {}) {
  const interactions = new Map(Object.entries(existing).map(([id, value]) => [id, structuredClone(value)]));
  const commands = new Map();
  let marked = 0;
  return {
    interactions,
    get markedCount() { return marked; },
    registerCommand(pmRunId, command) { commands.set(pmRunId, command); },
    async findMaterializedCommandByPmRunId(pmRunId) { return commands.get(pmRunId) ?? null; },
    async createInteraction(value) {
      const existingRow = interactions.get(value.interaction_id);
      if (!existingRow) { interactions.set(value.interaction_id, structuredClone(value)); return interactions.get(value.interaction_id); }
      // Mirror the real PostgresOwnerRepository: ON CONFLICT DO NOTHING, then
      // strict semantic-equality check against what's already durably stored.
      const wanted = { project_id: value.project_id, task_id: value.task_id ?? null, pm_run_id: value.pm_run_id ?? null, runtime_facts: value.runtime_facts };
      const actual = { project_id: existingRow.project_id, task_id: existingRow.task_id ?? null, pm_run_id: existingRow.pm_run_id ?? null, runtime_facts: existingRow.runtime_facts };
      if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new OwnerControlError('interaction id semantic conflict', 'OWNER_INTERACTION_CONFLICT');
      return existingRow;
    },
    async claimNotifications({ terminal }) {
      return [...interactions.values()].filter((item) => !item.notified_at && (item.runtime_facts?.notification_kind === 'TERMINAL_PM_RESULT') === terminal);
    },
    async markNotified(id) { interactions.get(id).notified_at = new Date().toISOString(); marked += 1; },
  };
}

function councilRun(overrides = {}) {
  return {
    id: 'pmrun-5QSLNr2r1LJgTV-90X0jwQX2Cq8u4-gq',
    status: 'completed',
    output: 'A'.repeat(5517), // real observed size
    error: null,
    driver: 'council:live1-claude-pm',
    pmProfileId: 'live1-claude-pm',
    data: { type: 'council', chair_profile_id: 'live1-claude-pm', participant_profile_ids: ['live1-codex-pm', 'live1-grok-pm'], rounds: 2, strategy: 'independent_then_critique_then_synthesis', degraded: false, completed_participants: ['live1-codex-pm', 'live1-grok-pm'], failed_participants: [] },
    ...overrides,
  };
}

const REAL_COMMAND = { project_id: 'dsh-p6-test-b', canonical_result: { task_id: 'task-5QSLNr2r1LJgTV-90X0jwQX2Cq8u4-gq', pm_run_id: 'pmrun-5QSLNr2r1LJgTV-90X0jwQX2Cq8u4-gq', pm_profile_id: 'live1-claude-pm' } };

// ---- U1/U3: realistic council lineage end-to-end ---------------------

test('U1/U3: realistic Telegram council lineage is materialized, claimed, rendered, sent, and marked notified', async () => {
  const repository = fakeOwnerRepository();
  repository.registerCommand('pmrun-5QSLNr2r1LJgTV-90X0jwQX2Cq8u4-gq', REAL_COMMAND);
  const sent = [];
  const notifier = new OwnerTerminalResultNotifier({ repository, pmRepository: { listTerminalRuns: () => [councilRun()] }, send: async (text) => sent.push(text) });
  const result = await notifier.flush();
  assert.equal(result.materialized, 1);
  assert.equal(result.conflicted, 0);
  assert.equal(result.claimed, 1);
  assert.equal(result.sent, 1);
  assert.equal(repository.markedCount, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /DSH council completed/);
  assert.match(sent[0], /Project: dsh-p6-test-b/);
  assert.match(sent[0], /Chair: live1-claude-pm/);
  assert.match(sent[0], /Council: live1-codex-pm, live1-grok-pm/);
  assert.match(sent[0], /Rounds: 2/);
  assert.match(sent[0], /Result:/);
});

test('U8: a second flush after a successful send delivers nothing further', async () => {
  const repository = fakeOwnerRepository();
  repository.registerCommand('pmrun-5QSLNr2r1LJgTV-90X0jwQX2Cq8u4-gq', REAL_COMMAND);
  const sent = [];
  const notifier = new OwnerTerminalResultNotifier({ repository, pmRepository: { listTerminalRuns: () => [councilRun()] }, send: async (text) => sent.push(text) });
  await notifier.flush();
  const second = await notifier.flush();
  assert.equal(second.sent, 0);
  assert.equal(sent.length, 1, 'no duplicate final Telegram notification');
});

// ---- The real bug: an old, shape-drifted interaction must not block -----
// ---- delivery of a NEW, legitimately-pending one ------------------------

test('E4 regression: an old already-notified interaction whose stored runtime_facts predates data/project_id no longer blocks a new pending council notification', async () => {
  // Exact real evidence: an older interaction's durably-stored runtime_facts
  // has 8 keys and no `data`/`project_id` (captured directly from the real
  // Postgres store — see docs/p7/04_P7_MANUAL_ACCEPTANCE.md).
  const oldRunId = 'pmrun-PXEeTFtGsnHa0BBfmpGqsxh_mcIrhKCN';
  const oldInteractionId = 'terminal-4pwGwZjVd-xU6U2qUYu7rqMv3y8z1NRm';
  const repository = fakeOwnerRepository({
    existing: {
      [oldInteractionId]: {
        interaction_id: oldInteractionId,
        project_id: 'dsh-p6-test-b',
        task_id: 'task-old',
        pm_run_id: oldRunId,
        notified_at: '2026-08-21T13:59:37.998Z', // already delivered, long ago
        runtime_facts: { notification_kind: 'TERMINAL_PM_RESULT', task_id: 'task-old', pm_run_id: oldRunId, status: 'completed', pm_profile_id: 'live1-claude-pm', driver: 'production:claude-code:live1-claude-pm', output: 'old single-PM result', error: null },
      },
    },
  });
  repository.registerCommand(oldRunId, { project_id: 'dsh-p6-test-b', canonical_result: { task_id: 'task-old', pm_run_id: oldRunId } });
  repository.registerCommand('pmrun-5QSLNr2r1LJgTV-90X0jwQX2Cq8u4-gq', REAL_COMMAND);

  const oldRun = { id: oldRunId, status: 'completed', output: 'old single-PM result', error: null, driver: 'production:claude-code:live1-claude-pm', pmProfileId: 'live1-claude-pm', data: null };
  const newCouncilRun = councilRun();

  const sent = [];
  const logs = [];
  const notifier = new OwnerTerminalResultNotifier({
    repository,
    pmRepository: { listTerminalRuns: () => [newCouncilRun, oldRun] }, // newest-first, exactly like the real listTerminalRuns() ordering
    send: async (text) => sent.push(text),
    log: (event) => logs.push(event),
  });

  const result = await notifier.flush();
  // The old row conflicts (shape drift) and is skipped, not fatal.
  assert.equal(result.conflicted, 1);
  // The NEW council interaction still gets materialized, claimed, and sent —
  // this is the entire bug: before the fix, the old row's throw aborted the
  // loop and claimNotifications() was never reached at all.
  assert.equal(result.materialized, 1);
  assert.equal(result.claimed, 1);
  assert.equal(result.sent, 1);
  assert.match(sent[0], /DSH council completed/);
  // The already-notified old interaction is never re-sent.
  assert.equal(sent.length, 1);
  assert.ok(logs.some((e) => e.stage === 'terminal_materialize_failed' && e.pmRunId === oldRunId), 'the conflict is observable');
  assert.ok(logs.some((e) => e.stage === 'terminal_materialized' && e.pmRunId === newCouncilRun.id));
  assert.ok(logs.some((e) => e.stage === 'telegram_send_success'));
});

// ---- U4/U5: degraded and failed councils ----------------------------------

test('U4: a degraded council is delivered with the degraded-participation format', async () => {
  const repository = fakeOwnerRepository();
  repository.registerCommand('pmrun-degraded', { project_id: 'dsh-p6-test-b', canonical_result: { task_id: 'task-degraded', pm_run_id: 'pmrun-degraded' } });
  const run = councilRun({ id: 'pmrun-degraded', output: 'Council degraded: only one participant completed.\n\nFinal.', data: { type: 'council', chair_profile_id: 'live1-claude-pm', participant_profile_ids: ['live1-codex-pm', 'live1-grok-pm'], rounds: 2, degraded: true, completed_participants: ['live1-codex-pm'], failed_participants: ['live1-grok-pm'] } });
  const sent = [];
  const notifier = new OwnerTerminalResultNotifier({ repository, pmRepository: { listTerminalRuns: () => [run] }, send: async (text) => sent.push(text) });
  await notifier.flush();
  assert.match(sent[0], /degraded participation/);
  assert.match(sent[0], /Failed:\nlive1-grok-pm/);
  assert.match(sent[0], /Completed:\nlive1-codex-pm/);
});

test('U5: a failed council terminal result is delivered honestly (not disguised as success)', async () => {
  const repository = fakeOwnerRepository();
  repository.registerCommand('pmrun-failed', { project_id: 'dsh-p6-test-b', canonical_result: { task_id: 'task-failed', pm_run_id: 'pmrun-failed' } });
  const run = { id: 'pmrun-failed', status: 'failed', output: '', error: { name: 'CouncilOrchestrationError', message: 'all council participants failed round 1', code: 'COUNCIL_ALL_PARTICIPANTS_FAILED' }, driver: 'council:live1-claude-pm', pmProfileId: 'live1-claude-pm', data: null };
  const sent = [];
  const notifier = new OwnerTerminalResultNotifier({ repository, pmRepository: { listTerminalRuns: () => [run] }, send: async (text) => sent.push(text) });
  await notifier.flush();
  assert.match(sent[0], /❌ DSH task failed/);
  assert.match(sent[0], /all council participants failed round 1/);
});

// ---- U6/U7: send retry semantics (unchanged) ------------------------------

test('U6/U7: a send failure remains retryable; a later successful send marks notified', async () => {
  const repository = fakeOwnerRepository();
  repository.registerCommand('pmrun-5QSLNr2r1LJgTV-90X0jwQX2Cq8u4-gq', REAL_COMMAND);
  const pmRepository = { listTerminalRuns: () => [councilRun()] };
  let attempts = 0;
  const failing = new OwnerTerminalResultNotifier({ repository, pmRepository, send: async () => { attempts += 1; throw new Error('Telegram sendMessage failed'); } });
  const first = await failing.flush();
  assert.equal(first.sent, 0);
  assert.equal(repository.markedCount, 0, 'never marked notified on a failed send');
  const recovered = new OwnerTerminalResultNotifier({ repository, pmRepository, send: async () => { attempts += 1; } });
  const second = await recovered.flush();
  assert.equal(second.sent, 1);
  assert.equal(attempts, 2);
  assert.equal(repository.markedCount, 1);
});

// ---- U9: no historical flood ----------------------------------------------

test('U9: many already-notified historical runs never get re-sent, even when a new one is materialized alongside them', async () => {
  const existing = {};
  const historicalRuns = [];
  for (let i = 0; i < 10; i += 1) {
    const id = `pmrun-hist-${i}`;
    const interactionId = deterministicOwnerId('terminal', id); // must match exactly what flush() computes
    existing[interactionId] = { interaction_id: interactionId, project_id: 'dsh-p6-test-b', task_id: `task-hist-${i}`, pm_run_id: id, notified_at: '2026-08-20T00:00:00.000Z', runtime_facts: { notification_kind: 'TERMINAL_PM_RESULT', task_id: `task-hist-${i}`, pm_run_id: id, project_id: 'dsh-p6-test-b', status: 'completed', pm_profile_id: 'live1-claude-pm', driver: 'production:claude-code:live1-claude-pm', output: `old result ${i}`, error: null, data: null } };
    historicalRuns.push({ id, status: 'completed', output: `old result ${i}`, error: null, driver: 'production:claude-code:live1-claude-pm', pmProfileId: 'live1-claude-pm', data: null });
  }
  const repository = fakeOwnerRepository({ existing });
  for (const run of historicalRuns) repository.registerCommand(run.id, { project_id: 'dsh-p6-test-b', canonical_result: { task_id: `task-${run.id}`, pm_run_id: run.id } });
  repository.registerCommand('pmrun-5QSLNr2r1LJgTV-90X0jwQX2Cq8u4-gq', REAL_COMMAND);
  const sent = [];
  const notifier = new OwnerTerminalResultNotifier({ repository, pmRepository: { listTerminalRuns: () => [councilRun(), ...historicalRuns] }, send: async (text) => sent.push(text) });
  const result = await notifier.flush();
  assert.equal(result.sent, 1, 'only the one genuinely pending council notification is sent');
  assert.equal(sent.length, 1);
  assert.match(sent[0], /DSH council completed/);
});

// ---- U10/U11: fail-closed lineage ------------------------------------------

test('U10: a terminal run with no materialized owner command is skipped, never fabricated', async () => {
  const repository = fakeOwnerRepository(); // no registerCommand call
  const sent = [];
  const notifier = new OwnerTerminalResultNotifier({ repository, pmRepository: { listTerminalRuns: () => [councilRun()] }, send: async (text) => sent.push(text) });
  const result = await notifier.flush();
  assert.equal(result.materialized, 0);
  assert.equal(result.sent, 0);
});

test('U11: lineage identity is exact — a differently-keyed command never fuzzy-matches this run', async () => {
  const repository = fakeOwnerRepository();
  // Register a command for a DIFFERENT pm_run_id only.
  repository.registerCommand('pmrun-someone-else', { project_id: 'dsh-p6-test-b', canonical_result: { task_id: 'task-x', pm_run_id: 'pmrun-someone-else' } });
  const sent = [];
  const notifier = new OwnerTerminalResultNotifier({ repository, pmRepository: { listTerminalRuns: () => [councilRun()] }, send: async (text) => sent.push(text) });
  const result = await notifier.flush();
  assert.equal(result.materialized, 0, 'no fuzzy match by project/chair/timestamp — exact pm_run_id or nothing');
  assert.equal(result.sent, 0);
});

// ---- U12/U13: sanitization + bounded length --------------------------------

test('U12: council data fields survive sanitization end to end', async () => {
  const repository = fakeOwnerRepository();
  repository.registerCommand('pmrun-5QSLNr2r1LJgTV-90X0jwQX2Cq8u4-gq', REAL_COMMAND);
  const notifier = new OwnerTerminalResultNotifier({ repository, pmRepository: { listTerminalRuns: () => [councilRun()] }, send: async () => {} });
  await notifier.flush();
  const stored = repository.interactions.get('terminal-zY2TjTSLhq4B20L_722DzODle76A_9-P') ?? [...repository.interactions.values()][0];
  const facts = stored.runtime_facts;
  assert.equal(facts.data.type, 'council');
  assert.equal(facts.data.chair_profile_id, 'live1-claude-pm');
  assert.deepEqual(facts.data.participant_profile_ids, ['live1-codex-pm', 'live1-grok-pm']);
  assert.equal(facts.data.rounds, 2);
  assert.equal(facts.data.degraded, false);
  assert.deepEqual(facts.data.completed_participants, ['live1-codex-pm', 'live1-grok-pm']);
  assert.deepEqual(facts.data.failed_participants, []);
});

test('U13: the rendered council message for a real-sized synthesis (5,517 bytes) stays within the Telegram-safe bound', () => {
  const text = renderTerminalResult({ runtime_facts: { status: 'completed', project_id: 'dsh-p6-test-b', output: 'S'.repeat(5517), data: { type: 'council', chair_profile_id: 'live1-claude-pm', participant_profile_ids: ['live1-codex-pm', 'live1-grok-pm'], rounds: 2, degraded: false } } });
  assert.ok(text.length <= 3500);
  assert.match(text, /\[TRUNCATED — full result remains available in DSH Desktop\]$/);
  // Meaningfully more than the generic sanitizer's 512-char cap survives —
  // this is the actual Part J fix, not just "some" truncation.
  assert.ok(text.length > 2000);
});

// ---- U14: observability never leaks secrets --------------------------------

test('U14: notifier log events are structurally bounded and never contain the raw result text or a secret', async () => {
  const repository = fakeOwnerRepository();
  repository.registerCommand('pmrun-5QSLNr2r1LJgTV-90X0jwQX2Cq8u4-gq', REAL_COMMAND);
  const logs = [];
  const secretRun = councilRun({ output: 'FINAL SYNTHESIS token=SECRET-do-not-leak-12345 more analysis text' });
  const notifier = new OwnerTerminalResultNotifier({ repository, pmRepository: { listTerminalRuns: () => [secretRun] }, send: async () => {}, log: (e) => logs.push(e) });
  await notifier.flush();
  assert.ok(logs.length > 0);
  const serialized = JSON.stringify(logs);
  assert.equal(serialized.includes('SECRET-do-not-leak'), false);
  assert.equal(serialized.includes('FINAL SYNTHESIS'), false);
  const stages = logs.map((e) => e.stage);
  assert.ok(stages.includes('terminal_materialized'));
  assert.ok(stages.includes('terminal_claimed'));
  assert.ok(stages.includes('terminal_rendered'));
  assert.ok(stages.includes('telegram_send_success'));
  assert.ok(stages.includes('terminal_marked_notified'));
});

test('U14b: a send failure is logged as telegram_send_failed, distinctly from a materialize conflict', async () => {
  const repository = fakeOwnerRepository();
  repository.registerCommand('pmrun-5QSLNr2r1LJgTV-90X0jwQX2Cq8u4-gq', REAL_COMMAND);
  const logs = [];
  const notifier = new OwnerTerminalResultNotifier({ repository, pmRepository: { listTerminalRuns: () => [councilRun()] }, send: async () => { throw new Error('Telegram sendMessage failed'); }, log: (e) => logs.push(e) });
  await notifier.flush();
  assert.ok(logs.some((e) => e.stage === 'telegram_send_failed'));
  assert.equal(logs.some((e) => e.stage === 'terminal_marked_notified'), false);
});
