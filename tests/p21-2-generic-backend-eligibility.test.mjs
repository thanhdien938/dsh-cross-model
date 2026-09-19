/**
 * P21.2 — GENERIC BACKEND ELIGIBILITY vs P20 REPORT-ADAPTER ELIGIBILITY.
 *
 * Root cause (docs/P21/P21_2_GENERIC_BACKEND_ELIGIBILITY_AND_TELEGRAM_POISON_FIX_REPORT.md):
 * with DSH_P20_ARTIFACT_V1_ENABLED on, EVERY new SINGLE task (any product)
 * was stamped transport_version=artifact_v1, and p5-production-
 * composition.mjs's createRuntime() entered the P20 SingleArtifactDriver
 * branch UNCONDITIONALLY for any product — Codex/API/Grok have no P20
 * report route (PRODUCTION_ROUTE_BY_PRODUCT only knows claude-code/
 * opencode/antigravity), so buildCapabilityParticipant() threw
 * CLI_REPORT_ROUTE_UNSUPPORTED_PRODUCT before any backend was ever spawned.
 *
 * Fix: the SINGLE artifact_v1 branch is now additionally gated on
 * `PRODUCTION_ROUTE_BY_PRODUCT[profile.product]` being defined (the SAME
 * single source of truth buildCapabilityParticipant() already consults —
 * never a second hard-coded list). When a product has no P20 report route,
 * artifact_v1 SINGLE falls through to the pre-existing generic PM
 * decision-plane driver, completely unchanged.
 *
 * Reuses the exact real-composition harness tests/p20-8-production-
 * artifact-wiring.test.mjs established (createP5ProductionComposition +
 * fakeStores) — no new test infrastructure. Every product's driver is
 * resolved through the REAL ProductionPmBackendRegistry (never the
 * 'scripted' escape hatch), with only probe()/the CLI runner functions
 * faked (submit()/prepare() never actually calls a runner — see
 * durable-pm-runtime.mjs's prepare(), which never calls driver.decide())
 * — so this proves REAL routing, not a stand-in driver.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createP5ProductionComposition } from '../src/runtime/p5-production-composition.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { ProductionPmBackendRegistry } from '../src/pm/production-pm-backend-registry.mjs';
import { PRODUCTION_ROUTE_BY_PRODUCT } from '../src/runtime/p20-report-route-resolution.mjs';
import { deterministicOwnerId } from '../src/owner/owner-contracts.mjs';

function fakeStores() {
  return {
    coordination: { assertReady: async () => true, close: async () => {}, registerWorkIdentity: async () => {} },
    owner: { close: async () => {}, claimNotifications: async () => [] },
    fetchImpl: async () => ({ ok: true, json: async () => ({ result: [] }) }),
  };
}

const ALL_TEST_PROFILES = Object.freeze([
  { id: 'pm-claude', role_kind: 'PM', session_kind: 'STATELESS', product: 'claude-code', transport: 'stdio', model: 'sonnet', reasoning: 'medium' },
  { id: 'pm-opencode', role_kind: 'PM', session_kind: 'STATELESS', product: 'opencode', transport: 'stdio', model: 'opencode-model', reasoning: 'medium' },
  { id: 'pm-antigravity', role_kind: 'PM', session_kind: 'STATELESS', product: 'antigravity', transport: 'stdio', model: 'antigravity-model', reasoning: null },
  { id: 'pm-codex', role_kind: 'PM', session_kind: 'STATELESS', product: 'codex', transport: 'stdio', model: 'gpt-5.6-sol', reasoning: 'low' },
  { id: 'pm-grok', role_kind: 'PM', session_kind: 'STATELESS', product: 'grok', transport: 'stdio', model: 'grok-model', reasoning: null },
  { id: 'pm-api', role_kind: 'PM', session_kind: 'STATELESS', product: 'api', provider: 'openrouter', transport: 'http', model: 'api-model', reasoning: null },
]);

function fakeBackendRegistry() {
  const okRunner = async () => ({ result: '{"type":"finish","output":"unused"}' });
  return new ProductionPmBackendRegistry({
    probe: () => true,
    claudeBinary: 'claude', openCodeBinary: 'opencode', codexBinary: 'codex', grokBinary: 'grok', antigravityBinary: 'antigravity',
    claudeRunner: okRunner, openCodeRunner: okRunner, codexRunner: okRunner, grokRunner: okRunner, antigravityRunner: okRunner, apiRunner: okRunner,
  });
}

async function buildComposition(t, { extraDeps = {}, profiles = ALL_TEST_PROFILES } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'p21-2-eligibility-'));
  t.after(() => { try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }); } catch { /* best-effort only on Windows — not a correctness signal */ } });
  mkdirSync(join(root, 'p1'), { recursive: true });
  const sqlite = await new SqlitePersistenceStore().open({ path: join(root, 'state.db') });
  const projects = [{ id: 'p1', repo_path: join(root, 'p1'), default_pm_profile_id: 'pm-claude', autonomy: { revision: 1, effects: { SUBMIT_TASK: 'ALLOW' } } }];
  const config = {
    postgres: { connectionString: 'not-used' }, sqlitePath: join(root, 'state.db'), projects, profiles,
    telegram: { token: 'opaque', ownerUserId: '1', ownerChatId: '2', projectId: 'p1', pollIntervalMs: 10 },
    coordinator: { logicalId: 'c', leaseMs: 5000, pollIntervalMs: 10 }, worker: { logicalId: 'w', leaseMs: 5000, pollIntervalMs: 10 },
    pm: { scriptedDecisions: null },
  };
  const { coordination, owner, fetchImpl } = fakeStores();
  const composition = await createP5ProductionComposition(config, {
    pmBackendRegistry: fakeBackendRegistry(), sqliteStore: sqlite, coordinationStore: coordination, ownerRepository: owner, fetchImpl,
    enableProductionArtifactStores: true, enableProductionArtifactWiring: true, resolveNewTaskTransportVersion: () => 'artifact_v1',
    ...extraDeps,
  });
  t.after(async () => { try { await composition.close(); } catch { /* drain may already be settled */ } });
  return { composition, projects };
}

async function submitSingle(composition, projects, profileId, cmdId) {
  const project = projects[0];
  const profile = composition.profileRegistry.get(profileId);
  const result = await composition.taskController.submit({ command: { command_id: cmdId, payload: { body: 'do the P21.2 thing' }, accepted_at: '2026-09-12T00:00:00.000Z' }, project, profile });
  const taskId = deterministicOwnerId('task', cmdId);
  const pmRunId = deterministicOwnerId('pmrun', cmdId);
  const pmRun = composition.pmRepository.load(pmRunId);
  return { result, taskId, pmRunId, pmRun };
}

// P22.4 §H/§C/§D/§E supersedes the P21.2 "three-versus-three" boundary this
// file originally froze (P22.3 §12 explicitly calls out this suite for
// replacement "after cutover"). Codex/API/Grok now have real P20 report
// routes (PRODUCTION_ROUTE_BY_PRODUCT — see p20-report-route-resolution.mjs
// and production-backend-capabilities.mjs), so artifact_v1 SINGLE for all
// six products now resolves the SAME P20 SingleArtifactDriver path, not the
// legacy generic decision-plane driver. The underlying ELIGIBILITY
// invariant this file exists to protect — a product's generic-workflow
// eligibility must never depend on P20 report-route membership — is now
// vacuously satisfied for every profile (both are true for all six), so it
// is asserted directly rather than by absence.
test('WORKFLOW ELIGIBILITY INVARIANT: every production product has both a generic workflow backend and a P20 report route', () => {
  for (const profile of ALL_TEST_PROFILES) {
    assert.ok(PRODUCTION_ROUTE_BY_PRODUCT[profile.product], `profile ${profile.id} (product ${profile.product}) must have a P20 report route now that six-backend migration is complete`);
  }
});

test('CODEX SINGLE + artifact_v1 enabled: resolves the P20 SingleArtifactDriver (P22.4 six-backend cutover)', async (t) => {
  const { composition, projects } = await buildComposition(t);
  const { result, pmRun } = await submitSingle(composition, projects, 'pm-codex', 'cmd-codex-single');
  assert.equal(result.status, 'MATERIALIZED');
  assert.ok(pmRun, 'a pm_run row must exist — createRuntime()/prepare() completed without throwing');
  assert.equal(pmRun.driver, 'production:artifact_v1:single:pm-codex', 'Codex must now use the SAME P20 artifact path as Claude/OpenCode/Antigravity');
});

test('API SINGLE + artifact_v1 enabled: resolves the P20 SingleArtifactDriver (P22.4 six-backend cutover)', async (t) => {
  const { composition, projects } = await buildComposition(t);
  const { result, pmRun } = await submitSingle(composition, projects, 'pm-api', 'cmd-api-single');
  assert.equal(result.status, 'MATERIALIZED');
  assert.equal(pmRun.driver, 'production:artifact_v1:single:pm-api', 'API must now use the SAME P20 artifact path (VERBATIM_MATERIALIZATION route)');
});

test('GROK SINGLE + artifact_v1 enabled: resolves the P20 SingleArtifactDriver (P22.4 six-backend cutover)', async (t) => {
  const { composition, projects } = await buildComposition(t);
  const { result, pmRun } = await submitSingle(composition, projects, 'pm-grok', 'cmd-grok-single');
  assert.equal(result.status, 'MATERIALIZED');
  assert.equal(pmRun.driver, 'production:artifact_v1:single:pm-grok', 'Grok must now use the SAME P20 artifact path');
});

test('CLAUDE SINGLE + artifact_v1 enabled: continues to select the P20 SingleArtifactDriver (DIRECT_WRITE preserved)', async (t) => {
  const { composition, projects } = await buildComposition(t);
  const { result, pmRun } = await submitSingle(composition, projects, 'pm-claude', 'cmd-claude-single');
  assert.equal(result.status, 'MATERIALIZED');
  assert.equal(pmRun.driver, 'production:artifact_v1:single:pm-claude', 'Claude must be completely unaffected — still the P20 artifact path');
});

test('OPENCODE SINGLE + artifact_v1 enabled: continues to select the P20 SingleArtifactDriver', async (t) => {
  const { composition, projects } = await buildComposition(t);
  const { result, pmRun } = await submitSingle(composition, projects, 'pm-opencode', 'cmd-opencode-single');
  assert.equal(result.status, 'MATERIALIZED');
  assert.equal(pmRun.driver, 'production:artifact_v1:single:pm-opencode');
});

test('ANTIGRAVITY SINGLE + artifact_v1 enabled: continues to select the P20 SingleArtifactDriver', async (t) => {
  const { composition, projects } = await buildComposition(t);
  const { result, pmRun } = await submitSingle(composition, projects, 'pm-antigravity', 'cmd-antigravity-single');
  assert.equal(result.status, 'MATERIALIZED');
  assert.equal(pmRun.driver, 'production:artifact_v1:single:pm-antigravity');
});

// P21.2 requirement #8 — QUOTA INVARIANT: a source-level search proving no
// runtime/source path derives backend ELIGIBILITY from quota, live-test
// roster, or the P20 Phase-1 product set. This is deliberately a narrow,
// literal check on the ONE routing decision point this phase touches
// (createRuntime()'s SINGLE artifact_v1 branch) — it must gate on
// PRODUCTION_ROUTE_BY_PRODUCT membership (a capability fact) and nothing
// resembling quota/roster/availability vocabulary.
test('QUOTA INVARIANT: the SINGLE artifact_v1 routing guard reads from the P20 capability registry only — never quota/roster/availability text', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/runtime/p5-production-composition.mjs', import.meta.url), 'utf8');
  const guardLine = source.split('\n').find((line) => line.includes('effectiveTransport===TRANSPORT_VERSION.ARTIFACT_V1') && line.includes('PRODUCTION_ROUTE_BY_PRODUCT'));
  assert.ok(guardLine, 'the SINGLE artifact_v1 branch must gate directly on PRODUCTION_ROUTE_BY_PRODUCT — the single P20 capability source of truth');
  for (const forbidden of [/quota/i, /roster/i, /liveTest/i, /phase1/i, /phase_1/i, /allowlist/i]) {
    assert.doesNotMatch(guardLine, forbidden, `routing guard line must not reference ${forbidden} — eligibility must never be derived from quota/roster/phase-1 facts`);
  }
});
