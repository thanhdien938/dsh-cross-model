import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const rootPostgresDiagnostic = Object.freeze([
  'tests/multi-process-workers.test.mjs',
]);

const rootPostgres = Object.freeze([
  'tests/fenced-p2-dispatch-integration.test.mjs',
  'tests/p13-r2-cancel-unclaimed-postgres.test.mjs',
  'tests/p13-r3-workspace-reconciliation-postgres.test.mjs',
  'tests/p15-rem-r1-occupancy-postgres.test.mjs',
  'tests/p15-rem-r5-postgres-bootstrap.test.mjs',
  'tests/p15-rem-r6-fresh-install-recovery.test.mjs',
  'tests/p6-p0-prototypes.test.mjs',
  'tests/phase3-final-postgres.test.mjs',
  'tests/phase5-owner-postgres.test.mjs',
  'tests/phase5-r2-postgres.test.mjs',
  'tests/phase5-r3-claim-renewal-postgres.test.mjs',
  'tests/postgres-claim-lease-fencing.test.mjs',
  'tests/postgres-coordination-store.test.mjs',
  'tests/reconciler-cancellation-postgres.test.mjs',
]);

const desktopPostgres = Object.freeze([
  'desktop/tests/p14-r22-readProjection-pool-error-handler.test.ts',
]);

const rootWindowsProcess = Object.freeze([
  'tests/p10-r022-codex-sandbox-bridge.test.mjs',
  'tests/p12-r5b-owner-live-remediation.test.mjs',
  'tests/p13-r61-normal-shutdown-process.test.mjs',
  'tests/p13-r73-provider-process-ownership.test.mjs',
  'tests/phase4-runtime.test.mjs',
]);

const rootHostTimingDiagnostics = Object.freeze([
  'tests/event-loop-responsiveness.test.mjs',
]);

// These audited files contain assertions against CLIs installed on the owner's
// workstation. They are bounded diagnostics, not secret-free clean-runner gates.
const rootInstalledCliDiagnostics = Object.freeze([
  'tests/claude-code-session-bridge.test.mjs',
  'tests/opencode-cli-session-bridge.test.mjs',
  'tests/production-codex-grok-backends.test.mjs',
]);

const desktopWindowsProcess = Object.freeze([
  'desktop/tests/p13-r71-restart-exit-race.test.ts',
  'desktop/tests/relayRunnerLifecycleManagerWindows.test.ts',
  'desktop/tests/runtimeRestartLifecycle.test.ts',
]);

const desktopCrossTree = Object.freeze([
  'desktop/tests/p13-r72-long-submission-integration.test.ts',
]);

export const futureCriticalCoverage = Object.freeze({
  // P15-C-001: covered as of P15-REM-R2 —
  // tests/p15-rem-r2-terminalization-council-recovery.test.mjs (root-portable-sqlite).
  'P15-D-014': 'P15-REM-R3',
  'P15-G-005/projection-errors': 'P15-REM-R3',
  'P15-F-002/P15-F-005': 'P15-REM-R4',
  'P15-F-001': 'P15-REM-R4',
});

function filesIn(directory, pattern) {
  return readdirSync(resolve(directory), { withFileTypes: true })
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => `${directory}/${entry.name}`)
    .sort();
}

function isSqliteTest(file) {
  return /better-sqlite3|\bsqlite\b|SqlitePersistenceStore/i.test(readFileSync(resolve(file), 'utf8'));
}

export function discoverShards() {
  const allRoot = filesIn('tests', /\.test\.mjs$/);
  const allDesktop = filesIn('desktop/tests', /\.test\.(?:ts|tsx|js|jsx|mts)$/);
  const pgRoot = new Set(rootPostgres);
  const pgDiagnostic = new Set(rootPostgresDiagnostic);
  const pgDesktop = new Set(desktopPostgres);
  const requiredWindowsRoot = new Set(rootWindowsProcess);
  const installedCliDiagnostics = new Set(rootInstalledCliDiagnostics);
  const hostTimingDiagnostics = new Set(rootHostTimingDiagnostics);
  const portableRoot = allRoot.filter((file) =>
    !pgRoot.has(file) &&
    !pgDiagnostic.has(file) &&
    !requiredWindowsRoot.has(file) &&
    !installedCliDiagnostics.has(file) &&
    !hostTimingDiagnostics.has(file));
  const portableSqlite = portableRoot.filter(isSqliteTest);
  const portableSqliteSet = new Set(portableSqlite);
  const portablePure = portableRoot.filter((file) => !portableSqliteSet.has(file));
  const windowsDesktop = new Set(desktopWindowsProcess);
  const crossTreeDesktop = new Set(desktopCrossTree);

  return Object.freeze({
    'root-portable-pure': Object.freeze({ kind: 'node', files: portablePure, timeoutMs: 120_000, concurrency: 3 }),
    'root-portable-sqlite': Object.freeze({ kind: 'node', files: portableSqlite, timeoutMs: 120_000, concurrency: 3 }),
    'root-windows-process': Object.freeze({ kind: 'node', files: [...rootWindowsProcess], timeoutMs: 180_000, concurrency: 1 }),
    'root-installed-cli-diagnostic': Object.freeze({ kind: 'node', files: [...rootInstalledCliDiagnostics], timeoutMs: 60_000, concurrency: 1, required: false }),
    'root-host-timing-diagnostic': Object.freeze({ kind: 'node', files: [...rootHostTimingDiagnostics], timeoutMs: 60_000, concurrency: 1, required: false }),
    'root-postgres': Object.freeze({ kind: 'node', files: [...rootPostgres], timeoutMs: 240_000, concurrency: 1, forbidSkips: true, restorePostgres: true }),
    'root-postgres-diagnostic': Object.freeze({ kind: 'node', files: [...rootPostgresDiagnostic], timeoutMs: 240_000, concurrency: 1, forbidSkips: true, restorePostgres: true, required: false }),
    'desktop-node': Object.freeze({ kind: 'vitest', files: allDesktop.filter((file) => !pgDesktop.has(file) && !windowsDesktop.has(file) && !crossTreeDesktop.has(file)), timeoutMs: 120_000, concurrency: 1 }),
    'desktop-windows-process': Object.freeze({ kind: 'vitest', files: [...desktopWindowsProcess], timeoutMs: 120_000, concurrency: 1 }),
    'desktop-cross-tree': Object.freeze({ kind: 'vitest', files: [...desktopCrossTree], timeoutMs: 120_000, concurrency: 1 }),
    'desktop-postgres': Object.freeze({ kind: 'vitest', files: [...desktopPostgres], timeoutMs: 180_000, concurrency: 1, forbidSkips: true }),
  });
}

export function validateShards(shards = discoverShards()) {
  const errors = [];
  const allEntries = Object.entries(shards);
  for (const [name, shard] of allEntries) {
    if (shard.files.length === 0) errors.push(`${name}: no files discovered`);
    for (const file of shard.files) if (!existsSync(resolve(file))) errors.push(`${name}: missing ${file}`);
    if (!Number.isInteger(shard.timeoutMs) || shard.timeoutMs <= 0) errors.push(`${name}: invalid timeout`);
  }
  const portable = [...shards['root-portable-pure'].files, ...shards['root-portable-sqlite'].files];
  if (new Set(portable).size !== portable.length) errors.push('portable root shards overlap');
  const allRoot = filesIn('tests', /\.test\.mjs$/);
  const coveredRoot = new Set([
    ...portable,
    ...shards['root-windows-process'].files,
    ...shards['root-installed-cli-diagnostic'].files,
    ...shards['root-host-timing-diagnostic'].files,
    ...shards['root-postgres'].files,
    ...shards['root-postgres-diagnostic'].files,
  ]);
  if (coveredRoot.size !== allRoot.length || allRoot.some((file) => !coveredRoot.has(file))) {
    errors.push(`root partition mismatch: discovered=${allRoot.length} covered=${coveredRoot.size}`);
  }
  const allDesktop = filesIn('desktop/tests', /\.test\.(?:ts|tsx|js|jsx|mts)$/);
  const coveredDesktop = new Set([
    ...shards['desktop-node'].files,
    ...shards['desktop-windows-process'].files,
    ...shards['desktop-cross-tree'].files,
    ...shards['desktop-postgres'].files,
  ]);
  if (coveredDesktop.size !== allDesktop.length || allDesktop.some((file) => !coveredDesktop.has(file))) {
    errors.push(`desktop partition mismatch: discovered=${allDesktop.length} covered=${coveredDesktop.size}`);
  }
  if (rootPostgres.length + rootPostgresDiagnostic.length !== 15 || desktopPostgres.length !== 1) errors.push('expected 15 root + 1 Desktop PostgreSQL-gated files');
  return errors;
}
