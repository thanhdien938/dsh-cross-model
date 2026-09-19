import test from 'node:test';
import assert from 'node:assert/strict';

import { routeTelegramUpdate, TelegramOwnerAdapter, renderShorthandTaskAck, renderProjectList, renderPmProfileList, renderAliasesHelp } from '../src/owner/telegram-owner-client.mjs';
import { TelegramAliasRegistry } from '../src/owner/telegram-alias-registry.mjs';
import { OwnerControlService } from '../src/owner/owner-control-service.mjs';
import { OwnerControlError } from '../src/owner/owner-contracts.mjs';

const projects = [
  { id: 'live1-local', display_name: 'DSH LIVE-1 Local' },
  { id: 'dsh-p6-test-b' },
  { id: 'dsh-p8-test-c', display_name: 'DSH P8 Test C' },
];
const pmProfiles = [
  { id: 'live1-claude-sonnet-high', product: 'claude-code', model: 'sonnet', reasoning: 'high' },
  { id: 'live1-claude-opus-high', product: 'claude-code', model: 'opus', reasoning: 'high' },
  { id: 'live1-claude-opus-low', product: 'claude-code', model: 'opus', reasoning: 'low' },
  { id: 'live1-opencode-pm', product: 'opencode', model: 'default', reasoning: null },
  { id: 'live1-codex-pm', product: 'codex', model: 'default', reasoning: null },
  { id: 'live1-grok-pm', product: 'grok', model: 'grok-4.5', reasoning: null },
];

function aliasRegistry() {
  return new TelegramAliasRegistry({
    projects: { 1: 'live1-local', 2: 'dsh-p6-test-b', 3: 'dsh-p8-test-c' },
    pmProfiles: { 1: 'live1-claude-sonnet-high', 2: 'live1-claude-opus-high', 3: 'live1-claude-opus-low', 4: 'live1-opencode-pm', 5: 'live1-codex-pm', 6: 'live1-grok-pm' },
  });
}

function update(text) { return { update_id: 1, message: { from: { id: 1 }, chat: { id: 2 }, text } }; }

// ==== Part P: single-task shorthand canonicalizes identically ==============

test('shorthand "3-1 <task>" resolves to the exact same project_id/payload as the canonical @project --pm form', () => {
  const shorthand = routeTelegramUpdate(update('3-1 inspect current repository architecture'), { projects, aliasRegistry: aliasRegistry() });
  const canonical = routeTelegramUpdate(update('@dsh-p8-test-c --pm live1-claude-sonnet-high inspect current repository architecture'), { projects });
  assert.equal(shorthand.operation, 'SUBMIT_TASK');
  assert.equal(shorthand.project_id, canonical.project_id);
  assert.deepEqual(shorthand.payload, canonical.payload);
  assert.equal(shorthand.project_id, 'dsh-p8-test-c');
  assert.equal(shorthand.payload.pm_profile_id, 'live1-claude-sonnet-high');
  assert.equal(shorthand.payload.body, 'inspect current repository architecture');
  // Additive only — alias metadata never leaks into canonical fields.
  assert.deepEqual(shorthand.alias, { project: '3', pm: '1' });
});

test('task body is preserved exactly, including punctuation/newlines', () => {
  const routed = routeTelegramUpdate(update('3-1 Do not modify anything.\nJust report the branch name.'), { projects, aliasRegistry: aliasRegistry() });
  assert.equal(routed.payload.body, 'Do not modify anything.\nJust report the branch name.');
});

// ==== Part Q: council shorthand canonicalizes identically ===================

test('council shorthand "/c 2 1 5,6 <task>" resolves identically to the canonical --debate form', () => {
  const shorthand = routeTelegramUpdate(update('/c 2 1 5,6 Compare two safe designs'), { projects, aliasRegistry: aliasRegistry() });
  const canonical = routeTelegramUpdate(update('@dsh-p6-test-b --pm live1-claude-sonnet-high --debate live1-codex-pm,live1-grok-pm Compare two safe designs'), { projects });
  assert.equal(shorthand.project_id, canonical.project_id);
  assert.deepEqual(shorthand.payload, canonical.payload);
  assert.equal(shorthand.payload.council.chair_profile_id, 'live1-claude-sonnet-high');
  assert.deepEqual(shorthand.payload.council.participant_profile_ids, ['live1-codex-pm', 'live1-grok-pm']);
  assert.deepEqual(shorthand.alias, { project: '2', pm: '1', participants: ['5', '6'] });
});

test('council shorthand tolerates spaces after commas in the participant list', () => {
  const routed = routeTelegramUpdate(update('/c 2 1 5, 6 Compare two designs'), { projects, aliasRegistry: aliasRegistry() });
  assert.deepEqual(routed.payload.council.participant_profile_ids, ['live1-codex-pm', 'live1-grok-pm']);
});

// ==== Part M: unknown alias fails BEFORE canonical acceptance ==============

test('unknown project alias in single-task shorthand fails closed, not falling back to bare-text handling', () => {
  const routed = routeTelegramUpdate(update('9-1 do the thing'), { projects, aliasRegistry: aliasRegistry() });
  assert.equal(routed.read, 'ALIAS_PROJECT_UNKNOWN');
  assert.equal(routed.alias, '9');
  assert.equal('operation' in routed, false);
});

test('unknown PM alias in single-task shorthand fails closed', () => {
  const routed = routeTelegramUpdate(update('3-9 do the thing'), { projects, aliasRegistry: aliasRegistry() });
  assert.equal(routed.read, 'ALIAS_PM_UNKNOWN');
  assert.equal(routed.alias, '9');
});

test('unknown chair/participant alias in council shorthand fails closed', () => {
  const badChair = routeTelegramUpdate(update('/c 2 9 5,6 task'), { projects, aliasRegistry: aliasRegistry() });
  assert.equal(badChair.read, 'ALIAS_PM_UNKNOWN');
  const badParticipant = routeTelegramUpdate(update('/c 2 1 5,9 task'), { projects, aliasRegistry: aliasRegistry() });
  assert.equal(badParticipant.read, 'ALIAS_PM_UNKNOWN');
  assert.equal(badParticipant.alias, '9');
  const badProject = routeTelegramUpdate(update('/c 9 1 5,6 task'), { projects, aliasRegistry: aliasRegistry() });
  assert.equal(badProject.read, 'ALIAS_PROJECT_UNKNOWN');
});

test('adapter renders the unknown-alias refusal and never calls service.mutate', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    if (url.includes('getUpdates')) return { ok: true, json: async () => ({ result: [{ update_id: 1, message: { from: { id: 1 }, chat: { id: 2 }, text: '9-1 do the thing' } }] }) };
    sent.push(JSON.parse(init.body).text);
    return { ok: true, json: async () => ({}) };
  };
  let mutated = false;
  const service = { mutate: async () => { mutated = true; return {}; } };
  const adapter = new TelegramOwnerAdapter({ token: 't', ownerUserId: '1', ownerChatId: '2', projects, pmProfiles, aliasRegistry: aliasRegistry(), service, fetchImpl });
  await adapter.pollOnce();
  assert.equal(mutated, false);
  assert.match(sent[0], /Unknown project alias: 9/);
  assert.match(sent[0], /\/projects or \/aliases/);
});

// ==== Part "FAILURE POLICY": alias state unavailable, canonical unaffected =

test('shorthand refuses safely when alias state is unavailable, without ever calling service.mutate', async () => {
  const unavailable = TelegramAliasRegistry.unavailable();
  const routed = routeTelegramUpdate(update('3-1 do the thing'), { projects, aliasRegistry: unavailable });
  assert.equal(routed.read, 'ALIAS_STATE_UNAVAILABLE');
  const sent = [];
  const fetchImpl = async (url, init) => {
    if (url.includes('getUpdates')) return { ok: true, json: async () => ({ result: [{ update_id: 1, message: { from: { id: 1 }, chat: { id: 2 }, text: '3-1 do the thing' } }] }) };
    sent.push(JSON.parse(init.body).text);
    return { ok: true, json: async () => ({}) };
  };
  let mutated = false;
  const service = { mutate: async () => { mutated = true; return {}; } };
  const adapter = new TelegramOwnerAdapter({ token: 't', ownerUserId: '1', ownerChatId: '2', projects, pmProfiles, aliasRegistry: unavailable, service, fetchImpl });
  await adapter.pollOnce();
  assert.equal(mutated, false);
  assert.match(sent[0], /temporarily unavailable/);
  assert.match(sent[0], /@<project_id> --pm <profile_id>/);
});

test('canonical @project --pm syntax is completely unaffected when alias state is unavailable', () => {
  const routed = routeTelegramUpdate(update('@dsh-p8-test-c --pm live1-claude-sonnet-high inspect'), { projects, aliasRegistry: TelegramAliasRegistry.unavailable() });
  assert.equal(routed.operation, 'SUBMIT_TASK');
  assert.equal(routed.project_id, 'dsh-p8-test-c');
});

test('/aliases reports alias state unavailable instead of throwing or listing stale data', () => {
  const unavailable = TelegramAliasRegistry.unavailable();
  assert.equal(routeTelegramUpdate(update('/aliases'), { projects, aliasRegistry: unavailable }).read, 'LIST_ALIASES');
  const text = renderAliasesHelp({ projects, profiles: pmProfiles, aliasRegistry: unavailable });
  assert.match(text, /temporarily unavailable/);
});

test('/projects and /pms still work (canonical-only, no alias decoration) when alias state is unavailable', () => {
  const unavailable = TelegramAliasRegistry.unavailable();
  const text = renderProjectList(projects, unavailable);
  assert.match(text, /^Registered projects:\n- live1-local/);
});

// ==== Part 24: aliasRegistry absent -> byte-for-byte pre-P8 behavior =======

test('without an aliasRegistry, shorthand-looking text is NOT specially interpreted (backward compatible)', () => {
  const routed = routeTelegramUpdate(update('3-1 do the thing'), { projects: [{ id: 'solo' }] });
  // Falls through to bare single-project handling, exactly like before P8.
  assert.equal(routed.operation, 'SUBMIT_TASK');
  assert.equal(routed.project_id, 'solo');
  assert.equal(routed.payload.body, '3-1 do the thing');
  assert.equal('alias' in routed, false);
});

test('without an aliasRegistry, /c is refused as an unknown command exactly like before P8', () => {
  assert.throws(() => routeTelegramUpdate(update('/c 2 1 5,6 task'), { projects }), (e) => e.code === 'TELEGRAM_COMMAND_REFUSED');
});

test('without an aliasRegistry, /pms /profiles /aliases do not exist (fall through to unknown command)', () => {
  assert.throws(() => routeTelegramUpdate(update('/pms'), { projects }));
  assert.throws(() => routeTelegramUpdate(update('/aliases'), { projects }));
});

// ==== Part I/J: list commands ==============================================

test('/projects shows the configured alias alongside the canonical id', () => {
  const routed = routeTelegramUpdate(update('/projects'), { projects, aliasRegistry: aliasRegistry() });
  assert.equal(routed.read, 'LIST_PROJECTS');
  const text = renderProjectList(projects, aliasRegistry());
  assert.match(text, /3 — dsh-p8-test-c \(DSH P8 Test C\)/);
  assert.match(text, /1 — live1-local \(DSH LIVE-1 Local\)/);
});

test('/projects renders unchanged (no alias prefix) when no aliasRegistry is configured', () => {
  const text = renderProjectList(projects);
  assert.match(text, /^Registered projects:\n- live1-local/);
});

test('/pms and /profiles both route to the PM profile listing', () => {
  assert.equal(routeTelegramUpdate(update('/pms'), { projects, aliasRegistry: aliasRegistry() }).read, 'LIST_PM_PROFILES');
  assert.equal(routeTelegramUpdate(update('/profiles'), { projects, aliasRegistry: aliasRegistry() }).read, 'LIST_PM_PROFILES');
});

// P9-R0.4 Part A/B: renderPmProfileList/renderAliasesHelp now format
// through the ONE canonical display helper (src/pm/pm-profile-display.mjs)
// — "Claude Code · sonnet · high" style — rather than inventing their own
// "backend: x\nmodel: y" / "x | y | z" strings.
test('renderPmProfileList shows alias, CANONICAL profile id, product, model and reasoning — no secrets (Part K)', () => {
  const text = renderPmProfileList(pmProfiles, aliasRegistry());
  assert.match(text, /1 — live1-claude-sonnet-high\n\s+Claude Code · sonnet · high/);
  assert.match(text, /6 — live1-grok-pm\n\s+Grok · grok-4\.5 · default\/inherited/);
  assert.equal(text.includes('secret'), false);
});

test('renderPmProfileList never fabricates a null model as a discovered CLI default (Part J)', () => {
  const withNullModel = [{ id: 'live1-codex-pm', product: 'codex', model: null, reasoning: 'medium' }];
  const text = renderPmProfileList(withNullModel);
  assert.match(text, /Codex · default\/inherited · medium/);
});

test('/aliases shows the CANONICAL pm_profile_id as the primary line, never collapsed to model/reasoning alone (Part I)', () => {
  assert.equal(routeTelegramUpdate(update('/aliases'), { projects, aliasRegistry: aliasRegistry() }).read, 'LIST_ALIASES');
  const text = renderAliasesHelp({ projects, profiles: pmProfiles, aliasRegistry: aliasRegistry() });
  assert.match(text, /3 = DSH P8 Test C/);
  assert.match(text, /1 = live1-claude-sonnet-high\n\s+Claude Code \| sonnet \| high/);
  assert.match(text, /Usage:\n\n1-1 inspect repository architecture/);
  assert.match(text, /@live1-local --pm live1-claude-sonnet-high inspect repository architecture/);
});

test('/aliases renders a null model as "default/inherited" (never silently dropped) and omits a null reasoning cleanly (Part I/J)', () => {
  const reg = new TelegramAliasRegistry({ projects: { 1: 'live1-local' }, pmProfiles: { 1: 'live1-codex-pm', 2: 'live1-grok-pm' } });
  const profiles = [
    { id: 'live1-codex-pm', product: 'codex', model: null, reasoning: 'medium' },
    { id: 'live1-grok-pm', product: 'grok', model: 'grok-4.5', reasoning: null },
  ];
  const text = renderAliasesHelp({ projects, profiles, aliasRegistry: reg });
  assert.match(text, /1 = live1-codex-pm\n\s+Codex \| default\/inherited \| medium/);
  assert.match(text, /2 = live1-grok-pm\n\s+Grok \| grok-4\.5$/m);
});

test('/aliases reports "no aliases configured" cleanly when the registry is empty', () => {
  const empty = new TelegramAliasRegistry();
  const text = renderAliasesHelp({ projects, profiles: pmProfiles, aliasRegistry: empty });
  assert.match(text, /No aliases are configured yet/);
});

// ==== Part F: shorthand ack shows BOTH alias and canonical identity =======

test('renderShorthandTaskAck shows alias + canonical project/PM/backend/model/reasoning/task', () => {
  const text = renderShorthandTaskAck({
    project: { id: 'dsh-p8-test-c', display_name: 'DSH P8 Test C' },
    projectAlias: '3',
    pmProfile: { id: 'live1-claude-sonnet-high', product: 'claude-code', model: 'sonnet', reasoning: 'high' },
    pmAlias: '1',
    taskBody: 'inspect current repository architecture',
  });
  assert.match(text, /✅ DSH task accepted/);
  assert.match(text, /3 — DSH P8 Test C/);
  assert.match(text, /id: dsh-p8-test-c/);
  assert.match(text, /1 — live1-claude-sonnet-high/);
  assert.match(text, /Backend:\nclaude-code/);
  assert.match(text, /Model:\nsonnet/);
  assert.match(text, /Reasoning:\nhigh/);
  assert.match(text, /Task:\ninspect current repository architecture/);
});

test('adapter ack for a shorthand SUBMIT_TASK uses the rich alias+canonical format; canonical submissions are unaffected', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    if (url.includes('getUpdates')) return { ok: true, json: async () => ({ result: [{ update_id: 1, message: { from: { id: 1 }, chat: { id: 2 }, text: '3-1 inspect current repository architecture' } }] }) };
    sent.push(JSON.parse(init.body).text);
    return { ok: true, json: async () => ({}) };
  };
  const service = { mutate: async () => ({ canonical_result: { task_id: 'task-1', pm_profile_id: 'live1-claude-sonnet-high' } }) };
  const adapter = new TelegramOwnerAdapter({ token: 't', ownerUserId: '1', ownerChatId: '2', projects, pmProfiles, aliasRegistry: aliasRegistry(), service, fetchImpl });
  await adapter.pollOnce();
  assert.match(sent[0], /3 — DSH P8 Test C/);
  assert.match(sent[0], /id: dsh-p8-test-c/);
  assert.match(sent[0], /1 — live1-claude-sonnet-high/);
  assert.match(sent[0], /Model:\nsonnet/);
});

test('adapter ack for a canonical @project --pm submission is unchanged (no alias section)', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    if (url.includes('getUpdates')) return { ok: true, json: async () => ({ result: [{ update_id: 1, message: { from: { id: 1 }, chat: { id: 2 }, text: '@dsh-p8-test-c --pm live1-claude-sonnet-high inspect' } }] }) };
    sent.push(JSON.parse(init.body).text);
    return { ok: true, json: async () => ({}) };
  };
  const service = { mutate: async () => ({ canonical_result: { task_id: 'task-1', pm_profile_id: 'live1-claude-sonnet-high' } }) };
  const adapter = new TelegramOwnerAdapter({ token: 't', ownerUserId: '1', ownerChatId: '2', projects, pmProfiles, aliasRegistry: aliasRegistry(), service, fetchImpl });
  await adapter.pollOnce();
  assert.match(sent[0], /^✅ DSH task accepted/);
  assert.equal(sent[0].includes('Backend:'), false);
});

// ==== OwnerControlService-level: Part S/T (project cwd invariant, ==========
// ==== multiple PM profiles sharing one backend product) ====================

function realService({ submitted = [] } = {}) {
  const repository = { async beginCommand(command) { return { status: 'ACCEPTED', created_at: '2026-08-22T00:00:00.000Z', command_id: command.command_id }; }, async completeCommand(id, canonical) { return { canonical_result: canonical }; } };
  const taskController = { async submit({ command, project, profile, council }) { submitted.push({ project, profile, council }); return { status: 'MATERIALIZED', task_id: 'task-1', pm_run_id: 'pmrun-1', pm_profile_id: profile.id, ...(council ? { council: { participant_profile_ids: council.participant_profile_ids, rounds: council.rounds } } : {}) }; } };
  const registeredProjects = [
    { id: 'live1-local', repo_path: 'C:/live1/repo', autonomy: { effects: {} } },
    { id: 'dsh-p6-test-b', repo_path: 'C:/dsh/p6-test-b', autonomy: { effects: {} } },
    { id: 'dsh-p8-test-c', repo_path: 'D:/games/dsh-p8-test-c', autonomy: { effects: {} } },
  ];
  const registeredProfiles = [
    { id: 'live1-claude-sonnet-high', product: 'claude-code', model: 'sonnet', reasoning: 'high' },
    { id: 'live1-claude-opus-high', product: 'claude-code', model: 'opus', reasoning: 'high' },
    { id: 'live1-claude-opus-low', product: 'claude-code', model: 'opus', reasoning: 'low' },
    { id: 'live1-codex-pm', product: 'codex', model: 'default', reasoning: null },
    { id: 'live1-grok-pm', product: 'grok', model: 'grok-4.5', reasoning: null },
  ];
  return new OwnerControlService({ repository, taskController, projects: registeredProjects, pmProfiles: registeredProfiles });
}

test('Part S: alias resolves to the project id, but execution still receives project.repo_path — never derived from the PM profile', async () => {
  const submitted = [];
  const svc = realService({ submitted });
  const routed = routeTelegramUpdate(update('3-1 report repository name and current branch'), { projects, aliasRegistry: aliasRegistry() });
  await svc.mutate(routed);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].project.id, 'dsh-p8-test-c');
  assert.equal(submitted[0].project.repo_path, 'D:/games/dsh-p8-test-c');
  assert.equal(submitted[0].profile.model, 'sonnet');
});

test('Part T: three aliases for three claude-code profiles resolve to distinct model/reasoning against the same project', async () => {
  const submitted = [];
  const svc = realService({ submitted });
  for (const [shorthand, expectModel, expectReasoning] of [['1-1 x', 'sonnet', 'high'], ['1-2 x', 'opus', 'high'], ['1-3 x', 'opus', 'low']]) {
    const routed = routeTelegramUpdate(update(shorthand), { projects, aliasRegistry: aliasRegistry() });
    await svc.mutate(routed);
  }
  assert.equal(submitted.length, 3);
  assert.deepEqual(submitted.map((s) => s.project.repo_path), Array(3).fill('C:/live1/repo'));
  assert.deepEqual(submitted.map((s) => s.profile.product), ['claude-code', 'claude-code', 'claude-code']);
  assert.deepEqual(submitted.map((s) => s.profile.model), ['sonnet', 'opus', 'opus']);
  assert.deepEqual(submitted.map((s) => s.profile.reasoning), ['high', 'high', 'low']);
});

// ==== Part U #22: duplicate council participant refused (reuses the ========
// ==== EXISTING normalizeCouncilSpec check — no new validation written) =====

test('council shorthand with a repeated participant alias is refused by the existing council duplicate-participant check', async () => {
  const svc = realService();
  const routed = routeTelegramUpdate(update('/c 2 1 5,5 compare'), { projects, aliasRegistry: aliasRegistry() });
  await assert.rejects(svc.mutate(routed), (e) => e instanceof OwnerControlError && e.code === 'COUNCIL_DUPLICATE_PARTICIPANT');
});

// ==== Part H/27: Telegram carries no PM-profile mutation surface at all ====

test('the owner mutation vocabulary Telegram can reach is unchanged by P8 (no PM profile create/edit/delete op exists)', async () => {
  const { OWNER_MUTATIONS } = await import('../src/owner/owner-contracts.mjs');
  assert.deepEqual([...OWNER_MUTATIONS], ['SUBMIT_TASK', 'REPLY_TO_INTERACTION', 'DECIDE_INTERACTION', 'REQUEST_CANCEL', 'NARROW_AUTONOMY', 'EXPAND_AUTONOMY']);
  assert.equal(OWNER_MUTATIONS.some((op) => /PROFILE/.test(op)), false);
});

test('no shorthand or list route ever produces an operation other than the pre-existing owner mutation set', () => {
  const reg = aliasRegistry();
  const routedShorthand = routeTelegramUpdate(update('3-1 task'), { projects, aliasRegistry: reg });
  const routedCouncil = routeTelegramUpdate(update('/c 2 1 5,6 task'), { projects, aliasRegistry: reg });
  const routedList = routeTelegramUpdate(update('/pms'), { projects, aliasRegistry: reg });
  const routedAliases = routeTelegramUpdate(update('/aliases'), { projects, aliasRegistry: reg });
  assert.equal(routedShorthand.operation, 'SUBMIT_TASK');
  assert.equal(routedCouncil.operation, 'SUBMIT_TASK');
  assert.equal('operation' in routedList, false);
  assert.equal(routedList.read, 'LIST_PM_PROFILES');
  assert.equal('operation' in routedAliases, false);
  assert.equal(routedAliases.read, 'LIST_ALIASES');
});

test('chair alias also present in the participant list is accepted (existing P7 behavior, unchanged)', async () => {
  const submitted = [];
  const svc = realService({ submitted });
  const routed = routeTelegramUpdate(update('/c 2 1 1,5 compare'), { projects, aliasRegistry: aliasRegistry() });
  await svc.mutate(routed);
  assert.equal(submitted.length, 1);
  assert.deepEqual(submitted[0].council.participant_profile_ids, ['live1-claude-sonnet-high', 'live1-codex-pm']);
});
