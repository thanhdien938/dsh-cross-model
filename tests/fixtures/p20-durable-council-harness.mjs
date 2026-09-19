/**
 * P20.4R2 — shared offline harness for the REAL durable artifact-Council
 * machine (DurablePmRuntime + CouncilChairDriver + CouncilStepWorkflowRunner +
 * DurableWorkflowState/WorkflowRepository + PmRepository SQLite + a real P20
 * artifact store). Not a *.test.mjs file, so it is never discovered as a test.
 *
 * Used by the A–J crash matrix (R10) and the focused R9/R11/R12 durable
 * tamper tests. No live model/API calls.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { CouncilChairDriver } from '../../src/pm/council/council-chair-driver.mjs';
import { CouncilStepWorkflowRunner } from '../../src/pm/council/council-step-workflow-runner.mjs';
import { DurablePmRuntime } from '../../src/pm/durable-pm-runtime.mjs';
import { PmRepository } from '../../src/persistence/repositories/pm-repository.mjs';
import { WorkflowRepository } from '../../src/persistence/repositories/workflow-repository.mjs';
import { DurableWorkflowState } from '../../src/workflow/durable-workflow-state.mjs';
import { SqlitePersistenceStore } from '../../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { createArtifactStore } from '../../src/artifacts/artifact-store.mjs';
import { buildActorAliasRegistry } from '../../src/artifacts/artifact-paths.mjs';
import { fakeReportBackend } from './p20-report-helpers.mjs';

export const PROJECT = Object.freeze({ id: 'proj-cm', repo_path: process.cwd() });
export const CREATED_AT = '2026-09-10T12:00:00Z';

/**
 * @param {Array} calls              push {profileId, stage, round}
 * @param {object} [opts]
 * @param {boolean} [opts.debateTypedControl]  mark backends Debate-typed-control-capable
 * @param {(ctx:{stage,round,profileId})=>boolean} [opts.continueDebate]  the typed
 *        control value a `debate-chair-synthesis` execution surfaces (default: false)
 */
export function backendResolver(calls, opts = {}) {
  const supports = opts.debateTypedControl === true;
  const cont = typeof opts.continueDebate === 'function' ? opts.continueDebate : () => false;
  const onPrompt = typeof opts.onPrompt === 'function' ? opts.onPrompt : null;
  const responseFails = typeof opts.responseFails === 'function' ? opts.responseFails : () => false;
  const proseExtra = opts.proseSaysContinue ? '\ncontinue_debate: true — the debate MUST continue\n'
    : opts.proseSaysStop ? '\nSTOP: do not continue the debate under any circumstances\n' : '';
  const productOf = typeof opts.backendProduct === 'function' ? opts.backendProduct
    : (opts.backendProduct && typeof opts.backendProduct === 'object' ? ((id) => opts.backendProduct[id] ?? 'fake') : (() => 'fake'));
  // P20.5R R5 — first debate-chair-synthesis delivery is EMPTY (forces a
  // bounded delivery repair); the repair re-invocation (prompt marked
  // __ARTIFACT_DELIVERY_REPAIR__) returns a valid body on a new execution.
  const forceSynthRepair = opts.forceSynthesisRepair === true;
  const r = (profileId) => ({
    backend: productOf(profileId),
    supportsDebateTypedControl: supports,
    async runReport(args) {
      const stage = args?.request?.stage ?? null;
      const round = args?.request?.round ?? null;
      const isRepair = typeof args?.prompt === 'string' && args.prompt.includes('__ARTIFACT_DELIVERY_REPAIR__');
      calls.push({ profileId, stage, round, prompt: args?.prompt ?? null, repair: isRepair });
      if (onPrompt) onPrompt({ profileId, stage, round, prompt: args?.prompt ?? null, repair: isRepair });
      if (stage === 'debate-member-response' && responseFails({ profileId, round })) {
        return fakeReportBackend({ terminalState: 'PROVIDER_ERROR', finishReason: 'error' }).runReport(args);
      }
      const tc = supports && stage === 'debate-chair-synthesis' ? Boolean(cont({ stage, round, profileId })) : null;
      if (forceSynthRepair && stage === 'debate-chair-synthesis' && !isRepair) {
        // an empty body (whitespace only) -> REPORT_EMPTY integrity failure ->
        // bounded delivery repair. The FIRST execution still surfaces a valid
        // typed control (so capture succeeds and R5's repair-binding check is
        // what fails closed, not a "no control captured" failure).
        return fakeReportBackend({ text: '   ', debateTypedControl: tc, supportsDebateTypedControl: supports }).runReport(args);
      }
      let text = `# ${stage}${round ? ` r${round}` : ''} by ${profileId}${isRepair ? ' (repair)' : ''}\n\nbody ${profileId} round ${round}\n${proseExtra}`;
      if (typeof opts.synthesisText === 'string' && stage === 'debate-chair-synthesis' && round === 1 && !forceSynthRepair) text = opts.synthesisText;
      return fakeReportBackend({ text, debateTypedControl: tc, supportsDebateTypedControl: supports }).runReport(args);
    },
  });
  r.calls = calls;
  return r;
}

const fakeProfileRegistry = (ids) => ({ get(id) { if (!ids.includes(id)) throw Object.assign(new Error('unknown'), { code: 'PM_PROFILE_NOT_REGISTERED' }); return { id, product: 'fake' }; } });
const fakeResolveDriver = () => () => ({ name: 'x', async decide() { throw new Error('artifact council steps never call decide()'); } });

export async function withStores(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'p20-4r2-cm-'));
  const store = new SqlitePersistenceStore();
  await store.open({ path: join(dir, 'state.db') });
  await store.migrate();
  const artifactRoot = join(dir, 'artifacts');
  try {
    await fn({
      sqlite: store,
      newArtifactStore: () => createArtifactStore({ storeId: 's-cm', projectId: PROJECT.id, root: artifactRoot }),
      newPmRepo: () => new PmRepository({ store }),
      newStepState: () => new DurableWorkflowState({ repository: new WorkflowRepository({ store }) }),
    });
  } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
}

/**
 * P22.5 — a bare `CouncilChairDriver`, no `DurablePmRuntime`/workflow-runner
 * wrapper, for admission tests that only need `driver.decide({turn, history})`
 * directly (proving a rejection happens before any provider call, with
 * `calls.length === 0`) — mirrors tests/p20-8r8-debate-admission-actual-route.test.mjs's
 * own `buildDriver()`.
 */
export function buildDriver({ council, artifactStore, taskId, calls, debate = null, capabilityPolicy = undefined, resolveWorkspaceCapability = null, resolveReportBackend = undefined }) {
  const aliasRegistry = buildActorAliasRegistry([council.chair_profile_id, ...council.participant_profile_ids]);
  const artifactCouncil = {
    store: artifactStore, taskId, taskSlug: 'admission probe', createdAt: CREATED_AT,
    // P22.5 — an explicit `resolveReportBackend` override (e.g. a resolver
    // that sets real per-product deliveryMechanism/directWriter, for a
    // DIRECT_WRITE-route product) takes priority; every pre-P22.5 caller
    // omits it and gets the exact prior `backendResolver(calls, ...)`
    // (VERBATIM_MATERIALIZATION-only 'fake' semantics), unchanged.
    resolveReportBackend: resolveReportBackend ?? backendResolver(calls, debate ?? {}), aliasRegistry, consumerInputTransport: 'VERBATIM_CONTENT',
    capabilityPolicy,
  };
  const driverArgs = { council, ownerTask: 'admission probe.', transportMode: 'artifact_v1', artifactCouncil };
  if (typeof resolveWorkspaceCapability === 'function') driverArgs.resolveWorkspaceCapability = resolveWorkspaceCapability;
  return new CouncilChairDriver(driverArgs);
}

export function buildRuntime({ council, artifactStore, stepState, pmRepository, calls, taskId, afterDeliverHook = null, beforeFinalProjection = null, beforeSynthesisControlPersistHook = null, maxTurns = 24, debate = null, resolveWorkspaceCapability = null, consumerInputTransport = 'VERBATIM_CONTENT', capabilityPolicy = undefined, resolveReportBackend = undefined, workspaceEvidence = null }) {
  const aliasRegistry = buildActorAliasRegistry([council.chair_profile_id, ...council.participant_profile_ids]);
  const artifactCouncil = {
    store: artifactStore, taskId, taskSlug: 'crash matrix', createdAt: CREATED_AT,
    // P22.5 — see buildDriver()'s identical comment above.
    resolveReportBackend: resolveReportBackend ?? backendResolver(calls, debate ?? {}), aliasRegistry, consumerInputTransport,
    // P22.5 — optional real production capability policy (see
    // production-backend-capabilities.mjs's buildProductionCapabilityPolicy())
    // for tests exercising real product names (opencode/codex/grok/
    // antigravity/claude-code/api) rather than the default 'fake' product,
    // which is already fully PROVEN in DEFAULT_BACKEND_REPORT_POLICY.
    // `undefined` (every pre-P22.5 caller) is byte-for-byte unchanged —
    // assertReportRoute() itself defaults to DEFAULT_BACKEND_REPORT_POLICY.
    capabilityPolicy,
    // P24.3C-R1 — optional durable per-invocation task-workspace evidence
    // passthrough (`null` for every pre-existing caller, byte-for-byte
    // unchanged) — see report-invocation.mjs's own use of `request.workspaceEvidence`.
    workspaceEvidence,
    __afterDeliverHook: afterDeliverHook,
    __beforeFinalProjection: beforeFinalProjection,
    __beforeSynthesisControlPersistHook: beforeSynthesisControlPersistHook,
  };
  const workflowRunner = new CouncilStepWorkflowRunner({
    resolveDriver: fakeResolveDriver(), profileRegistry: fakeProfileRegistry([council.chair_profile_id, ...council.participant_profile_ids]),
    project: PROJECT, stepState, artifactCouncil,
  });
  const peerRelay = { async exchange() { throw new Error('unused'); }, createConversation() {}, getConversation() { return null; }, result() { return null; } };
  const driverArgs = { council, ownerTask: 'crash-matrix council', transportMode: 'artifact_v1', artifactCouncil };
  if (typeof resolveWorkspaceCapability === 'function') driverArgs.resolveWorkspaceCapability = resolveWorkspaceCapability;
  const driver = new CouncilChairDriver(driverArgs);
  return new DurablePmRuntime({ driver, workflowRunner, peerRelay, repository: pmRepository, maxTurns, historyLimit: 24 });
}

// ---------- helpers to reshape the durable PM/workflow rows ----------

/** All artifact council turns for a run, ordered, with their workflow row. */
export function artifactTurns(sqlite, pmRunId) {
  return sqlite.all(
    "SELECT t.turn_index, t.action_id, t.decision, w.status AS wf_status FROM pm_turns t LEFT JOIN workflows w ON w.id=t.action_id WHERE t.pm_run_id=? ORDER BY t.turn_index",
    [pmRunId],
  );
}
export function resetTurnToActionStarted(sqlite, pmRunId, turnIndex) {
  sqlite.run("UPDATE pm_turns SET phase='ACTION_STARTED', outcome=NULL, completed_at=NULL WHERE pm_run_id=? AND turn_index=?", [pmRunId, turnIndex]);
}
export function deleteTurnsFrom(sqlite, pmRunId, fromIndexInclusive) {
  sqlite.run('DELETE FROM pm_turns WHERE pm_run_id=? AND turn_index>=?', [pmRunId, fromIndexInclusive]);
}
export function reopenRun(sqlite, pmRunId) {
  const n = sqlite.get('SELECT COUNT(*) n FROM pm_turns WHERE pm_run_id=?', [pmRunId]).n;
  sqlite.run("UPDATE pm_runs SET status='running', completed_at=NULL, output='', data=NULL, error=NULL, turn_count=? WHERE id=?", [n, pmRunId]);
}
export function setWorkflowRunning(sqlite, wfId) {
  sqlite.run("UPDATE workflows SET status='running', completed_at=NULL WHERE id=?", [wfId]);
  sqlite.run("UPDATE workflow_steps SET status='running', dispatched_context=NULL WHERE workflow_id=?", [wfId]);
}
/** Read a workflow step's persisted dispatched_context (parsed) or null. */
export function stepDispatchedContext(sqlite, wfId) {
  const row = sqlite.get('SELECT dispatched_context FROM workflow_steps WHERE workflow_id=?', [wfId]);
  if (!row || row.dispatched_context == null) return null;
  try { return JSON.parse(row.dispatched_context); } catch { return null; }
}
/** Overwrite a workflow step's dispatched_context with `obj` (JSON-serialised). */
export function writeStepDispatchedContext(sqlite, wfId, obj) {
  sqlite.run('UPDATE workflow_steps SET dispatched_context=? WHERE workflow_id=?', [JSON.stringify(obj), wfId]);
}
/** Read a completed PM turn's persisted `outcome` (parsed) — the DurablePmRuntime history projection. */
export function pmTurnOutcome(sqlite, pmRunId, turnIndex) {
  const row = sqlite.get('SELECT outcome FROM pm_turns WHERE pm_run_id=? AND turn_index=?', [pmRunId, turnIndex]);
  if (!row || row.outcome == null) return null;
  try { return JSON.parse(row.outcome); } catch { return null; }
}
/** Overwrite a completed PM turn's persisted `outcome` (tamper the durable history itself). */
export function writePmTurnOutcome(sqlite, pmRunId, turnIndex, obj) {
  sqlite.run('UPDATE pm_turns SET outcome=? WHERE pm_run_id=? AND turn_index=?', [JSON.stringify(obj), pmRunId, turnIndex]);
}
export const stageKindOf = (decisionJson) => { try { const d = JSON.parse(decisionJson); return d?.spec?.stepKind ?? d?.type ?? null; } catch { return null; } };

/**
 * Reconstruct `{ councilGateArgs, roster, rounds }` for a direct
 * verifyDebateArtifactTopology() call from a COMPLETED durable Debate run's
 * pm_turns.outcome handoffs. Test-only helper for the R2/R3 adversarial tests.
 */
export async function debateGateInputsFromRun(sqlite, pmRunId, { store, council, aliasRegistry, maxReportBytes }) {
  const { councilStageKeyPlan } = await import('../../src/pm/council/council-artifact-stage-keys.mjs');
  const rows = sqlite.all('SELECT turn_index, outcome FROM pm_turns WHERE pm_run_id=? ORDER BY turn_index', [pmRunId]);
  let chairPlan = null; let synthesis = null;
  const reports = new Map(); const critiques = new Map();
  const rounds = new Map();
  for (const row of rows) {
    let h; try { h = JSON.parse(row.outcome)?.finalResult?.handoff; } catch { h = null; }
    if (!h || h.transport_version !== 'artifact_v1') continue;
    const k = h.step_kind;
    if (k === 'chair_plan') chairPlan = h;
    else if (k === 'participant_report') reports.set(h.profile_id, h);
    else if (k === 'participant_critique') critiques.set(h.profile_id, h);
    else if (k === 'chair_synthesis') synthesis = h;
    else if (k === 'debate_brief' || k === 'debate_response' || k === 'debate_synthesis') {
      if (!rounds.has(h.round)) rounds.set(h.round, { round: h.round, brief: null, responses: new Map(), synthesis: null });
      const rr = rounds.get(h.round);
      if (k === 'debate_brief') rr.brief = h;
      else if (k === 'debate_response') rr.responses.set(h.profile_id, h);
      else rr.synthesis = h;
    }
  }
  const participants = [...council.participant_profile_ids];
  const stageKeyPlan = councilStageKeyPlan({ rounds: council.rounds, participantAliases: participants.map((id) => aliasRegistry.get(id)) });
  const roster = participants.filter((id) => reports.get(id)?.ok);
  const councilGateArgs = {
    store, chairPlanOutcome: chairPlan,
    reportOutcomes: reports, critiqueOutcomes: critiques, synthesisOutcome: synthesis,
    council, stageKeyPlan, participants, maxReportBytes, aliasRegistry,
  };
  const builtRounds = [...rounds.keys()].sort((a, b) => a - b).map((rn) => rounds.get(rn));
  return { councilGateArgs, roster, rounds: builtRounds };
}

/** Convenience: run one artifact council/debate to a terminal DurablePmRuntime result. */
export async function runArtifactCouncilDurable({ council, newArtifactStore, newPmRepo, newStepState, taskId, pmRunId, debate = null, calls = [], maxTurns = 32 }) {
  const rt = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls, taskId, maxTurns, debate });
  const res = await rt.run({ objective: 'x', pmRunId, context: { council, transport_version: 'artifact_v1' } });
  return { res, calls };
}
