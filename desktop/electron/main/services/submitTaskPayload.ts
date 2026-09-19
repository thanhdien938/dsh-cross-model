// P12-R5A — the pure payload-building half of the `owner:submitTask` IPC
// handler (main.ts), extracted so it is directly unit-testable without
// touching Electron/ipcMain at all. Folds the owner's Composer selections
// onto exactly the same payload.durability/payload.git/payload.review
// shapes Telegram's applyLifecycleFlags() already produces
// (src/owner/telegram-owner-client.mjs) — never a second, divergent
// vocabulary for the same runtime contract. Performs zero validation of
// its own: OwnerControlService/owner-task-controller.mjs already own
// that, server-side, for whichever channel the command arrived from.

export interface SubmitTaskArgs {
  body: string;
  pmProfileId: string;
  council?: {
    participantProfileIds: string[];
    rounds: number;
    // P19-D5: the existing W4R6 nullable scalar, exposed only by an
    // explicit owner selection. Server-side CouncilSpec normalization is
    // still the authority for membership and profile validity.
    implementationParticipantId?: string;
    // P19-D4: additive, optional Debate extension — reuses the EXACT
    // `council.debate` shape normalizeCouncilSpec() (council-contracts.mjs)
    // already validates server-side (max_rounds 1|2, default 2). Omitting
    // it entirely (every pre-D4 caller) reaches the server as if `debate`
    // were never in the payload at all — byte-for-byte the pre-D4 shape.
    debate?: { enabled: boolean; maxRounds?: 1 | 2 };
  };
  taskFile?: { ref: string; path: string };
  lifecycle?: {
    durability: 'DIRECT' | 'DURABLE_LOCAL' | 'DURABLE_REMOTE';
    commitLocal?: boolean;
    pushRemote?: boolean;
    requestReview?: boolean;
    // P12-R5A: an advanced, optional git remote NAME override (never a
    // URL/credential) — mirrors Telegram's --remote flag exactly. Its
    // sole owner-facing purpose is R5 TEST 5: naming a deliberately
    // unconfigured remote to rehearse a safe, controlled remote-sync
    // failure without ever touching the project's real `origin`.
    remoteName?: string;
  };
}

export function buildSubmitTaskPayload(args: SubmitTaskArgs): Record<string, unknown> {
  const payload: Record<string, unknown> = { body: args.body, pm_profile_id: args.pmProfileId };
  if (args.council) {
    const council: Record<string, unknown> = { chair_profile_id: args.pmProfileId, participant_profile_ids: args.council.participantProfileIds, rounds: args.council.rounds };
    if (args.council.implementationParticipantId) council.implementation_participant_id = args.council.implementationParticipantId;
    // P19-D4: only ever attached when the owner explicitly enabled it —
    // never a guessed/defaulted `enabled:true`. `max_rounds` omitted here
    // falls back to normalizeCouncilSpec()'s own server-side default (2),
    // never re-implemented client-side.
    if (args.council.debate?.enabled) {
      council.debate = { enabled: true, ...(args.council.debate.maxRounds ? { max_rounds: args.council.debate.maxRounds } : {}) };
    }
    payload.council = council;
  }
  if (args.taskFile) payload.task_file = { ref: args.taskFile.ref, path: args.taskFile.path };
  if (args.lifecycle) {
    payload.durability = args.lifecycle.durability;
    // Matches normalizeGitSyncRequest() exactly (owner-task-controller.mjs):
    // requesting push alone still implies commit — DSH never pushes
    // whatever a backend happened to leave uncommitted without a
    // verified commit step of its own first.
    if (args.lifecycle.commitLocal || args.lifecycle.pushRemote) {
      const git: Record<string, unknown> = { commit: true, push: Boolean(args.lifecycle.pushRemote) };
      if (args.lifecycle.remoteName) git.remote = args.lifecycle.remoteName;
      payload.git = git;
    }
    if (args.lifecycle.requestReview) payload.review = { requested: true };
  }
  return payload;
}
