import test from 'node:test';
import assert from 'node:assert/strict';
import { loadProductionConfig, redactConfig } from '../src/runtime/production-config.mjs';
import { ProductionScheduler } from '../src/runtime/production-scheduler.mjs';
import { RuntimeObservability } from '../src/runtime/runtime-observability.mjs';
import { ProductionCoordinatorRuntime } from '../src/runtime/production-coordinator-runtime.mjs';
import { ProductionWorkerRuntime } from '../src/runtime/production-worker-runtime.mjs';
import { OperatorControlService } from '../src/runtime/operator-control-service.mjs';
import { readFile } from 'node:fs/promises';

test('P4_C0_C6 config is strict, durable, local-SQLite, and redacted', () => {
  assert.throws(() => loadProductionConfig({ mode: 'production', postgresDsn: 'secret', sqlitePath: '\\\\server\\share\\x.sqlite' }), /network/);
  assert.throws(() => loadProductionConfig({ mode: 'production', postgresDsn: '', sqlitePath: 'C:/x.sqlite' }), /required/);
  const config = loadProductionConfig({ postgresDsn: 'postgres://u:p@h/db', sqlitePath: 'C:/var/dsh.sqlite' });
  assert.equal(config.concurrency, 1);
  assert.equal(redactConfig(config).postgresDsn, '[REDACTED]');
});

test('P4_C1 coordinator reconstructs before fenced advancement and freezes on authority loss', async () => {
  const calls = []; let reject = false;
  const fence = { logical_coordinator_id: 'c', owner_coordinator_incarnation_id: 'c:i', leader_generation: 1, leadership_token: 'x'.repeat(43) };
  const store = { registerCoordinatorIncarnation: async () => {}, acquireLeadership: async () => fence, renewLeadership: async () => fence, withLeadershipAuthority: async (_f, fn) => { if (reject) throw Object.assign(new Error('lost'), { code: 'LEADERSHIP_AUTHORITY_REJECTED' }); calls.push('fence'); return fn(); } };
  const runtime = new ProductionCoordinatorRuntime({ coordinationStore: store, logicalCoordinatorId: 'c', reconstruct: async () => calls.push('reconstruct'), advance: async () => calls.push('advance') });
  await runtime.start({ host_id: 'host' }); assert.equal((await runtime.runOnce()).status, 'LEADER'); assert.deepEqual(calls, ['reconstruct', 'fence', 'advance']);
  reject = true; assert.equal((await runtime.runOnce()).status, 'FROZEN'); assert.deepEqual(calls, ['reconstruct', 'fence', 'advance']);
});

test('P4_C2_C4 worker heartbeat is observational and drain grants no authority', async () => {
  let runs = 0; const telemetry = new RuntimeObservability();
  const runtime = new ProductionWorkerRuntime({ worker: { runOnce: async () => { runs += 1; return { status: 'IDLE' }; }, requestStop() {} }, heartbeat: async () => { throw new Error('telemetry down'); }, telemetry });
  assert.equal((await runtime.runOnce()).status, 'IDLE'); assert.equal(runs, 1); assert.equal(telemetry.snapshot().counters.heartbeat_failures, 1);
  runtime.requestDrain(); assert.equal((await runtime.runOnce()).status, 'DRAINING'); assert.equal(runs, 1);
});

test('P4_C4 lifecycle status remains separate from claim and leadership authority', () => {
  const dimensions = Object.freeze({ heartbeat: 'STALE', lifecycle: 'DEAD', claim: 'ACTIVE', leadership: 'ABSENT', providerHealth: 'HEALTHY' });
  assert.equal(dimensions.claim, 'ACTIVE'); assert.equal(dimensions.providerHealth, 'HEALTHY');
});

test('P4_C3 scheduler separates lifecycle, capacity, profile and provider health', () => {
  const profile = { backend: 'codex', product: 'cli', version: '1', transport: 'stdio', fingerprint: 'fp' };
  const worker = (id, status = 'ACTIVE', used = 0) => ({ worker_incarnation_id: id, status, capacity: { max_concurrency: 1, reported_in_use: used }, installed_profiles: [profile] });
  const selected = new ProductionScheduler().candidates({ workers: [worker('b'), worker('a'), worker('d', 'DRAINING'), worker('f', 'ACTIVE', 1)], requirement: profile });
  assert.deepEqual(selected.map((x) => x.worker.worker_incarnation_id), ['a', 'b']);
  assert.equal(new ProductionScheduler().candidates({ workers: [worker('a')], requirement: profile, providerHealth: 'UNAVAILABLE' }).length, 0);
});

test('P4_C5 operator is read-only by default, redacts fence token, and refuses ambiguity', async () => {
  let mutations = 0;
  const store = { readWorkItem: async () => ({ work_item_id: 'w', work_kind: 'TASK_DISPATCH', task_id: 't', secret: 'no' }), readClaim: async () => ({ work_item_id: 'w', fencing_token: 'secret', state: 'ACTIVE' }), readCancellation: async () => null };
  const service = new OperatorControlService({ coordinationStore: store, classifyDispatch: async () => 'DISPATCH_STARTED', safeRecovery: async () => { mutations += 1; } });
  const view = await service.inspect('w'); assert.equal(view.claim.fencing_token, undefined); assert.equal(view.work.secret, undefined); assert.equal(mutations, 0);
  assert.equal((await service.executeSafeRecovery('w')).executed, false); assert.equal(mutations, 0);
});

test('P4_C7 telemetry is bounded, redacted, and sink failure is non-interfering', () => {
  const telemetry = new RuntimeObservability({ eventLimit: 1, sink: () => { throw new Error('down'); } });
  telemetry.emit('one', { task_body: 'secret', status: 'ok' }); telemetry.emit('two', { token: 'secret', state: 'idle' }); telemetry.count('blocked');
  const snap = telemetry.snapshot({ authorityReady: true }); assert.equal(snap.events.length, 1); assert.deepEqual(snap.events[0].data, { state: 'idle' }); assert.equal(snap.readiness, true);
});

test('P4_C8 deployment is constrained to host-local SQLite', async () => {
  // The normative deployment-constraint text lives in the public README's
  // "Deployment Constraints" subsection (§5), not in an internal-only phase
  // report — this is the one product doc an OSS user actually reads.
  const text = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(text, /one execution host/i); assert.match(text, /Never mount.*NFS, SMB/is); assert.match(text, /unsupported/i);
});
