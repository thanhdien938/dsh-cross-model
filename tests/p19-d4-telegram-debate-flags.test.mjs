import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOwnerFlags, routeTelegramUpdate } from '../src/owner/telegram-owner-client.mjs';
import { TelegramAliasRegistry } from '../src/owner/telegram-alias-registry.mjs';

// P19-D4 — real Telegram syntax for the Debate extension
// (council.debate.{enabled,max_rounds}, D1's own shape).
//
// `--debate-extend`/`--debate-rounds` are DELIBERATELY named apart from
// the pre-existing `--debate <p1,p2,...>` flag (P7-era — selects COUNCIL
// participants, unrelated to the Debate extension). Every test below that
// touches the old `--debate <participants>` flag exists specifically to
// pin that the two never collide.

function update(text) { return { update_id: 1, message: { from: { id: 1 }, chat: { id: 2 }, text } }; }
const projects = [{ id: 'proj-a' }];

test('parseOwnerFlags: --debate-extend is a bare boolean switch, never consuming a following word', () => {
  const r = parseOwnerFlags('--debate-extend do the actual task');
  assert.equal(r.debateExtend, true);
  assert.equal(r.text, 'do the actual task');
});

test('parseOwnerFlags: --debate-rounds accepts exactly 1 or 2', () => {
  assert.equal(parseOwnerFlags('--debate-extend --debate-rounds 1 do it').debateRounds, 1);
  assert.equal(parseOwnerFlags('--debate-extend --debate-rounds 2 do it').debateRounds, 2);
});

test('parseOwnerFlags: an invalid --debate-rounds value is refused, never silently defaulted', () => {
  assert.throws(() => parseOwnerFlags('--debate-extend --debate-rounds 3 do it'), /--debate-rounds must be 1 or 2/);
  assert.throws(() => parseOwnerFlags('--debate-extend --debate-rounds 0 do it'), /--debate-rounds must be 1 or 2/);
  assert.throws(() => parseOwnerFlags('--debate-extend --debate-rounds auto do it'), /--debate-rounds must be 1 or 2/);
});

test('parseOwnerFlags: --debate-rounds without --debate-extend is refused, never silently dropped', () => {
  assert.throws(() => parseOwnerFlags('--debate-rounds 1 do it'), /--debate-rounds requires --debate-extend/);
});

test('parseOwnerFlags: omitting --debate-extend/--debate-rounds is byte-for-byte the pre-D4 default (false/null)', () => {
  const r = parseOwnerFlags('--pm pm-1 plain task');
  assert.equal(r.debateExtend, false);
  assert.equal(r.debateRounds, null);
});

test('parseOwnerFlags: --debate-extend never collides with the pre-existing --debate <participants> flag — both parse independently', () => {
  const r = parseOwnerFlags('--pm pm-1 --debate p1,p2 --debate-extend --debate-rounds 1 do it');
  assert.deepEqual(r.debateProfileIds, ['p1', 'p2']);
  assert.equal(r.debateExtend, true);
  assert.equal(r.debateRounds, 1);
  assert.equal(r.text, 'do it');
});

test('parseOwnerFlags: --debate <participants> alone (no --debate-extend) is completely unaffected — byte-for-byte pre-D4 behavior', () => {
  const r = parseOwnerFlags('--pm pm-1 --debate p1,p2 do it');
  assert.deepEqual(r.debateProfileIds, ['p1', 'p2']);
  assert.equal(r.debateExtend, false);
});

// ---- end-to-end through routeTelegramUpdate --------------------------------

test('a real @project council dispatch with --debate-extend produces the exact council.debate shape normalizeCouncilSpec() expects', () => {
  const routed = routeTelegramUpdate(update('@proj-a --pm pm-1 --debate p1,p2 --debate-extend --debate-rounds 1 analyze this'), { ownerUserId: 1, ownerChatId: 2, projects, aliasRegistry: null });
  assert.equal(routed.operation, 'SUBMIT_TASK');
  assert.deepEqual(routed.payload.council, { chair_profile_id: 'pm-1', participant_profile_ids: ['p1', 'p2'], debate: { enabled: true, max_rounds: 1 } });
});

test('--debate-extend without --debate-rounds omits max_rounds — server-side normalizeCouncilSpec() default (2) applies, never re-derived client-side', () => {
  const routed = routeTelegramUpdate(update('@proj-a --pm pm-1 --debate p1,p2 --debate-extend analyze this'), { ownerUserId: 1, ownerChatId: 2, projects, aliasRegistry: null });
  assert.deepEqual(routed.payload.council.debate, { enabled: true });
  assert.equal('max_rounds' in routed.payload.council.debate, false);
});

test('an ordinary council dispatch without --debate-extend carries no debate field at all — byte-for-byte pre-D4 payload', () => {
  const routed = routeTelegramUpdate(update('@proj-a --pm pm-1 --debate p1,p2 analyze this'), { ownerUserId: 1, ownerChatId: 2, projects, aliasRegistry: null });
  assert.deepEqual(routed.payload.council, { chair_profile_id: 'pm-1', participant_profile_ids: ['p1', 'p2'] });
  assert.equal('debate' in routed.payload.council, false);
});

test('a plain SINGLE dispatch is completely unaffected by these flags existing at all', () => {
  const routed = routeTelegramUpdate(update('@proj-a --pm pm-1 plain task'), { ownerUserId: 1, ownerChatId: 2, projects, aliasRegistry: null });
  assert.equal('council' in routed.payload, false);
});

test('--debate-extend on a SINGLE dispatch (no --debate <participants>) fails closed with a specific FLAGS_INVALID reason, never silently dropped', () => {
  const routed = routeTelegramUpdate(update('@proj-a --pm pm-1 --debate-extend plain task'), { ownerUserId: 1, ownerChatId: 2, projects, aliasRegistry: null });
  assert.equal(routed.read, 'FLAGS_INVALID');
  assert.match(routed.detail, /--debate-extend requires a council dispatch/);
});

test('--debate-extend combined with --task-file fails closed (no council exists in a task-file dispatch)', () => {
  const routed = routeTelegramUpdate(update('@proj-a --task-file main tasks/dsh/X.md --debate-extend'), { ownerUserId: 1, ownerChatId: 2, projects, aliasRegistry: null });
  assert.equal(routed.read, 'FLAGS_INVALID');
});

test('--debate-extend combines correctly with lifecycle flags (--commit/--durability) in the same dispatch', () => {
  const routed = routeTelegramUpdate(update('@proj-a --pm pm-1 --debate p1,p2 --debate-extend --debate-rounds 2 --durability local --commit ship it'), { ownerUserId: 1, ownerChatId: 2, projects, aliasRegistry: null });
  assert.deepEqual(routed.payload.council.debate, { enabled: true, max_rounds: 2 });
  assert.equal(routed.payload.durability, 'DURABLE_LOCAL');
  assert.deepEqual(routed.payload.git, { commit: true, push: false });
});

// ---- alias shorthand ("/c ...") — the OTHER call site applyDebateExtension() was added to ----

const aliasProjects = [{ id: 'proj-a' }];
function aliasRegistry() {
  return new TelegramAliasRegistry({
    projects: { 1: 'proj-a' },
    pmProfiles: { 1: 'chair-1', 2: 'p-1', 3: 'p-2' },
  });
}

test('council shorthand "/c ..." with --debate-extend resolves identically to the canonical form (same call site as the canonical --debate form, PM identity from aliases)', () => {
  const shorthand = routeTelegramUpdate(update('/c 1 1 2,3 --debate-extend --debate-rounds 1 Compare two safe designs'), { projects: aliasProjects, aliasRegistry: aliasRegistry() });
  assert.equal(shorthand.operation, 'SUBMIT_TASK');
  assert.deepEqual(shorthand.payload.council, { chair_profile_id: 'chair-1', participant_profile_ids: ['p-1', 'p-2'], debate: { enabled: true, max_rounds: 1 } });
});

test('council shorthand "/c ..." without --debate-extend carries no debate field — byte-for-byte pre-D4 shorthand payload', () => {
  const shorthand = routeTelegramUpdate(update('/c 1 1 2,3 Compare two safe designs'), { projects: aliasProjects, aliasRegistry: aliasRegistry() });
  assert.equal('debate' in shorthand.payload.council, false);
});

test('single-task shorthand ("<pmAlias>-<pmAlias> ...") refuses --debate-extend explicitly — no council exists to extend', () => {
  const shorthand = routeTelegramUpdate(update('1-1 plain task'), { projects: aliasProjects, aliasRegistry: aliasRegistry() });
  assert.equal(shorthand.operation, 'SUBMIT_TASK'); // sanity: the bare form still works
  const withFlag = routeTelegramUpdate(update('1-1 --debate-extend plain task'), { projects: aliasProjects, aliasRegistry: aliasRegistry() });
  assert.equal(withFlag.read, 'FLAGS_INVALID');
  assert.match(withFlag.detail, /not valid for single-task shorthand/);
});
