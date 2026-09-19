import React, { useEffect, useState } from 'react';
import { Project, PushRemotePolicy } from '../../electron/main/types';
import './Composer.css';

// P12-R5A: mirrors owner-task-controller.mjs's TASK_DURABILITY enum and
// Telegram's --durability flag exactly (src/owner/telegram-owner-client.mjs)
// — Desktop never invents a second vocabulary for the same contract field.
export type TaskDurability = 'DIRECT' | 'DURABLE_LOCAL' | 'DURABLE_REMOTE';

// P12-R5A: the owner's explicit lifecycle intent for this one task — folds
// into payload.durability/payload.git/payload.review exactly like
// applyLifecycleFlags() does for Telegram (telegram-owner-client.mjs).
// Omitting this entirely (every pre-R5A caller) is byte-for-byte the
// existing DIRECT/no-flags behavior.
export interface LifecycleRequest {
  durability: TaskDurability;
  commitLocal?: boolean;
  pushRemote?: boolean;
  requestReview?: boolean;
  // P12-R5A: an advanced, optional override — a git remote NAME only
  // (never a URL/credential), mirroring Telegram's --remote flag exactly
  // (telegram-owner-client.mjs). Its sole owner-facing purpose is R5
  // TEST 5: naming a deliberately unconfigured remote to rehearse a safe,
  // controlled remote-sync failure without ever touching the project's
  // real `origin`. Blank/omitted uses the runtime's own default ('origin').
  remoteName?: string;
}

// P12-R5A Part F/G: pure, directly testable — whether the push checkbox
// should be enabled for this project's REAL, main-process-derived policy.
// 'UNKNOWN' (a dynamic-import hiccup, or a policy that genuinely could not
// be read) is treated as NOT allowed, the safe default. This function is
// UI-gating ONLY, never the authority — production-pm-worker.mjs's
// isPushAuthorized() independently re-derives and enforces the real
// decision from durable project config, regardless of what this renderer
// computes or sends (Part G: the renderer cannot override FORBID no
// matter what this returns).
export function isPushCheckboxEnabled(pushRemotePolicy: PushRemotePolicy | undefined): boolean {
  return pushRemotePolicy === 'APPROVAL' || pushRemotePolicy === 'ALLOW';
}

export interface PmProfileOption {
  id: string;
  product: string;
  model: string | null;
  sessionKind: string;
  available: boolean;
  // P9-R0.4 Part A/C: the one canonical "backend · model · reasoning"
  // label — this list is already ACTIVE-only (Part N), so every entry
  // here is selectable.
  displayLabel: string;
}

export type TaskMode = 'SINGLE' | 'COUNCIL';

// P22.5 §G: the one owner-facing explanation for why a direct API profile
// cannot chair or join a Council/Debate — mirrors
// production-backend-capabilities.mjs's API_MULTI_AGENT_POLICY_GUIDANCE
// (server-side) so the two texts never drift. Never phrased as
// unproven/qualification-required/not-yet-tested — this is permanent
// product policy, not a migration state.
export const API_SINGLE_ONLY_HINT =
  'API profiles support Single tasks only. For Council or Debate, configure this provider in OpenCode and use an OpenCode PM profile.';

interface ComposerProps {
  selectedProject: Project | null;
  armedProjectId: string | null;
  runtimeRunning: boolean;
  pmProfiles: PmProfileOption[];
  draft: string;
  onDraftChange: (value: string) => void;
  pmProfileId: string | null;
  onPmProfileChange: (id: string) => void;
  onArm: (projectId: string) => void;
  // P7 Part N: `council` is present only when Task mode is COUNCIL — chair
  // is already `pmProfileId` above (the chair selector reuses the SAME "PM"
  // select the SINGLE mode already has).
  // P12-R1: `taskFile` is SINGLE-only (mirrors Telegram's existing
  // TASK_FILE_COUNCIL_NOT_SUPPORTED restriction) and mutually exclusive
  // with typed draft text — when present, the resolved file content
  // becomes the entire task body server-side.
  // P12-R5A: `lifecycle` is additive and applies identically to SINGLE and
  // COUNCIL (Part J: no separate Council Git-sync path) — omitted
  // entirely defaults to DIRECT, byte-for-byte the pre-R5A behavior.
  // P19-D4: `debate` is additive and COUNCIL-only, applying the exact same
  // "omitted === off" discipline every other optional field on this call
  // already uses — a SINGLE task, or a COUNCIL task with the Debate toggle
  // left off (the default), reaches the server with no `debate` key at
  // all, byte-for-byte the pre-D4 payload.
  onSubmit: (
    council?: { participantProfileIds: string[]; rounds: number; implementationParticipantId?: string; debate?: { enabled: boolean; maxRounds?: 1 | 2 } },
    taskFile?: { ref: string; path: string },
    lifecycle?: LifecycleRequest,
  ) => Promise<void>;
}

// W2-C/D/E: the composer is the one place selected/armed/PM-choice all
// converge. It is only ever enabled when selected === armed, the runtime is
// running, and a resolvable PM profile is chosen — every other state is a
// visible, typed reason, never a silently-disabled control.
function Composer({ selectedProject, armedProjectId, runtimeRunning, pmProfiles, draft, onDraftChange, pmProfileId, onPmProfileChange, onArm, onSubmit }: ComposerProps) {
  const [sending, setSending] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  // P7 Part B: task mode + council selection are Composer-local — a draft
  // is project-bound (existing behavior), but the council selection is not
  // persisted across a submit; selecting a project never silently arms it
  // and never silently picks a mode (Part N).
  const [mode, setMode] = useState<TaskMode>('SINGLE');
  const [participants, setParticipants] = useState<Set<string>>(new Set());
  const [rounds, setRounds] = useState<1 | 2>(2);
  // P19-D4: Debate extension toggle — Composer-local, per-task intent,
  // never persisted across a submit, off by default (matches the pattern
  // every other opt-in Composer control here already follows).
  const [debateEnabled, setDebateEnabled] = useState(false);
  const [debateMaxRounds, setDebateMaxRounds] = useState<1 | 2>(2);
  // P19-D5: exactly zero or one explicit selection. This is transported as
  // W4R6's existing implementation_participant_id scalar, never a new role.
  const [implementationParticipantId, setImplementationParticipantId] = useState('');
  // P12-R1: a pinned task-file source is SINGLE-only and additive — the
  // owner opts in explicitly; every existing draft-text flow is unaffected
  // when this stays off (the default).
  const [useTaskFile, setUseTaskFile] = useState(false);
  const [taskFileRef, setTaskFileRef] = useState('');
  const [taskFilePath, setTaskFilePath] = useState('');
  // P12-R5A: durability/git/review are Composer-local, per-task intent —
  // never persisted across a submit, never silently carried over when
  // switching projects (Part B/C: DIRECT stays the effortless default).
  const [durability, setDurability] = useState<TaskDurability>('DIRECT');
  const [commitLocal, setCommitLocal] = useState(false);
  const [pushRemote, setPushRemote] = useState(false);
  const [requestReview, setRequestReview] = useState(false);
  const [remoteName, setRemoteName] = useState('');

  useEffect(() => setLastError(null), [selectedProject?.id]);
  useEffect(() => {
    setMode('SINGLE');
    setParticipants(new Set());
    setRounds(2);
    setDebateEnabled(false);
    setDebateMaxRounds(2);
    setImplementationParticipantId('');
    setUseTaskFile(false);
    setTaskFileRef('');
    setTaskFilePath('');
    setDurability('DIRECT');
    setCommitLocal(false);
    setPushRemote(false);
    setRequestReview(false);
    setRemoteName('');
  }, [selectedProject?.id]);
  // P12-R5A Part F: the push toggle must never survive a switch away from
  // DURABLE_REMOTE, and never survive the project's own policy turning
  // unfavorable — always OFF by default, never remembered across an
  // unrelated state change.
  useEffect(() => {
    if (durability !== 'DURABLE_REMOTE') { setPushRemote(false); setRemoteName(''); }
    if (durability === 'DIRECT') { setCommitLocal(false); setRequestReview(false); }
  }, [durability]);
  // Switching to COUNCIL while a task-file source is armed would otherwise
  // silently submit a combination the runtime refuses
  // (TASK_FILE_COUNCIL_NOT_SUPPORTED) — turn it off instead of surfacing a
  // late server error for a state the UI could have prevented.
  useEffect(() => {
    if (mode === 'COUNCIL' && useTaskFile) setUseTaskFile(false);
  }, [mode, useTaskFile]);
  // P22.5 §G: a direct API profile chosen as "PM for next task" (SINGLE) is
  // no longer a valid Chair PM the moment the owner switches to COUNCIL —
  // clear it immediately rather than leaving a stale, now-disabled
  // selection the owner would otherwise have to notice and change by hand.
  useEffect(() => {
    if (mode === 'COUNCIL' && pmProfileId) {
      const chosen = pmProfiles.find((p) => p.id === pmProfileId);
      if (chosen?.product === 'api') onPmProfileChange('');
    }
  }, [mode, pmProfileId, pmProfiles, onPmProfileChange]);
  // P19-D4: the Debate toggle is COUNCIL-only — leaving SINGLE must never
  // silently carry a stale "on" selection forward (same discipline as the
  // task-file/COUNCIL exclusion just above).
  useEffect(() => {
    if (mode !== 'COUNCIL' && debateEnabled) setDebateEnabled(false);
  }, [mode, debateEnabled]);
  // The selected implementation participant must remain a member of this
  // exact Council. Clear stale UI state immediately; the server independently
  // fails closed if a malformed payload bypasses the renderer.
  useEffect(() => {
    if (implementationParticipantId && (!debateEnabled || !participants.has(implementationParticipantId))) {
      setImplementationParticipantId('');
    }
  }, [debateEnabled, implementationParticipantId, participants]);

  if (!selectedProject) {
    return (
      <div className="composer composer-disabled card">
        <p className="composer-reason">Select a project to compose a task.</p>
      </div>
    );
  }

  const isArmed = selectedProject.id === armedProjectId;
  const pathMissing = selectedProject.state === 'PATH_MISSING';
  const availableProfiles = pmProfiles.filter((p) => p.available);
  const reason = !runtimeRunning
    ? 'RUNTIME STOPPED'
    : pathMissing
    ? 'PROJECT PATH MISSING'
    : !isArmed
    ? 'PROJECT NOT ARMED'
    : availableProfiles.length === 0
    ? 'PM PROFILE UNAVAILABLE'
    : null;

  const chairChosen = Boolean(pmProfileId) && availableProfiles.some((p) => p.id === pmProfileId);
  const taskFileReady = useTaskFile && taskFileRef.trim().length > 0 && taskFilePath.trim().length > 0;
  // P12-R5A Part F/P: the project's REAL PUSH_REMOTE policy, already
  // derived main-process-side (readProjection.ts's buildProjectList(),
  // via the exact same normalizeAutonomyEnvelope() the runtime enforces)
  // — the renderer never guesses or re-derives this. 'UNKNOWN' (a
  // dynamic-import hiccup, or a policy that genuinely could not be read)
  // is treated as NOT allowed — the safe default, never a permissive one.
  const pushRemotePolicy: PushRemotePolicy = selectedProject.pushRemotePolicy ?? 'UNKNOWN';
  const pushAllowedByPolicy = isPushCheckboxEnabled(pushRemotePolicy);
  // Defense in depth only — the real authorization boundary is
  // production-pm-worker.mjs's isPushAuthorized(), which independently
  // re-derives and enforces this from durable project config regardless
  // of anything the renderer sends (Part G: renderer never becomes the
  // authority). This just keeps the UI from ever submitting a push
  // request the UI itself already knows will be refused.
  const canSubmit =
    !reason &&
    (useTaskFile ? taskFileReady : draft.trim().length > 0) &&
    chairChosen &&
    (mode === 'SINGLE' || (participants.size >= 1 && (rounds === 1 || rounds === 2))) &&
    (!pushRemote || pushAllowedByPolicy) &&
    !sending;

  const toggleParticipant = (id: string) => {
    setParticipants((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSubmit = async () => {
    setSending(true);
    setLastError(null);
    try {
      // P14-R2.1: preserve legacy omission only for ordinary typed-text
      // DIRECT tasks. A task-file is LONG and its absent runtime default is
      // intentionally DURABLE_LOCAL, so the Desktop must transmit its
      // visible DIRECT selection explicitly to preserve owner intent.
      const lifecycle: LifecycleRequest | undefined = durability === 'DIRECT' && !useTaskFile
        ? undefined
        : {
            durability,
            commitLocal: durability === 'DURABLE_LOCAL' ? commitLocal : undefined,
            pushRemote: durability === 'DURABLE_REMOTE' ? pushRemote : undefined,
            requestReview: durability === 'DURABLE_REMOTE' ? requestReview : undefined,
            remoteName: durability === 'DURABLE_REMOTE' && pushRemote && remoteName.trim() ? remoteName.trim() : undefined,
          };
      await onSubmit(
        mode === 'COUNCIL'
          ? {
              participantProfileIds: [...participants],
              rounds,
              ...(debateEnabled ? {
                debate: { enabled: true, maxRounds: debateMaxRounds },
                ...(implementationParticipantId ? { implementationParticipantId } : {}),
              } : {}),
            }
          : undefined,
        useTaskFile ? { ref: taskFileRef.trim(), path: taskFilePath.trim() } : undefined,
        lifecycle,
      );
    } catch (error: any) {
      setLastError(error?.message ?? 'OWNER_COMMAND_FAILED');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="composer card">
      <div className="composer-context">
        <span className="composer-context-name">{selectedProject.name}</span>
        <span className="composer-context-path">{selectedProject.path}</span>
        {selectedProject.branch && <span className="composer-context-branch">⎇ {selectedProject.branch}</span>}
      </div>

      {!isArmed && pathMissing && (
        <div className="composer-arm-banner composer-arm-banner-error">
          <span>PROJECT PATH MISSING — the configured folder was not found. Restore it and restart before arming.</span>
        </div>
      )}

      {!isArmed && !pathMissing && (
        <div className="composer-arm-banner">
          <span>This project is not armed. Drafts here are retained but cannot be sent.</span>
          <button className="btn btn-primary" onClick={() => onArm(selectedProject.id)} disabled={!runtimeRunning}>
            ARM THIS PROJECT
          </button>
        </div>
      )}

      <div className="composer-mode" role="radiogroup" aria-label="Task mode">
        <label className="composer-mode-option">
          <input type="radio" name="composer-mode" checked={mode === 'SINGLE'} onChange={() => setMode('SINGLE')} disabled={!isArmed} />
          Single
        </label>
        <label className="composer-mode-option">
          <input type="radio" name="composer-mode" checked={mode === 'COUNCIL'} onChange={() => setMode('COUNCIL')} disabled={!isArmed} />
          Council / Debate
        </label>
      </div>

      {/* P12-R5A Part B/C: a compact, always-visible durability selector —
          the DIRECT default (index 0) shows nothing further, keeping the
          simple/default path exactly as effortless as before this wave.
          Applies identically to SINGLE and COUNCIL (Part J). */}
      <label className="composer-durability-label">
        Durability
        <select
          className="composer-pm-select composer-durability-select"
          value={durability}
          onChange={(e) => setDurability(e.target.value as TaskDurability)}
          disabled={!isArmed}
        >
          <option value="DIRECT">Direct</option>
          <option value="DURABLE_LOCAL">Durable Local</option>
          <option value="DURABLE_REMOTE">Durable Remote</option>
        </select>
      </label>

      {durability === 'DURABLE_LOCAL' && (
        <div className="composer-durability-panel">
          <span className="composer-durability-info">Durable local artifacts: enabled according to lifecycle policy</span>
          <label className="composer-durability-toggle">
            <input type="checkbox" checked={commitLocal} onChange={(e) => setCommitLocal(e.target.checked)} disabled={!isArmed} />
            Create local Git result
          </label>
        </div>
      )}

      {durability === 'DURABLE_REMOTE' && (
        <div className="composer-durability-panel">
          {pushRemotePolicy === 'FORBID' ? (
            <span className="composer-durability-info composer-durability-forbidden">Remote push: Not allowed by project policy</span>
          ) : pushRemotePolicy === 'UNKNOWN' ? (
            <span className="composer-durability-info composer-durability-forbidden">Remote push: Policy could not be determined — disabled</span>
          ) : (
            <>
              <label className="composer-durability-toggle">
                <input type="checkbox" checked={pushRemote} onChange={(e) => setPushRemote(e.target.checked)} disabled={!isArmed} />
                Push result to configured remote
                {pushRemotePolicy === 'APPROVAL' && <span className="composer-durability-hint"> (requires your explicit request — this checkbox is that request)</span>}
              </label>
              {pushRemote && (
                <label className="composer-durability-toggle composer-durability-remote-name">
                  Remote (advanced, defaults to origin)
                  <input
                    className="composer-task-file-input"
                    type="text"
                    placeholder="origin"
                    value={remoteName}
                    onChange={(e) => setRemoteName(e.target.value)}
                    disabled={!isArmed}
                  />
                </label>
              )}
            </>
          )}
          <label className="composer-durability-toggle">
            <input type="checkbox" checked={requestReview} onChange={(e) => setRequestReview(e.target.checked)} disabled={!isArmed} />
            Mark result ready for PM review
          </label>
        </div>
      )}

      <textarea
        className="composer-textarea"
        aria-label="Task prompt"
        placeholder={useTaskFile ? 'Task text is not used — the pinned file content below is the entire task body.' : 'Describe the task for this project...'}
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        disabled={!isArmed || useTaskFile}
        rows={4}
      />

      {mode === 'SINGLE' && (
        <div className="composer-task-file">
          <label className="composer-task-file-toggle">
            <input
              type="checkbox"
              checked={useTaskFile}
              onChange={(e) => setUseTaskFile(e.target.checked)}
              disabled={!isArmed}
            />
            Use a pinned task file from this project's Git repository instead of typed text
          </label>
          {useTaskFile && (
            <div className="composer-task-file-fields">
              <input
                className="composer-task-file-input"
                type="text"
                placeholder="ref (branch, tag, or commit)"
                value={taskFileRef}
                onChange={(e) => setTaskFileRef(e.target.value)}
                disabled={!isArmed}
              />
              <input
                className="composer-task-file-input"
                type="text"
                placeholder="tasks/dsh/<name>.md"
                value={taskFilePath}
                onChange={(e) => setTaskFilePath(e.target.value)}
                disabled={!isArmed}
              />
            </div>
          )}
        </div>
      )}

      {mode === 'COUNCIL' && (
        <div className="composer-council">
          <div className="composer-council-participants">
            <span className="composer-council-label">Participants</span>
            {/* Part C/U: primary text is the self-describing label; the
                canonical id is secondary subtext — the owner never needs to
                hover to tell profiles apart. */}
            {/* P22.5: a direct API profile is SINGLE-only by permanent
                product policy (not "unproven"/"pending"/"not yet tested") —
                it stays visible here (never hidden, so the owner isn't left
                wondering where a configured profile went) but disabled,
                with the same explanation the runtime error itself gives.
                To use an API-hosted model in Council/Debate, configure the
                provider in OpenCode and use an OpenCode PM profile instead. */}
            {pmProfiles.map((p) => {
              const apiSingleOnly = p.product === 'api';
              return (
                <label key={p.id} className="composer-council-participant" title={apiSingleOnly ? API_SINGLE_ONLY_HINT : undefined}>
                  <input
                    type="checkbox"
                    checked={participants.has(p.id)}
                    onChange={() => toggleParticipant(p.id)}
                    disabled={!isArmed || !p.available || apiSingleOnly}
                  />
                  <span className="composer-council-participant-text">
                    <span className="composer-council-participant-label">
                      {p.displayLabel}
                      {p.available ? '' : ' — unavailable'}
                      {apiSingleOnly ? ' — Single tasks only' : ''}
                    </span>
                    <span className="composer-council-participant-id">{p.id}</span>
                  </span>
                </label>
              );
            })}
            {participants.size === 0 && <span className="composer-council-hint">Select at least one participant.</span>}
          </div>
          <label className="composer-pm-label composer-council-rounds">
            Rounds
            <select className="composer-pm-select" value={rounds} onChange={(e) => setRounds(Number(e.target.value) === 1 ? 1 : 2)} disabled={!isArmed}>
              <option value={1}>1</option>
              <option value={2}>2</option>
            </select>
          </label>
          {/* P19-D4: DEBATE = COUNCIL + bounded iterative challenge/synthesis
              (docs/p19/00_...md) — an extension of the Council Report above,
              never a separate submission or a separate task mode. Reuses the
              exact council.debate.{enabled,max_rounds} shape
              normalizeCouncilSpec() already validates server-side. */}
          <div className="composer-debate">
            <label className="composer-debate-toggle">
              <input type="checkbox" checked={debateEnabled} onChange={(e) => setDebateEnabled(e.target.checked)} disabled={!isArmed} />
              Extend with Debate (after the Council Report, participants challenge/respond to a shared brief)
            </label>
            {debateEnabled && (
              <>
                <label className="composer-pm-label composer-debate-rounds">
                  Debate max rounds
                  <select className="composer-pm-select" value={debateMaxRounds} onChange={(e) => setDebateMaxRounds(Number(e.target.value) === 1 ? 1 : 2)} disabled={!isArmed}>
                    <option value={1}>1</option>
                    <option value={2}>2</option>
                  </select>
                  <span className="composer-durability-info">The chair decides after Round 1 whether Round 2 is needed; the engine forces a stop at max rounds regardless.</span>
                </label>
                <label className="composer-pm-label composer-debate-implementation">
                  Implementation participant (optional)
                  <select className="composer-pm-select" value={implementationParticipantId} onChange={(e) => setImplementationParticipantId(e.target.value)} disabled={!isArmed}>
                    <option value="">None — all participants read-only</option>
                    {[...participants].map((id) => {
                      const profile = pmProfiles.find((p) => p.id === id);
                      return <option key={id} value={id}>{profile?.displayLabel ?? id} — {id}</option>;
                    })}
                  </select>
                  <span className="composer-durability-info">Only this participant may implement during its Council report turn. All Debate briefs, responses, and syntheses remain read-only.</span>
                </label>
              </>
            )}
          </div>
        </div>
      )}

      <div className="composer-footer">
        <label className="composer-pm-label">
          {mode === 'SINGLE' ? 'PM for next task' : 'Chair PM'}
          <select
            className="composer-pm-select"
            value={pmProfileId ?? ''}
            onChange={(e) => onPmProfileChange(e.target.value)}
            disabled={!isArmed || availableProfiles.length === 0}
          >
            <option value="" disabled>
              {availableProfiles.length === 0 ? 'No PM profile available' : 'Choose a PM profile'}
            </option>
            {/* P9-R0.4 Part A/C/U: the self-describing label is the PRIMARY
                visible text — the canonical id is secondary, appended so it
                stays available without a hover (native <option> has no rich
                markup, so both live on one line).
                P22.5: as Chair PM (mode === 'COUNCIL'), a direct API profile
                is disabled with the same Single-only explanation as the
                participant list above — never hidden, never phrased as
                unproven/pending. As "PM for next task" (mode === 'SINGLE')
                it is fully selectable, unchanged. */}
            {pmProfiles.map((p) => {
              const apiSingleOnly = mode === 'COUNCIL' && p.product === 'api';
              return (
                <option key={p.id} value={p.id} disabled={!p.available || apiSingleOnly}>
                  {p.displayLabel} — {p.id}
                  {p.available ? '' : ' — unavailable'}
                  {apiSingleOnly ? ' — Single tasks only' : ''}
                </option>
              );
            })}
          </select>
        </label>

        <button className="btn btn-primary composer-send" onClick={handleSubmit} disabled={!canSubmit}>
          {sending ? 'SENDING…' : reason ?? 'Send'}
        </button>
      </div>

      {lastError && <div className="composer-error">{lastError}</div>}
    </div>
  );
}

export default Composer;
