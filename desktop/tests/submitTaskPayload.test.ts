import { describe, it, expect } from 'vitest';
import { buildSubmitTaskPayload } from '../electron/main/services/submitTaskPayload';

// P12-R5A — the pure payload-building logic behind the `owner:submitTask`
// IPC handler (main.ts). Proves the Desktop lifecycle controls (durability
// selector, commit/push/review toggles) reach the exact same
// payload.durability/payload.git/payload.review contract fields
// owner-task-controller.mjs's normalizeDurability()/normalizeGitSyncRequest()/
// normalizeReviewRequest() already validate server-side, and that omitting
// them entirely reproduces the byte-for-byte pre-R5A payload.

describe('buildSubmitTaskPayload', () => {
  it('1. DIRECT / no lifecycle at all requires no interaction — payload is byte-for-byte the pre-R5A shape', () => {
    const payload = buildSubmitTaskPayload({ body: 'plain task', pmProfileId: 'pm-1' });
    expect(payload).toEqual({ body: 'plain task', pm_profile_id: 'pm-1' });
    expect('durability' in payload).toBe(false);
    expect('git' in payload).toBe(false);
    expect('review' in payload).toBe(false);
  });

  it('2. DURABLE_LOCAL is selectable and reaches payload.durability verbatim', () => {
    const payload = buildSubmitTaskPayload({ body: 'x', pmProfileId: 'pm-1', lifecycle: { durability: 'DURABLE_LOCAL' } });
    expect(payload.durability).toBe('DURABLE_LOCAL');
    expect('git' in payload).toBe(false);
  });

  it('3. DURABLE_REMOTE is selectable and reaches payload.durability verbatim', () => {
    const payload = buildSubmitTaskPayload({ body: 'x', pmProfileId: 'pm-1', lifecycle: { durability: 'DURABLE_REMOTE' } });
    expect(payload.durability).toBe('DURABLE_REMOTE');
  });

  it('6. an explicit Desktop push request reaches the exact existing payload.git field the runtime already validates', () => {
    const payload = buildSubmitTaskPayload({ body: 'x', pmProfileId: 'pm-1', lifecycle: { durability: 'DURABLE_REMOTE', pushRemote: true } });
    expect(payload.git).toEqual({ commit: true, push: true });
  });

  it('DURABLE_LOCAL commitLocal alone reaches payload.git with push:false (never pushes just because commit was requested)', () => {
    const payload = buildSubmitTaskPayload({ body: 'x', pmProfileId: 'pm-1', lifecycle: { durability: 'DURABLE_LOCAL', commitLocal: true } });
    expect(payload.git).toEqual({ commit: true, push: false });
  });

  it('5. pushRemote defaults OFF — omitting it (or explicitly false) never produces a git request at all', () => {
    const noneRequested = buildSubmitTaskPayload({ body: 'x', pmProfileId: 'pm-1', lifecycle: { durability: 'DURABLE_REMOTE' } });
    expect('git' in noneRequested).toBe(false);
    const explicitlyOff = buildSubmitTaskPayload({ body: 'x', pmProfileId: 'pm-1', lifecycle: { durability: 'DURABLE_REMOTE', pushRemote: false } });
    expect('git' in explicitlyOff).toBe(false);
  });

  it('10. the review checkbox maps to the exact existing payload.review field', () => {
    const requested = buildSubmitTaskPayload({ body: 'x', pmProfileId: 'pm-1', lifecycle: { durability: 'DURABLE_REMOTE', requestReview: true } });
    expect(requested.review).toEqual({ requested: true });
    const notRequested = buildSubmitTaskPayload({ body: 'x', pmProfileId: 'pm-1', lifecycle: { durability: 'DURABLE_REMOTE' } });
    expect('review' in notRequested).toBe(false);
  });

  it('11. Council uses the exact same durability/git/review contract as SINGLE — no separate Council payload shape', () => {
    const single = buildSubmitTaskPayload({ body: 'x', pmProfileId: 'pm-1', lifecycle: { durability: 'DURABLE_REMOTE', pushRemote: true, requestReview: true } });
    const council = buildSubmitTaskPayload({
      body: 'x', pmProfileId: 'pm-1',
      council: { participantProfileIds: ['pm-2', 'pm-3'], rounds: 2 },
      lifecycle: { durability: 'DURABLE_REMOTE', pushRemote: true, requestReview: true },
    });
    expect(council.durability).toBe(single.durability);
    expect(council.git).toEqual(single.git);
    expect(council.review).toEqual(single.review);
    expect(council.council).toEqual({ chair_profile_id: 'pm-1', participant_profile_ids: ['pm-2', 'pm-3'], rounds: 2 });
  });

  it('14. existing task-file submission is unchanged — task_file/durability/git/review all coexist independently', () => {
    const payload = buildSubmitTaskPayload({
      body: '', pmProfileId: 'pm-1',
      taskFile: { ref: 'main', path: 'tasks/dsh/X.md' },
      lifecycle: { durability: 'DURABLE_REMOTE', pushRemote: true, requestReview: true },
    });
    expect(payload.task_file).toEqual({ ref: 'main', path: 'tasks/dsh/X.md' });
    expect(payload.durability).toBe('DURABLE_REMOTE');
    expect(payload.git).toEqual({ commit: true, push: true });
    expect(payload.review).toEqual({ requested: true });
  });

  // ---- P19-D4: council.debate --------------------------------------------

  it('D4-1. no council.debate field at all when the owner never enabled Debate — byte-for-byte the pre-D4 council shape', () => {
    const payload = buildSubmitTaskPayload({ body: 'x', pmProfileId: 'pm-1', council: { participantProfileIds: ['pm-2', 'pm-3'], rounds: 2 } });
    expect(payload.council).toEqual({ chair_profile_id: 'pm-1', participant_profile_ids: ['pm-2', 'pm-3'], rounds: 2 });
    expect('debate' in (payload.council as object)).toBe(false);
  });

  it('D4-2. debate.enabled=true with maxRounds reaches council.debate exactly as normalizeCouncilSpec() expects', () => {
    const payload = buildSubmitTaskPayload({ body: 'x', pmProfileId: 'pm-1', council: { participantProfileIds: ['pm-2', 'pm-3'], rounds: 2, debate: { enabled: true, maxRounds: 1 } } });
    expect((payload.council as any).debate).toEqual({ enabled: true, max_rounds: 1 });
  });

  it('D4-3. debate.enabled=true without maxRounds omits max_rounds entirely — the server-side normalizeCouncilSpec() default (2) applies, never re-derived client-side', () => {
    const payload = buildSubmitTaskPayload({ body: 'x', pmProfileId: 'pm-1', council: { participantProfileIds: ['pm-2', 'pm-3'], rounds: 2, debate: { enabled: true } } });
    expect((payload.council as any).debate).toEqual({ enabled: true });
    expect('max_rounds' in (payload.council as any).debate).toBe(false);
  });

  it('D4-4. debate.enabled=false never attaches a debate field at all — the toggle being present but off is indistinguishable from never having been asked', () => {
    const payload = buildSubmitTaskPayload({ body: 'x', pmProfileId: 'pm-1', council: { participantProfileIds: ['pm-2', 'pm-3'], rounds: 2, debate: { enabled: false } } });
    expect('debate' in (payload.council as object)).toBe(false);
  });

  it('D4-5. Debate coexists independently with lifecycle flags (durability/git/review) in the same submission', () => {
    const payload = buildSubmitTaskPayload({
      body: 'x', pmProfileId: 'pm-1',
      council: { participantProfileIds: ['pm-2', 'pm-3'], rounds: 2, debate: { enabled: true, maxRounds: 2 } },
      lifecycle: { durability: 'DURABLE_REMOTE', pushRemote: true, requestReview: true },
    });
    expect((payload.council as any).debate).toEqual({ enabled: true, max_rounds: 2 });
    expect(payload.durability).toBe('DURABLE_REMOTE');
    expect(payload.git).toEqual({ commit: true, push: true });
    expect(payload.review).toEqual({ requested: true });
  });

  // ---- P19-D5: existing W4R6 implementation_participant_id ------------

  it('D5-1. an explicit Debate implementation selection maps to the existing CouncilSpec scalar', () => {
    const payload = buildSubmitTaskPayload({
      body: 'x', pmProfileId: 'chair',
      council: { participantProfileIds: ['analyst', 'implementer'], rounds: 2, implementationParticipantId: 'implementer', debate: { enabled: true, maxRounds: 1 } },
    });
    expect(payload.council).toEqual({
      chair_profile_id: 'chair', participant_profile_ids: ['analyst', 'implementer'], rounds: 2,
      implementation_participant_id: 'implementer', debate: { enabled: true, max_rounds: 1 },
    });
  });

  it('D5-2. omitting the selection adds no implementation field — all-participants-read-only remains the default', () => {
    const payload = buildSubmitTaskPayload({
      body: 'x', pmProfileId: 'chair',
      council: { participantProfileIds: ['analyst', 'implementer'], rounds: 2, debate: { enabled: true } },
    });
    expect('implementation_participant_id' in (payload.council as object)).toBe(false);
  });

  it('an advanced remote-name override (R5 TEST 5 preparation) reaches payload.git.remote, never the default', () => {
    const payload = buildSubmitTaskPayload({ body: 'x', pmProfileId: 'pm-1', lifecycle: { durability: 'DURABLE_REMOTE', pushRemote: true, remoteName: 'dsh-p12-r5-test5-unconfigured-remote' } });
    expect(payload.git).toEqual({ commit: true, push: true, remote: 'dsh-p12-r5-test5-unconfigured-remote' });
  });

  it('omitting remoteName never adds the field at all — the runtime\'s own default (origin) applies', () => {
    const payload = buildSubmitTaskPayload({ body: 'x', pmProfileId: 'pm-1', lifecycle: { durability: 'DURABLE_REMOTE', pushRemote: true } });
    expect(payload.git).toEqual({ commit: true, push: true });
    expect('remote' in (payload.git as object)).toBe(false);
  });

  it('13. an existing plain direct Composer task (no council, no taskFile, no lifecycle) is completely unchanged', () => {
    const payload = buildSubmitTaskPayload({ body: 'describe the task', pmProfileId: 'pm-1' });
    expect(Object.keys(payload).sort()).toEqual(['body', 'pm_profile_id']);
  });
});
