import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PmProfileRegistry, profileFingerprint } from '../src/pm/pm-profile-registry.mjs';
import { formatPmProfileLabel, formatPmProfileCompact, pmProductDisplayName } from '../src/pm/pm-profile-display.mjs';
import { PmProfileStatusStore } from '../src/pm/pm-profile-status-store.mjs';
import { OwnerControlService } from '../src/owner/owner-control-service.mjs';

// P9-R0.4 Part V: PM profile lifecycle (deactivate/reactivate) + the one
// canonical display helper, and their two trusted enforcement points —
// PmProfileRegistry (identity/fingerprint) and OwnerControlService
// (execution-time gating for both Desktop and Telegram, since both funnel
// through the same #validateBeforeAcceptance — see
// src/owner/owner-control-service.mjs).

// ==== Part V items 1-5: display helper ====================================

test('display helper: Claude Code with model + reasoning', () => {
  assert.equal(formatPmProfileLabel({ product: 'claude-code', model: 'sonnet', reasoning: 'high' }), 'Claude Code · sonnet · high');
});

test('display helper: OpenCode with a slashed model id', () => {
  assert.equal(formatPmProfileLabel({ product: 'opencode', model: 'opencode-go/deepseek-v4-flash', reasoning: 'high' }), 'OpenCode · opencode-go/deepseek-v4-flash · high');
});

test('display helper: Codex with no model configured (default/inherited)', () => {
  assert.equal(formatPmProfileLabel({ product: 'codex', model: null, reasoning: 'medium' }), 'Codex · default/inherited · medium');
});

test('display helper: Grok with no reasoning configured (default/inherited)', () => {
  assert.equal(formatPmProfileLabel({ product: 'grok', model: 'grok-4.5', reasoning: null }), 'Grok · grok-4.5 · default/inherited');
});

test('display helper: Antigravity shows the stored model-encoded reasoning as-is, no invented semantics', () => {
  assert.equal(formatPmProfileLabel({ product: 'antigravity', model: 'gemini-3.7-flash-high', reasoning: 'high' }), 'Antigravity · gemini-3.7-flash-high · high');
  assert.equal(formatPmProfileLabel({ product: 'antigravity', model: 'gemini-3.5-flash-medium', reasoning: 'medium' }), 'Antigravity · gemini-3.5-flash-medium · medium');
});

test('display helper: unknown product falls back to the raw value rather than throwing', () => {
  assert.equal(pmProductDisplayName('some-future-backend'), 'some-future-backend');
  assert.doesNotThrow(() => formatPmProfileLabel({ product: 'some-future-backend', model: null, reasoning: null }));
});

test('display helper compact form omits reasoning when unset, never prints "default/inherited" twice', () => {
  assert.equal(formatPmProfileCompact({ product: 'codex', model: null, reasoning: 'medium' }), 'Codex | default/inherited | medium');
  assert.equal(formatPmProfileCompact({ product: 'grok', model: 'grok-4.5', reasoning: null }), 'Grok | grok-4.5');
});

// ==== Part V items 6-12: registry lifecycle + immutability =================

test('existing profiles (no status key) default to ACTIVE', () => {
  const registry = new PmProfileRegistry([{ id: 'a', role_kind: 'PM', session_kind: 'STATELESS', product: 'claude-code', transport: 'stdio' }]);
  assert.equal(registry.get('a').status, 'ACTIVE');
});

test('an explicit ACTIVE/INACTIVE status round-trips', () => {
  const registry = new PmProfileRegistry([
    { id: 'a', role_kind: 'PM', session_kind: 'STATELESS', product: 'claude-code', transport: 'stdio', status: 'ACTIVE' },
    { id: 'b', role_kind: 'PM', session_kind: 'STATELESS', product: 'claude-code', transport: 'stdio', status: 'INACTIVE' },
  ]);
  assert.equal(registry.get('a').status, 'ACTIVE');
  assert.equal(registry.get('b').status, 'INACTIVE');
});

test('an invalid status value is refused at construction', () => {
  assert.throws(() => new PmProfileRegistry([{ id: 'a', role_kind: 'PM', session_kind: 'STATELESS', product: 'claude-code', transport: 'stdio', status: 'DELETED' }]), TypeError);
});

test('Part R: status is NOT part of the execution-identity fingerprint — deactivate/reactivate never changes it', () => {
  const base = { id: 'x', role_kind: 'PM', session_kind: 'STATELESS', product: 'claude-code', transport: 'stdio', model: 'sonnet', reasoning: 'high' };
  const active = new PmProfileRegistry([{ ...base, status: 'ACTIVE' }]).get('x');
  const inactive = new PmProfileRegistry([{ ...base, status: 'INACTIVE' }]).get('x');
  assert.equal(active.fingerprint, inactive.fingerprint);
  assert.equal(active.fingerprint, profileFingerprint(base));
});

test('a durable pm_run pinned fingerprint still resolves after the profile is deactivated', () => {
  const before = new PmProfileRegistry([{ id: 'x', role_kind: 'PM', session_kind: 'STATELESS', product: 'codex', transport: 'stdio' }]);
  const historicalFingerprint = before.get('x').fingerprint;
  const afterDeactivate = new PmProfileRegistry([{ id: 'x', role_kind: 'PM', session_kind: 'STATELESS', product: 'codex', transport: 'stdio', status: 'INACTIVE' }]);
  assert.doesNotThrow(() => afterDeactivate.assertPinned('x', historicalFingerprint));
  assert.equal(afterDeactivate.get('x').status, 'INACTIVE');
});

// ==== Part V items 18/21/22/26-29: OwnerControlService execution gate =====
// This is the ONE trusted choke point Desktop's owner:submitTask and every
// Telegram SUBMIT_TASK route (canonical @project --pm, shorthand, alias)
// all funnel through — see docs/p9/08_*.md.

function service({ profiles, statusResolver = null } = {}) {
  const repository = { beginCommand: async () => ({ status: 'ACCEPTED', created_at: 'now' }), completeCommand: async (_id, canonical) => ({ status: 'COMPLETED', canonical_result: canonical }) };
  const taskController = { submit: async (x) => ({ task_id: 't', profile_id: x.profile.id }) };
  const project = { id: 'p', default_pm_profile_id: profiles[0].id, autonomy: { revision: 1, effects: {} } };
  return new OwnerControlService({ repository, taskController, projects: [project], pmProfiles: profiles, statusResolver });
}

test('SINGLE mode: an INACTIVE PM profile is rejected with a typed PM_PROFILE_INACTIVE error', async () => {
  const svc = service({ profiles: [{ id: 'a', status: 'INACTIVE' }] });
  await assert.rejects(
    svc.mutate({ command_id: 'c1', actor_id: '1', client_kind: 'LOCAL', operation: 'SUBMIT_TASK', project_id: 'p', payload: { body: 'x', pm_profile_id: 'a' } }),
    (e) => e.code === 'PM_PROFILE_INACTIVE' && e.profileId === 'a',
  );
});

test('SINGLE mode: an ACTIVE PM profile is accepted (default project profile, no explicit status field)', async () => {
  const svc = service({ profiles: [{ id: 'a' }] });
  const result = await svc.mutate({ command_id: 'c2', actor_id: '1', client_kind: 'LOCAL', operation: 'SUBMIT_TASK', project_id: 'p', payload: { body: 'x' } });
  assert.equal(result.status, 'COMPLETED');
});

test('SINGLE mode: an unknown profile id is still PM_PROFILE_UNAVAILABLE, distinct from PM_PROFILE_INACTIVE', async () => {
  const svc = service({ profiles: [{ id: 'a' }] });
  await assert.rejects(
    svc.mutate({ command_id: 'c3', actor_id: '1', client_kind: 'LOCAL', operation: 'SUBMIT_TASK', project_id: 'p', payload: { body: 'x', pm_profile_id: 'missing' } }),
    (e) => e.code === 'PM_PROFILE_UNAVAILABLE',
  );
});

test('COUNCIL mode: an INACTIVE chair is rejected before execution', async () => {
  const svc = service({ profiles: [{ id: 'chair', status: 'INACTIVE' }, { id: 'p1' }] });
  await assert.rejects(
    svc.mutate({ command_id: 'c4', actor_id: '1', client_kind: 'LOCAL', operation: 'SUBMIT_TASK', project_id: 'p', payload: { body: 'x', council: { chair_profile_id: 'chair', participant_profile_ids: ['p1'] } } }),
    (e) => e.code === 'PM_PROFILE_INACTIVE' && e.profileId === 'chair',
  );
});

test('COUNCIL mode: an INACTIVE participant is rejected before execution — never silently dropped from the council', async () => {
  const svc = service({ profiles: [{ id: 'chair' }, { id: 'p1', status: 'INACTIVE' }, { id: 'p2' }] });
  await assert.rejects(
    svc.mutate({ command_id: 'c5', actor_id: '1', client_kind: 'LOCAL', operation: 'SUBMIT_TASK', project_id: 'p', payload: { body: 'x', council: { chair_profile_id: 'chair', participant_profile_ids: ['p1', 'p2'] } } }),
    (e) => e.code === 'PM_PROFILE_INACTIVE' && e.profileId === 'p1',
  );
});

test('COUNCIL mode: every-participant-ACTIVE council is accepted', async () => {
  const svc = service({ profiles: [{ id: 'chair' }, { id: 'p1' }, { id: 'p2' }] });
  const result = await svc.mutate({ command_id: 'c6', actor_id: '1', client_kind: 'LOCAL', operation: 'SUBMIT_TASK', project_id: 'p', payload: { body: 'x', council: { chair_profile_id: 'chair', participant_profile_ids: ['p1', 'p2'] } } });
  assert.equal(result.status, 'COMPLETED');
});

test('a live statusResolver overrides the frozen snapshot — a deactivate takes effect on the very next command, no restart/reconstruction needed', async () => {
  let live = 'ACTIVE';
  const svc = service({ profiles: [{ id: 'a', status: 'ACTIVE' }], statusResolver: async (id) => (id === 'a' ? live : undefined) });
  const first = { command_id: 'c7', actor_id: '1', client_kind: 'LOCAL', operation: 'SUBMIT_TASK', project_id: 'p', payload: { body: 'x', pm_profile_id: 'a' } };
  assert.equal((await svc.mutate(first)).status, 'COMPLETED');
  live = 'INACTIVE';
  const second = { ...first, command_id: 'c8' };
  await assert.rejects(svc.mutate(second), (e) => e.code === 'PM_PROFILE_INACTIVE');
});

test('a statusResolver that cannot resolve an id (undefined) falls back to the frozen snapshot rather than failing the command', async () => {
  const svc = service({ profiles: [{ id: 'a', status: 'ACTIVE' }], statusResolver: async () => undefined });
  const result = await svc.mutate({ command_id: 'c9', actor_id: '1', client_kind: 'LOCAL', operation: 'SUBMIT_TASK', project_id: 'p', payload: { body: 'x', pm_profile_id: 'a' } });
  assert.equal(result.status, 'COMPLETED');
});

test('an ALREADY-RUNNING run is never killed by a mid-flight deactivate — the guard only gates NEW SUBMIT_TASK acceptance', async () => {
  // The guard lives entirely in #validateBeforeAcceptance, which runs
  // once, before repository.beginCommand — it has no reach into an
  // already-accepted/already-dispatched PmRun at all, so there is nothing
  // here that could reach into (let alone kill) in-flight execution.
  let started = 0;
  const repository = { beginCommand: async () => ({ status: 'ACCEPTED', created_at: 'now' }), completeCommand: async (_id, x) => x };
  const taskController = { submit: async () => { started += 1; return { task_id: 't' }; } };
  const project = { id: 'p', default_pm_profile_id: 'a', autonomy: { revision: 1, effects: {} } };
  let live = 'ACTIVE';
  const svc = new OwnerControlService({ repository, taskController, projects: [project], pmProfiles: [{ id: 'a', status: 'ACTIVE' }], statusResolver: async () => live });
  await svc.mutate({ command_id: 'c10', actor_id: '1', client_kind: 'LOCAL', operation: 'SUBMIT_TASK', project_id: 'p', payload: { body: 'x' } });
  assert.equal(started, 1);
  live = 'INACTIVE'; // deactivated mid-flight — the already-started run above is untouched.
  await assert.rejects(svc.mutate({ command_id: 'c11', actor_id: '1', client_kind: 'LOCAL', operation: 'SUBMIT_TASK', project_id: 'p', payload: { body: 'x' } }), (e) => e.code === 'PM_PROFILE_INACTIVE');
  assert.equal(started, 1); // no second run started by the rejected attempt.
});

// ==== PmProfileStatusStore ==================================================

test('PmProfileStatusStore reads the live status field fresh off disk', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'p9-status-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'pm-profiles.yaml');
  writeFileSync(path, 'pm_profiles:\n  - id: a\n    status: ACTIVE\n  - id: b\n    status: INACTIVE\n');
  const store = new PmProfileStatusStore(path);
  assert.equal(await store.getStatus('a'), 'ACTIVE');
  assert.equal(await store.getStatus('b'), 'INACTIVE');
  assert.equal(await store.getStatus('unknown'), undefined);

  writeFileSync(path, 'pm_profiles:\n  - id: a\n    status: INACTIVE\n');
  assert.equal(await store.getStatus('a'), 'INACTIVE');
});

test('PmProfileStatusStore fails soft (undefined) on a missing or malformed file', async () => {
  const store = new PmProfileStatusStore(join(tmpdir(), `does-not-exist-${Date.now()}.yaml`));
  assert.equal(await store.getStatus('a'), undefined);
});
