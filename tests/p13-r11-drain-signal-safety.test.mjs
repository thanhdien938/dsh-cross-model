// P13-R1.1 (docs/p13/05_*.md): drain/shutdown signal wiring and claim-
// authority safety proofs -- the two gaps found during PM diff review of
// P13-R1's original drainActive() (a renewal-stop-only design that could
// leave an abandoned execution running past store close).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createPmRequest } from '../src/pm/pm-contracts.mjs';
import { DurablePmRuntime } from '../src/pm/durable-pm-runtime.mjs';
import { PmRepository } from '../src/persistence/repositories/pm-repository.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { ProductionPmWorker } from '../src/runtime/production-pm-worker.mjs';

async function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-p13-r11-'));
  const store = new SqlitePersistenceStore();
  try { await store.open({ path: join(dir, 'pm.db') }); await store.migrate(); await fn({ store, repository: new PmRepository({ store }) }); }
  finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
}

// ---- existing canonical primitive wiring: WORKFLOW spec.signal ------------
//
// CouncilStepWorkflowRunner already reads `spec.signal` for its own
// decide() calls (council-step-workflow-runner.mjs) -- built for P12-R5B's
// owner-cancel path. Durable-pm-runtime.mjs's WORKFLOW branch never
// actually attached a signal onto the spec it hands to `workflowRunner
// .run()`, so a Council (or any WORKFLOW-typed) step never actually saw a
// shutdown/cancel abort even once the outer decide() calls did. This
// proves the wiring at the ONE call site P13-R1.1 changed, without
// needing a full Council fixture.
test('a WORKFLOW decision\'s spec carries the SAME AbortSignal `resume()`/`run()` was given, for the existing spec.signal consumer to use', async () => fixture(async ({ repository }) => {
  const controller = new AbortController();
  let observedSpec = null;
  const workflowRunner = {
    result: () => null,
    run: async (spec) => { observedSpec = spec; return { workflowId: spec.id, status: 'completed', finalResult: { id: 'r', output: 'ok' }, error: null }; },
  };
  const peerRelay = { exchange: async () => {}, createConversation() {}, getConversation() { return null; }, result: () => null };
  const driver = { name: 'council-shaped-driver', calls: [], async decide(input) { this.calls.push(input); const n = this.calls.length; return n === 1 ? { type: 'workflow', spec: { kind: 'council_step', stepKind: 'chair_plan', steps: [{ recipient: 'alpha', body: 'work' }] } } : { type: 'finish', output: 'done', data: null }; } };
  const runtime = new DurablePmRuntime({ driver, workflowRunner, peerRelay, repository });
  const result = await runtime.run({ objective: 'council-shaped', signal: controller.signal });
  assert.equal(result.status, 'completed');
  assert.ok(observedSpec, 'workflowRunner.run() must have been called');
  assert.equal(observedSpec.signal, controller.signal, 'the exact same AbortSignal must reach the workflow spec -- never a copy, never omitted');
  assert.equal(observedSpec.kind, 'council_step', 'the model-authored spec fields are preserved unchanged alongside the added signal');
}));

test('a WORKFLOW spec is never mutated on the durably committed turn -- the signal is attached to a fresh object each time', async () => fixture(async ({ repository }) => {
  const controller = new AbortController();
  const workflowRunner = { result: () => null, run: async (spec) => ({ workflowId: spec.id, status: 'completed', finalResult: { id: 'r', output: 'ok' }, error: null }) };
  const peerRelay = { exchange: async () => {}, createConversation() {}, getConversation() { return null; }, result: () => null };
  const driver = { name: 'd', calls: [], async decide() { this.calls.push(1); return this.calls.length === 1 ? { type: 'workflow', spec: { steps: [{ recipient: 'a', body: 'x' }] } } : { type: 'finish', output: 'done', data: null }; } };
  const runtime = new DurablePmRuntime({ driver, workflowRunner, peerRelay, repository });
  const result = await runtime.run({ objective: 'x', signal: controller.signal });
  const pmRunId = result.pmRunId;
  const committedSpec = repository.load(pmRunId).turns[0].decision.spec;
  assert.equal(committedSpec.signal, undefined, 'the durably committed decision must never carry a live AbortSignal object');
}));

// ---- claim/recovery safety: no overlapping executor authority -----------
//
// TEST CASE 4: stopping claim renewal (the §13 step 5 residual fallback
// for a slot that never consumes the shutdown signal at all) must NEVER
// itself release or complete the durable claim. The claim's `expires_at`
// is fixed at the last successful renewal and is the ONLY authority that
// ever lets a second executor acquire the same work item -- proven here
// with a fake coordination store that models real lease-expiry timing
// (unlike the simpler always-succeeds fakes used elsewhere in this suite).
function leaseAwareCoordination({ leaseMs }) {
  let claim = null; // { holder, expiresAt } | null
  const calls = [];
  return {
    calls,
    listPmActionCandidates: async () => (claim && Date.now() < claim.expiresAt ? [] : [{ work_item_id: 'w', work_kind: 'PM_ACTION', pm_run_id: 'pm', action_id: 'a' }]),
    acquireClaim: async ({ work_item_id, worker_incarnation_id }) => {
      calls.push({ op: 'acquireClaim', worker_incarnation_id, at: Date.now() });
      if (claim && Date.now() < claim.expiresAt) return null; // still leased to the other holder
      claim = { holder: worker_incarnation_id, expiresAt: Date.now() + leaseMs };
      return { work_item_id, owner_worker_incarnation_id: worker_incarnation_id, fencing_generation: (claim.generation = (claim.generation ?? 0) + 1), fencing_token: 'fence' };
    },
    renewClaim: async (fence) => {
      calls.push({ op: 'renewClaim', at: Date.now() });
      if (!claim || claim.holder !== fence.owner_worker_incarnation_id) throw Object.assign(new Error('lost'), { code: 'CLAIM_AUTHORITY_REJECTED' });
      claim.expiresAt = Date.now() + leaseMs;
    },
    completeClaim: async () => { calls.push({ op: 'completeClaim', at: Date.now() }); claim = null; },
    currentExpiry: () => claim?.expiresAt ?? null,
  };
}

test('stopping renewal on drain timeout never releases/completes the claim -- a second executor cannot acquire it before the lease actually expires', async () => {
  const leaseMs = 80;
  const coordination = leaseAwareCoordination({ leaseMs });
  const handler = { execute: async () => new Promise(() => {}) }; // never settles, ignores signal entirely
  const workerA = new ProductionPmWorker({ coordinationStore: coordination, handler, workerIncarnationId: 'executor-A', leaseMs });
  const started = await workerA.runOnce();
  assert.equal(started.status, 'WORK');
  // Drain gives up quickly (short bound); the underlying handler is still
  // "running" from A's own perspective the whole time.
  const drainResult = await workerA.drainActive({ gracePeriodMs: 10, timeoutMs: 10 });
  assert.equal(drainResult.settled, false);
  assert.equal(coordination.calls.some((c) => c.op === 'completeClaim'), false, 'drain must never call completeClaim for a slot it could not confirm settled');
  // Immediately after renewal stopped, the lease has NOT yet expired --
  // a second executor must be refused.
  const immediateAttempt = await coordination.acquireClaim({ work_item_id: 'w', worker_incarnation_id: 'executor-B' });
  assert.equal(immediateAttempt, null, 'executor B must not acquire the item while A\'s executor could still be live (lease not yet expired)');
  // Only once the lease has genuinely elapsed (server-time authority, the
  // SAME mechanism that already governs a killed process's recovery) may
  // a second executor claim the item.
  await new Promise((resolve) => setTimeout(resolve, leaseMs + 20));
  const laterAttempt = await coordination.acquireClaim({ work_item_id: 'w', worker_incarnation_id: 'executor-B' });
  assert.ok(laterAttempt, 'once the lease has actually expired, the item is legitimately re-claimable -- this is existing, unmodified recovery behavior');
});
