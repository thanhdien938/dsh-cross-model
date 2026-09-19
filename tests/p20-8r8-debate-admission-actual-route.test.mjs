/**
 * P20.8R8 — Debate admission must validate the ACTUAL resolved report route.
 *
 * Authority: docs/P20/P20_8R8_DEBATE_ADMISSION_ACTUAL_ROUTE_FIX_MASTER_PROMPT.md
 *
 * `CouncilChairDriver.#assertArtifactDebateAdmission()` (src/pm/council/
 * council-chair-driver.mjs) previously hard-coded
 * `requestedDelivery: 'VERBATIM_MATERIALIZATION'` in its `assertReportRoute()`
 * call, regardless of what the resolved report backend would actually use at
 * execution time. This let a Debate task whose real backends are all
 * `DIRECT_WRITE`-PROVEN still fail closed at the earlier admission gate
 * before any provider call (the exact owner Telegram Debate E2E failure,
 * task-oGvw5lx1doy1M9TrGTQ9TKT-NE6iL0wJ, correlation
 * p20-r7-alt-profile-debate-e2e-20260912).
 *
 * The fix: `actualDelivery = backend.deliveryMechanism ?? 'VERBATIM_MATERIALIZATION'`,
 * passed to `assertReportRoute()` — the SAME fact `runDebateArtifactStage()`
 * (R6) and `runCouncilArtifactStage()` already use at execution time.
 *
 * Offline only. No real CLI process is ever spawned.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { normalizeCouncilSpec } from '../src/pm/council/council-contracts.mjs';
import { CouncilChairDriver } from '../src/pm/council/council-chair-driver.mjs';
import { CouncilStepWorkflowRunner } from '../src/pm/council/council-step-workflow-runner.mjs';
import { DurablePmRuntime } from '../src/pm/durable-pm-runtime.mjs';
import { PmRepository } from '../src/persistence/repositories/pm-repository.mjs';
import { WorkflowRepository } from '../src/persistence/repositories/workflow-repository.mjs';
import { DurableWorkflowState } from '../src/workflow/durable-workflow-state.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { createArtifactStore } from '../src/artifacts/artifact-store.mjs';
import { buildActorAliasRegistry } from '../src/artifacts/artifact-paths.mjs';
import { CAPABILITY_STATE } from '../src/artifacts/backend-report-capability.mjs';
import { buildReportBackendResult, TERMINAL_STATE, VISIBLE_OUTPUT_SOURCE } from '../src/pm/report-backend-result.mjs';
import { PROVIDER_DIRECT_WRITE_CONFIRMER } from '../src/pm/report-backends/cli-report-backends.mjs';

const PROJECT = Object.freeze({ id: 'proj-r8', repo_path: process.cwd() });
const CREATED_AT = '2026-09-12T00:00:00Z';

// ---- shared harness (mirrors tests/p20-council-durable-integration.test.mjs) ----

async function withStores(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'p20-8r8-'));
  const store = new SqlitePersistenceStore();
  await store.open({ path: join(dir, 'state.db') });
  await store.migrate();
  const artifactRoot = join(dir, 'artifacts');
  try {
    await fn({
      newArtifactStore: () => createArtifactStore({ storeId: 's-r8', projectId: PROJECT.id, root: artifactRoot }),
      newPmRepo: () => new PmRepository({ store }),
      newStepState: () => new DurableWorkflowState({ repository: new WorkflowRepository({ store }) }),
    });
  } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
}

const fakeProfileRegistry = (ids) => ({ get(id) { if (!ids.includes(id)) throw Object.assign(new Error('unknown'), { code: 'PM_PROFILE_NOT_REGISTERED' }); return { id, product: 'fake' }; } });
const fakeResolveDriver = () => () => ({ name: 'unused-for-artifact', async decide() { throw new Error('artifact council steps never call decide()'); } });

/**
 * A per-profile fake report backend, shaped like the real production Phase-1
 * CLI backends (cli-report-backends.mjs): carries `.backend`,
 * `.deliveryMechanism`, and (chair-only, when opted in) a truthy
 * `.supportsDebateTypedControl`. For DIRECT_WRITE it writes the assigned
 * path itself (DSH never materializes DIRECT_WRITE bytes); for
 * VERBATIM_MATERIALIZATION it returns `acceptedVisibleText` normally.
 * When `continueDebateOnSynthesis` is set, a debate-chair-synthesis call
 * also populates the separate typed-control channel.
 */
function rosterBackend({ product, deliveryMechanism = 'DIRECT_WRITE', supportsDebateTypedControl = false, continueDebateOnSynthesis = null, calls } = {}) {
  const record = (profileId, stage) => { if (calls) calls.push({ profileId, stage }); };
  return {
    backend: product,
    deliveryMechanism,
    directWriter: deliveryMechanism === 'DIRECT_WRITE' ? PROVIDER_DIRECT_WRITE_CONFIRMER : undefined,
    supportsDebateTypedControl,
    async runReport({ request }) {
      const stage = request?.stage ?? null;
      record(request?.profileId, stage);
      const text = `# ${stage} by ${request?.profileId}\n\nbody\n`;
      const debateTypedControl = stage === 'debate-chair-synthesis' && typeof continueDebateOnSynthesis === 'boolean' ? continueDebateOnSynthesis : null;
      if (deliveryMechanism === 'DIRECT_WRITE' && request?.attempt?.reportPath) {
        mkdirSync(dirname(request.attempt.reportPath), { recursive: true });
        writeFileSync(request.attempt.reportPath, text);
        return buildReportBackendResult({
          backend: request.backend, profileId: request.profileId, executionId: request.executionId,
          terminalState: TERMINAL_STATE.SUCCESS, safeDiagnostics: { direct_write: true }, debateTypedControl,
        });
      }
      return buildReportBackendResult({
        backend: request.backend, profileId: request.profileId, executionId: request.executionId,
        terminalState: TERMINAL_STATE.SUCCESS, acceptedVisibleText: text, visibleOutputSource: VISIBLE_OUTPUT_SOURCE.FAKE, debateTypedControl,
      });
    },
  };
}

/** A policy proving exactly one delivery mechanism + one input transport per product (mirrors p20-8r6's policyProving()). */
function policyFor(products) {
  const backends = {};
  for (const [product, { delivery, input = 'VERBATIM_CONTENT' }] of Object.entries(products)) {
    const otherDelivery = delivery === 'DIRECT_WRITE' ? 'VERBATIM_MATERIALIZATION' : 'DIRECT_WRITE';
    const otherInput = input === 'VERBATIM_CONTENT' ? 'NATIVE_ASSIGNED_READ' : 'VERBATIM_CONTENT';
    backends[product] = {
      report_delivery: { [delivery]: CAPABILITY_STATE.PROVEN, [otherDelivery]: CAPABILITY_STATE.UNSUPPORTED },
      artifact_input: { [input]: CAPABILITY_STATE.PROVEN, [otherInput]: CAPABILITY_STATE.UNSUPPORTED },
    };
  }
  return { enforcement_version: 'test-p20-8r8-1', backends };
}

function buildDriver({ council, artifactStore, resolveReportBackend, taskId, capabilityPolicy }) {
  const aliasRegistry = buildActorAliasRegistry([council.chair_profile_id, ...council.participant_profile_ids]);
  const artifactCouncil = {
    store: artifactStore, taskId, taskSlug: 'r8 debate admission', createdAt: CREATED_AT,
    resolveReportBackend, aliasRegistry, capabilityPolicy, consumerInputTransport: 'VERBATIM_CONTENT',
  };
  return new CouncilChairDriver({ council, ownerTask: 'R8 admission probe.', transportMode: 'artifact_v1', artifactCouncil });
}

function buildRuntime({ council, artifactStore, stepState, pmRepository, resolveReportBackend, taskId, capabilityPolicy }) {
  const aliasRegistry = buildActorAliasRegistry([council.chair_profile_id, ...council.participant_profile_ids]);
  const artifactCouncil = {
    store: artifactStore, taskId, taskSlug: 'r8 debate roster', createdAt: CREATED_AT,
    resolveReportBackend, aliasRegistry, capabilityPolicy, consumerInputTransport: 'VERBATIM_CONTENT',
  };
  const workflowRunner = new CouncilStepWorkflowRunner({
    resolveDriver: fakeResolveDriver(), profileRegistry: fakeProfileRegistry([council.chair_profile_id, ...council.participant_profile_ids]),
    project: PROJECT, stepState, artifactCouncil,
  });
  const peerRelay = { async exchange() { throw new Error('unused'); }, createConversation() {}, getConversation() { return null; }, result() { return null; } };
  const driver = new CouncilChairDriver({ council, ownerTask: 'R8 full roster debate.', transportMode: 'artifact_v1', artifactCouncil });
  return new DurablePmRuntime({ driver, workflowRunner, peerRelay, repository: pmRepository, maxTurns: 40, historyLimit: 40 });
}

const debateSpec2 = () => normalizeCouncilSpec({ chair_profile_id: 'c', participant_profile_ids: ['p1', 'p2'], rounds: 1, debate: { enabled: true, max_rounds: 1 } });

// ---- 1/2 — DIRECT_WRITE-proven backend passes the route-admission portion; never asks for materialization ----

test('§R8.1/§R8.2 — a resolved DIRECT_WRITE backend passes admission; the policy proves ONLY DIRECT_WRITE (VERBATIM_MATERIALIZATION UNSUPPORTED) so a materialization request would fail closed instead', async () => {
  await withStores(async ({ newArtifactStore }) => {
    const council = debateSpec2();
    const calls = [];
    const policy = policyFor({ fake: { delivery: 'DIRECT_WRITE', input: 'VERBATIM_CONTENT' } });
    const resolve = (profileId) => rosterBackend({ product: 'fake', deliveryMechanism: 'DIRECT_WRITE', supportsDebateTypedControl: profileId === 'c', calls });
    const driver = buildDriver({ council, artifactStore: newArtifactStore(), resolveReportBackend: resolve, taskId: 'task-r8-1', capabilityPolicy: policy });
    // Admission passes -> decide() proceeds PAST admission and returns the
    // next workflow action (chair-plan), never invoking the provider itself
    // (decide() only PLANS the next step; CouncilStepWorkflowRunner executes
    // it). If admission had incorrectly requested VERBATIM_MATERIALIZATION
    // (UNSUPPORTED in this policy), this would throw
    // COUNCIL_ARTIFACT_DEBATE_ADMISSION_ROUTE_UNSUPPORTED instead.
    const result = await driver.decide({ turn: 1, history: [] });
    assert.equal(result.type, 'workflow', 'decide() must return a chair-plan workflow action, proving admission passed');
    assert.equal(result.spec.stepKind, 'chair_plan');
    assert.equal(calls.length, 0, 'decide() alone never invokes the report backend; it only plans the next step');
  });
});

// ---- 3 — DIRECT_WRITE backend with DIRECT_WRITE UNPROVEN fails closed before any provider call ----

test('§R8.3 — a DIRECT_WRITE backend with DIRECT_WRITE UNPROVEN fails closed before any provider call', async () => {
  await withStores(async ({ newArtifactStore }) => {
    const council = debateSpec2();
    const calls = [];
    // Policy proves only VERBATIM_MATERIALIZATION; the resolved backend
    // declares DIRECT_WRITE -> actualDelivery=DIRECT_WRITE is NOT proven.
    const policy = policyFor({ fake: { delivery: 'VERBATIM_MATERIALIZATION', input: 'VERBATIM_CONTENT' } });
    const resolve = (profileId) => rosterBackend({ product: 'fake', deliveryMechanism: 'DIRECT_WRITE', supportsDebateTypedControl: profileId === 'c', calls });
    const driver = buildDriver({ council, artifactStore: newArtifactStore(), resolveReportBackend: resolve, taskId: 'task-r8-3', capabilityPolicy: policy });
    await assert.rejects(
      driver.decide({ turn: 1, history: [] }),
      (e) => { assert.match(e.message, /report route not admitted/); assert.equal(e.code, 'COUNCIL_ARTIFACT_DEBATE_ADMISSION_ROUTE_UNSUPPORTED'); return true; },
    );
    assert.equal(calls.length, 0, 'zero provider calls when DIRECT_WRITE is not proven');
  });
});

// ---- 4 — required VERBATIM_CONTENT input proof remains enforced ----

test('§R8.4 — VERBATIM_CONTENT input transport UNPROVEN still fails closed even though DIRECT_WRITE delivery is proven', async () => {
  await withStores(async ({ newArtifactStore }) => {
    const council = debateSpec2();
    const calls = [];
    const policy = policyFor({ fake: { delivery: 'DIRECT_WRITE', input: 'NATIVE_ASSIGNED_READ' } });
    const resolve = (profileId) => rosterBackend({ product: 'fake', deliveryMechanism: 'DIRECT_WRITE', supportsDebateTypedControl: profileId === 'c', calls });
    const driver = buildDriver({ council, artifactStore: newArtifactStore(), resolveReportBackend: resolve, taskId: 'task-r8-4', capabilityPolicy: policy });
    await assert.rejects(
      driver.decide({ turn: 1, history: [] }),
      (e) => { assert.equal(e.code, 'COUNCIL_ARTIFACT_DEBATE_ADMISSION_ROUTE_UNSUPPORTED'); return true; },
    );
    assert.equal(calls.length, 0, 'zero provider calls when the required input transport is not proven');
  });
});

// ---- 5 — legacy backend with no .deliveryMechanism keeps the old materialization default ----

test('§R8.5 — a pre-R6/legacy backend with no .deliveryMechanism field still defaults to VERBATIM_MATERIALIZATION (backward compatible)', async () => {
  await withStores(async ({ newArtifactStore }) => {
    const council = debateSpec2();
    const calls = [];
    const policy = policyFor({ fake: { delivery: 'VERBATIM_MATERIALIZATION', input: 'VERBATIM_CONTENT' } });
    const resolve = (profileId) => {
      const legacy = rosterBackend({ product: 'fake', deliveryMechanism: 'DIRECT_WRITE', supportsDebateTypedControl: profileId === 'c', calls });
      delete legacy.deliveryMechanism; // simulate a pre-R6/test double that never set this field
      return legacy;
    };
    const driver = buildDriver({ council, artifactStore: newArtifactStore(), resolveReportBackend: resolve, taskId: 'task-r8-5', capabilityPolicy: policy });
    const result = await driver.decide({ turn: 1, history: [] });
    assert.equal(result.type, 'workflow', 'admission must pass via the VERBATIM_MATERIALIZATION default for a legacy backend');
    assert.equal(result.spec.stepKind, 'chair_plan');
    assert.equal(calls.length, 0, 'decide() alone never invokes the report backend');
  });
});

// ---- 6 — Claude Chair typed-control admission remains required and unchanged ----

test('§R8.6 — Chair typed-control admission is still required even when the route check passes (route fix did not touch this gate)', async () => {
  await withStores(async ({ newArtifactStore }) => {
    const council = debateSpec2();
    const calls = [];
    const policy = policyFor({ fake: { delivery: 'DIRECT_WRITE', input: 'VERBATIM_CONTENT' } });
    // Route is fully proven for everyone, but the CHAIR does not declare
    // supportsDebateTypedControl -> must still fail closed on the SEPARATE
    // typed-control gate, not the route gate.
    const resolve = () => rosterBackend({ product: 'fake', deliveryMechanism: 'DIRECT_WRITE', supportsDebateTypedControl: false, calls });
    const driver = buildDriver({ council, artifactStore: newArtifactStore(), resolveReportBackend: resolve, taskId: 'task-r8-6', capabilityPolicy: policy });
    await assert.rejects(
      driver.decide({ turn: 1, history: [] }),
      (e) => { assert.equal(e.code, 'COUNCIL_ARTIFACT_DEBATE_TYPED_CONTROL_UNSUPPORTED'); return true; },
    );
    assert.equal(calls.length, 0, 'zero provider calls: the route passed but typed-control admission still fails closed BEFORE any provider call');
  });
});

// ---- 7 — OpenCode/Antigravity Debate members are not required to expose typed-control ----

test('§R8.7 — participants without supportsDebateTypedControl still admit fine; only the Chair is checked for typed control', async () => {
  await withStores(async ({ newArtifactStore }) => {
    const council = debateSpec2();
    const calls = [];
    const policy = policyFor({ fake: { delivery: 'DIRECT_WRITE', input: 'VERBATIM_CONTENT' } });
    // Only the chair ('c') declares typed control; participants p1/p2 (standing
    // in for OpenCode/Antigravity) do not.
    const resolve = (profileId) => rosterBackend({ product: 'fake', deliveryMechanism: 'DIRECT_WRITE', supportsDebateTypedControl: profileId === 'c', calls });
    const driver = buildDriver({ council, artifactStore: newArtifactStore(), resolveReportBackend: resolve, taskId: 'task-r8-7', capabilityPolicy: policy });
    const result = await driver.decide({ turn: 1, history: [] });
    assert.equal(result.type, 'workflow', 'admission must pass: participants need no typed-control capability');
    assert.equal(result.spec.stepKind, 'chair_plan');
    assert.equal(calls.length, 0, 'decide() alone never invokes the report backend');
  });
});

// ---- 8/9 — exact alternate roster 24/23/7 passes complete Debate preflight; first Debate stage reachable end-to-end ----

test('§R8.8/§R8.9 — the exact alternate roster (claude-code chair, opencode + antigravity members) passes complete Debate preflight offline and runs a full 1-round Debate to completion, fake/offline only', async () => {
  await withStores(async ({ newArtifactStore, newPmRepo, newStepState }) => {
    const CHAIR = 'live1-claude-sonnet-low';
    const OPENCODE = 'live1-opencode-opencode-go-deepseek-v4-flash';
    const ANTIGRAVITY = 'live1-antigravity-gemini-high';
    const council = normalizeCouncilSpec({
      chair_profile_id: CHAIR, participant_profile_ids: [OPENCODE, ANTIGRAVITY], rounds: 1,
      debate: { enabled: true, max_rounds: 1 },
    });
    // Synthetic/offline policy matching the currently recorded production
    // facts (P20.8R7): all three Phase-1 CLI products are DIRECT_WRITE +
    // VERBATIM_CONTENT PROVEN.
    const policy = policyFor({
      'claude-code': { delivery: 'DIRECT_WRITE', input: 'VERBATIM_CONTENT' },
      opencode: { delivery: 'DIRECT_WRITE', input: 'VERBATIM_CONTENT' },
      antigravity: { delivery: 'DIRECT_WRITE', input: 'VERBATIM_CONTENT' },
    });
    const calls = [];
    const productOf = { [CHAIR]: 'claude-code', [OPENCODE]: 'opencode', [ANTIGRAVITY]: 'antigravity' };
    const resolve = (profileId) => rosterBackend({
      product: productOf[profileId], deliveryMechanism: 'DIRECT_WRITE',
      supportsDebateTypedControl: profileId === CHAIR,
      // one Debate round only: the chair's debate-chair-synthesis call says
      // continue_debate=false so the bounded Debate loop terminates at round 1.
      continueDebateOnSynthesis: false,
      calls,
    });
    const runtime = buildRuntime({
      council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(),
      resolveReportBackend: resolve, taskId: 'task-r8-roster', capabilityPolicy: policy,
    });
    const res = await runtime.run({ objective: 'x', pmRunId: 'r'.repeat(120) + '08', context: { council, transport_version: 'artifact_v1' } });
    assert.equal(res.status, 'completed', `expected the full roster to complete, got ${JSON.stringify(res.error ?? res)}`);
    assert.equal(res.data.debate.enabled, true);
    // The first artifact Debate workflow stage (debate-chair-brief) — and
    // every subsequent Debate stage — became reachable AFTER admission:
    const stages = calls.map((c) => c.stage);
    assert.ok(stages.includes('debate-chair-brief'), `expected debate-chair-brief to run, got stages: ${JSON.stringify(stages)}`);
    assert.ok(stages.includes('debate-member-response') || stages.some((s) => /debate-member/.test(s)), `expected a debate member response stage, got: ${JSON.stringify(stages)}`);
    assert.ok(stages.includes('debate-chair-synthesis'), `expected debate-chair-synthesis to run, got: ${JSON.stringify(stages)}`);
    // final_ref is set (sealed Debate synthesis), never the Council synthesis.
    assert.equal(res.data.final_ref.sha256.length, 64);
  });
});

// ---- 10 — existing R6/R7 Debate + Council/SINGLE regressions stay green is verified by running those suites directly (see report); this file only re-asserts the admission-adjacent fail-closed case those suites already cover remains intact ----

test('§R8.10 — the pre-existing "no typed control at all" fail-closed admission case (R6/§25) still fails closed with ZERO provider calls after the route fix', async () => {
  await withStores(async ({ newArtifactStore }) => {
    // Mirrors tests/p20-council-durable-integration.test.mjs's existing
    // "NO proven typed-control route fails closed" test, but now also proves
    // it fails for the TYPED_CONTROL reason specifically, not a route error,
    // confirming the route fix left this gate's behavior unchanged.
    const council = debateSpec2();
    const calls = [];
    const policy = policyFor({ fake: { delivery: 'DIRECT_WRITE', input: 'VERBATIM_CONTENT' } });
    const resolve = () => rosterBackend({ product: 'fake', deliveryMechanism: 'DIRECT_WRITE', supportsDebateTypedControl: false, calls });
    const driver = buildDriver({ council, artifactStore: newArtifactStore(), resolveReportBackend: resolve, taskId: 'task-r8-10', capabilityPolicy: policy });
    await assert.rejects(
      driver.decide({ turn: 1, history: [] }),
      (e) => { assert.equal(e.code, 'COUNCIL_ARTIFACT_DEBATE_TYPED_CONTROL_UNSUPPORTED'); return true; },
    );
    assert.equal(calls.length, 0);
  });
});
