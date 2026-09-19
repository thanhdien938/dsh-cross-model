import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { classifyDispatchAttempt } from '../src/persistence/recovery/dispatch-recovery-classifier.mjs';
import { ATTEMPT_PHASES, RECOVERY_CLASSIFICATIONS } from '../src/persistence/recovery/dispatch-attempt-protocol.mjs';
import { NativeSessionRepository } from '../src/persistence/repositories/native-session-repository.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { NativeSessionReconciler, NATIVE_RECONCILIATION_RESULTS } from '../src/session/native-session-reconciler.mjs';
import { nativeProfileFingerprint } from '../src/session/native-profile.mjs';

function profile(overrides = {}) {
  return { backend: 'alpha', product: 'Alpha CLI', version: '1.2.3', transport: 'stdio', capabilities: { resume_existing: 'PROVED', send_next_turn: 'PROVED' }, bridge: { calls: 0, async resume() { this.calls += 1; return { status: 'resumed', usable: true, nativeSessionId: 'native-1' }; } }, ...overrides };
}

function capture(repository, current, overrides = {}) {
  return repository.capture({ id: overrides.id ?? 'native-record-1', backend: overrides.backend ?? 'alpha', nativeSessionId: overrides.nativeSessionId ?? 'native-1', nativeReference: overrides.nativeReference ?? { nativeSessionId: overrides.nativeSessionId ?? 'native-1' }, product: overrides.product ?? 'Alpha CLI', version: overrides.version ?? '1.2.3', transport: overrides.transport ?? 'stdio', capabilityFingerprint: overrides.capabilityFingerprint ?? nativeProfileFingerprint(current), taskId: overrides.taskId ?? 'task-1', runId: overrides.runId ?? 'run-1', dispatchAttemptId: overrides.dispatchAttemptId ?? 'attempt-1', lineage: overrides.lineage ?? {}, capturedAt: '2026-08-18T00:00:00.000Z' });
}

async function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-native8-')); const store = new SqlitePersistenceStore();
  try { await store.open({ path: join(dir, 'native.db') }); await store.migrate(); await fn({ store, repository: new NativeSessionRepository({ store, knownBackends: ['alpha', 'beta'] }) }); }
  finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('captured native evidence survives close/reopen with profile and attempt linkage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-native8-reopen-')); const path = join(dir, 'native.db'); let store = new SqlitePersistenceStore();
  try {
    await store.open({ path }); await store.migrate(); const current = profile(); capture(new NativeSessionRepository({ store, knownBackends: ['alpha'] }), current); await store.close();
    store = new SqlitePersistenceStore(); await store.open({ path }); const reopened = new NativeSessionRepository({ store, knownBackends: ['alpha'] }).get('native-record-1');
    assert.equal(reopened.nativeSessionId, 'native-1'); assert.equal(reopened.dispatchAttemptId, 'attempt-1'); assert.equal(reopened.transport, 'stdio'); assert.equal(reopened.status, 'PENDING');
  } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('compatible current profile resumes exactly once, persists RECONCILED, and reopen is idempotent', async () => fixture(async ({ repository }) => {
  const current = profile(); capture(repository, current); const reconciler = new NativeSessionReconciler({ repository, profileResolver: () => current });
  const first = await reconciler.reconcile('native-record-1'); const second = await reconciler.reconcile('native-record-1');
  assert.equal(first.status, 'RECONCILED'); assert.equal(second.status, 'RECONCILED'); assert.equal(current.bridge.calls, 1); assert.equal(repository.get('native-record-1').status, 'RECONCILED'); assert.equal(repository.get('native-record-1').revision, 3);
}));

for (const [field, changed] of [['version', '9.9.9'], ['transport', 'http'], ['product', 'Other Product']]) {
  test(`${field} profile mismatch blocks resume and fresh dispatch`, async () => fixture(async ({ repository }) => {
    const origin = profile(); capture(repository, origin); const current = profile({ [field]: changed });
    const out = await new NativeSessionReconciler({ repository, profileResolver: () => current }).reconcile('native-record-1');
    assert.equal(out.status, 'PROFILE_MISMATCH'); assert.equal(current.bridge.calls, 0); assert.equal(out.freshFallbackPlan.executed, false); assert.equal(out.freshFallbackPlan.truthfulContinuity, false);
  }));
}

test('backend mismatch fails closed before bridge resume', async () => fixture(async ({ repository }) => {
  const origin = profile(); capture(repository, origin); const current = profile({ backend: 'beta' });
  const out = await new NativeSessionReconciler({ repository, profileResolver: () => current }).reconcile('native-record-1');
  assert.equal(out.status, 'PROFILE_MISMATCH'); assert.equal(current.bridge.calls, 0);
}));

for (const currentFactory of [
  () => profile({ capabilities: { resume_existing: 'UNPROVEN' } }),
  () => profile({ bridge: {} }),
]) {
  test('current resume capability or bridge unavailable makes zero calls', async () => fixture(async ({ repository }) => {
    const origin = profile(); capture(repository, origin); const current = currentFactory();
    const out = await new NativeSessionReconciler({ repository, profileResolver: () => current }).reconcile('native-record-1');
    assert.equal(out.status, 'CAPABILITY_UNAVAILABLE'); assert.equal(current.bridge.calls ?? 0, 0); assert.equal(repository.get('native-record-1').status, 'PENDING');
  }));
}

test('capability fingerprint drift blocks resume even while resume remains PROVED', async () => fixture(async ({ repository }) => {
  const origin = profile(); capture(repository, origin); const current = profile({ capabilities: { resume_existing: 'PROVED', send_next_turn: 'UNPROVEN' } });
  const out = await new NativeSessionReconciler({ repository, profileResolver: () => current }).reconcile('native-record-1');
  assert.equal(out.status, 'PROFILE_MISMATCH'); assert.equal(current.bridge.calls, 0);
}));

for (const [bridgeStatus, expected] of [['missing', 'NATIVE_SESSION_MISSING'], ['failed', 'RECONCILE_FAILED'], ['unknown', 'OPERATOR_ACTION_REQUIRED']]) {
  test(`normalized bridge ${bridgeStatus} result is truthful and never fresh-replays`, async () => fixture(async ({ repository }) => {
    const current = profile(); current.bridge.resume = async function resume() { this.calls += 1; return { status: bridgeStatus, diagnostic: 'truth' }; }; capture(repository, current);
    const reconciler = new NativeSessionReconciler({ repository, profileResolver: () => current }); const out = await reconciler.reconcile('native-record-1'); const again = await reconciler.reconcile('native-record-1');
    assert.equal(out.status, expected); assert.equal(again.status, expected); assert.equal(current.bridge.calls, 1); assert.equal(out.freshFallbackPlan.executed, false); assert.equal(repository.get('native-record-1').status, expected);
  }));
}

test('thrown/ambiguous resume becomes operator-required, never RECONCILED', async () => fixture(async ({ repository }) => {
  const current = profile(); current.bridge.resume = async function resume() { this.calls += 1; throw new Error('uncertain transport outcome'); }; capture(repository, current);
  const out = await new NativeSessionReconciler({ repository, profileResolver: () => current }).reconcile('native-record-1');
  assert.equal(out.status, 'OPERATOR_ACTION_REQUIRED'); assert.equal(current.bridge.calls, 1); assert.equal(out.freshFallbackPlan.executed, false);
}));

test('successful resume plus result-commit failure is quarantined and never resumed twice', async () => fixture(async ({ repository }) => {
  const current = profile(); capture(repository, current); const failing = new Proxy(repository, { get(target, prop) { if (prop === 'commitResult') return () => { throw new Error('INJECTED_COMMIT_FAILURE'); }; const value = Reflect.get(target, prop); return typeof value === 'function' ? value.bind(target) : value; } });
  const reconciler = new NativeSessionReconciler({ repository: failing, profileResolver: () => current }); const first = await reconciler.reconcile('native-record-1'); const second = await reconciler.reconcile('native-record-1');
  assert.equal(first.status, 'OPERATOR_ACTION_REQUIRED'); assert.equal(first.commitAmbiguous, true); assert.equal(second.commitAmbiguous, true); assert.equal(current.bridge.calls, 1); assert.equal(repository.get('native-record-1').status, 'RESUME_STARTED');
  const fresh = new NativeSessionReconciler({ repository, profileResolver: () => current }); const afterRestart = await fresh.reconcile('native-record-1');
  assert.equal(afterRestart.status, 'OPERATOR_ACTION_REQUIRED'); assert.equal(afterRestart.commitAmbiguous, true); assert.equal(current.bridge.calls, 1);
}));

test('corrupt native JSON, unknown backend, invalid revision, and impossible status evidence fail closed', async () => fixture(async ({ store, repository }) => {
  const current = profile(); capture(repository, current);
  for (const [sql, params] of [
    ['UPDATE native_sessions SET native_reference = ? WHERE id = ?', ['{bad', 'native-record-1']],
    ['UPDATE native_sessions SET native_reference = ?, backend = ? WHERE id = ?', [JSON.stringify({ nativeSessionId: 'native-1' }), 'unknown', 'native-record-1']],
    ['UPDATE native_sessions SET backend = ?, revision = 0 WHERE id = ?', ['alpha', 'native-record-1']],
    ['UPDATE native_sessions SET revision = 1, reconciliation_status = ?, reconciliation_result = NULL, reconciled_at = NULL WHERE id = ?', ['RECONCILED', 'native-record-1']],
  ]) {
    store.run(sql, params); assert.throws(() => repository.get('native-record-1'), (error) => error.code === 'CORRUPT_NATIVE_SESSION');
  }
}));

test('secret reference, lineage, result, and diagnostic values are absent from raw native rows', async () => fixture(async ({ store, repository }) => {
  const current = profile(); current.bridge.resume = async function resume() { this.calls += 1; return { status: 'failed', authorization: 'Bearer RESULTSECRET123456', diagnostic: 'cookie Bearer DIAGSECRET123456' }; };
  capture(repository, current, { nativeReference: { nativeSessionId: 'native-1', password: 'hunter2', apiKey: 'sk-referenceSecret123' }, lineage: { cookie: 'raw-cookie' } });
  await new NativeSessionReconciler({ repository, profileResolver: () => current }).reconcile('native-record-1');
  const raw = JSON.stringify(store.get('SELECT * FROM native_sessions WHERE id = ?', ['native-record-1']));
  for (const secret of ['hunter2', 'sk-referenceSecret123', 'raw-cookie', 'RESULTSECRET123456', 'DIAGSECRET123456']) assert.equal(raw.includes(secret), false);
  assert.match(raw, /REDACTED/);
}));

test('Gate3 NATIVE_RECONCILE_REQUIRED delegates without changing canonical attempt truth', async () => fixture(async ({ repository }) => {
  const current = profile(); capture(repository, current); const attempt = { id: 'attempt-1', runId: 'run-1', taskId: 'task-1', phase: ATTEMPT_PHASES.REMOTE_STARTED, nativeReference: { nativeSessionId: 'native-1' } };
  const recovery = classifyDispatchAttempt({ attempt, run: { id: 'run-1', status: 'running' }, result: null, capabilities: { resumeExisting: 'PROVED' } });
  const out = await new NativeSessionReconciler({ repository, profileResolver: () => current }).reconcileGate3({ attempt, recovery });
  assert.equal(recovery.classification, RECOVERY_CLASSIFICATIONS.NATIVE_RECONCILE_REQUIRED); assert.equal(out.gate3Classification, RECOVERY_CLASSIFICATIONS.NATIVE_RECONCILE_REQUIRED); assert.equal(out.status, 'RECONCILED'); assert.equal(out.autoReplayAllowed, false);
}));

for (const [name, mutate] of [
  ['run lineage mismatch', (store) => store.run('UPDATE native_sessions SET run_id = ? WHERE id = ?', ['run-other', 'native-record-1'])],
  ['task lineage mismatch when both task ids exist', (store) => store.run('UPDATE native_sessions SET task_id = ? WHERE id = ?', ['task-other', 'native-record-1'])],
  ['tampered dispatch attempt linkage retaining the original run', (store) => store.run('UPDATE native_sessions SET dispatch_attempt_id = ? WHERE id = ?', ['attempt-2', 'native-record-1'])],
]) {
  test(`Gate3 ${name} fails closed before resume without mutating native state`, async () => fixture(async ({ store, repository }) => {
    const current = profile(); capture(repository, current); mutate(store);
    const attemptId = name.startsWith('tampered') ? 'attempt-2' : 'attempt-1';
    const attempt = { id: attemptId, runId: name.startsWith('tampered') ? 'run-2' : 'run-1', taskId: 'task-1', phase: ATTEMPT_PHASES.REMOTE_STARTED, nativeReference: { nativeSessionId: 'native-1' } };
    const recovery = { classification: RECOVERY_CLASSIFICATIONS.NATIVE_RECONCILE_REQUIRED };
    const out = await new NativeSessionReconciler({ repository, profileResolver: () => current }).reconcileGate3({ attempt, recovery });
    assert.equal(out.status, NATIVE_RECONCILIATION_RESULTS.OPERATOR_ACTION_REQUIRED); assert.equal(out.reason, 'native evidence lineage mismatch');
    assert.equal(out.gate3Classification, RECOVERY_CLASSIFICATIONS.NATIVE_RECONCILE_REQUIRED); assert.equal(out.autoReplayAllowed, false); assert.equal(current.bridge.calls, 0);
    assert.equal(repository.get('native-record-1').status, 'PENDING'); assert.equal(repository.get('native-record-1').revision, 1);
  }));
}

test('Gate3 missing optional attempt taskId remains valid when attempt/run linkage matches', async () => fixture(async ({ repository }) => {
  const current = profile(); capture(repository, current); const attempt = { id: 'attempt-1', runId: 'run-1', phase: ATTEMPT_PHASES.REMOTE_STARTED, nativeReference: { nativeSessionId: 'native-1' } };
  const recovery = { classification: RECOVERY_CLASSIFICATIONS.NATIVE_RECONCILE_REQUIRED };
  const out = await new NativeSessionReconciler({ repository, profileResolver: () => current }).reconcileGate3({ attempt, recovery });
  assert.equal(out.status, NATIVE_RECONCILIATION_RESULTS.RECONCILED); assert.equal(out.gate3Classification, RECOVERY_CLASSIFICATIONS.NATIVE_RECONCILE_REQUIRED); assert.equal(current.bridge.calls, 1);
}));

test('Gate3 missing native record remains operator-required with canonical classification', async () => fixture(async ({ repository }) => {
  const current = profile(); const recovery = { classification: RECOVERY_CLASSIFICATIONS.NATIVE_RECONCILE_REQUIRED };
  const out = await new NativeSessionReconciler({ repository, profileResolver: () => current }).reconcileGate3({ attempt: { id: 'absent', runId: 'run-1' }, recovery });
  assert.equal(out.status, NATIVE_RECONCILIATION_RESULTS.OPERATOR_ACTION_REQUIRED); assert.equal(out.reason, 'no canonical native record for dispatch attempt'); assert.equal(out.gate3Classification, RECOVERY_CLASSIFICATIONS.NATIVE_RECONCILE_REQUIRED); assert.equal(current.bridge.calls, 0);
}));

test('native dispatch attempt linkage retains a unique non-null database constraint', async () => fixture(async ({ repository }) => {
  const current = profile(); capture(repository, current);
  assert.throws(() => capture(repository, current, { id: 'native-record-2', nativeSessionId: 'native-2', nativeReference: { nativeSessionId: 'native-2' } }));
}));

test('terminal native reconciliation evidence is semantically validated on hydration', async () => fixture(async ({ store, repository }) => {
  const current = profile(); capture(repository, current);
  const cases = [
    ['RECONCILED', { status: 'resumed', usable: false }, '2026-08-18T00:01:00.000Z', false],
    ['RECONCILED', { status: 'resumed' }, '2026-08-18T00:01:00.000Z', false],
    ['NATIVE_SESSION_MISSING', { status: 'resumed', usable: true }, '2026-08-18T00:01:00.000Z', false],
    ['RECONCILE_FAILED', { status: 'resumed', usable: true }, '2026-08-18T00:01:00.000Z', false],
    ['OPERATOR_ACTION_REQUIRED', { status: 'resumed', usable: true }, '2026-08-18T00:01:00.000Z', false],
    ['RECONCILED', { status: 'resumed', usable: true }, null, false],
    ['RECONCILED', { status: 'resumed', usable: true }, '2026-08-18T00:01:00.000Z', true],
    ['NATIVE_SESSION_MISSING', { status: 'missing' }, '2026-08-18T00:01:00.000Z', true],
    ['RECONCILE_FAILED', { status: 'failed' }, '2026-08-18T00:01:00.000Z', true],
    ['OPERATOR_ACTION_REQUIRED', { status: 'unknown', diagnostic: 'ambiguous' }, '2026-08-18T00:01:00.000Z', true],
  ];
  for (const [status, result, timestamp, valid] of cases) {
    store.run('UPDATE native_sessions SET reconciliation_status = ?, reconciliation_result = ?, reconciled_at = ? WHERE id = ?', [status, JSON.stringify(result), timestamp, 'native-record-1']);
    if (valid) assert.equal(repository.get('native-record-1').status, status);
    else assert.throws(() => repository.get('native-record-1'), (error) => error.code === 'CORRUPT_NATIVE_SESSION');
  }
}));

test('nonterminal native reconciliation states reject even JSON-null result columns', async () => fixture(async ({ store, repository }) => {
  const current = profile(); capture(repository, current);
  for (const status of ['PENDING', 'RESUME_STARTED']) {
    store.run('UPDATE native_sessions SET reconciliation_status = ?, reconciliation_result = ?, reconciled_at = NULL WHERE id = ?', [status, 'null', 'native-record-1']);
    assert.throws(() => repository.get('native-record-1'), (error) => error.code === 'CORRUPT_NATIVE_SESSION');
  }
}));

test('Gate3 interrupted/no-native-ref bypasses reconciler and remains interrupted', async () => fixture(async ({ repository }) => {
  const current = profile(); capture(repository, current); const attempt = { id: 'attempt-other', runId: 'run-1', phase: ATTEMPT_PHASES.REMOTE_STARTED, nativeReference: null };
  const recovery = classifyDispatchAttempt({ attempt, run: { id: 'run-1', status: 'running' }, result: null, capabilities: { resumeExisting: 'PROVED' } });
  const out = await new NativeSessionReconciler({ repository, profileResolver: () => current }).reconcileGate3({ attempt, recovery });
  assert.equal(out.status, RECOVERY_CLASSIFICATIONS.INTERRUPTED_EXTERNAL_RUN); assert.equal(out.reconcilerCalled, false); assert.equal(current.bridge.calls, 0); assert.equal(out.autoReplayAllowed, false);
}));

test('historical PROVED profile cannot authorize a different current version', async () => fixture(async ({ repository }) => {
  const origin = profile(); capture(repository, origin); const current = profile({ version: '1.2.4' });
  const historicalEvidence = { resumeExisting: 'PROVED' }; assert.equal(historicalEvidence.resumeExisting, 'PROVED');
  const out = await new NativeSessionReconciler({ repository, profileResolver: () => current }).reconcile('native-record-1');
  assert.equal(out.status, NATIVE_RECONCILIATION_RESULTS.PROFILE_MISMATCH); assert.equal(current.bridge.calls, 0);
}));
