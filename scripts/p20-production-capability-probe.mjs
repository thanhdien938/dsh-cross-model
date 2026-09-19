/**
 * P20.8 §8.2 — operator-only production capability probe CLI.
 *
 * Authority: docs/P20/P20_8_PRODUCTION_ARTIFACT_WIRING_CAPABILITY_PROBES_AND_E2E_MASTER_PROMPT.md §8.2, §9, §14, §20.
 *
 * NOT wired into any owner task/prompt path. An operator runs this
 * directly:
 *
 *   node scripts/p20-production-capability-probe.mjs --config <path> \
 *     --profile <profile_id> --project <project_id> [--record]
 *
 * §0 hard freeze: only the three explicitly authorized profile ids may be
 * probed. Any other profile id is refused before any live call.
 *
 * §8.2 / §13 safety, checked in order, before any live call:
 *   1. exact-roster freeze (above);
 *   2. no runtime/task work active or queued for this workspace right now
 *      (read-only coordination check — refuses to run while an unrelated
 *      owner task could be executing);
 *   3. the canonical production ArtifactStore + the REAL production report
 *      backend adapter for this exact profile are used — never a scratch
 *      store, never a substitute backend/model.
 *
 * `--record` persists PROVEN evidence to the durable
 * CapabilityEvidenceRegistry ONLY after `runProductionCapabilityProbe()`
 * returns `ok:true` — a failed/ambiguous probe never writes anything.
 * Without `--record` this is a dry run: the probe still makes the ONE live
 * call and seals a real report in the canonical store, but leaves the
 * capability registry untouched (useful to inspect evidence before
 * committing to PROVEN).
 */

import { dirname, join } from 'node:path';
import { loadP5ProductionConfig } from '../src/runtime/p5-production-config.mjs';
import { PmProfileRegistry } from '../src/pm/pm-profile-registry.mjs';
import { PostgresCoordinationStore } from '../src/coordination/postgres/postgres-coordination-store.mjs';
import { createArtifactStore } from '../src/artifacts/artifact-store.mjs';
import { CapabilityEvidenceRegistry } from '../src/artifacts/capability-evidence-registry.mjs';
import { createCliReportBackendResolver, resolveExecutableIdentity, PRODUCTION_ROUTE_BY_PRODUCT } from '../src/runtime/p20-report-route-resolution.mjs';
import { runProductionCapabilityProbe } from '../src/runtime/p20-production-capability-probe.mjs';

// §0 — EXACT PROVIDER ROSTER, hard freeze. Never substituted, never
// extended by this script without a new authorized dispatch.
//
// P20.8R6 §C — added the exact three alternate-profile ids authorized for
// the later owner Debate E2E (docs/P20/
// P20_8R6_DEBATE_DIRECT_WRITE_ALT_PROFILE_READINESS_MASTER_PROMPT.md):
// Claude profile 24 (sonnet/low), OpenCode profile 23 (DeepSeek v4 Flash),
// Antigravity profile 7 (Gemini 3.7 Flash High). The original P20.8/R2
// Phase-1 roster stays authorized too — this ADDS to the freeze, it never
// revokes or reuses evidence across the two rosters (each profile id's
// capability evidence remains its own exact tuple).
const AUTHORIZED_PROFILE_IDS = new Set([
  'live1-claude-sonnet-medium',
  'live1-opencode-opencode-go-glm-5-3-flash',
  'live1-antigravity-gemini-3-8-flash-high',
  'live1-claude-sonnet-low',
  'live1-opencode-opencode-go-deepseek-v4-flash',
  'live1-antigravity-gemini-high',
]);

function flag(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

async function main() {
  const configPath = flag('config');
  const profileId = flag('profile');
  const projectId = flag('project');
  const record = has('record');
  if (!configPath || !profileId) {
    console.error('usage: node scripts/p20-production-capability-probe.mjs --config <path> --profile <profile_id> [--project <project_id>] [--record]');
    process.exitCode = 2;
    return;
  }
  if (!AUTHORIZED_PROFILE_IDS.has(profileId)) {
    console.error(JSON.stringify({ event: 'p20_8.probe.refused', code: 'PROFILE_NOT_AUTHORIZED', profileId, authorized: [...AUTHORIZED_PROFILE_IDS] }));
    process.exitCode = 1;
    return;
  }

  const config = await loadP5ProductionConfig(configPath);
  const project = projectId ? config.projects.find((p) => p.id === projectId) : config.projects[0];
  if (!project) {
    console.error(JSON.stringify({ event: 'p20_8.probe.refused', code: 'PROJECT_NOT_FOUND', projectId }));
    process.exitCode = 1;
    return;
  }
  const profileRegistry = new PmProfileRegistry(config.profiles);
  let profile;
  try { profile = profileRegistry.get(profileId); } catch (error) {
    console.error(JSON.stringify({ event: 'p20_8.probe.refused', code: 'PROFILE_NOT_CONFIGURED', profileId, message: error.message }));
    process.exitCode = 1;
    return;
  }
  if (!PRODUCTION_ROUTE_BY_PRODUCT[profile.product]) {
    console.error(JSON.stringify({ event: 'p20_8.probe.refused', code: 'PRODUCT_NOT_SUPPORTED', product: profile.product }));
    process.exitCode = 1;
    return;
  }

  // §8.2 — cannot promote a capability while an unrelated owner task is
  // running in the same workspace: a read-only coordination-queue check,
  // the SAME primitives the PRE-R3/PRE-R4 orphan-reconciliation sessions
  // already used to prove workspace safety before any live/mutating step.
  const coordination = await new PostgresCoordinationStore().open(config.postgres);
  try {
    await coordination.assertReady();
    const [dispatchCandidates, pmActionCandidates, activePmAction] = await Promise.all([
      coordination.listTaskDispatchCandidates({ limit: 5 }),
      coordination.listPmActionCandidates({ limit: 5 }),
      coordination.listActivePmActionWork({ limit: 5 }),
    ]);
    const activeCount = (dispatchCandidates?.length ?? 0) + (pmActionCandidates?.length ?? 0) + (activePmAction?.length ?? 0);
    if (activeCount > 0) {
      console.error(JSON.stringify({ event: 'p20_8.probe.refused', code: 'WORKSPACE_NOT_IDLE', activeCount }));
      process.exitCode = 1;
      return;
    }
  } finally {
    await coordination.close();
  }

  const runtimeBase = dirname(config.sqlitePath);
  const store = createArtifactStore({ storeId: 'store-p20-production-v1', projectId: project.id, runtimeBase });
  const resolveReportBackend = createCliReportBackendResolver({ profileRegistry, project });
  const reportBackend = resolveReportBackend(profileId);
  const route = PRODUCTION_ROUTE_BY_PRODUCT[profile.product];
  const executableIdentity = resolveExecutableIdentity(profile.product);

  console.log(JSON.stringify({
    event: 'p20_8.probe.starting', profileId, product: profile.product, model: profile.model ?? null,
    reasoning: profile.reasoning ?? null, projectId: project.id, storeRoot: store.root,
    deliveryMechanism: route.deliveryMechanism, inputTransport: route.inputTransport,
    executablePath: executableIdentity.path, executableVersion: executableIdentity.version,
  }));

  const result = await runProductionCapabilityProbe({
    store, profile, reportBackend,
    deliveryMechanism: route.deliveryMechanism, inputTransport: route.inputTransport,
    executableIdentity, sourceAccessMode: 'READ_ONLY',
  });

  if (!result.ok) {
    console.error(JSON.stringify({ event: 'p20_8.probe.failed', profileId, taskId: result.taskId, failureCode: result.failureCode }));
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify({ event: 'p20_8.probe.passed', profileId, taskId: result.taskId, evidence: result.evidence }));

  if (record) {
    const registry = new CapabilityEvidenceRegistry({ filePath: join(runtimeBase, 'p20-capability-evidence.json') });
    const evidenceId = `p20-8-${result.taskId}`;
    const written = [registry.recordProven({ tuple: result.tuple, evidenceId, evidence: result.evidence })];
    if (result.inputTuple) written.push(registry.recordProven({ tuple: result.inputTuple, evidenceId, evidence: result.evidence }));
    console.log(JSON.stringify({ event: 'p20_8.probe.recorded', profileId, filePath: registry.filePath, keys: written.map((w) => w.key) }));
  } else {
    console.log(JSON.stringify({ event: 'p20_8.probe.dry_run', profileId, note: 'pass --record to persist PROVEN evidence' }));
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ event: 'p20_8.probe.crashed', code: error?.code ?? 'UNCAUGHT', message: error?.message ?? String(error) }));
  process.exitCode = 1;
});
