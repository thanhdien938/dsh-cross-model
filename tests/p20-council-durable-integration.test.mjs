/**
 * P20.4R R1/R2/R3/R5/§10/§20 — the artifact_v1 Council runs through ONE
 * DurablePmRuntime PmRun over the REAL CouncilChairDriver +
 * CouncilStepWorkflowRunner + DurableWorkflowState + PmRepository (SQLite).
 * Durable restart tests: crash points A–J; no duplicate provider call; same
 * sealed ref reused; same participant order; final_ref stable. Offline.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { normalizeCouncilSpec } from '../src/pm/council/council-contracts.mjs';
import { CouncilChairDriver } from '../src/pm/council/council-chair-driver.mjs';
import { CouncilStepWorkflowRunner } from '../src/pm/council/council-step-workflow-runner.mjs';
import { DurablePmRuntime } from '../src/pm/durable-pm-runtime.mjs';
import { PmRepository } from '../src/persistence/repositories/pm-repository.mjs';
import { WorkflowRepository } from '../src/persistence/repositories/workflow-repository.mjs';
import { DurableWorkflowState } from '../src/workflow/durable-workflow-state.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { createPmRequest } from '../src/pm/pm-contracts.mjs';
import { createArtifactStore } from '../src/artifacts/artifact-store.mjs';
import { buildActorAliasRegistry } from '../src/artifacts/artifact-paths.mjs';
import { verifySealedArtifactReference } from '../src/artifacts/artifact-recovery.mjs';
import { fakeReportBackend } from './fixtures/p20-report-helpers.mjs';

const PROJECT = Object.freeze({ id: 'proj-art', repo_path: process.cwd() });
const CREATED_AT = '2026-09-10T12:00:00Z';

function backendResolver({ product = 'fake', plan = {}, calls = [] } = {}) {
  const r = (profileId) => ({
    backend: product,
    async runReport(args) {
      const stage = args?.request?.stage ?? null;
      calls.push({ profileId, stage });
      const cfg = typeof plan[profileId] === 'function' ? plan[profileId]({ stage }) : (plan[profileId] ?? plan.default ?? {});
      const inner = fakeReportBackend({
        text: cfg.text ?? `# ${stage} by ${profileId}\n\nbody ${profileId}\n`,
        terminalState: cfg.terminalState, finishReason: cfg.finishReason, timedOut: cfg.timedOut, cancelled: cfg.cancelled,
      });
      return inner.runReport(args);
    },
  });
  r.calls = calls;
  return r;
}

const fakeProfileRegistry = (ids) => ({ get(id) { if (!ids.includes(id)) throw Object.assign(new Error('unknown'), { code: 'PM_PROFILE_NOT_REGISTERED' }); return { id, product: 'fake' }; } });
const fakeResolveDriver = () => () => ({ name: 'unused-for-artifact', async decide() { throw new Error('artifact council steps never call decide()'); } });

async function withStores(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'p20-4r-dur-'));
  const store = new SqlitePersistenceStore();
  await store.open({ path: join(dir, 'state.db') });
  await store.migrate();
  const artifactRoot = join(dir, 'artifacts');
  try {
    await fn({
      sqlite: store, dir, artifactRoot,
      newArtifactStore: () => createArtifactStore({ storeId: 's-art', projectId: PROJECT.id, root: artifactRoot }),
      newPmRepo: () => new PmRepository({ store }),
      newStepState: () => new DurableWorkflowState({ repository: new WorkflowRepository({ store }) }),
    });
  } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
}

function buildRuntime({ council, artifactStore, stepState, pmRepository, resolveReportBackend, taskId }) {
  const aliasRegistry = buildActorAliasRegistry([council.chair_profile_id, ...council.participant_profile_ids]);
  const artifactCouncil = {
    store: artifactStore, taskId, taskSlug: 'durable council', createdAt: CREATED_AT,
    resolveReportBackend, aliasRegistry, capabilityPolicy: undefined, consumerInputTransport: 'VERBATIM_CONTENT',
  };
  const workflowRunner = new CouncilStepWorkflowRunner({
    resolveDriver: fakeResolveDriver(), profileRegistry: fakeProfileRegistry([council.chair_profile_id, ...council.participant_profile_ids]),
    project: PROJECT, stepState, artifactCouncil,
  });
  const peerRelay = { async exchange() { throw new Error('unused'); }, createConversation() {}, getConversation() { return null; }, result() { return null; } };
  const driver = new CouncilChairDriver({ council, ownerTask: 'Durable artifact council.', transportMode: 'artifact_v1', artifactCouncil });
  return new DurablePmRuntime({ driver, workflowRunner, peerRelay, repository: pmRepository, maxTurns: 24, historyLimit: 24 });
}

const spec2 = () => normalizeCouncilSpec({ chair_profile_id: 'c', participant_profile_ids: ['p1', 'p2'], rounds: 1 });

test('R1/§10: a full artifact_v1 Council runs to a chair FINISH over the real durable machine; final_ref = synthesis sealed_ref', async () => {
  await withStores(async ({ newArtifactStore, newPmRepo, newStepState }) => {
    const council = spec2();
    const calls = [];
    const runtime = buildRuntime({
      council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(),
      resolveReportBackend: backendResolver({ calls }), taskId: 'task-DUR1',
    });
    const res = await runtime.run({ objective: 'x', pmRunId: 'x'.repeat(120) + '01', context: { council, transport_version: 'artifact_v1' } });
    assert.equal(res.status, 'completed');
    assert.equal(res.data.type, 'council');
    assert.equal(res.data.transport_version, 'artifact_v1');
    assert.equal(res.data.final_ref.sha256.length, 64);
    // provider called once per stage: chair_plan + 2 reports + synthesis
    assert.equal(calls.length, 4);
    assert.deepEqual(calls.map((c) => c.stage), ['chair-plan', 'participant-report', 'participant-report', 'chair-council-synthesis']);
    // the FINISH output is the exact verified synthesis bytes
    const store = newArtifactStore();
    const v = verifySealedArtifactReference({ store, reference: res.data.final_ref });
    assert.equal(res.output, v.buffer.toString('utf8'));
    // manifest topology + persisted council_control
    const task = store.openTaskById('task-DUR1');
    const m = task.freshManifest();
    assert.equal(m.task_state, 'COMPLETED');
    assert.equal(m.council_control.schema_version, 'p20.4-council-control-1');
    assert.deepEqual(m.council_control.participant_profile_ids, ['p1', 'p2']);
    assert.deepEqual(m.stages['chair-council-synthesis'].sealed_ref, res.data.final_ref);
  });
});

test('R1/R2/§20 (crash point J): a fully completed run replays with ZERO provider calls and a stable final_ref', async () => {
  await withStores(async ({ newArtifactStore, newPmRepo, newStepState }) => {
    const council = spec2();
    const pmRunId = 'y'.repeat(120) + '02';
    const calls1 = [];
    const r1 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), resolveReportBackend: backendResolver({ calls: calls1 }), taskId: 'task-DUR2' });
    const res1 = await r1.run({ objective: 'x', pmRunId, context: { council, transport_version: 'artifact_v1' } });
    assert.equal(res1.status, 'completed');
    assert.ok(calls1.length > 0);

    // "restart": brand-new object graph, same SQLite + artifact root.
    const calls2 = [];
    const r2 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), resolveReportBackend: backendResolver({ calls: calls2 }), taskId: 'task-DUR2' });
    const res2 = await r2.resume(pmRunId);
    assert.equal(res2.status, 'completed');
    assert.equal(calls2.length, 0, 'no provider replay on a completed run');
    assert.deepEqual(res2.data.final_ref, res1.data.final_ref);
    assert.equal(res2.output, res1.output);
  });
});

test('R2 (crash points B/D/H): a SEALED stage on a RUNNING workflow row recovers RECOVERED_FROM_SEAL with ZERO replay', async () => {
  await withStores(async ({ newArtifactStore, newPmRepo, newStepState, sqlite }) => {
    const council = spec2();
    const pmRunId = 'z'.repeat(120) + '03';
    const calls1 = [];
    const r1 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), resolveReportBackend: backendResolver({ calls: calls1 }), taskId: 'task-DUR3' });
    await r1.run({ objective: 'x', pmRunId, context: { council, transport_version: 'artifact_v1' } });

    // Simulate a crash right after the SYNTHESIS report SEALED on disk but
    // before its durable workflow outcome + the PM FINISH turn committed:
    //  - drop the (last) FINISH pm_turn
    //  - reset the synthesis pm_turn to ACTION_STARTED (no later turns -> valid)
    //  - reset the synthesis workflow row + step to 'running'
    //  - reset the pm_run to 'running'
    const lastTurn = sqlite.get('SELECT turn_index, action_id, decision FROM pm_turns WHERE pm_run_id=? ORDER BY turn_index DESC LIMIT 1', [pmRunId]);
    assert.match(String(lastTurn.decision), /"type":"finish"/);
    sqlite.run('DELETE FROM pm_turns WHERE pm_run_id=? AND turn_index=?', [pmRunId, lastTurn.turn_index]);
    const synthTurn = sqlite.get('SELECT turn_index, action_id FROM pm_turns WHERE pm_run_id=? ORDER BY turn_index DESC LIMIT 1', [pmRunId]);
    const synthWf = synthTurn.action_id;
    sqlite.run("UPDATE pm_turns SET phase='ACTION_STARTED', outcome=NULL, completed_at=NULL WHERE pm_run_id=? AND turn_index=?", [pmRunId, synthTurn.turn_index]);
    sqlite.run("UPDATE workflows SET status='running', completed_at=NULL WHERE id=?", [synthWf]);
    sqlite.run("UPDATE workflow_steps SET status='running', dispatched_context=NULL WHERE workflow_id=?", [synthWf]);
    const remaining = sqlite.get('SELECT COUNT(*) n FROM pm_turns WHERE pm_run_id=?', [pmRunId]).n;
    sqlite.run("UPDATE pm_runs SET status='running', completed_at=NULL, output='', data=NULL, error=NULL, turn_count=? WHERE id=?", [remaining, pmRunId]);

    const calls2 = [];
    const r2 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), resolveReportBackend: backendResolver({ calls: calls2 }), taskId: 'task-DUR3' });
    const res2 = await r2.resume(pmRunId);
    assert.equal(res2.status, 'completed');
    assert.equal(calls2.length, 0, 'the SEALED synthesis stage is reused from disk, no replay');
    // the recovered synthesis workflow step handoff is RECOVERED_FROM_SEAL
    const step = sqlite.get("SELECT dispatched_context FROM workflow_steps WHERE workflow_id=?", [synthWf]);
    const handoff = JSON.parse(step.dispatched_context).handoff;
    assert.equal(handoff.transport_version, 'artifact_v1');
    assert.equal(handoff.execution_state, 'RECOVERED_FROM_SEAL');
    assert.ok(handoff.sealed_ref);
    // final_ref committed + stable
    const m = newArtifactStore().openTaskById('task-DUR3').freshManifest();
    assert.equal(m.task_state, 'COMPLETED');
    assert.deepEqual(res2.data.final_ref, m.stages['chair-council-synthesis'].sealed_ref);
  });
});

test('R4/§21: reopening the same task_id with a changed roster fails closed BEFORE any provider call', async () => {
  await withStores(async ({ newArtifactStore, newPmRepo, newStepState }) => {
    const councilA = spec2();
    const calls1 = [];
    const rA = buildRuntime({ council: councilA, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), resolveReportBackend: backendResolver({ calls: calls1 }), taskId: 'task-CTRL1' });
    await rA.run({ objective: 'x', pmRunId: 'a'.repeat(120) + '04', context: { council: councilA, transport_version: 'artifact_v1' } });

    // Same task id, different roster order.
    const councilB = normalizeCouncilSpec({ chair_profile_id: 'c', participant_profile_ids: ['p2', 'p1'], rounds: 1 });
    const calls2 = [];
    const rB = buildRuntime({ council: councilB, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), resolveReportBackend: backendResolver({ calls: calls2 }), taskId: 'task-CTRL1' });
    const resB = await rB.run({ objective: 'x', pmRunId: 'b'.repeat(120) + '05', context: { council: councilB, transport_version: 'artifact_v1' } });
    assert.equal(resB.status, 'failed');
    assert.match(JSON.stringify(resB.error ?? {}), /COUNCIL_ARTIFACT_CONTROL_MISMATCH/);
    assert.equal(calls2.length, 0, 'zero provider calls on a control mismatch');
  });
});

test('R1/§16: one participant report fails -> Council still completes degraded, chair FINISH, final_ref set', async () => {
  await withStores(async ({ newArtifactStore, newPmRepo, newStepState }) => {
    const council = normalizeCouncilSpec({ chair_profile_id: 'c', participant_profile_ids: ['p1', 'p2', 'p3'], rounds: 1 });
    const calls = [];
    const runtime = buildRuntime({
      council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(),
      resolveReportBackend: backendResolver({ calls, plan: { p2: ({ stage }) => stage === 'participant-report' ? { terminalState: 'PROVIDER_ERROR', finishReason: 'error' } : {} } }),
      taskId: 'task-DEG1',
    });
    const res = await runtime.run({ objective: 'x', pmRunId: 'd'.repeat(120) + '06', context: { council, transport_version: 'artifact_v1' } });
    assert.equal(res.status, 'completed');
    assert.equal(res.data.degraded, true);
    assert.deepEqual(res.data.failed_participants, ['p2']);
    assert.deepEqual(res.data.completed_participants, ['p1', 'p3']);
  });
});

test('§17/P20.5 §25: an artifact_v1 Council with debate.enabled=true and NO proven typed-control route fails closed BEFORE any stage, ZERO provider calls', async () => {
  await withStores(async ({ newArtifactStore, newPmRepo, newStepState }) => {
    const council = normalizeCouncilSpec({ chair_profile_id: 'c', participant_profile_ids: ['p1', 'p2'], rounds: 1, debate: { enabled: true, max_rounds: 2 } });
    const calls = [];
    // the fake backends carry no `supportsDebateTypedControl` -> the P20.5 §25
    // Debate typed-control preflight fails closed before the first Council call.
    const runtime = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), resolveReportBackend: backendResolver({ calls }), taskId: 'task-DEB1' });
    const res = await runtime.run({ objective: 'x', pmRunId: 'e'.repeat(120) + '07', context: { council, transport_version: 'artifact_v1' } });
    assert.equal(res.status, 'failed');
    assert.match(JSON.stringify(res.error ?? {}), /COUNCIL_ARTIFACT_DEBATE_TYPED_CONTROL_UNSUPPORTED/);
    assert.equal(calls.length, 0);
  });
});
