import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TelegramOwnerAdapter } from '../src/owner/telegram-owner-client.mjs';
import { TelegramAliasRegistry } from '../src/owner/telegram-alias-registry.mjs';
import { OwnerControlService } from '../src/owner/owner-control-service.mjs';
import { PmProfileStatusStore } from '../src/pm/pm-profile-status-store.mjs';
import { PmProfileRegistry } from '../src/pm/pm-profile-registry.mjs';

// P9-R0.4.2 — owner-live bug: Desktop deactivated live1-codex-pm (alias 3)
// through the real PM Profile Management UI; Desktop's own selectors
// updated immediately, but Telegram's /profiles kept showing alias 3 as
// ACTIVE and undercounted the hidden total, because OwnerControlService's
// GET_PM_PROFILES read returned the frozen, construction-time `pmProfiles`
// snapshot verbatim — never consulting the same PmProfileStatusStore the
// SUBMIT_TASK execution gate already re-reads live. This file reproduces
// the exact bug (Part I) and proves the fix: GET_PM_PROFILES now resolves
// CURRENT status for every profile at request time, via the SAME store.

const PROFILES = [
  { id: 'live1-codex-pm', role_kind: 'PM', session_kind: 'STATELESS', product: 'codex', transport: 'stdio', model: null, reasoning: 'medium', status: 'ACTIVE' }, // alias 3
  { id: 'live1-antigravity-gemini-high', role_kind: 'PM', session_kind: 'STATELESS', product: 'antigravity', transport: 'stdio', model: 'gemini-3.7-flash-high', reasoning: 'high', status: 'ACTIVE' }, // alias 7
  { id: 'live1-antigravity-gemini-3-7-flash-high', role_kind: 'PM', session_kind: 'STATELESS', product: 'antigravity', transport: 'stdio', model: 'gemini-3.7-flash-high', reasoning: 'high', status: 'INACTIVE' }, // alias 8
  { id: 'live1-codex-gpt-5-6-sol-pm', role_kind: 'PM', session_kind: 'STATELESS', product: 'codex', transport: 'stdio', model: 'gpt-5.6-sol', reasoning: 'medium', status: 'ACTIVE' }, // alias 9
];

function writeProfilesYaml(path, profiles) {
  const lines = ['pm_profiles:'];
  for (const p of profiles) {
    lines.push(`  - id: ${p.id}`, `    role_kind: ${p.role_kind}`, `    session_kind: ${p.session_kind}`, `    product: ${p.product}`, `    transport: ${p.transport}`, `    model: ${p.model ?? 'null'}`, `    reasoning: ${p.reasoning ?? 'null'}`, `    status: ${p.status}`);
  }
  writeFileSync(path, lines.join('\n') + '\n');
}

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'p9-telegram-fresh-lifecycle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const profilesPath = join(dir, 'pm-profiles.yaml');
  writeProfilesYaml(profilesPath, PROFILES);

  // The frozen, construction-time registry (execution identity + the
  // status the profile had AT STARTUP — exactly what a real runtime
  // process's PmProfileRegistry snapshot looks like).
  const registry = new PmProfileRegistry(PROFILES);
  const statusStore = new PmProfileStatusStore(profilesPath);
  const repository = { beginCommand: async () => ({ status: 'ACCEPTED', created_at: 'now' }), completeCommand: async (_id, canonical) => ({ status: 'COMPLETED', canonical_result: canonical }) };
  const taskController = { submit: async () => ({ task_id: 't' }) };
  const project = { id: 'live1-local', default_pm_profile_id: 'live1-codex-gpt-5-6-sol-pm', autonomy: { revision: 1, effects: {} } };
  const service = new OwnerControlService({
    repository,
    taskController,
    projects: [project],
    pmProfiles: registry.list(),
    statusResolver: (id) => statusStore.getStatus(id),
    statusListResolver: () => statusStore.getAllStatuses(),
  });
  const aliasRegistry = new TelegramAliasRegistry({
    projects: { 1: 'live1-local' },
    pmProfiles: { 3: 'live1-codex-pm', 7: 'live1-antigravity-gemini-high', 8: 'live1-antigravity-gemini-3-7-flash-high', 9: 'live1-codex-gpt-5-6-sol-pm' },
  });

  return { dir, profilesPath, registry, statusStore, service, aliasRegistry, project, pmProfiles: registry.list() };
}

async function sendCommand({ service, aliasRegistry, projects = [{ id: 'live1-local' }], pmProfiles }, text) {
  const sent = [];
  const fetchImpl = async (url, init) => {
    if (url.includes('getUpdates')) return { ok: true, json: async () => ({ result: [{ update_id: Date.now() + Math.random(), message: { from: { id: 1 }, chat: { id: 2 }, text } }] }) };
    sent.push(JSON.parse(init.body).text);
    return { ok: true, json: async () => ({}) };
  };
  const adapter = new TelegramOwnerAdapter({ token: 't', ownerUserId: '1', ownerChatId: '2', projects, pmProfiles, aliasRegistry, service, fetchImpl });
  await adapter.pollOnce();
  return sent[0];
}

// ==== Part I: the exact owner bug, reproduced and fixed =====================

test('Part I/N1-N3: a lifecycle change AFTER client construction is reflected on the very next /profiles — no client reconstruction', async (t) => {
  const ctx = setup(t);
  // Sanity: both profile 3 and 9 visible/active at first.
  const before = await sendCommand(ctx, '/profiles');
  assert.match(before, /live1-codex-pm/);
  assert.match(before, /1 inactive profile hidden/); // only alias 8 inactive so far

  // Desktop deactivates alias 3 (live1-codex-pm) — a plain file write,
  // exactly what PmProfileConfigService.deactivate() does. The Telegram
  // client/adapter/service objects above are NOT reconstructed.
  writeProfilesYaml(ctx.profilesPath, PROFILES.map((p) => (p.id === 'live1-codex-pm' ? { ...p, status: 'INACTIVE' } : p)));

  const after = await sendCommand(ctx, '/profiles');
  assert.doesNotMatch(after, /live1-codex-pm/);
  assert.doesNotMatch(after, /live1-antigravity-gemini-3-7-flash-high/);
  assert.match(after, /2 inactive profiles hidden/); // Part D/N3: accurate fresh count
});

test('Part E/N4: /profiles all marks BOTH freshly- and previously-inactive profiles', async (t) => {
  const ctx = setup(t);
  writeProfilesYaml(ctx.profilesPath, PROFILES.map((p) => (p.id === 'live1-codex-pm' ? { ...p, status: 'INACTIVE' } : p)));
  const text = await sendCommand(ctx, '/profiles all');
  assert.match(text, /3 — live1-codex-pm \[INACTIVE\]/);
  assert.match(text, /8 — live1-antigravity-gemini-3-7-flash-high \[INACTIVE\]/);
  // Still-ACTIVE profiles show their id WITHOUT the [INACTIVE] marker.
  assert.ok(text.includes('7 — live1-antigravity-gemini-high\n'));
  assert.ok(!text.includes('7 — live1-antigravity-gemini-high [INACTIVE]'));
  assert.ok(text.includes('9 — live1-codex-gpt-5-6-sol-pm\n'));
  assert.ok(!text.includes('9 — live1-codex-gpt-5-6-sol-pm [INACTIVE]'));
});

test('Part F/N5: /aliases marks fresh inactive status for both aliases', async (t) => {
  const ctx = setup(t);
  writeProfilesYaml(ctx.profilesPath, PROFILES.map((p) => (p.id === 'live1-codex-pm' ? { ...p, status: 'INACTIVE' } : p)));
  const text = await sendCommand(ctx, '/aliases');
  assert.match(text, /3 = live1-codex-pm \[INACTIVE\]/);
  assert.match(text, /8 = live1-antigravity-gemini-3-7-flash-high \[INACTIVE\]/);
  assert.match(text, /9 = live1-codex-gpt-5-6-sol-pm\n/); // no [INACTIVE] marker
  assert.doesNotMatch(text.split('9 = live1-codex-gpt-5-6-sol-pm')[1].split('\n')[0], /INACTIVE/);
  // Part F: alias reservation itself is untouched — every alias still lists.
  assert.match(text, /7 = live1-antigravity-gemini-high/);
});

// ==== Part J: reactivation is equally fresh, same alias/id/model ==========

test('Part J/N6-N9: reactivation reappears immediately with the exact same canonical id, alias, model, and reasoning', async (t) => {
  const ctx = setup(t);
  writeProfilesYaml(ctx.profilesPath, PROFILES.map((p) => (p.id === 'live1-codex-pm' ? { ...p, status: 'INACTIVE' } : p)));
  const inactiveText = await sendCommand(ctx, '/profiles');
  assert.doesNotMatch(inactiveText, /live1-codex-pm/);

  // Reactivate — same file, same fields, status flips back only.
  writeProfilesYaml(ctx.profilesPath, PROFILES); // back to the original all-fields-unchanged state

  const reactivatedText = await sendCommand(ctx, '/profiles');
  assert.match(reactivatedText, /3 — live1-codex-pm\n\s+Codex · default\/inherited · medium/);
  assert.match(reactivatedText, /1 inactive profile hidden/); // only alias 8 again

  const aliasesText = await sendCommand(ctx, '/aliases');
  assert.ok(aliasesText.includes('3 = live1-codex-pm\n'));
  assert.ok(!aliasesText.includes('3 = live1-codex-pm [INACTIVE]'));
});

// ==== Part K: execution gate is completely unaffected by this wave ========

test('Part K: PM_PROFILE_INACTIVE execution gate is unchanged — inactive profile 3 rejected, active profile 9 accepted', async (t) => {
  const ctx = setup(t);
  writeProfilesYaml(ctx.profilesPath, PROFILES.map((p) => (p.id === 'live1-codex-pm' ? { ...p, status: 'INACTIVE' } : p)));

  await assert.rejects(
    ctx.service.mutate({ command_id: 'c1', actor_id: '1', client_kind: 'LOCAL', operation: 'SUBMIT_TASK', project_id: 'live1-local', payload: { body: 'x', pm_profile_id: 'live1-codex-pm' } }),
    (e) => e.code === 'PM_PROFILE_INACTIVE',
  );
  const accepted = await ctx.service.mutate({ command_id: 'c2', actor_id: '1', client_kind: 'LOCAL', operation: 'SUBMIT_TASK', project_id: 'live1-local', payload: { body: 'x', pm_profile_id: 'live1-codex-gpt-5-6-sol-pm' } });
  assert.equal(accepted.status, 'COMPLETED');
});

// ==== Part G: failure policy — a broken lifecycle read never claims ACTIVE =

test('Part G: a broken/unreadable pm-profiles.yaml never causes /profiles to silently claim everything ACTIVE', async (t) => {
  const ctx = setup(t);
  // Simulate mid-write/corruption: malformed YAML.
  writeFileSync(ctx.profilesPath, ': not: valid: yaml: [[[');
  const text = await sendCommand(ctx, '/profiles');
  // Falls back to each profile's OWN frozen snapshot status (alias 8 was
  // INACTIVE at construction time and stays shown as such) rather than
  // inventing "everyone is ACTIVE" — and says so explicitly.
  assert.doesNotMatch(text, /live1-antigravity-gemini-3-7-flash-high/);
  assert.match(text, /live1-codex-pm/); // frozen snapshot: still ACTIVE at construction time
  assert.match(text, /could not be confirmed/);
});

// ==== Part H: identity fields are never touched by any of this ============

test('Part H: canonical id/product/model/reasoning are identical before and after a lifecycle flip', async (t) => {
  const ctx = setup(t);
  const before = await sendCommand(ctx, '/profiles all');
  writeProfilesYaml(ctx.profilesPath, PROFILES.map((p) => (p.id === 'live1-codex-pm' ? { ...p, status: 'INACTIVE' } : p)));
  const after = await sendCommand(ctx, '/profiles all');
  for (const line of ['Codex · default/inherited · medium', 'Antigravity · gemini-3.7-flash-high · high', 'Codex · gpt-5.6-sol · medium']) {
    assert.ok(before.includes(line), `before missing: ${line}`);
    assert.ok(after.includes(line), `after missing: ${line}`);
  }
});
