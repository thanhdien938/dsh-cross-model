#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { classifyDispatchAttempt } from '../src/persistence/recovery/dispatch-recovery-classifier.mjs';
import { ATTEMPT_PHASES, RECOVERY_CLASSIFICATIONS } from '../src/persistence/recovery/dispatch-attempt-protocol.mjs';
import { NativeSessionRepository } from '../src/persistence/repositories/native-session-repository.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { NativeSessionReconciler } from '../src/session/native-session-reconciler.mjs';
import { nativeProfileFingerprint } from '../src/session/native-profile.mjs';
import { classifySmoke, exitCodeFor } from './lib/smoke-status.mjs';

const dir = mkdtempSync(join(tmpdir(), 'dsh-p2g8-smoke-')); const path = join(dir, 'native.db'); let store = new SqlitePersistenceStore(); const checks = [];
const add = (name, passed) => checks.push({ name, passed: passed === true });
const makeProfile = (overrides = {}) => ({ backend: 'alpha', product: 'Alpha', version: '1.0.0', transport: 'stdio', capabilities: { resume_existing: 'PROVED' }, bridge: { calls: 0, async resume() { this.calls += 1; return { status: 'resumed', usable: true }; } }, ...overrides });
const capture = (repository, id, attemptId, current) => repository.capture({ id, backend: 'alpha', nativeSessionId: `session-${id}`, nativeReference: { nativeSessionId: `session-${id}` }, product: 'Alpha', version: '1.0.0', transport: 'stdio', capabilityFingerprint: nativeProfileFingerprint(current), dispatchAttemptId: attemptId, capturedAt: '2026-08-18T00:00:00.000Z' });

try {
  await store.open({ path }); await store.migrate(); let repository = new NativeSessionRepository({ store, knownBackends: ['alpha'] }); const compatible = makeProfile(); capture(repository, 'survive', 'attempt-survive', compatible); await store.close();
  store = new SqlitePersistenceStore(); await store.open({ path }); repository = new NativeSessionRepository({ store, knownBackends: ['alpha'] });
  add('1. persisted native reference survives reopen', repository.get('survive').nativeSessionId === 'session-survive');
  const reconciler = new NativeSessionReconciler({ repository, profileResolver: () => compatible }); const first = await reconciler.reconcile('survive');
  add('2. compatible current profile reconciles exactly once', first.status === 'RECONCILED' && compatible.bridge.calls === 1);

  const versionOrigin = makeProfile(); capture(repository, 'version', 'attempt-version', versionOrigin); const changed = makeProfile({ version: '2.0.0' }); const mismatch = await new NativeSessionReconciler({ repository, profileResolver: () => changed }).reconcile('version');
  add('3. version mismatch blocks native resume', mismatch.status === 'PROFILE_MISMATCH' && changed.bridge.calls === 0);

  const capabilityOrigin = makeProfile(); capture(repository, 'capability', 'attempt-capability', capabilityOrigin); const unavailable = makeProfile({ capabilities: { resume_existing: 'UNPROVEN' } }); const blocked = await new NativeSessionReconciler({ repository, profileResolver: () => unavailable }).reconcile('capability');
  add('4. unavailable current resume capability blocks resume', blocked.status === 'CAPABILITY_UNAVAILABLE' && unavailable.bridge.calls === 0);

  const missingProfile = makeProfile(); missingProfile.bridge.resume = async function resume() { this.calls += 1; return { status: 'missing' }; }; capture(repository, 'missing', 'attempt-missing', missingProfile); const missing = await new NativeSessionReconciler({ repository, profileResolver: () => missingProfile }).reconcile('missing');
  add('5. missing native session never fresh-replays', missing.status === 'NATIVE_SESSION_MISSING' && missing.freshFallbackPlan.executed === false && missing.freshFallbackPlan.truthfulContinuity === false);

  const ambiguousProfile = makeProfile(); ambiguousProfile.bridge.resume = async function resume() { this.calls += 1; return { status: 'unknown' }; }; capture(repository, 'ambiguous', 'attempt-ambiguous', ambiguousProfile); const ambiguous = await new NativeSessionReconciler({ repository, profileResolver: () => ambiguousProfile }).reconcile('ambiguous');
  add('6. ambiguous native result requires operator and no replay', ambiguous.status === 'OPERATOR_ACTION_REQUIRED' && ambiguous.freshFallbackPlan.executed === false);

  const again = await reconciler.reconcile('survive');
  add('7. successful result survives reopen and is idempotent', again.status === 'RECONCILED' && compatible.bridge.calls === 1 && repository.get('survive').status === 'RECONCILED');

  const attempt = { id: 'attempt-version', runId: 'run-v', phase: ATTEMPT_PHASES.REMOTE_STARTED, nativeReference: { nativeSessionId: 'session-version' } }; const recovery = classifyDispatchAttempt({ attempt, run: { id: 'run-v', status: 'running' }, result: null, capabilities: { resumeExisting: 'PROVED' } }); const integrated = await new NativeSessionReconciler({ repository, profileResolver: () => changed }).reconcileGate3({ attempt, recovery });
  add('8. Gate3 reconciliation preserves canonical ambiguous truth', recovery.classification === RECOVERY_CLASSIFICATIONS.NATIVE_RECONCILE_REQUIRED && integrated.gate3Classification === RECOVERY_CLASSIFICATIONS.NATIVE_RECONCILE_REQUIRED && integrated.autoReplayAllowed === false);

  for (const item of checks) console.log(`${item.passed ? 'PASS' : 'FAIL'}  ${item.name}`); const proved = checks.filter((item) => item.passed).length; const status = classifySmoke({ proved, required: 8 }); console.log(`P2-GATE8: ${status} (${proved}/8 checks) — native session reconciliation`); process.exitCode = exitCodeFor(status);
} finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
