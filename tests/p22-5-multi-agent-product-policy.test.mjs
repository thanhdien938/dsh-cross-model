/**
 * P22.5 — final multi-agent product policy: five full-multi-agent backends
 * (Claude Code, Codex, OpenCode, Antigravity, Grok) vs `api` (SINGLE-only by
 * deliberate product decision, not an unproven/incomplete migration state).
 *
 * Authority: docs/P22/P22_5_FINAL_MULTI_AGENT_PRODUCT_POLICY_AND_MIGRATION_CLOSURE.md
 *
 * Offline only. No live provider/model calls.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  TASK_MODE, PRODUCTION_BACKEND_SUPPORT, resolveBackendTaskModeSupport, assertBackendTaskModeSupported,
  taskModeForArtifactStage, buildProductionCapabilityPolicy, API_MULTI_AGENT_POLICY_GUIDANCE,
} from '../src/runtime/production-backend-capabilities.mjs';
import { PRODUCTION_ROUTE_BY_PRODUCT } from '../src/runtime/p20-report-route-resolution.mjs';
import { normalizeCouncilSpec } from '../src/pm/council/council-contracts.mjs';
import { SingleArtifactDriver } from '../src/pm/single-artifact-driver.mjs';
import { buildReportBackendResult, TERMINAL_STATE, VISIBLE_OUTPUT_SOURCE } from '../src/pm/report-backend-result.mjs';
import { PROVIDER_DIRECT_WRITE_CONFIRMER } from '../src/pm/report-backends/cli-report-backends.mjs';
import { withTempRoot, makeStore, fakeReportBackend } from './fixtures/p20-report-helpers.mjs';
import { withStores, buildDriver, buildRuntime } from './fixtures/p20-durable-council-harness.mjs';

const FULL_MULTI_AGENT = Object.freeze(['claude-code', 'codex', 'opencode', 'antigravity', 'grok']);

/**
 * A per-profile fake report backend shaped exactly like the real production
 * adapters (cli-report-backends.mjs): carries `.backend` and the product's
 * REAL `PRODUCTION_ROUTE_BY_PRODUCT` deliveryMechanism (DIRECT_WRITE for the
 * five full-multi-agent backends, VERBATIM_MATERIALIZATION for `api`), plus
 * (when opted in) `supportsDebateTypedControl` and the same-execution
 * strict typed-control envelope for a `debate-chair-synthesis` call. For
 * DIRECT_WRITE it writes the assigned path itself, exactly as
 * deliverDirectWrite() expects the provider to have already done.
 * Mirrors tests/p20-8r8-debate-admission-actual-route.test.mjs's own
 * `rosterBackend()`, generalized to a per-profile product map.
 */
function realProductRoster({ productOf, debateTypedControl = false, continueDebate = () => false, calls = [] }) {
  return (profileId) => {
    const product = productOf(profileId);
    const route = PRODUCTION_ROUTE_BY_PRODUCT[product];
    const deliveryMechanism = route?.deliveryMechanism ?? 'VERBATIM_MATERIALIZATION';
    const directWrite = deliveryMechanism === 'DIRECT_WRITE';
    return {
      backend: product,
      deliveryMechanism,
      directWriter: directWrite ? PROVIDER_DIRECT_WRITE_CONFIRMER : undefined,
      supportsDebateTypedControl: directWrite && debateTypedControl,
      async runReport({ request }) {
        const stage = request?.stage ?? null;
        const round = request?.round ?? null;
        calls.push({ profileId, stage, round });
        const text = `# ${stage}${round ? ` r${round}` : ''} by ${profileId}\n\nbody ${profileId}\n`;
        const tc = directWrite && debateTypedControl && stage === 'debate-chair-synthesis' ? Boolean(continueDebate({ stage, round, profileId })) : null;
        if (directWrite && request?.attempt?.reportPath) {
          mkdirSync(dirname(request.attempt.reportPath), { recursive: true });
          writeFileSync(request.attempt.reportPath, text);
          return buildReportBackendResult({
            backend: product, profileId: request.profileId, executionId: request.executionId,
            terminalState: TERMINAL_STATE.SUCCESS, safeDiagnostics: { direct_write: true }, debateTypedControl: tc,
          });
        }
        return buildReportBackendResult({
          backend: product, profileId: request.profileId, executionId: request.executionId,
          terminalState: TERMINAL_STATE.SUCCESS, acceptedVisibleText: text, visibleOutputSource: VISIBLE_OUTPUT_SOURCE.FAKE, debateTypedControl: tc,
        });
      },
    };
  };
}

// ==================================================================
// K1 — capability matrix
// ==================================================================

test('K1 — capability matrix: the five full-multi-agent backends allow all four task modes', () => {
  for (const product of FULL_MULTI_AGENT) {
    for (const mode of Object.values(TASK_MODE)) {
      const result = resolveBackendTaskModeSupport(product, mode);
      assert.equal(result.ok, true, `${product}/${mode} must be allowed`);
    }
  }
});

test('K1 — capability matrix: api allows SINGLE only, rejects COUNCIL/DEBATE_MEMBER/DEBATE_CHAIR by product policy', () => {
  assert.equal(resolveBackendTaskModeSupport('api', TASK_MODE.SINGLE).ok, true);
  for (const mode of [TASK_MODE.COUNCIL, TASK_MODE.DEBATE_MEMBER, TASK_MODE.DEBATE_CHAIR]) {
    const result = resolveBackendTaskModeSupport('api', mode);
    assert.equal(result.ok, false, `api/${mode} must be rejected`);
    assert.equal(result.code, 'BACKEND_TASK_MODE_UNSUPPORTED');
    assert.doesNotMatch(result.reason, /UNPROVEN|PROVEN|qualification|proof/i, 'must be product-policy language, never PROVEN/qualification wording');
    assert.match(result.reason, /OpenCode/, 'must explain the OpenCode alternative route');
  }
});

test('K1 — PRODUCTION_BACKEND_SUPPORT table matches the exact required O matrix', () => {
  const expected = {
    'claude-code': { SINGLE: true, COUNCIL: true, DEBATE_MEMBER: true, DEBATE_CHAIR: true },
    codex: { SINGLE: true, COUNCIL: true, DEBATE_MEMBER: true, DEBATE_CHAIR: true },
    opencode: { SINGLE: true, COUNCIL: true, DEBATE_MEMBER: true, DEBATE_CHAIR: true },
    antigravity: { SINGLE: true, COUNCIL: true, DEBATE_MEMBER: true, DEBATE_CHAIR: true },
    grok: { SINGLE: true, COUNCIL: true, DEBATE_MEMBER: true, DEBATE_CHAIR: true },
    api: { SINGLE: true, COUNCIL: false, DEBATE_MEMBER: false, DEBATE_CHAIR: false },
  };
  for (const [product, modes] of Object.entries(expected)) {
    for (const [mode, expectedOk] of Object.entries(modes)) {
      assert.equal(PRODUCTION_BACKEND_SUPPORT[product].task_modes[mode], expectedOk, `${product}/${mode}`);
    }
  }
});

test('K1/§F — an unknown product (test double) is never rejected by the task-mode axis — it defers to the route/capability check', () => {
  for (const mode of Object.values(TASK_MODE)) {
    assert.equal(resolveBackendTaskModeSupport('fake', mode).ok, true);
    assert.equal(resolveBackendTaskModeSupport('totally-unknown-backend', mode).ok, true);
  }
});

test('taskModeForArtifactStage maps every real stage correctly', () => {
  assert.equal(taskModeForArtifactStage('single'), TASK_MODE.SINGLE);
  assert.equal(taskModeForArtifactStage('chair-plan'), TASK_MODE.COUNCIL);
  assert.equal(taskModeForArtifactStage('chair-council-synthesis'), TASK_MODE.COUNCIL);
  assert.equal(taskModeForArtifactStage('participant-report'), TASK_MODE.COUNCIL);
  assert.equal(taskModeForArtifactStage('participant-critique'), TASK_MODE.COUNCIL);
  assert.equal(taskModeForArtifactStage('debate-chair-brief'), TASK_MODE.DEBATE_CHAIR);
  assert.equal(taskModeForArtifactStage('debate-chair-synthesis'), TASK_MODE.DEBATE_CHAIR);
  assert.equal(taskModeForArtifactStage('debate-member-response'), TASK_MODE.DEBATE_MEMBER);
});

// ==================================================================
// K2 — API SINGLE E2E offline through the real artifact/report contract
// ==================================================================

test('K2 — API SINGLE reaches a sealed finish with a real final_ref through the real SingleArtifactDriver', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const backend = fakeReportBackend({ text: '# API SINGLE report\n\nbody\n' });
    const driver = new SingleArtifactDriver({
      store, taskId: 'task-api-single', taskSlug: 'api-single', createdAt: '2026-09-14T00:00:00Z',
      profileId: 'live1-api-openrouter-deepseek', actorAlias: 'api',
      instructions: 'do the thing',
      resolveReportBackend: () => ({ backend: 'api', deliveryMechanism: 'VERBATIM_MATERIALIZATION', runReport: backend.runReport.bind(backend) }),
      capabilityPolicy: buildProductionCapabilityPolicy(),
    });
    const decision = await driver.decide({ turn: 0, request: { id: 'req-1' }, history: [] });
    // ADMITTED / REPORT_ROUTE / ARTIFACT_CREATED / MATERIALIZATION / SEALED / FINAL_REF
    assert.equal(decision.type, 'finish', 'ADMITTED+executed to completion');
    assert.match(decision.output, /API SINGLE report/, 'MATERIALIZATION carried the exact report body');
    assert.ok(decision.data.final_ref, 'FINAL_REF present');
    assert.equal(decision.data.transport_version, 'artifact_v1');
    const reopened = store.openTaskById('task-api-single');
    assert.equal(reopened.manifest.task_state, 'COMPLETED', 'SEALED — task reached COMPLETED with a real manifest');
    assert.ok(reopened.manifest.final_ref, 'ARTIFACT_CREATED — the sealed final_ref is durably persisted');
  });
});

// ==================================================================
// K3/K4/K5 — API rejected from Council / Debate member / Debate chair
// ==================================================================

const councilSpecWithApi = () => normalizeCouncilSpec({ chair_profile_id: 'chair-claude', participant_profile_ids: ['member-opencode', 'member-api'], rounds: 1 });
const debateSpecApiMember = () => normalizeCouncilSpec({ chair_profile_id: 'chair-claude', participant_profile_ids: ['member-opencode', 'member-api'], rounds: 1, debate: { enabled: true, max_rounds: 1 } });
const debateSpecApiChair = () => normalizeCouncilSpec({ chair_profile_id: 'chair-api', participant_profile_ids: ['member-opencode', 'member-codex'], rounds: 1, debate: { enabled: true, max_rounds: 1 } });

const productById = (over) => (id) => over[id] ?? 'fake';

test('K3 — a Council roster containing a direct API profile is rejected at admission, zero provider calls', async () => {
  await withStores(async ({ newArtifactStore }) => {
    const council = councilSpecWithApi();
    const calls = [];
    const productOf = productById({ 'chair-claude': 'claude-code', 'member-opencode': 'opencode', 'member-api': 'api' });
    const driver = buildDriver({
      council, artifactStore: newArtifactStore(), taskId: 'task-k3',
      calls, capabilityPolicy: buildProductionCapabilityPolicy(),
      resolveReportBackend: realProductRoster({ productOf, calls }),
    });
    await assert.rejects(
      driver.decide({ turn: 1, history: [] }),
      (e) => {
        assert.equal(e.code, 'COUNCIL_ARTIFACT_ADMISSION_TASK_MODE_UNSUPPORTED', 'ERROR_CLASS: product-capability / task-mode-unsupported');
        assert.doesNotMatch(e.message, /PROVEN|UNPROVEN|qualification|proof/i, 'ERROR_MENTIONS_PROVEN: NO');
        assert.match(e.message, /OpenCode/, 'ERROR_EXPLAINS_OPENCODE_ROUTE: YES');
        return true;
      },
    );
    assert.equal(calls.length, 0, 'EXECUTION_STARTED: NO — zero provider calls');
  });
});

test('K4 — a Debate roster containing a direct API member is rejected at admission, zero provider calls', async () => {
  await withStores(async ({ newArtifactStore }) => {
    const council = debateSpecApiMember();
    const calls = [];
    const productOf = productById({ 'chair-claude': 'claude-code', 'member-opencode': 'opencode', 'member-api': 'api' });
    const driver = buildDriver({
      council, artifactStore: newArtifactStore(), taskId: 'task-k4',
      calls, capabilityPolicy: buildProductionCapabilityPolicy(),
      resolveReportBackend: realProductRoster({ productOf, debateTypedControl: true, calls }),
    });
    await assert.rejects(
      driver.decide({ turn: 1, history: [] }),
      (e) => {
        assert.equal(e.code, 'COUNCIL_ARTIFACT_DEBATE_ADMISSION_TASK_MODE_UNSUPPORTED');
        assert.doesNotMatch(e.message, /PROVEN|UNPROVEN|qualification|proof/i, 'PROVEN_ERROR: NO');
        assert.match(e.message, /Single tasks only/i, 'CLEAR_SINGLE_ONLY_POLICY: YES');
        return true;
      },
    );
    assert.equal(calls.length, 0, 'EXECUTION_STARTED: NO');
  });
});

test('K5 — a Debate roster with a direct API chair is rejected at admission before any control-protocol attempt', async () => {
  await withStores(async ({ newArtifactStore }) => {
    const council = debateSpecApiChair();
    const calls = [];
    const productOf = productById({ 'chair-api': 'api', 'member-opencode': 'opencode', 'member-codex': 'codex' });
    const driver = buildDriver({
      council, artifactStore: newArtifactStore(), taskId: 'task-k5',
      calls, capabilityPolicy: buildProductionCapabilityPolicy(),
      resolveReportBackend: realProductRoster({ productOf, debateTypedControl: true, calls }),
    });
    await assert.rejects(
      driver.decide({ turn: 1, history: [] }),
      (e) => {
        assert.equal(e.code, 'COUNCIL_ARTIFACT_DEBATE_ADMISSION_TASK_MODE_UNSUPPORTED');
        assert.doesNotMatch(e.message, /PROVEN|UNPROVEN/i);
        assert.match(e.message, /Single tasks only/i, 'CLEAR_SINGLE_ONLY_POLICY: YES');
        return true;
      },
    );
    // NO_CONTROL_PROTOCOL_ATTEMPT: rejection happens in the roster-wide
    // per-role loop, strictly BEFORE the chair typed-control admission check
    // (assertDebateTypedControlAdmitted) and before any runReport() call —
    // zero calls proves no DSH_DEBATE_CONTROL_V1 envelope was ever attempted.
    assert.equal(calls.length, 0, 'NO_CONTROL_PROTOCOL_ATTEMPT: YES (zero provider calls of any kind)');
  });
});

// ==================================================================
// K6 — the OpenCode alternative path: provider origin does not matter once
// it runs through OpenCode; DSH only ever sees backend === 'opencode'
// ==================================================================

test('K6 — an OpenCode-backed profile (standing in for an API-model-via-OpenCode profile) is fully eligible for Council admission', async () => {
  await withStores(async ({ newArtifactStore }) => {
    // Product policy has NO field for "what provider/model OpenCode is
    // itself configured against" — that identity lives entirely inside the
    // OpenCode profile/provider config, invisible to DSH's admission layer.
    // DSH only ever resolves `backend === 'opencode'` here.
    const council = normalizeCouncilSpec({ chair_profile_id: 'chair-opencode-api-model', participant_profile_ids: ['p1'], rounds: 1 });
    const calls = [];
    const driver = buildDriver({
      council, artifactStore: newArtifactStore(), taskId: 'task-k6',
      calls, capabilityPolicy: buildProductionCapabilityPolicy(),
      resolveReportBackend: realProductRoster({ productOf: () => 'opencode', calls }),
    });
    const result = await driver.decide({ turn: 1, history: [] });
    assert.equal(result.type, 'workflow', 'admission passed — an OpenCode-hosted profile is never distinguished by its underlying provider');
    assert.equal(calls.length, 0, 'decide() only plans the next step');
  });
});

// ==================================================================
// K7 — new profile / no-proof, across all six products
// ==================================================================

test('K7 — brand-new profile ids across all six products: SINGLE always admitted; Council/Debate admitted for five, rejected for api by product policy only', () => {
  const NEW_PROFILES = {
    'claude-code': 'live2-claude-brand-new', codex: 'live2-codex-brand-new', opencode: 'live2-opencode-brand-new',
    antigravity: 'live2-antigravity-brand-new', grok: 'live2-grok-brand-new', api: 'live2-api-brand-new',
  };
  for (const [product] of Object.entries(NEW_PROFILES)) {
    assert.equal(assertBackendTaskModeSupported(product, TASK_MODE.SINGLE).ok, true, `${product} SINGLE`);
  }
  for (const product of FULL_MULTI_AGENT) {
    for (const mode of [TASK_MODE.COUNCIL, TASK_MODE.DEBATE_MEMBER, TASK_MODE.DEBATE_CHAIR]) {
      assert.doesNotThrow(() => assertBackendTaskModeSupported(product, mode), `${product}/${mode} must never require per-profile proof`);
    }
  }
  for (const mode of [TASK_MODE.COUNCIL, TASK_MODE.DEBATE_MEMBER, TASK_MODE.DEBATE_CHAIR]) {
    assert.throws(() => assertBackendTaskModeSupported('api', mode), (e) => e.code === 'BACKEND_TASK_MODE_UNSUPPORTED');
  }
});

test('K7 — the named regression profile (live1-opencode-opencode-go-deepseek-v4-1-flash-high) remains admitted for every OpenCode-supported mode', () => {
  // The profile id itself is irrelevant to this table by construction — see
  // production-backend-capabilities.mjs's own docstring. Proven directly:
  for (const mode of Object.values(TASK_MODE)) {
    assert.equal(resolveBackendTaskModeSupport('opencode', mode).ok, true);
  }
});

// ==================================================================
// K8 — a complete non-Claude Debate round, end to end
// ==================================================================

test('K8 — a full offline Debate round with an OpenCode chair: brief -> responses -> synthesis -> typed control -> decision -> final artifact -> settlement', async () => {
  await withStores(async ({ newArtifactStore, newPmRepo, newStepState }) => {
    const council = normalizeCouncilSpec({
      chair_profile_id: 'chair-opencode', participant_profile_ids: ['member-codex', 'member-grok'], rounds: 1,
      debate: { enabled: true, max_rounds: 1 },
    });
    const calls = [];
    const productOf = productById({ 'chair-opencode': 'opencode', 'member-codex': 'codex', 'member-grok': 'grok' });
    const rt = buildRuntime({
      council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(),
      calls, taskId: 'task-k8', maxTurns: 40, capabilityPolicy: buildProductionCapabilityPolicy(),
      // stop after round 1 -> clean FINISH
      resolveReportBackend: realProductRoster({ productOf, debateTypedControl: true, continueDebate: () => false, calls }),
    });
    const res = await rt.run({ objective: 'debate it', pmRunId: 'k8'.repeat(50) + '01', context: { council, transport_version: 'artifact_v1' } });
    assert.equal(res.status, 'completed', 'ROUND_DECISION: PASS — the run reached a terminal FINISH');
    assert.ok(res.data.final_ref, 'FINAL_ARTIFACT: PASS');
    assert.equal(res.data.final_ref.sha256.length, 64);
    const stages = calls.map((c) => c.stage);
    assert.ok(stages.includes('debate-chair-brief'), 'ROUND_STARTED: PASS');
    assert.equal(stages.filter((s) => s === 'debate-member-response').length, 2, 'PARTICIPANT_REPORTS: PASS (both members)');
    assert.ok(stages.includes('debate-chair-synthesis'), 'CHAIR_SYNTHESIS: PASS — an OpenCode chair produced a synthesis');
    // TYPED_CONTROL_PARSE: PASS — the run only reached FINISH (never an
    // engine-forced-stop error or a hung loop) because the OpenCode chair's
    // same-execution typed-control envelope was successfully captured and
    // parsed (continueDebate:false above) — a missing/malformed capture
    // would have thrown DEBATE_CONTROL_* before this point.
    const store = newArtifactStore();
    const task = store.openTaskById('task-k8'); // SETTLEMENT: PASS — durable manifest reached COMPLETED
    assert.equal(task.freshManifest().task_state, 'COMPLETED');
  });
});

// ==================================================================
// K9 — mixed-backend Council (all five full-multi-agent families, no api)
// ==================================================================

test('K9 — a mixed five-backend Council roster (no API) completes through the real artifact/report orchestration', async () => {
  await withStores(async ({ newArtifactStore, newPmRepo, newStepState }) => {
    const council = normalizeCouncilSpec({
      chair_profile_id: 'chair-claude', participant_profile_ids: ['m-codex', 'm-opencode', 'm-antigravity', 'm-grok'], rounds: 1,
    });
    const calls = [];
    const productOf = productById({ 'chair-claude': 'claude-code', 'm-codex': 'codex', 'm-opencode': 'opencode', 'm-antigravity': 'antigravity', 'm-grok': 'grok' });
    const rt = buildRuntime({
      council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(),
      calls, taskId: 'task-k9', maxTurns: 40, capabilityPolicy: buildProductionCapabilityPolicy(),
      resolveReportBackend: realProductRoster({ productOf, calls }),
    });
    const res = await rt.run({ objective: 'x', pmRunId: 'k9'.repeat(50) + '01', context: { council, transport_version: 'artifact_v1' } });
    assert.equal(res.status, 'completed');
    assert.ok(res.data.final_ref);
    const backendsUsed = new Set(calls.map((c) => c.profileId));
    assert.deepEqual([...backendsUsed].sort(), ['chair-claude', 'm-antigravity', 'm-codex', 'm-grok', 'm-opencode'].sort());
  });
});

// ==================================================================
// K10 — mixed-backend Debate with a non-Claude chair (no api)
// ==================================================================

test('K10 — a mixed-backend Debate with a non-Claude (Antigravity) chair completes through settlement', async () => {
  await withStores(async ({ newArtifactStore, newPmRepo, newStepState }) => {
    const council = normalizeCouncilSpec({
      chair_profile_id: 'chair-antigravity', participant_profile_ids: ['m-claude', 'm-opencode'], rounds: 1,
      debate: { enabled: true, max_rounds: 1 },
    });
    const calls = [];
    const productOf = productById({ 'chair-antigravity': 'antigravity', 'm-claude': 'claude-code', 'm-opencode': 'opencode' });
    const rt = buildRuntime({
      council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(),
      calls, taskId: 'task-k10', maxTurns: 40, capabilityPolicy: buildProductionCapabilityPolicy(),
      resolveReportBackend: realProductRoster({ productOf, debateTypedControl: true, continueDebate: () => false, calls }),
    });
    const res = await rt.run({ objective: 'x', pmRunId: 'k10'.repeat(30) + '01', context: { council, transport_version: 'artifact_v1' } });
    assert.equal(res.status, 'completed');
    assert.ok(res.data.final_ref);
    assert.ok(calls.some((c) => c.profileId === 'chair-antigravity' && c.stage === 'debate-chair-synthesis'), 'a non-Claude chair produced the synthesis');
  });
});

// ==================================================================
// §F — stale "API incomplete" semantics audit (module-level, static)
// ==================================================================

test('§F — API_MULTI_AGENT_POLICY_GUIDANCE is the single shared source for the OpenCode-alternative explanation', () => {
  assert.match(API_MULTI_AGENT_POLICY_GUIDANCE, /Single tasks only/);
  assert.match(API_MULTI_AGENT_POLICY_GUIDANCE, /OpenCode/);
  assert.doesNotMatch(API_MULTI_AGENT_POLICY_GUIDANCE, /UNPROVEN|qualification|proof/i);
});
