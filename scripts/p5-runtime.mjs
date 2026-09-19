import { dirname, join, resolve as resolvePath } from 'node:path';
import { loadP5ProductionConfig } from '../src/runtime/p5-production-config.mjs';
import { createP5ProductionComposition } from '../src/runtime/p5-production-composition.mjs';
import { startLocalRuntimeControl } from '../src/runtime/local-runtime-control.mjs';
import { installFatalExitCapture } from '../src/runtime/fatal-exit-log.mjs';
import { createResourcePressureGovernor } from '../src/runtime/resource-pressure-governor.mjs';
import { acquireRuntimeSingletonLease, buildRuntimeLockDomain } from '../src/runtime/runtime-singleton-lease.mjs';
import { PRODUCTION_REPORT_BACKEND_TIMEOUT_MS } from '../src/pm/report-execution-timeout-policy.mjs';

const role = process.argv[2];
const configPath = value('--config');
const controlPipe = value('--control-pipe');
const controlCapability = process.env.DSH_RUNTIME_CONTROL_AUTH;

// P13-R7.1: see the `finally` block below for the full root-cause
// rationale. Short on purpose -- long enough that a task genuinely on
// the verge of natural completion still gets to finish, short enough
// that it never by itself consumes the interactive caller's entire
// process-exit wait budget before an abort is even attempted.
const SHUTDOWN_DRAIN_GRACE_PERIOD_MS = 5000;

if (!['owner', 'coordinator', 'worker', 'all', 'readiness'].includes(role) || !configPath) {
  console.error('usage: node scripts/p5-runtime.mjs <owner|coordinator|worker|all|readiness> --config <path> [--control-pipe <pipe>]');
  process.exit(2);
}

// P13-R1.3: installed FIRST, before any async work (config load included),
// so a rejection/exception during startup is also captured -- two owner-
// live incidents (P13-R1-LIVE, P13-R1.2) both ended ROOT_CAUSE_NOT_PERSISTED
// with nothing durable ever recorded beyond a possibly-overwritten Desktop
// in-memory log. The fatal log path is derived synchronously from
// `--config` (never awaiting config load itself) -- the same sibling-of-
// config-directory convention `taskDiagnosticsRoot` below already uses for
// `logs/tasks`, so it is available even when config LOADING is what fails.
const fatal = installFatalExitCapture({ logPath: join(dirname(resolvePath(configPath)), 'fatal-runtime.jsonl') });

let composition;
let control;
let runtimeLease;
const abort = new AbortController();
let signals = 0;
const stop = () => {
  signals += 1;
  abort.abort();
  composition?.requestDrain();
  if (signals > 1) process.exitCode = 130;
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

try {
  const config = await loadP5ProductionConfig(configPath);
  // P15-B-001: singleton authority belongs to the runtime process, not to
  // Desktop (or any other launcher). The domain is the union of the
  // authoritative SQLite store, PostgreSQL coordination domain, and each
  // verified physical workspace. Only hashed identities are persisted.
  runtimeLease = await acquireRuntimeSingletonLease({
    domain: buildRuntimeLockDomain({
      sqlitePath: config.sqlitePath,
      postgresConnectionString: config.postgres.connectionString,
      projects: config.projects,
    }),
  });
  // P10-R0.1 Part H: automatic task-scoped diagnostic logging for the real
  // owner-facing runtime — the default convention is a `logs/tasks` folder
  // sibling to this env's own SQLite file (e.g. `.runtime/live1/state.sqlite`
  // -> `.runtime/live1/logs/tasks/<task_id>/`), which is already inside the
  // blanket-.gitignore'd `.runtime/` root. This is the ONLY place that
  // enables it — createP5ProductionComposition() stays opt-in (Part H/Q,
  // src/runtime/task-diagnostic-log.mjs) so the existing test suite gets no
  // new disk I/O it never asked for.
  const taskDiagnosticsRoot = join(dirname(config.sqlitePath), 'logs', 'tasks');
  // P10-R0.2 Part Q/AP: automatic deterministic repository-context
  // materialization for the real owner-facing runtime — see
  // docs/p10/06_REPOSITORY_CONTEXT_MATERIALIZATION.md. Opt-in at the
  // composition level; this script is the ONLY caller that turns it on, so
  // the existing test suite (which builds the composition directly) is
  // unaffected.
  // P13-R8: `config.concurrency` is the new, purely optional benchmark seam
  // (src/runtime/p5-production-config.mjs's parseConcurrency()) -- every
  // field defaults to the exact pre-R8 fallback behaviour
  // (createP5ProductionComposition's own `??2` / `??null` / `??null`) when
  // `concurrency:` is absent from the YAML config, so this line changes
  // nothing for any deployment (including `live1`) that has not opted in.
  const resourcePressureGovernor = config.concurrency?.resourceGovernor?.enabled
    ? createResourcePressureGovernor({
        highWatermark: config.concurrency.resourceGovernor.highWatermark,
        recoveryWatermark: config.concurrency.resourceGovernor.recoveryWatermark,
      })
    : null;
  // P20.8 §7/§16 — production artifact wiring activation. Explicit,
  // testable, fail-closed (§7 rule 5): absent/not exactly '1', every field
  // below stays at its pre-P20.8 default (`enableProductionArtifactWiring:
  // false`, `enableProductionArtifactStores: false`, `resolveNewTaskTransport
  // Version: undefined` -> OwnerTaskController's own default resolver,
  // which always returns 'legacy') — this process behaves byte-for-byte
  // identically to every pre-P20.8 deployment unless an operator sets
  // `DSH_P20_ARTIFACT_V1_ENABLED=1` in this process's own environment.
  // Never inferred from task/prompt content (§7 rule 1).
  const p20ArtifactV1Enabled = process.env.DSH_P20_ARTIFACT_V1_ENABLED === '1';
  // P24.3C: per-task worktree isolation activation. Explicit, testable,
  // fail-closed, mirroring the p20ArtifactV1Enabled convention above —
  // absent/not exactly '1', `enableTaskWorkspaceIsolation` stays false and
  // `taskWorkspaceRoot` stays undefined, so createP5ProductionComposition()
  // falls back to its existing (pre-P24.3C) OwnerTaskController wiring
  // byte-for-byte. `taskWorkspaceRoot` is derived from this env's own
  // `config.sqlitePath` (never hardcoded) so it always lands beside that
  // env's SQLite state, matching the sibling-of-config-directory convention
  // `taskDiagnosticsRoot` above already uses.
  const taskWorkspaceIsolationEnabled = process.env.DSH_P24_TASK_WORKSPACE_ISOLATION_ENABLED === '1';
  const taskWorkspaceRoot = taskWorkspaceIsolationEnabled
    ? join(dirname(config.sqlitePath), 'worktrees')
    : undefined;
  composition = await createP5ProductionComposition(config, {
    taskDiagnosticsRoot,
    enableRepoHistoryMaterialization: true,
    // P24.1G7A: history/progress files move out of the target repository's
    // own Git tree by default for this, the one real production
    // entrypoint — mirrors `enableRepoHistoryMaterialization` above (always
    // on here, off for every existing test/DI caller that does not pass it).
    enableProjectHistoryRuntimeStorage: true,
    pmConcurrencyLimit: config.concurrency?.globalLimit,
    backendConcurrencyLimits: config.concurrency?.backendLimits ?? null,
    resourcePressureGovernor,
    enableProductionArtifactStores: p20ArtifactV1Enabled,
    enableProductionArtifactWiring: p20ArtifactV1Enabled,
    reportBackendTimeoutMsByProduct: PRODUCTION_REPORT_BACKEND_TIMEOUT_MS,
    resolveNewTaskTransportVersion: p20ArtifactV1Enabled ? () => 'artifact_v1' : undefined,
    enableTaskWorkspaceIsolation: taskWorkspaceIsolationEnabled,
    taskWorkspaceRoot,
  });

  if (controlPipe && role !== 'readiness') {
    control = await startLocalRuntimeControl({
      pipeName: controlPipe,
      authCapability: controlCapability,
      readiness: () => composition.readiness(),
      runtimeTaskStatus: () => composition.runtimeTaskStatus(),
      onShutdown: stop,
      ownerCommand: (input) => composition.ownerService.mutate(input),
      ownerRead: (operation, params) => composition.ownerService.read(operation, params),
      reloadPmProfiles: () => composition.reloadPmProfiles(),
      resolveTaskFile: (args) => composition.resolveTaskFile(args),
      resolveRequiredContext: (args) => composition.resolveRequiredContext(args),
      enrolledOwnerActorId: composition.config.telegram?.ownerUserId ?? '1',
    });
  }

  if (role === 'readiness') {
    const report = composition.readiness();
    console.log(JSON.stringify(report));
    if (!report.ready) process.exitCode = 1;
  } else if (role === 'owner') {
    console.log(JSON.stringify({ event: 'p5.runtime.started', role }));
    await composition.ownerRuntime.run({ signal: abort.signal });
  } else if (role === 'coordinator') {
    const runtime = await composition.buildCoordinator();
    console.log(JSON.stringify({ event: 'p5.runtime.started', role }));
    await runtime.run();
  } else if (role === 'worker') {
    const runtime = await composition.buildWorker();
    console.log(JSON.stringify({ event: 'p5.runtime.started', role }));
    await runtime.run();
  } else {
    const coordinator = await composition.buildCoordinator();
    const worker = await composition.buildWorker();
    console.log(JSON.stringify({ event: 'p5.runtime.started', role }));
    await Promise.all([
      composition.ownerRuntime.run({ signal: abort.signal }),
      coordinator.run(),
      worker.run(),
    ]);
  }
} catch (error) {
  console.error(JSON.stringify({ event: 'p5.runtime.failed', role, code: error?.code ?? 'CONFIGURATION_ERROR' }));
  // P13-R1.3: this catch already covers rejection from ANY of
  // ownerRuntime.run()/coordinator.run()/worker.run() (all inside the same
  // try, whether awaited singly or as members of the top-level
  // Promise.all()) plus config-load/composition-startup failures -- it is
  // the ONE place that already sees every fatal exception this process
  // can produce outside a genuinely unhandled async rejection (which
  // `fatal`'s own uncaughtException/unhandledRejection listeners cover).
  // Persisting here is strictly additive to the existing console.error.
  fatal.recordFatal('STARTUP_OR_RUNTIME_LOOP', error, { role });
  process.exitCode = 1;
} finally {
  // P13-R1.3: a close() failure was previously swallowed with zero
  // evidence -- Part B explicitly requires this to be observable.
  // Each store's close is still attempted independently (unchanged) so
  // one failing close never prevents the other from being attempted.
  await control?.close().catch((error) => { fatal.recordFatal('SHUTDOWN_CONTROL_CLOSE', error, { role }); process.exitCode = 1; });
  // P13-R7.1 (docs/p13/15A_*.md): root cause of a real R7 live defect --
  // a normal Desktop Restart reported "Process exit timeout" even though
  // the runtime process really did exit soon after. composition.close()'s
  // own default drain grace period is `worker.leaseMs` (production
  // default 30000ms -- src/runtime/p5-production-config.mjs), which is
  // ALSO exactly Desktop's entire process-exit wait budget
  // (RuntimeSupervisor's SHUTDOWN_TIMEOUT_MS). That default was always
  // R1-provisional (docs/p13/05_*.md: "the worker.leaseMs grace period
  // remains an R1-style provisional value... deferred to R3" -- R3 never
  // revisited it) and was never actually SIZED against how long Desktop
  // is willing to wait for the real OS process to exit -- with an active
  // task at shutdown time, the grace phase ALONE (which fires no abort
  // signal at all) can legitimately consume the runtime's *entire*
  // shutdown budget before the abort+confirm phase, store teardown, and
  // pipe/process teardown even begin, structurally guaranteeing the
  // exit-wait timeout on the Desktop side whenever real work is active.
  //
  // This value is deliberately SHORT and used ONLY for this one
  // interactive-shutdown call site (an owner-initiated Stop/Restart via
  // the SHUTDOWN pipe command, or SIGINT/SIGTERM) -- it does NOT change
  // `worker.leaseMs` itself (claim-renewal cadence, unrelated), does not
  // touch `drainActive()`'s own default for any other caller/test, and
  // keeps the existing `timeoutMs` (DRAIN_ABORT_CEILING_MS, 600s) abort-
  // confirm safety net completely unchanged: a task that is already
  // essentially done still gets a few seconds to finish naturally: one
  // that is not gets its (already-consumed-in-milliseconds-by-every-real-
  // backend, per raceWithWatchdog()) abort signal fired promptly instead
  // of waiting up to 30 real seconds doing nothing first.
  await composition?.close({ drainGracePeriodMs: SHUTDOWN_DRAIN_GRACE_PERIOD_MS }).catch((error) => { fatal.recordFatal('SHUTDOWN_COMPOSITION_CLOSE', error, { role }); process.exitCode = 1; });
  await runtimeLease?.release().catch((error) => { fatal.recordFatal('SHUTDOWN_RUNTIME_LEASE_RELEASE', error, { role }); process.exitCode = 1; });
}

function value(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : null;
}
