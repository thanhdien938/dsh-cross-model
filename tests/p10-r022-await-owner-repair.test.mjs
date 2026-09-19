import test from 'node:test';
import assert from 'node:assert/strict';

import { ProductionPmBackendRegistry } from '../src/pm/production-pm-backend-registry.mjs';
import { resolveExecutionOptions, EXECUTION_STAGE } from '../src/pm/pm-execution-timeout-policy.mjs';
import { buildTaskSummaryMarkdown } from '../src/runtime/task-diagnostic-summary.mjs';

const PROJECT = { repo_path: 'C:/repo-b' };
const SINGLE_OPTIONS = resolveExecutionOptions(EXECUTION_STAGE.OWNER_SINGLE);

function fakeCodexRunnerFactory(outputs) {
  const calls = [];
  const runner = async (input) => { calls.push(input); const next = outputs.shift(); if (next instanceof Error) throw next; return next; };
  return { runner, calls };
}

const VALID_AWAIT_OWNER = JSON.stringify({ type: 'finish', output: JSON.stringify({ type: 'await_owner', kind: 'QUESTION', title: 't', prompt: 'p', allowedResponses: ['RETRY', 'CANCEL'] }) });
// Not actually used -- codex run() closure returns the raw text directly.

function textOf(decision) { return JSON.stringify(decision); }

// P10-R0.2.2 Part R — reproduces the owner-live T3 pattern: Codex exits 0,
// a sandbox tool error appears mid-turn, and the assistant's final decision
// is `await_owner` with a malformed `allowedResponses` (the exact live
// failure message: "await_owner.allowedResponses is invalid").
function t3LikeInvalidAwaitOwner() {
  return textOf({ type: 'await_owner', kind: 'QUESTION', title: 'Cannot read repo', prompt: 'Sandbox helper failed to launch. Retry or cancel?', allowedResponses: ['Retry', 'Cancel'] });
}

function validAwaitOwner(tokens = ['RETRY', 'CANCEL']) {
  return textOf({ type: 'await_owner', kind: 'QUESTION', title: 'Cannot read repo', prompt: 'Sandbox helper failed to launch. Retry or cancel?', allowedResponses: tokens });
}

function validFinish(text = 'done without owner input') {
  return textOf({ type: 'finish', output: text });
}

function registryWith(outputs) {
  const { runner, calls } = fakeCodexRunnerFactory(outputs);
  const registry = new ProductionPmBackendRegistry({ probe: () => true, codexBinary: 'codex-safe', codexRunner: async (input) => ({ events: [{ type: 'item.completed', item: { type: 'agent_message', text: await runner(input) } }] }) });
  return { registry, calls };
}

function decide(registry) {
  const profile = { id: 'live1-codex-gpt-5-6-sol-pm', product: 'codex', transport: 'stdio', session_kind: 'STATELESS', model: 'gpt-5.6-sol' };
  return registry.resolve(profile, { project: PROJECT, executionOptions: SINGLE_OPTIONS }).decide({ turn: 0, request: { objective: 'recover T1/T2 context' }, history: [] });
}

// ---- Part R: OLD vs NEW behavior for the exact T3 failure pattern --------

test('OLD-equivalent baseline: an invalid await_owner outside SINGLE stage (e.g. no executionOptions) is NOT repaired and fails at normalizePmDecision downstream (ambiguous — only parseDecision ran)', async () => {
  const { runner, calls } = fakeCodexRunnerFactory([t3LikeInvalidAwaitOwner()]);
  const registry = new ProductionPmBackendRegistry({ probe: () => true, codexBinary: 'codex-safe', codexRunner: async (input) => ({ events: [{ type: 'item.completed', item: { type: 'agent_message', text: await runner(input) } }] }) });
  const profile = { id: 'p', product: 'codex', transport: 'stdio', session_kind: 'STATELESS' };
  // No executionOptions -> ctx.stage is null -> repair never triggers (matches the OLD behavior before this wave: createCliPmDriver just returns the raw parsed decision unchanged).
  const decision = await registry.resolve(profile, { project: PROJECT }).decide({ turn: 0, request: {}, history: [] });
  assert.equal(decision.type, 'await_owner');
  assert.deepEqual(decision.allowedResponses, ['Retry', 'Cancel']); // still lowercase-mixed -- would fail normalizePmDecision one layer up, exactly like the owner-live T3 failure.
  assert.equal(calls.length, 1, 'no repair attempted outside SINGLE stage');
});

test('NEW behavior: the SAME invalid await_owner, under the OWNER_SINGLE stage, triggers exactly one bounded repair', async () => {
  const { registry, calls } = registryWith([t3LikeInvalidAwaitOwner(), validAwaitOwner(['RETRY', 'CANCEL'])]);
  const decision = await decide(registry);
  assert.equal(decision.type, 'await_owner');
  assert.deepEqual(decision.allowedResponses, ['RETRY', 'CANCEL']);
  assert.equal(calls.length, 2, 'exactly one repair invocation (2 total backend calls)');
});

// ---- Part U.1: valid await_owner -> no repair ----------------------------

test('U1: a valid await_owner on the first attempt never triggers a repair call', async () => {
  const { registry, calls } = registryWith([validAwaitOwner()]);
  const decision = await decide(registry);
  assert.equal(decision.type, 'await_owner');
  assert.equal(calls.length, 1);
});

// ---- Part U.2/U.3: invalid allowedResponses -> one repair -> accepted ----

test('U2/U3: invalid allowedResponses triggers one repair, and a valid repaired decision is accepted', async () => {
  const { registry, calls } = registryWith([validAwaitOwner(['retry']), validAwaitOwner(['RETRY'])]);
  const decision = await decide(registry);
  assert.equal(decision.type, 'await_owner');
  assert.deepEqual(decision.allowedResponses, ['RETRY']);
  assert.equal(calls.length, 2);
});

// ---- Part U.4: repaired invalid await_owner -> terminal failure ----------

test('U4: a repair that is STILL invalid fails closed with a typed terminal error (no third attempt)', async () => {
  const { registry, calls } = registryWith([validAwaitOwner(['retry']), validAwaitOwner(['still not valid'])]);
  await assert.rejects(decide(registry), (e) => e.code === 'PM_DECISION_AWAIT_OWNER_INVALID');
  assert.equal(calls.length, 2, 'never a third attempt');
});

// ---- Part U.5: non-await_owner normalization error -> no repair ---------

test('U5: a non-await_owner decision (e.g. finish) never goes through await_owner repair, even if it would otherwise fail downstream normalization', async () => {
  const { registry, calls } = registryWith([validFinish('ok, no owner input needed')]);
  const decision = await decide(registry);
  assert.equal(decision.type, 'finish');
  assert.equal(calls.length, 1, 'finish decisions are never repaired by this path');
});

// ---- Part U.6: parse failure -> existing parse path, not await_owner ----

test('U6: a JSON parse failure is NOT treated as an await_owner repair case (no repair call, existing PM_DECISION_PARSE_FAILED path)', async () => {
  const { registry, calls } = registryWith(['not json at all']);
  await assert.rejects(decide(registry), (e) => e.code === 'PM_DECISION_PARSE_FAILED');
  assert.equal(calls.length, 1, 'parse failure never triggers the await_owner repair call');
});

// ---- Part U.7: no more than one await_owner repair (transport failure) ---

test('U7: a repair invocation that itself fails at the transport layer terminates without a further attempt', async () => {
  const { runner, calls } = fakeCodexRunnerFactory([t3LikeInvalidAwaitOwner(), Object.assign(new Error('codex process timed out'), { code: 'CODEX_TIMEOUT' })]);
  const registry = new ProductionPmBackendRegistry({ probe: () => true, codexBinary: 'codex-safe', codexRunner: async (input) => ({ events: [{ type: 'item.completed', item: { type: 'agent_message', text: await runner(input) } }] }) });
  await assert.rejects(decide(registry), (e) => e.code === 'PM_DECISION_AWAIT_OWNER_REPAIR_FAILED');
  assert.equal(calls.length, 2);
});

test('U7b: a repair invocation whose output is unparseable also terminates without a further attempt', async () => {
  const { registry, calls } = registryWith([t3LikeInvalidAwaitOwner(), 'not json either']);
  await assert.rejects(decide(registry), (e) => e.code === 'PM_DECISION_AWAIT_OWNER_REPAIR_FAILED');
  assert.equal(calls.length, 2);
});

// ---- Part U.8/U.9: original task and PM profile preserved exactly -------

test('U8/U9: the repair prompt carries the ORIGINAL task text verbatim, and profile/model identity is untouched', async () => {
  const { runner, calls } = fakeCodexRunnerFactory([t3LikeInvalidAwaitOwner(), validAwaitOwner(['RETRY'])]);
  const registry = new ProductionPmBackendRegistry({ probe: () => true, codexBinary: 'codex-safe', codexRunner: async (input) => { calls.push(input); return { events: [{ type: 'item.completed', item: { type: 'agent_message', text: await runner(input) } }] }; } });
  const profile = { id: 'live1-codex-gpt-5-6-sol-pm', product: 'codex', transport: 'stdio', session_kind: 'STATELESS', model: 'gpt-5.6-sol', reasoning: 'medium' };
  const decision = await registry.resolve(profile, { project: PROJECT, executionOptions: SINGLE_OPTIONS }).decide({ turn: 0, request: { objective: 'PROVE_CROSS_BACKEND_RECOVERY_MARKER_XYZ' }, history: [] });
  assert.equal(decision.type, 'await_owner');
  // codexRunner receives {model, reasoning} on every call (production-pm-
  // backend-registry.mjs's codex closure forwards profile.model/reasoning
  // every time) — unchanged across the repair.
  assert.equal(calls[0].model, 'gpt-5.6-sol');
  assert.equal(calls[1].model, 'gpt-5.6-sol');
  assert.equal(calls[0].reasoning, 'medium');
  assert.equal(calls[1].reasoning, 'medium');
  // The repair prompt (2nd call) still contains the original task text.
  assert.ok(calls[1].prompt.includes('PROVE_CROSS_BACKEND_RECOVERY_MARKER_XYZ'));
});

// ---- Part U.10: no owner response is ever fabricated ----------------------

test('U10: a successfully-repaired await_owner decision is returned as a real await_owner decision for the owner to answer — never auto-resolved to a fabricated response', async () => {
  const { registry } = registryWith([t3LikeInvalidAwaitOwner(), validAwaitOwner(['RETRY', 'CANCEL'])]);
  const decision = await decide(registry);
  assert.equal(decision.type, 'await_owner');
  assert.equal('response' in decision, false);
  assert.equal('answer' in decision, false);
});

// ---- Part M: hard bound — never more than 2 backend invocations ----------

test('never more than 2 total backend invocations for the await_owner-repair class, even when both attempts are invalid', async () => {
  const { registry, calls } = registryWith([t3LikeInvalidAwaitOwner(), t3LikeInvalidAwaitOwner()]);
  await assert.rejects(decide(registry));
  assert.equal(calls.length, 2);
});

// ---- Part K/G: sandbox classification and await_owner repair coexist ----
// (the T3-repro end-to-end shape: a sandbox tool failure inside the SAME
// turn as an invalid await_owner decision — sandbox diagnostics and
// await_owner repair diagnostics both fire independently).

test('T3-repro end-to-end: a sandbox-tool-failure turn producing an invalid await_owner is both classified (sandbox) AND repaired (await_owner), landing on a valid decision', async () => {
  const emitted = [];
  const observer = { start(){}, parser(){}, terminal(){}, stdoutSummary(){}, sandbox(ctx, extra){ emitted.push(['sandbox', extra]); }, awaitOwnerContract(ctx, extra){ emitted.push(['awaitOwnerContract', extra]); } };
  const sandboxFailureText = t3LikeInvalidAwaitOwner();
  let call = 0;
  const codexRunner = async () => {
    call += 1;
    if (call === 1) {
      return {
        events: [
          { type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'windows sandbox: orchestrator_helper_launch_failed: setup refresh failed to launch helper: helper=codex-windows-sandbox-setup.exe, error=program not found', status: 'failed' } },
          { type: 'item.completed', item: { type: 'agent_message', text: sandboxFailureText } },
        ],
      };
    }
    return { events: [{ type: 'item.completed', item: { type: 'agent_message', text: validAwaitOwner(['RETRY', 'CANCEL']) } }] };
  };
  const registry = new ProductionPmBackendRegistry({ probe: () => true, codexBinary: 'codex-safe', observer, codexRunner });
  const decision = await decide(registry);
  assert.equal(decision.type, 'await_owner');
  assert.deepEqual(decision.allowedResponses, ['RETRY', 'CANCEL']);
  const sandboxEvent = emitted.find(([kind]) => kind === 'sandbox');
  const contractEvent = emitted.find(([kind]) => kind === 'awaitOwnerContract');
  assert.ok(sandboxEvent, 'sandbox classification fired');
  assert.equal(sandboxEvent[1].state, 'FAILED');
  assert.ok(contractEvent, 'await_owner contract diagnostics fired');
  assert.equal(contractEvent[1].repairAttempted, true);
  assert.equal(contractEvent[1].repairResult, 'OK');
  // The task never claims cross-backend recovery success by itself -- it
  // only reaches a VALID await_owner decision, which still requires real
  // owner input before the task can proceed (Part N: no auto-answer).
});

// ---- Part P: summary.md "## PM Decision Contract" section ---------------

test('summary.md renders a PM Decision Contract section only when normalization ultimately FAILED', () => {
  const withoutIt = buildTaskSummaryMarkdown({ taskId: 't1', status: 'completed' });
  assert.equal(withoutIt.includes('## PM Decision Contract'), false);

  const withIt = buildTaskSummaryMarkdown({
    taskId: 't2', status: 'failed', errorCode: 'PM_DECISION_AWAIT_OWNER_INVALID',
    pmDecisionContractDetail: { decisionType: 'await_owner', normalizationResult: 'FAILED', normalizationError: 'await_owner.allowedResponses is invalid', repairAttempted: true, repairResult: 'FAILED', terminalError: 'PM_DECISION_AWAIT_OWNER_INVALID' },
  });
  assert.ok(withIt.includes('## PM Decision Contract'));
  assert.ok(withIt.includes('await_owner.allowedResponses is invalid'));
  assert.ok(withIt.includes('repair attempted: YES'));
  assert.ok(withIt.includes('repair result: FAILED'));
});
