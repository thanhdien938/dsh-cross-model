/**
 * P22.4 — six-backend unified artifact execution migration.
 *
 * Authority: docs/P22/P22_3_SIX_BACKEND_UNIFIED_ARTIFACT_EXECUTION_ARCHITECTURE.md,
 * docs/P22/P22_4_COMPLETE_SIX_BACKEND_P20_P21_MIGRATION_AND_FINAL_AUDIT.md.
 *
 * Covers:
 *  - production-backend-capabilities.mjs: a static, profile-independent
 *    SUPPORTED/UNSUPPORTED authority — no per-tuple evidence file consulted.
 *  - all six products carry a PRODUCTION_ROUTE_BY_PRODUCT entry.
 *  - Codex/Grok report backends: VERBATIM_MATERIALIZATION + DIRECT_WRITE,
 *    including the same-execution Debate chair-synthesis typed-control
 *    envelope (Claude/OpenCode/Antigravity already had coverage elsewhere).
 *  - a real mixed six-backend Council roster is admitted through the full
 *    production composition with zero capability-evidence records.
 *  - the named regression profile reaches admission with an EMPTY registry.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PRODUCTION_BACKEND_SUPPORT, buildProductionCapabilityPolicy, resolveProductionCapability } from '../src/runtime/production-backend-capabilities.mjs';
import { PRODUCTION_ROUTE_BY_PRODUCT } from '../src/runtime/p20-report-route-resolution.mjs';
import { CAPABILITY_STATE } from '../src/artifacts/backend-report-capability.mjs';
import { createCodexReportBackend, createGrokReportBackend, extractCodexReportText, extractCodexFinalAssistantTextForDebateControl } from '../src/pm/report-backends/cli-report-backends.mjs';
import { summarizeCodexCliRun } from '../src/session/codex-cli-session-bridge.mjs';
import { resolveDebateTypedControlStatus, DEBATE_TYPED_CONTROL_STATUS } from '../src/pm/council/debate-backend-capability.mjs';
import { createApiReportBackend } from '../src/pm/api-backend/api-report-transport.mjs';
import { createP5ProductionComposition } from '../src/runtime/p5-production-composition.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { ProductionPmBackendRegistry } from '../src/pm/production-pm-backend-registry.mjs';
import { deterministicOwnerId } from '../src/owner/owner-contracts.mjs';

const ALL_SIX = Object.freeze(['claude-code', 'opencode', 'antigravity', 'codex', 'grok', 'api']);

// ---- helpers for a fake, deterministic CLI child process --------------
function fakeSpawn(stdoutText, { closeAfterMs = 0, exitCode = 0 } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {};
    child.stdin = { end: () => {}, on: () => {} };
    child.kill = () => { process.nextTick(() => { child.emit('exit', null, 'SIGTERM'); child.emit('close', null, 'SIGTERM'); }); };
    const emit = () => { child.stdout.emit('data', stdoutText); child.emit('close', exitCode); };
    if (closeAfterMs > 0) setTimeout(emit, closeAfterMs); else process.nextTick(emit);
    return child;
  };
}
function hangingSpawn() {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {};
    child.stdin = { end: () => {}, on: () => {} };
    child.kill = () => { process.nextTick(() => { child.emit('exit', null, 'SIGTERM'); child.emit('close', null, 'SIGTERM'); }); };
    return child; // never closes — exercises the bridge's own timeout
  };
}

// ---- §5/§G — production capability authority --------------------------

test('P22.4 §G: every PRODUCTION_BACKEND_SUPPORT product resolves PROVEN with NO capability-evidence registry involved', () => {
  const policy = buildProductionCapabilityPolicy();
  for (const [product, support] of Object.entries(PRODUCTION_BACKEND_SUPPORT)) {
    assert.equal(policy.backends[product].report_delivery[support.report_delivery], CAPABILITY_STATE.PROVEN, `${product} ${support.report_delivery} must be PROVEN`);
    assert.equal(policy.backends[product].artifact_input[support.artifact_input], CAPABILITY_STATE.PROVEN, `${product} ${support.artifact_input} must be PROVEN`);
  }
  // Calling it twice with different (irrelevant) inputs never changes the answer —
  // there is no profile/model/registry parameter to vary at all.
  const again = buildProductionCapabilityPolicy();
  assert.deepEqual(again, policy);
});

test('P22.4 §G: resolveProductionCapability fails closed for an unknown product/routeKind, never throws', () => {
  const bad = resolveProductionCapability('not-a-real-backend', 'report_delivery');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'PRODUCTION_CAPABILITY_UNSUPPORTED_PRODUCT');
  const badKind = resolveProductionCapability('codex', 'not_a_route_kind');
  assert.equal(badKind.ok, false);
  assert.equal(badKind.code, 'PRODUCTION_CAPABILITY_INVALID_ROUTE_KIND');
});

test('P22.4 §H: PRODUCTION_ROUTE_BY_PRODUCT now covers all six production backends', () => {
  for (const product of ALL_SIX) {
    assert.ok(PRODUCTION_ROUTE_BY_PRODUCT[product], `${product} must have a P20 production report route`);
  }
  assert.equal(PRODUCTION_ROUTE_BY_PRODUCT.api.deliveryMechanism, 'VERBATIM_MATERIALIZATION', 'api has no filesystem — DIRECT_WRITE must never be claimed');
  for (const product of ['claude-code', 'opencode', 'antigravity', 'codex', 'grok']) {
    assert.equal(PRODUCTION_ROUTE_BY_PRODUCT[product].deliveryMechanism, 'DIRECT_WRITE', `${product} must use DIRECT_WRITE`);
  }
});

// ---- §C/§E — Codex/Grok report backends --------------------------------

test('Codex report backend: VERBATIM_MATERIALIZATION success carries exact, non-trimmed bytes', async () => {
  const raw = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '  padded report body  \n' } }) + '\n';
  const backend = createCodexReportBackend({ model: 'gpt-5', cwd: '.', spawnImpl: fakeSpawn(raw) });
  const result = await backend.runReport({ prompt: 'x', request: { profileId: 'p1', executionId: 'e1' } });
  assert.equal(result.terminal_state, 'SUCCESS');
  assert.equal(result.accepted_visible_text, '  padded report body  \n', 'must NOT be trimmed — byte fidelity');
});

test('Codex report backend: DIRECT_WRITE success + valid Debate chair-synthesis control envelope', async () => {
  const raw = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'DSH_DEBATE_CONTROL_V1:{"continue_debate":true}' } });
  const backend = createCodexReportBackend({ model: 'gpt-5', deliveryMechanism: 'DIRECT_WRITE', cwd: '.', spawnImpl: fakeSpawn(raw) });
  assert.equal(backend.supportsDebateTypedControl, true);
  const result = await backend.runReport({ prompt: 'x', request: { profileId: 'p1', executionId: 'e1', stage: 'debate-chair-synthesis' } });
  assert.equal(result.terminal_state, 'SUCCESS');
  assert.deepEqual(result.debate_typed_control, { continue_debate: true });
});

test('Codex report backend: malformed control envelope fails closed (UNKNOWN_OUTCOME), never a false SUCCESS+control', async () => {
  const raw = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'not an envelope at all' } });
  const backend = createCodexReportBackend({ model: 'gpt-5', deliveryMechanism: 'DIRECT_WRITE', cwd: '.', spawnImpl: fakeSpawn(raw) });
  const result = await backend.runReport({ prompt: 'x', request: { profileId: 'p1', executionId: 'e1', stage: 'debate-chair-synthesis' } });
  assert.equal(result.terminal_state, 'UNKNOWN_OUTCOME');
  assert.equal(result.debate_typed_control, null);
});

test('Codex report backend: no assistant message event -> UNKNOWN_OUTCOME, never SUCCESS', async () => {
  const backend = createCodexReportBackend({ model: 'gpt-5', cwd: '.', spawnImpl: fakeSpawn('') });
  const result = await backend.runReport({ prompt: 'x', request: { profileId: 'p1', executionId: 'e1' } });
  assert.equal(result.terminal_state, 'UNKNOWN_OUTCOME');
  assert.equal(result.accepted_visible_text, null);
});

test('Codex report backend: process timeout is truthfully TIMEOUT, never SUCCESS', async () => {
  const backend = createCodexReportBackend({ model: 'gpt-5', cwd: '.', timeoutMs: 20, spawnImpl: hangingSpawn() });
  const result = await backend.runReport({ prompt: 'x', request: { profileId: 'p1', executionId: 'e1' } });
  assert.equal(result.terminal_state, 'TIMEOUT');
  assert.equal(result.timed_out, true);
});

// ---- Task8-codex-fix — Codex Debate control reads the FINAL agent_message
// only, never the report-plane concatenation (architectural defect fixed on
// its own merits; NOT presented as proof of the live Task 8 incident's root
// cause — see reports/TASK8_CODEX_DEBATE_CONTROL_RAW_EVIDENCE_AUDIT_20260914.md).

// A two-`agent_message` Codex run: an intermediate assistant message (as a
// real Codex turn might emit while narrating/writing the report file),
// followed by a FINAL message that is exactly one bounded control envelope.
function twoMessageRaw(finalText) {
  return [
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'intermediate assistant message' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: finalText } }),
  ].join('\n');
}

test('Task8-codex-fix — extractCodexReportText still concatenates BOTH agent_message events exactly (report-plane byte fidelity unchanged)', () => {
  const raw = twoMessageRaw('DSH_DEBATE_CONTROL_V1:{"continue_debate":true}');
  const summary = summarizeCodexCliRun({ stdout: raw, code: 0 });
  assert.equal(
    extractCodexReportText(summary),
    'intermediate assistant messageDSH_DEBATE_CONTROL_V1:{"continue_debate":true}',
    'the report-plane extractor must still concatenate every agent_message event with zero joining beyond straight concatenation',
  );
});

test('Task8-codex-fix — extractCodexFinalAssistantTextForDebateControl returns ONLY the last agent_message event, never a concatenation', () => {
  const raw = twoMessageRaw('DSH_DEBATE_CONTROL_V1:{"continue_debate":true}');
  const summary = summarizeCodexCliRun({ stdout: raw, code: 0 });
  assert.equal(
    extractCodexFinalAssistantTextForDebateControl(summary),
    'DSH_DEBATE_CONTROL_V1:{"continue_debate":true}',
    'must be exactly the FINAL agent_message text, with no earlier message concatenated in',
  );
});

test('Task8-codex-fix — mandatory regression: intermediate message + exact final envelope -> Debate control SUCCEEDS with continue_debate=true, while report bytes still carry both messages', async () => {
  const raw = twoMessageRaw('DSH_DEBATE_CONTROL_V1:{"continue_debate":true}');
  // Independently verify the report-plane byte-fidelity claim on the exact
  // same raw stdout this backend run below will consume.
  const summary = summarizeCodexCliRun({ stdout: raw, code: 0 });
  assert.equal(extractCodexReportText(summary), 'intermediate assistant messageDSH_DEBATE_CONTROL_V1:{"continue_debate":true}');

  const backend = createCodexReportBackend({ model: 'gpt-5', deliveryMechanism: 'DIRECT_WRITE', cwd: '.', spawnImpl: fakeSpawn(raw) });
  const result = await backend.runReport({ prompt: 'x', request: { profileId: 'p1', executionId: 'e1', stage: 'debate-chair-synthesis' } });
  assert.equal(result.terminal_state, 'SUCCESS', `expected SUCCESS despite the intermediate message, got ${JSON.stringify(result)}`);
  assert.deepEqual(result.debate_typed_control, { continue_debate: true });
});

test('Task8-codex-fix — mandatory regression: FINAL message has prose BEFORE the envelope -> UNKNOWN_OUTCOME (fails closed, strict parser unweakened)', async () => {
  const raw = twoMessageRaw('I finished.\nDSH_DEBATE_CONTROL_V1:{"continue_debate":true}');
  const backend = createCodexReportBackend({ model: 'gpt-5', deliveryMechanism: 'DIRECT_WRITE', cwd: '.', spawnImpl: fakeSpawn(raw) });
  const result = await backend.runReport({ prompt: 'x', request: { profileId: 'p1', executionId: 'e1', stage: 'debate-chair-synthesis' } });
  assert.equal(result.terminal_state, 'UNKNOWN_OUTCOME');
  assert.equal(result.debate_typed_control, null);
});

test('Task8-codex-fix — mandatory regression: FINAL message has prose AFTER the envelope -> UNKNOWN_OUTCOME (fails closed, strict parser unweakened)', async () => {
  const raw = twoMessageRaw('DSH_DEBATE_CONTROL_V1:{"continue_debate":false}\nDone.');
  const backend = createCodexReportBackend({ model: 'gpt-5', deliveryMechanism: 'DIRECT_WRITE', cwd: '.', spawnImpl: fakeSpawn(raw) });
  const result = await backend.runReport({ prompt: 'x', request: { profileId: 'p1', executionId: 'e1', stage: 'debate-chair-synthesis' } });
  assert.equal(result.terminal_state, 'UNKNOWN_OUTCOME');
  assert.equal(result.debate_typed_control, null);
});

test('Task8-codex-fix — mandatory regression: no agent_message event at all on a DIRECT_WRITE Debate chair-synthesis call -> UNKNOWN_OUTCOME', async () => {
  const backend = createCodexReportBackend({ model: 'gpt-5', deliveryMechanism: 'DIRECT_WRITE', cwd: '.', spawnImpl: fakeSpawn('') });
  const result = await backend.runReport({ prompt: 'x', request: { profileId: 'p1', executionId: 'e1', stage: 'debate-chair-synthesis' } });
  assert.equal(result.terminal_state, 'UNKNOWN_OUTCOME');
  assert.equal(result.debate_typed_control, null);
});

test('Grok report backend: VERBATIM_MATERIALIZATION success carries exact, non-trimmed bytes', async () => {
  const raw = JSON.stringify({ text: '  padded grok body  ' });
  const backend = createGrokReportBackend({ model: 'grok-4', cwd: '.', spawnImpl: fakeSpawn(raw) });
  const result = await backend.runReport({ prompt: 'x', request: { profileId: 'p2', executionId: 'e2' } });
  assert.equal(result.terminal_state, 'SUCCESS');
  assert.equal(result.accepted_visible_text, '  padded grok body  ');
});

test('Grok report backend: DIRECT_WRITE + valid Debate chair-synthesis control envelope', async () => {
  const raw = JSON.stringify({ text: 'DSH_DEBATE_CONTROL_V1:{"continue_debate":false}' });
  const backend = createGrokReportBackend({ model: 'grok-4', deliveryMechanism: 'DIRECT_WRITE', cwd: '.', spawnImpl: fakeSpawn(raw) });
  const result = await backend.runReport({ prompt: 'x', request: { profileId: 'p2', executionId: 'e2', stage: 'debate-chair-synthesis' } });
  assert.equal(result.terminal_state, 'SUCCESS');
  assert.deepEqual(result.debate_typed_control, { continue_debate: false });
});

test('Grok report backend: malformed JSON stdout -> UNKNOWN_OUTCOME, never SUCCESS', async () => {
  const backend = createGrokReportBackend({ model: 'grok-4', cwd: '.', spawnImpl: fakeSpawn('not json at all') });
  const result = await backend.runReport({ prompt: 'x', request: { profileId: 'p2', executionId: 'e2' } });
  assert.equal(result.terminal_state, 'UNKNOWN_OUTCOME');
});

test('Grok report backend: nonzero exit is PROVIDER_ERROR, never SUCCESS', async () => {
  const backend = createGrokReportBackend({ model: 'grok-4', cwd: '.', spawnImpl: fakeSpawn(JSON.stringify({ text: 'irrelevant' }), { exitCode: 1 }) });
  const result = await backend.runReport({ prompt: 'x', request: { profileId: 'p2', executionId: 'e2' } });
  assert.equal(result.terminal_state, 'PROVIDER_ERROR');
});

// ---- §I — Debate typed-control admission across backends ---------------

// P22.5: api's Debate-chair non-admission is now permanent product policy
// (see production-backend-capabilities.mjs / debate-backend-capability.mjs
// and tests/p22-5-multi-agent-product-policy.test.mjs's K5), not the
// "documented remaining gap" this test originally called it — the
// underlying capability primitive (resolveDebateTypedControlStatus) is
// unchanged and still correctly reports UNPROVEN for api, since no
// same-execution typed-control channel exists for it; P22.5 additionally
// rejects api at Debate admission BEFORE this check is ever reached.
test('Debate typed-control admission: all five DIRECT_WRITE backends admit; api is never admitted (SINGLE-only by product policy, not by missing proof)', () => {
  assert.equal(resolveDebateTypedControlStatus(createCodexReportBackend({ deliveryMechanism: 'DIRECT_WRITE', cwd: '.' })), DEBATE_TYPED_CONTROL_STATUS.PROVEN);
  assert.equal(resolveDebateTypedControlStatus(createGrokReportBackend({ deliveryMechanism: 'DIRECT_WRITE', cwd: '.' })), DEBATE_TYPED_CONTROL_STATUS.PROVEN);
  assert.equal(resolveDebateTypedControlStatus(createApiReportBackend({})), DEBATE_TYPED_CONTROL_STATUS.UNPROVEN, 'no same-execution typed-control channel exists for api; a Council/Debate roster containing api is now additionally rejected earlier, at task-mode admission');
});

// ---- §M/§L — real mixed six-backend Council admission, zero evidence ---

function fakeStores() {
  return {
    coordination: { assertReady: async () => true, close: async () => {}, registerWorkIdentity: async () => {} },
    owner: { close: async () => {}, claimNotifications: async () => [] },
    fetchImpl: async () => ({ ok: true, json: async () => ({ result: [] }) }),
  };
}

const SIX_BACKEND_PROFILES = Object.freeze([
  { id: 'pm-claude', role_kind: 'PM', session_kind: 'STATELESS', product: 'claude-code', transport: 'stdio', model: 'sonnet', reasoning: 'medium' },
  { id: 'pm-opencode', role_kind: 'PM', session_kind: 'STATELESS', product: 'opencode', transport: 'stdio', model: 'opencode-model', reasoning: 'medium' },
  { id: 'pm-antigravity', role_kind: 'PM', session_kind: 'STATELESS', product: 'antigravity', transport: 'stdio', model: 'antigravity-model', reasoning: null },
  { id: 'pm-codex', role_kind: 'PM', session_kind: 'STATELESS', product: 'codex', transport: 'stdio', model: 'gpt-5.6-sol', reasoning: 'low' },
  { id: 'pm-grok', role_kind: 'PM', session_kind: 'STATELESS', product: 'grok', transport: 'stdio', model: 'grok-model', reasoning: null },
  { id: 'pm-api', role_kind: 'PM', session_kind: 'STATELESS', product: 'api', provider: 'openrouter', transport: 'http', model: 'api-model', reasoning: null },
  // P22.4 §N.9 — the exact named regression profile: a brand-new profile
  // id for an existing product, with NO matching capability-evidence
  // record (this composition never even constructs a
  // CapabilityEvidenceRegistry with any records — see enableProductionArtifactWiring below).
  { id: 'live1-opencode-opencode-go-deepseek-v4-1-flash-high', role_kind: 'PM', session_kind: 'STATELESS', product: 'opencode', transport: 'stdio', model: 'opencode-go/deepseek-v4.1-flash', reasoning: 'high' },
]);

async function buildSixBackendComposition(t, extraDeps = {}) {
  const root = mkdtempSync(join(tmpdir(), 'p22-4-six-backend-'));
  t.after(() => { try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }); } catch { /* Windows best-effort */ } });
  mkdirSync(join(root, 'p1'), { recursive: true });
  const sqlite = await new SqlitePersistenceStore().open({ path: join(root, 'state.db') });
  const projects = [{ id: 'p1', repo_path: join(root, 'p1'), default_pm_profile_id: 'pm-claude', autonomy: { revision: 1, effects: { SUBMIT_TASK: 'ALLOW' } } }];
  const config = {
    postgres: { connectionString: 'not-used' }, sqlitePath: join(root, 'state.db'), projects, profiles: SIX_BACKEND_PROFILES,
    telegram: { token: 'opaque', ownerUserId: '1', ownerChatId: '2', projectId: 'p1', pollIntervalMs: 10 },
    coordinator: { logicalId: 'c', leaseMs: 5000, pollIntervalMs: 10 }, worker: { logicalId: 'w', leaseMs: 5000, pollIntervalMs: 10 },
    pm: { scriptedDecisions: null },
  };
  const okRunner = async () => ({ result: '{"type":"finish","output":"unused"}' });
  const backend = new ProductionPmBackendRegistry({
    probe: () => true,
    claudeBinary: 'claude', openCodeBinary: 'opencode', codexBinary: 'codex', grokBinary: 'grok', antigravityBinary: 'antigravity',
    claudeRunner: okRunner, openCodeRunner: okRunner, codexRunner: okRunner, grokRunner: okRunner, antigravityRunner: okRunner, apiRunner: okRunner,
  });
  const { coordination, owner, fetchImpl } = fakeStores();
  // P22.4 §G proof-by-construction: `enableProductionArtifactWiring: true`
  // WITHOUT ever supplying/populating a capabilityEvidenceRegistry file —
  // admission must not need one any more.
  const composition = await createP5ProductionComposition(config, {
    pmBackendRegistry: backend, sqliteStore: sqlite, coordinationStore: coordination, ownerRepository: owner, fetchImpl,
    enableProductionArtifactStores: true, enableProductionArtifactWiring: true, resolveNewTaskTransportVersion: () => 'artifact_v1',
    ...extraDeps,
  });
  t.after(async () => { try { await composition.close(); } catch { /* drain may already be settled */ } });
  return { composition, projects };
}

test('P22.4 §M/§N: a mixed six-backend Council roster is admitted with zero capability-evidence records', async (t) => {
  const { composition, projects } = await buildSixBackendComposition(t);
  const project = projects[0];
  const profile = composition.profileRegistry.get('pm-claude');
  const council = {
    chair_profile_id: 'pm-claude',
    participant_profile_ids: ['pm-opencode', 'pm-antigravity', 'pm-codex', 'pm-grok', 'pm-api'],
    kind: 'COUNCIL', rounds: 1, strategy: 'independent_then_critique_then_synthesis', workspace_requirement: 'NONE',
  };
  const result = await composition.taskController.submit({
    command: { command_id: 'cmd-six-backend-council', payload: { body: 'mixed six-backend council' }, accepted_at: '2026-09-13T00:00:00.000Z' },
    project, profile, council,
  });
  assert.equal(result.status, 'MATERIALIZED', 'a mixed six-backend roster must be admitted, not rejected as CLI_REPORT_ROUTE_UNSUPPORTED_PRODUCT / *_UNPROVEN / CAPABILITY_OVERLAY_CONFLICT');
  const taskId = deterministicOwnerId('task', 'cmd-six-backend-council');
  const pmRun = composition.pmRepository.load(deterministicOwnerId('pmrun', 'cmd-six-backend-council'));
  assert.ok(pmRun, `pm_run row must exist for task ${taskId}`);
});

test('P22.4 §N.9: the named regression profile (new opencode profile id, zero evidence) is admitted for SINGLE', async (t) => {
  const { composition, projects } = await buildSixBackendComposition(t);
  const project = projects[0];
  const profileId = 'live1-opencode-opencode-go-deepseek-v4-1-flash-high';
  const profile = composition.profileRegistry.get(profileId);
  const result = await composition.taskController.submit({
    command: { command_id: 'cmd-named-regression', payload: { body: 'named regression profile probe' }, accepted_at: '2026-09-13T00:00:00.000Z' },
    project, profile,
  });
  assert.equal(result.status, 'MATERIALIZED');
  const pmRun = composition.pmRepository.load(deterministicOwnerId('pmrun', 'cmd-named-regression'));
  assert.equal(pmRun.driver, 'production:artifact_v1:single:live1-opencode-opencode-go-deepseek-v4-1-flash-high', 'must resolve the P20 artifact SingleArtifactDriver — never ARTIFACT_REPORT_DELIVERY_UNPROVEN, never CAPABILITY_OVERLAY_CONFLICT');
});
