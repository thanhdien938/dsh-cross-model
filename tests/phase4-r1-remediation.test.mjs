import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { OperatorControlService } from '../src/runtime/operator-control-service.mjs';
import { KNOWN_TELEMETRY_COUNTERS, RuntimeObservability } from '../src/runtime/runtime-observability.mjs';
import { ProductionCoordinatorRuntime } from '../src/runtime/production-coordinator-runtime.mjs';
import { ProductionWorkerRuntime } from '../src/runtime/production-worker-runtime.mjs';

const CANARY = randomBytes(24).toString('hex');
const attacks = Object.freeze({
  password: CANARY,
  message: `Bearer ${CANARY}`,
  detail: `postgresql://user:${CANARY}@host/db`,
  error: `token=${CANARY}`,
  nested: { credential: CANARY, benign: 'preserved', deeper: [{ description: `password=${CANARY}` }] },
  list: [{ leadership_token: CANARY }, `Bearer ${CANARY}`],
  prompt: CANARY,
  result: { body: CANARY },
  long: `${'x'.repeat(2_000)} token=${CANARY}`
});

test('P4_R1_A operator central boundary recursively removes canaries from every inspector', async () => {
  const store = {
    readWorkItem: async () => ({ work_item_id: 'work-1', work_kind: 'TASK_DISPATCH', task_id: 'task-1', prompt: CANARY }),
    readClaim: async () => ({ work_item_id: 'work-1', state: 'ACTIVE', fencing_token: CANARY }),
    readCancellation: async () => ({ state: 'REQUESTED', ...attacks })
  };
  const service = new OperatorControlService({
    coordinationStore: store,
    classifyDispatch: async () => ({ classification: 'SAFE_TO_DISPATCH', ...attacks }),
    inspectNative: async () => ({ state: 'PENDING', ...attacks }),
    inspectParents: async () => ({ blocked: true, ...attacks }),
    inspectPm: async () => ({ committed: true, ...attacks })
  });
  const output = await service.inspect('work-1'); const serialized = JSON.stringify(output);
  assert.equal(serialized.includes(CANARY), false);
  assert.equal(output.classification.classification, 'SAFE_TO_DISPATCH');
  assert.equal(output.native.state, 'PENDING'); assert.equal(output.parents.blocked, true); assert.equal(output.pm.committed, true);
  assert.equal(output.classification.nested.benign, 'preserved');
  assert.equal(output.claim.fencing_token, undefined); assert.equal(output.work.prompt, undefined);
});

test('P4_R1_B telemetry sanitizes innocent values, event types, counter names and remains bounded', () => {
  const telemetry = new RuntimeObservability({ eventLimit: 2 });
  for (const [key, value] of Object.entries({
    message: `Bearer ${CANARY}`, detail: `postgresql://user:${CANARY}@host/db`, reason: `token=${CANARY}`,
    error: `password=${CANARY}`, description: `credential=${CANARY}`, endpoint: `redis://u:${CANARY}@host`,
    url: `mongodb://u:${CANARY}@host/db`, statusText: `Bearer ${CANARY}`
  })) telemetry.emit(`safe.${key}`, { [key]: value, benign: 'kept', nested: attacks, array: [attacks] });
  telemetry.emit(`event.${CANARY}`, { status: 'ok' }); telemetry.count(`counter.${CANARY}`); telemetry.count('work_completed');
  const snapshot = telemetry.snapshot({ authorityReady: true }); const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes(CANARY), false); assert.equal(snapshot.counters.redacted, 1); assert.equal(snapshot.counters.work_completed, 1);
  for (const name of KNOWN_TELEMETRY_COUNTERS) { telemetry.count(name); assert.equal(telemetry.snapshot().counters[name] >= 1, true); }
  assert.equal(snapshot.events.length, 2); assert.equal(snapshot.events.at(-1).type, 'redacted');
  telemetry.emit('runtime.health', { state: 'ready' }); assert.equal(telemetry.snapshot().events.at(-1).type, 'runtime.health');
});

test('P4_R1_B sync throw and asynchronous sink rejection are detached', async () => {
  const unhandled = []; const listener = (reason) => unhandled.push(reason); process.on('unhandledRejection', listener);
  try {
    const sync = new RuntimeObservability({ sink: () => { throw new Error('sync sink'); } }); sync.emit('safe', { status: 'ok' });
    const asyncSink = new RuntimeObservability({ sink: () => Promise.reject(new Error('async sink')) }); asyncSink.emit('safe', { status: 'ok' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(unhandled.length, 0); assert.equal(sync.snapshot().events.length, 1); assert.equal(asyncSink.snapshot().events.length, 1);
  } finally { process.off('unhandledRejection', listener); }
});

test('P4_R1_C coordinator finite diagnostics collect; daemon retains zero poll results', async () => {
  const fence = { logical_coordinator_id: 'c', owner_coordinator_incarnation_id: 'c:i', leader_generation: 1, leadership_token: 'x'.repeat(43) };
  const store = { acquireLeadership: async () => fence, renewLeadership: async () => fence, withLeadershipAuthority: async (_f, fn) => fn() };
  const finite = new ProductionCoordinatorRuntime({ coordinationStore: store, logicalCoordinatorId: 'c', reconstruct: async () => {}, advance: async () => 'ok', pollIntervalMs: 0 });
  assert.equal((await finite.run({ maxPolls: 3 })).length, 3);
  let polls = 0; let daemon;
  daemon = new ProductionCoordinatorRuntime({ coordinationStore: store, logicalCoordinatorId: 'c', reconstruct: async () => {}, advance: async () => { polls += 1; if (polls === 250) daemon.requestDrain(); }, pollIntervalMs: 0 });
  assert.equal(await daemon.run(), undefined); assert.equal(polls, 250);
});

test('P4_R1_C worker finite diagnostics collect; daemon retains zero poll results', async () => {
  const finiteWorker = { runOnce: async () => ({ status: 'IDLE' }), requestStop() {} };
  const finite = new ProductionWorkerRuntime({ worker: finiteWorker, pollIntervalMs: 0 });
  assert.equal((await finite.run({ maxPolls: 3 })).length, 3);
  let polls = 0; let daemon;
  const worker = { runOnce: async () => { polls += 1; if (polls === 250) daemon.requestDrain(); return { status: 'IDLE', payload: 'x'.repeat(1_000) }; }, requestStop() {} };
  daemon = new ProductionWorkerRuntime({ worker, pollIntervalMs: 0 });
  assert.equal(await daemon.run(), undefined); assert.equal(polls, 250);
});
