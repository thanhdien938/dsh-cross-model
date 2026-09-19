import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SCHEMA_VERSION, migrationDefinitions } from '../src/persistence/sqlite/migrations.mjs';
import { ATTEMPT_PHASES, RECOVERY_CLASSIFICATIONS } from '../src/persistence/recovery/dispatch-attempt-protocol.mjs';
import { classifyDispatchAttempt } from '../src/persistence/recovery/dispatch-recovery-classifier.mjs';
import { ARCHITECTURE_INVARIANTS } from '../src/orchestration/architecture-invariants.mjs';
import { PROVEN_SESSION_CAPABILITY_MATRIX, backendsProving } from '../src/session/proven-capability-matrix.mjs';
import { PM_RECOVERY } from '../src/pm/durable-pm-runtime.mjs';
import { NATIVE_RECONCILIATION_STATUSES } from '../src/persistence/repositories/native-session-repository.mjs';
import { PERSISTENCE_CONTRACT_METHODS } from '../src/persistence/persistence-contract.mjs';

export const PHASE2_DURABLE_INVARIANTS = Object.freeze([
  'D-001 explicit durable mode never silently downgrades to ephemeral',
  'D-002 migrations precede recovery and fail closed',
  'D-003 durable-domain SQL ownership remains repository-scoped',
  'D-004 persisted execution state is JSON-faithful or explicitly encoded',
  'D-005 credentials and live runtime handles are not durable state',
  'D-006 durable intent precedes external dispatch',
  'D-007 database state alone cannot disprove an external side effect',
  'D-008 Phase 2 does not claim exactly-once external execution',
  'D-009 only SAFE_TO_DISPATCH is generic automatic replay-safe truth',
  'D-010 ambiguous interrupted and ambiguous-result states never blind replay',
  'D-011 recovery classification is distinct from lifecycle status',
  'D-012 durable identities remain stable across reopen',
  'D-013 at most one durable result exists per run',
  'D-014 workflow peer PM and native recovery follow persisted lineage',
  'D-015 contradictory durable lineage fails closed',
  'D-016 a committed PM decision is never regenerated for the same turn',
  'D-017 committed PM action truth is reconciled before history advances',
  'D-018 PM driver provenance mismatch fails closed',
  'D-019 a persisted native session ID does not prove resumability',
  'D-020 native resume requires current compatible profile and PROVED capability',
  'D-021 RESUME_STARTED never automatically resumes again after restart',
  'D-022 fresh fallback is non-continuous and non-executing until separate dispatch',
  'D-023 restart is never a health success observation',
  'D-024 UNKNOWN health is never silently HEALTHY',
  'D-025 freshness cooldown and sticky-unavailable truth survive restart',
  'D-026 audit is append-only ordered sanitized minimized and observational-only',
  'D-027 sealed audit remains sealed after restart',
  'D-028 audit failure never changes routing or execution outcome',
  'D-029 recovery uses committed state from the same project database',
  'D-030 Gate 9 proves controlled windows not global exactly-once semantics',
  'D-031 Gate 9 side-effect evidence is independent of orchestration storage',
  'D-032 Phase 1 Gates 1 through 12 invariants remain valid',
  'D-033 roles remain policy rather than provider identity',
  'D-034 capability evidence remains separate from health evidence',
  'D-035 fresh Level-1 dispatch remains distinct from native continuation',
]);

const checks = [];
function check(name, fn) { fn(); checks.push(name); console.log(`PASS ${String(checks.length).padStart(2)}. ${name}`); }
function recovery(phase, { nativeReference = null, resumeExisting = 'UNPROVEN', runStatus = 'running', result = null } = {}) {
  return classifyDispatchAttempt({ attempt: { id: `a-${phase}`, runId: 'r', phase, nativeReference }, run: { id: 'r', status: runStatus }, result, capabilities: { resumeExisting } });
}

check('35 Phase 2 durable invariants are frozen and uniquely numbered', () => { assert.equal(PHASE2_DURABLE_INVARIANTS.length, 35); assert.equal(Object.isFrozen(PHASE2_DURABLE_INVARIANTS), true); assert.deepEqual(PHASE2_DURABLE_INVARIANTS.map((x) => x.slice(0, 5)), Array.from({ length: 35 }, (_, i) => `D-${String(i + 1).padStart(3, '0')}`)); });
check('current upgraded SQLite schema is exactly v6', () => assert.equal(SCHEMA_VERSION, 6));
check('Phase 2 migrations remain the exact 1 through 5 prefix', () => assert.deepEqual(migrationDefinitions().slice(0,5).map((x) => x.version), [1, 2, 3, 4, 5]));
check('migration checksums remain non-empty SHA-256 values', () => migrationDefinitions().forEach((x) => assert.match(x.checksum, /^[a-f0-9]{64}$/)));
check('migration definitions and persistence contract are frozen', () => { assert.equal(Object.isFrozen(migrationDefinitions()), true); assert.equal(Object.isFrozen(PERSISTENCE_CONTRACT_METHODS), true); });
check('INTENT_COMMITTED maps only to SAFE_TO_DISPATCH', () => { const x = recovery(ATTEMPT_PHASES.INTENT_COMMITTED); assert.equal(x.classification, RECOVERY_CLASSIFICATIONS.SAFE_TO_DISPATCH); assert.equal(x.autoReplayAllowed, true); });
check('DISPATCH_STARTED remains ambiguous and non-replayable', () => { const x = recovery(ATTEMPT_PHASES.DISPATCH_STARTED); assert.equal(x.classification, RECOVERY_CLASSIFICATIONS.AMBIGUOUS_EXTERNAL_ACCEPTANCE); assert.equal(x.autoReplayAllowed, false); });
check('REMOTE_STARTED exact proved native evidence requires reconciliation', () => { const x = recovery(ATTEMPT_PHASES.REMOTE_STARTED, { nativeReference: { nativeSessionId: 'n' }, resumeExisting: 'PROVED' }); assert.equal(x.classification, RECOVERY_CLASSIFICATIONS.NATIVE_RECONCILE_REQUIRED); assert.equal(x.autoReplayAllowed, false); });
check('REMOTE_STARTED without usable native recovery remains interrupted', () => assert.equal(recovery(ATTEMPT_PHASES.REMOTE_STARTED).classification, RECOVERY_CLASSIFICATIONS.INTERRUPTED_EXTERNAL_RUN));
check('terminal evidence without terminal attempt remains ambiguous-result', () => assert.equal(recovery(ATTEMPT_PHASES.DISPATCH_STARTED, { runStatus: 'completed', result: { id: 'z' } }).classification, RECOVERY_CLASSIFICATIONS.AMBIGUOUS_RESULT_COMMIT));
check('coherent TERMINAL_COMMITTED maps CLEAN without replay', () => { const x = recovery(ATTEMPT_PHASES.TERMINAL_COMMITTED, { runStatus: 'completed', result: { id: 'z' } }); assert.equal(x.classification, RECOVERY_CLASSIFICATIONS.CLEAN); assert.equal(x.autoReplayAllowed, false); });
check('Phase 1 invariant catalog remains 12 entries', () => assert.equal(ARCHITECTURE_INVARIANTS.length, 12));
check('Phase 1 audit remains observational-only', () => assert.match(ARCHITECTURE_INVARIANTS.find((x) => x.id === 'INV-010').statement, /must not change/i));
check('all four backends retain resume next-turn and stream proof', () => ['resume_existing', 'send_next_turn', 'stream_events'].forEach((capability) => assert.equal(backendsProving(capability).length, 4)));
check('interrupt and concurrency capability truth remains narrow', () => { assert.deepEqual(backendsProving('interrupt_active_turn'), ['grok', 'opencode']); assert.deepEqual(backendsProving('concurrent_client_safe'), ['opencode']); });
check('UI live refresh remains unproved everywhere', () => assert.deepEqual(backendsProving('ui_live_refresh'), []));
check('Codex interrupt remains ERROR', () => assert.equal(PROVEN_SESSION_CAPABILITY_MATRIX.codex.capabilities.interrupt_active_turn, 'ERROR'));
check('PM action reconciliation classifications remain explicit', () => { assert.equal(PM_RECOVERY.ACTION_RECONCILE_REQUIRED, 'ACTION_RECONCILE_REQUIRED'); assert.equal(PM_RECOVERY.ACTION_OUTCOME_RECOVERABLE, 'ACTION_OUTCOME_RECOVERABLE'); });
check('native protocol retains PENDING and RESUME_STARTED boundaries', () => assert.deepEqual(NATIVE_RECONCILIATION_STATUSES.slice(0, 2), ['PENDING', 'RESUME_STARTED']));

const sources = Object.fromEntries(await Promise.all([
  ['pm', '../src/pm/durable-pm-runtime.mjs'], ['native', '../src/session/native-session-reconciler.mjs'], ['nativeRepo', '../src/persistence/repositories/native-session-repository.mjs'], ['health', '../src/orchestration/durable-backend-health-registry.mjs'], ['audit', '../src/orchestration/retry-failover-executor.mjs'], ['gate9', './p2-gate9-e2e-kill-restart.mjs'], ['worker', './fixtures/p2-gate9-worker.mjs'], ['closeout', '../docs/PHASE2_DURABLE_STATE_CLOSEOUT.md'],
].map(async ([key, path]) => [key, await readFile(new URL(path, import.meta.url), 'utf8')])));

check('PM driver mismatch remains fail-closed', () => assert.match(sources.pm, /PM_DRIVER_MISMATCH/));
check('PM committed-turn processing precedes new decide path', () => assert.ok(sources.pm.indexOf('#processCommitted') < sources.pm.lastIndexOf('#driver.decide')));
check('native current profile and capability guards remain present', () => { assert.match(sources.native, /resume_existing !== 'PROVED'/); assert.match(sources.native, /nativeProfileFingerprint\(profile\)/); });
check('native Gate3 lineage cross-check remains present', () => { assert.match(sources.native, /record\.dispatchAttemptId !== attempt\?\.id/); assert.match(sources.native, /record\.runId !== attempt\?\.runId/); assert.match(sources.native, /record\.taskId !== attempt\.taskId/); });
check('native fallback remains non-continuous and unexecuted', () => { assert.match(sources.native, /truthfulContinuity: false/); assert.match(sources.native, /executed: false/); });
check('native terminal evidence requires positive usable resume', () => assert.match(sources.nativeRepo, /result\?\.usable !== true/));
check('health stale evidence materializes UNKNOWN without persistence write', () => { assert.match(sources.health, /now - observedMs < this\.#freshnessMs \? raw : this\.#unknown/); assert.doesNotMatch(sources.health.split('#materialize')[1].split('\n  get\(')[0], /commitObservation/); });
check('audit consumer isolates all trace failures', () => { assert.match(sources.audit, /try\s*\{/); assert.match(sources.audit, /catch\s*\{/); assert.match(sources.audit, /observational-only/); });
check('Gate 9 parent uses fork IPC force-kill and exit confirmation', () => { assert.match(sources.gate9, /fork\(/); assert.match(sources.gate9, /SIGKILL/); assert.match(sources.gate9, /CRASH_POINT/); assert.match(sources.gate9, /waitExit/); });
check('Gate 9 external ledger is fsynced outside orchestration DB', () => { assert.match(sources.worker, /fsyncSync/); assert.match(sources.worker, /ledgerPath/); assert.match(sources.gate9, /external\.jsonl/); });
check('Gate 9 recovery receives the same DB path in a fresh process', () => assert.match(sources.gate9, /spawn\('recover', scenario, db, ledger\)/));
const facadePaths = ['../src/pm/durable-pm-runtime.mjs', '../src/workflow/durable-workflow-state.mjs', '../src/peer/durable-peer-state.mjs', '../src/orchestration/durable-backend-health-registry.mjs', '../src/orchestration/durable-orchestration-audit-trace.mjs', '../src/session/native-session-reconciler.mjs'];
const facadeSources = await Promise.all(facadePaths.map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
check('durable facades contain no direct SQL statements', () => facadeSources.forEach((source, index) => assert.doesNotMatch(source, /\b(?:SELECT\s+\S+\s+FROM|INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM)\b/i, facadePaths[index])));
check('closeout document carries all 35 invariant IDs', () => PHASE2_DURABLE_INVARIANTS.forEach((x) => assert.match(sources.closeout, new RegExp(x.slice(0, 5)))));
check('closeout explicitly rejects exactly-once and production resume-facade overclaims', () => { assert.match(sources.closeout, /does not guarantee global exactly-once/i); assert.match(sources.closeout, /does not prove.*WorkflowRunner\.resume\(\).*PeerRelay\.resume\(\)/is); });

console.log(`P2 ARCHITECTURE CLOSEOUT: PASS (${checks.length}/${checks.length} checks)`);
