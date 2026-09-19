/**
 * P10-R0.2 — deterministic post-task repository context materializer.
 *
 * Writes a portable, human/AI-readable project-history package into the
 * OWNER'S OWN project (`<project repo_path>/docs/history/**`,
 * `<project repo_path>/progress.md`) from data DSH already durably owns
 * (`pm_runs`/`pm_turns` via `result.history` — the exact same array
 * `production-pm-worker.mjs#finalizeTaskDiagnostics()` already reads for the
 * SEPARATE runtime-diagnostic layer — see
 * docs/p10/03_TASK_DIAGNOSTIC_LOG_CONTRACT_SONNET5.md §8 for why these two
 * layers are deliberately never collapsed).
 *
 * Hard invariants (see docs/p10/06_REPOSITORY_CONTEXT_MATERIALIZATION.md):
 *  - NO model/LLM invocation of any kind (Part Q). Every byte written here
 *    is a deterministic projection of already-durable structured data.
 *  - Only ever called for a task that already reached `status: 'completed'`
 *    (Part T/AK item 39) — enforced by the caller
 *    (production-pm-worker.mjs), not re-checked here, so this module stays
 *    a pure "materialize what I'm given" primitive.
 *  - A failure here NEVER changes the task's own terminal result (Part T) —
 *    this module throws on genuine defects; its only production caller
 *    wraps every call in try/catch and records `HANDOFF_MATERIALIZATION_FAILED`
 *    as a distinct, additive fact, never retroactively touching
 *    `pm_runs.status`.
 *  - Idempotent (Part U) and reasonably atomic (Part V) — see `#marker`
 *    below.
 *  - Every write stays inside `<projectRoot>/docs/history/**` or
 *    `<projectRoot>/progress.md` (Part S) — `assertWithinProjectRoot()`
 *    is a hard, throwing guard, independent of the deterministic
 *    (therefore already-safe) folder-naming layer in
 *    repo-history-id.mjs.
 */

import { existsSync, mkdirSync, writeFileSync, renameSync, readFileSync, appendFileSync } from 'node:fs';
import { dirname, join, resolve, relative, sep, isAbsolute } from 'node:path';

import { taskFolderName, memberFolderName, assertSafeSegment } from './repo-history-id.mjs';
import {
  buildSingleTaskMarkdown, buildSinglePmMarkdown, buildSinglePlanMarkdown, buildSingleWalkthroughMarkdown,
  buildExecutionLogMarkdown, buildCouncilTaskMarkdown, buildChairPmMarkdown, buildChairPlanMarkdown,
  buildChairSynthesisMarkdown, buildMemberReportMarkdown, buildMemberCritiqueMarkdown, buildMemberFailureMarkdown,
  buildCouncilWalkthroughMarkdown, buildProgressLine,
  buildVerificationMarkdown, buildExecutiveSummaryMarkdown, buildTaskProgressMarkdown, buildMemberStatusMarkdown, buildTaskMetadataJson,
  // P19-D2 (docs/p19/00_...md §11 / docs/p19/03_...md):
  buildDebateBriefMarkdown, buildDebateResponseMarkdown, buildDebateResponseFailureMarkdown,
  buildDebateReportMarkdown, buildFinalDebateReportMarkdown,
} from './repo-history-content.mjs';
import {
  extractChairPlan, extractParticipantSteps, extractChairSynthesis, findMarkers, buildExecutionEntries,
  buildSingleExecutionEntries, extractSingleProcessEvidence, extractTaskSourceAndRuntimeClass,
  extractDebateRounds,
} from './repo-history-extract.mjs';
import { verificationStatusFromFinalData, VERIFICATION_STATUS } from '../pm/task-outcome-model.mjs';
import { DEBATE_MAX_ROUNDS } from '../pm/council/council-contracts.mjs';

export const MATERIALIZATION_STATUS = Object.freeze({
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  NOT_REQUESTED: 'NOT_REQUESTED',
});

// P10-R0.2.3 Part X/Y: bumped when a SINGLE task's ExecutionLog.md gained
// the new operational-evidence sections (PM identity/PID/sandbox/exit/
// handoff — buildSingleExecutionEntries()).
// P10-R0.2.4: bumped again — Task.md gained the "## Task source"/"runtime
// class" fields and ExecutionLog.md gained the LONG_TASK_RUNTIME/
// HARD_DEADLINE_REACHED sections (repo-history-extract.mjs).
// P12-R2: bumped again — BOTH SINGLE and COUNCIL gained new files this
// wave (task.json, ExecutiveSummary.md, optional Verification.md/
// Progress.md, and per-member Status.md for COUNCIL). The old "COUNCIL
// never requires a version match" exception is retired below: this is
// genuinely the first council format change since P10, so COUNCIL now
// participates in the exact same version-gated re-materialization SINGLE
// already used. No DB migration; this remains filesystem-only bookkeeping.
// P19-D2: bumped again — COUNCIL gains the additive Debate/Round-N/**
// tree (docs/p19/00_...md §11) whenever `council.debate?.enabled` is true
// AND at least one debate round actually executed (buildDebateFiles()
// below). SINGLE and every debate-DISABLED council are completely
// unaffected in output — the version bump exists only so a stale
// pre-D2 marker for a debate-enabled task is correctly re-materialized
// with the new files; a debate-disabled task's marker written under v4
// is functionally identical to one written under v5 (same file set) but
// still re-materializes once, byte-identically, per this same mechanism.
export const EXECUTION_LOG_VERSION = 5;

// ---- Part S: hard, throwing path-safety guard, independent of the ---------
// already-deterministic (and therefore already-safe) folder-naming layer.
export function assertWithinProjectRoot(projectRoot, candidatePath, label = 'path') {
  if (typeof projectRoot !== 'string' || !projectRoot || !isAbsolute(projectRoot)) {
    throw new TypeError('projectRoot must be an absolute path');
  }
  const root = resolve(projectRoot);
  const candidate = resolve(candidatePath);
  const rel = relative(root, candidate);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`${label} escapes the project root: ${candidatePath}`);
  }
  return candidate;
}

function toPosixRelative(root, candidate) {
  return relative(resolve(root), resolve(candidate)).split(sep).join('/');
}

function atomicWriteFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

/**
 * Part R/AG: opportunistic PID correlation from the SEPARATE runtime-
 * diagnostic `events.jsonl` (never required — a missing/unreadable file
 * yields an empty map, never a materialization failure). Correlates by
 * strict event ORDER (each `<PREFIX>_ATTEMPT_START` establishes "current
 * stage"; the very next `BACKEND_PROCESS_SPAWN` belongs to it) because the
 * diagnostic log's own `stage` field on `BACKEND_PROCESS_SPAWN` is always
 * the literal string `"PROCESS_SPAWN"` — never a step-kind discriminator —
 * see docs/p10/03_TASK_DIAGNOSTIC_LOG_CONTRACT_SONNET5.md §4's event
 * vocabulary.
 */
const ATTEMPT_PREFIX_TO_STEP_KIND = Object.freeze({
  COUNCIL_PLAN: 'chair_plan', PARTICIPANT: 'participant_report', CRITIQUE: 'participant_critique', CHAIR_SYNTHESIS: 'chair_synthesis',
});

export function correlateStagePids(events) {
  // Returns Map<"<stepKind>:<profileId>:<round>", pid> — turn-index-free
  // because events.jsonl carries no turn index; the caller maps this back
  // onto `result.history` turns by (stepKind, profileId) instead.
  const out = new Map();
  let current = null;
  for (const e of events ?? []) {
    if (typeof e?.event_type !== 'string') continue;
    const attemptMatch = e.event_type.match(/^(COUNCIL_PLAN|PARTICIPANT|CRITIQUE|CHAIR_SYNTHESIS)_ATTEMPT_START$/);
    if (attemptMatch) {
      current = { stepKind: ATTEMPT_PREFIX_TO_STEP_KIND[attemptMatch[1]], profileId: e.profile_id ?? null };
      continue;
    }
    if (e.event_type === 'BACKEND_PROCESS_SPAWN' && current) {
      const key = `${current.stepKind}:${e.profile_id ?? current.profileId}`;
      if (!out.has(key)) out.set(key, e.process_pid ?? null);
    }
  }
  return out;
}

/** Best-effort events.jsonl reader — NEVER throws, returns `[]` on any I/O/parse problem (Part R: PID evidence is always optional). */
export function readEventsJsonlSafe(path) {
  try {
    if (!path || !existsSync(path)) return [];
    return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

function handoffOf(turn) { return turn?.outcome?.finalResult?.handoff ?? null; }

function buildStagePidsByTurn(history, events) {
  const byKey = correlateStagePids(events);
  const byTurn = new Map();
  for (const h of history ?? []) {
    const handoff = handoffOf(h);
    if (!handoff?.stepKind) continue;
    const key = `${handoff.stepKind}:${handoff.participantProfileId ?? null}`;
    const pid = byKey.get(key);
    if (pid !== undefined && pid !== null) byTurn.set(h.turn, pid);
  }
  return byTurn;
}

function progressLineAlreadyPresent(progressPath, taskId) {
  if (!existsSync(progressPath)) return false;
  try {
    const text = readFileSync(progressPath, 'utf8');
    return text.includes(`| ${taskId} |`);
  } catch { return false; }
}

function appendProgressLine(progressPath, lineText) {
  mkdirSync(dirname(progressPath), { recursive: true });
  const needsLeadingNewline = existsSync(progressPath) && (() => {
    try { const s = readFileSync(progressPath, 'utf8'); return s.length > 0 && !s.endsWith('\n'); } catch { return false; }
  })();
  appendFileSync(progressPath, `${needsLeadingNewline ? '\n' : ''}${lineText}\n`, 'utf8');
}

function readMarker(markerPath) {
  try {
    if (!existsSync(markerPath)) return null;
    return JSON.parse(readFileSync(markerPath, 'utf8'));
  } catch { return null; }
}

// ---- SINGLE task file set ---------------------------------------------
// P10-R0.2.3 Part C/S: `events`/`historyPathRel` are the two additive
// inputs this wave adds — `events` (this task's own already-durable
// events.jsonl, read once by the caller) feeds ONLY ExecutionLog.md's new
// operational sections (PID/sandbox/exit — Part B: never a second source
// of semantic truth); `historyPathRel` lets ExecutionLog.md's REPOSITORY
// HANDOFF section state its own path without a forward reference. Both
// are optional (default `[]`/`null`) so a caller that omits them still
// gets a valid (just less-enriched) ExecutionLog.md.
function buildSingleFiles({ taskId, pmRunId, projectId, submittedVia, commandId, createdAt, completedAt, status, ownerTaskText, pmProfileId, profile, finalOutput, finalData, history, stagePidsByTurn, events = [], historyPathRel = null }) {
  const isPlan = Boolean(finalData && typeof finalData === 'object' && (finalData.type === 'plan' || typeof finalData.plan === 'string'));
  // P10-R0.2.4 Part P: task-source provenance/runtime class read back from
  // this task's OWN events.jsonl (already durable — never re-derived from
  // Telegram text, never a second source of truth).
  const { taskSource, runtimeClass } = extractTaskSourceAndRuntimeClass(events);
  return {
    'Task.md': buildSingleTaskMarkdown({ taskId, pmRunId, projectId, submittedVia, commandId, createdAt, completedAt, ownerTaskText, pmProfileId, status, runtimeClass, taskSource }),
    'PM.md': buildSinglePmMarkdown({ profileId: pmProfileId, profile, nativeSessionId: null, nativeSessionReuse: 'UNKNOWN' }),
    'Plan.md': buildSinglePlanMarkdown({ isPlan, output: finalOutput, data: finalData }),
    'Walkthrough.md': buildSingleWalkthroughMarkdown({
      taskId, ownerTaskText, pmProfileId, profile, status, output: finalOutput,
      filesChanged: [], verification: [], knownLimitations: ['DSH does not currently track a distinct "files changed"/"verification" evidence field for a SINGLE PM run beyond its own turn history — this section is intentionally empty rather than fabricated.'],
      continuationContext: [], recommendedNextFiles: [],
      processEvidence: extractSingleProcessEvidence(events),
    }),
    'ExecutionLog.md': buildExecutionLogMarkdown({
      title: 'Execution Log',
      entries: buildSingleExecutionEntries({
        taskId, pmRunId, submittedVia, taskAcceptedAt: createdAt, taskCompletedAt: completedAt, status,
        profileId: pmProfileId, profile, history, events, historyPathRel,
      }),
    }),
  };
}

// ---- DEBATE round file set (P19-D2, additive to COUNCIL) ---------------
// Pure function of `history` (+ the already-computed `memberFolderByProfile`
// slug map, reused verbatim so a debate participant's Debate/Round-N/
// Participant-<slug>.md path always matches its members/<slug>/ folder —
// "Same participant must map to the same artifact path after restart",
// docs/p19/03_...md). Returns `{}` (no files at all) when debate is
// disabled OR enabled-but-not-yet-started — never a fake/placeholder
// Debate/ tree (docs/p19/00_...md §0.9's "no Round-2 artifact when Round 2
// didn't run" applies symmetrically to Round 1 here).
function buildDebateFiles({ council, history, memberFolderByProfile, resolveProfile }) {
  const files = {};
  if (!council.debate?.enabled) return files;
  const debateRounds = extractDebateRounds(history);
  if (!debateRounds.length) return files; // Council Report complete, Debate not started -- Council artifacts only.

  const maxRounds = Math.min(council.debate.max_rounds ?? DEBATE_MAX_ROUNDS, DEBATE_MAX_ROUNDS);
  let finalRound = null; // the LAST round whose synthesis completed successfully with effectiveContinue=false

  for (const r of debateRounds) {
    const dir = `Debate/Round-${r.round}`;
    if (r.brief) {
      if (r.brief.handoff.ok) {
        files[`${dir}/Brief.md`] = buildDebateBriefMarkdown({ round: r.round, brief: r.brief.handoff.brief });
      }
      // A failed brief has no DebateReport/participant content to
      // materialize either (the driver throws before any response step is
      // ever dispatched — council-chair-driver.mjs) — nothing further to
      // write for this round; not fabricated here.
    }
    for (const resp of r.responses) {
      const folder = memberFolderByProfile.get(resp.profileId) ?? resp.profileId;
      const profile = resolveProfile(resp.profileId);
      if (resp.handoff.ok) {
        files[`${dir}/Participant-${folder}.md`] = buildDebateResponseMarkdown({ profileId: resp.profileId, profile, round: r.round, response: resp.handoff.response });
      } else {
        files[`${dir}/Participant-${folder}.md`] = buildDebateResponseFailureMarkdown({ profileId: resp.profileId, profile, round: r.round, reason: resp.handoff.reason ?? 'NO_RESPONSE_STEP_REACHED' });
      }
    }
    if (r.synthesis) {
      const ok = r.synthesis.handoff.ok === true;
      files[`${dir}/DebateReport.md`] = buildDebateReportMarkdown({
        round: r.round, ok, output: ok ? r.synthesis.handoff.output : null, reason: ok ? null : r.synthesis.handoff.reason,
        continueDebate: ok ? r.synthesis.handoff.continue_debate ?? null : null,
        unresolvedQuestions: ok ? (r.synthesis.handoff.unresolved_questions ?? []) : [],
      });
      if (ok) {
        const continueDebate = r.synthesis.handoff.continue_debate === true;
        const roundsRemaining = r.round < maxRounds;
        const effectiveContinue = continueDebate && roundsRemaining;
        if (!effectiveContinue) finalRound = { round: r.round, handoff: r.synthesis.handoff, engineForcedStop: continueDebate && !roundsRemaining };
      }
    }
  }

  if (finalRound) {
    files['Debate/FinalDebateReport.md'] = buildFinalDebateReportMarkdown({
      round: finalRound.round, output: finalRound.handoff.output,
      continueDebate: finalRound.handoff.continue_debate ?? null,
      unresolvedQuestions: finalRound.handoff.unresolved_questions ?? [],
      engineForcedStop: finalRound.engineForcedStop,
    });
  }

  return files;
}

// ---- COUNCIL task file set ---------------------------------------------
function buildCouncilFiles({ taskId, pmRunId, projectId, submittedVia, commandId, createdAt, completedAt, status, ownerTaskText, council, history, resolveProfile, stagePidsByTurn }) {
  const chairProfileId = council.chair_profile_id;
  const chairProfile = resolveProfile(chairProfileId);
  const participantIds = Array.isArray(council.participant_profile_ids) ? council.participant_profile_ids : [];
  const participants = participantIds.map((id) => ({ profileId: id, profile: resolveProfile(id) }));

  const chairPlan = extractChairPlan(history);
  const chairSynthesis = extractChairSynthesis(history);
  const reportSteps = extractParticipantSteps(history, 'participant_report');
  const critiqueSteps = extractParticipantSteps(history, 'participant_critique');

  const markers = [...new Set([...findMarkers(ownerTaskText), ...findMarkers(chairSynthesis?.handoff?.output ?? '')])];

  const files = {};
  files['Task.md'] = buildCouncilTaskMarkdown({
    taskId, pmRunId, projectId, submittedVia, commandId, createdAt, completedAt, ownerTaskText,
    rounds: council.rounds ?? null, strategy: council.strategy ?? null, chairProfileId, chairProfile, participants, markers, status,
  });

  const chairInvocations = [];
  if (chairPlan) chairInvocations.push({ stage: 'chair_plan', processPid: stagePidsByTurn.get(chairPlan.turn.turn) ?? null, nativeSessionId: null, nativeSessionReuse: 'UNKNOWN' });
  if (chairSynthesis) chairInvocations.push({ stage: 'chair_synthesis', processPid: stagePidsByTurn.get(chairSynthesis.turn.turn) ?? null, nativeSessionId: null, nativeSessionReuse: 'UNKNOWN' });
  files['chair/PM.md'] = buildChairPmMarkdown({ chairProfileId, profile: chairProfile, invocations: chairInvocations });
  files['chair/Plan.md'] = buildChairPlanMarkdown({
    participantInstructions: chairPlan?.handoff?.participant_instructions ?? {},
    critiqueFocus: chairPlan?.handoff?.critique_focus ?? null,
    synthesisFocus: chairPlan?.handoff?.synthesis_focus ?? null,
    structuredOutput: chairPlan?.handoff?.structured_output ?? null,
    repaired: chairPlan?.handoff?.repaired === true,
    attempts: chairPlan?.handoff?.attempts ?? [],
  });
  files['chair/Synthesis.md'] = buildChairSynthesisMarkdown({ output: chairSynthesis?.handoff?.output ?? chairSynthesis?.handoff?.output_text ?? '', markers });

  // Part L: represent EVERY owner-selected participant, including a failed one.
  const usedFolderNames = new Set();
  const memberFolderByProfile = new Map();
  for (const p of participants) memberFolderByProfile.set(p.profileId, memberFolderName({ product: p.profile?.product, model: p.profile?.model, profileId: p.profileId }, usedFolderNames));

  for (const p of participants) {
    const folder = memberFolderByProfile.get(p.profileId);
    const report = reportSteps.find((r) => r.profileId === p.profileId) ?? null;
    const round1Ok = Boolean(report && report.handoff?.ok);
    if (round1Ok) {
      files[`members/${folder}/Round1_Report.md`] = buildMemberReportMarkdown({
        profileId: p.profileId, profile: p.profile, round: report.turn.decision?.spec?.round ?? 1,
        processPid: stagePidsByTurn.get(report.turn.turn) ?? null, nativeSessionId: null,
        analysis: report.handoff.analysis, recommendation: report.handoff.recommendation,
        risks: report.handoff.risks ?? [], uncertainties: report.handoff.uncertainties ?? [],
      });
    } else {
      files[`members/${folder}/Round1_Failure.md`] = buildMemberFailureMarkdown({
        profileId: p.profileId, profile: p.profile, round: 1, stage: 'participant_report',
        reason: report?.handoff?.reason ?? 'NO_REPORT_STEP_REACHED', retryOccurred: (report?.handoff?.attempts ?? []).length > 1, attempts: report?.handoff?.attempts ?? [],
      });
    }

    const critique = critiqueSteps.find((c) => c.profileId === p.profileId) ?? null;
    const round2Ok = Boolean(critique && critique.handoff?.ok);
    if (round2Ok) {
      files[`members/${folder}/Round2_Critique.md`] = buildMemberCritiqueMarkdown({
        profileId: p.profileId, profile: p.profile, round: critique.turn.decision?.spec?.round ?? 2,
        processPid: stagePidsByTurn.get(critique.turn.turn) ?? null, nativeSessionId: null,
        criticisms: critique.handoff.criticisms ?? [], agreements: critique.handoff.agreements ?? [],
        revisedRecommendation: critique.handoff.revised_recommendation, remainingDisagreements: critique.handoff.remaining_disagreements ?? [],
        peerEvidenceSupplied: reportSteps.filter((r) => r.profileId !== p.profileId && r.handoff?.ok).map((r) => `${r.profileId} round-1 report`),
      });
    } else {
      files[`members/${folder}/Round2_Failure.md`] = buildMemberFailureMarkdown({
        profileId: p.profileId, profile: p.profile, round: 2, stage: 'participant_critique',
        reason: critique?.handoff?.reason ?? 'NO_CRITIQUE_STEP_REACHED', retryOccurred: (critique?.handoff?.attempts ?? []).length > 1, attempts: critique?.handoff?.attempts ?? [],
      });
    }

    // P12-R2 — additive companion to the two detailed files above (never a
    // substitute): a compact, scannable per-member status using the SAME
    // programmatic `ok` facts already computed here, never re-derived from
    // model text.
    files[`members/${folder}/Status.md`] = buildMemberStatusMarkdown({
      profileId: p.profileId, profile: p.profile, round1Ok, round2Ok,
      round1ErrorCode: round1Ok ? null : (report?.handoff?.reason ?? 'NO_REPORT_STEP_REACHED'),
      round2ErrorCode: round2Ok ? null : (critique?.handoff?.reason ?? 'NO_CRITIQUE_STEP_REACHED'),
    });
  }

  // P19-D2 — additive Debate/Round-N/** tree (docs/p19/00_...md §11).
  // `memberFolderByProfile` is reused verbatim so a debate participant's
  // artifact path always matches its members/<folder>/ slug.
  Object.assign(files, buildDebateFiles({ council, history, memberFolderByProfile, resolveProfile }));

  const round1 = reportSteps.filter((r) => r.handoff?.ok).map((r) => ({
    profileId: r.profileId, profile: resolveProfile(r.profileId), path: `members/${memberFolderByProfile.get(r.profileId)}/Round1_Report.md`,
    position: r.handoff.recommendation ?? r.handoff.output ?? '',
  }));
  const round2 = critiqueSteps.filter((c) => c.handoff?.ok).map((c) => ({
    profileId: c.profileId, profile: resolveProfile(c.profileId), path: `members/${memberFolderByProfile.get(c.profileId)}/Round2_Critique.md`,
    position: c.handoff.revised_recommendation ?? c.handoff.output ?? '',
  }));

  const sessionEvidence = [
    chairPlan ? { label: `Chair — chair_plan (${chairProfileId})`, newProcessProven: stagePidsByTurn.has(chairPlan.turn.turn), nativeSessionId: null, nativeSessionReuse: 'UNKNOWN' } : null,
    chairSynthesis ? { label: `Chair — chair_synthesis (${chairProfileId})`, newProcessProven: stagePidsByTurn.has(chairSynthesis.turn.turn), nativeSessionId: null, nativeSessionReuse: 'UNKNOWN' } : null,
    ...reportSteps.map((r) => ({ label: `${r.profileId} — participant_report`, newProcessProven: stagePidsByTurn.has(r.turn.turn), nativeSessionId: null, nativeSessionReuse: 'UNKNOWN' })),
    ...critiqueSteps.map((c) => ({ label: `${c.profileId} — participant_critique`, newProcessProven: stagePidsByTurn.has(c.turn.turn), nativeSessionId: null, nativeSessionReuse: 'UNKNOWN' })),
  ].filter(Boolean);

  files['Walkthrough.md'] = buildCouncilWalkthroughMarkdown({
    taskId, ownerTaskWhy: ownerTaskText, chairProfileId, chairProfile, round1, round2,
    finalDecisionPath: 'chair/Synthesis.md', finalDecisionExcerpt: chairSynthesis?.handoff?.output ?? '',
    agreements: [], disagreements: [], rejectedAlternatives: [], unresolvedQuestions: [],
    repositoryChanges: [], runtimeEvidence: [], sessionEvidence,
    continuationContext: markers.length ? [`Marker(s) present in this task's owner text/synthesis: ${markers.join(', ')}`] : [],
    readOrder: ['this Walkthrough.md', 'chair/Synthesis.md', ...round1.map((r) => r.path), ...round2.map((r) => r.path), 'ExecutionLog.md', 'progress.md'],
  });
  files['ExecutionLog.md'] = buildExecutionLogMarkdown({ title: 'Execution Log', entries: buildExecutionEntries({ history, stagePids: stagePidsByTurn, taskAcceptedAt: createdAt }) });

  return files;
}

/**
 * Main entry point. Only ever call this for a task whose canonical result
 * already reached `status: 'completed'` (Part T/AK item 39) — this function
 * does not itself re-check that; production-pm-worker.mjs's terminal-status
 * gate is the single enforcement point, matching how `finalizeTaskDiagnostics`
 * is already gated.
 */
export function materializeTaskHistory({
  projectRoot, taskId, pmRunId, projectId, taskMode, submittedVia = 'UNKNOWN', commandId = null,
  createdAt, completedAt = null, status = 'completed', ownerTaskText = '', pmProfileId = null,
  council = null, history = [], finalOutput = '', finalData = null,
  resolveProfile = () => null, events = [],
  // P12-R2 — additive. `durability`/`outcome`/`resultCommit` are the ONLY
  // new inputs this materializer needs: git-sync results and the
  // aggregated six-dimension outcome are computed by the CALLER
  // (production-pm-worker.mjs, which has git/coordination access this pure
  // primitive deliberately does not) and simply recorded here. Every
  // existing caller that omits these keeps producing byte-for-byte the
  // same file set as before P12 plus the two new unconditional files
  // (task.json, ExecutiveSummary.md — cheap structured/summary data, not
  // "documentation bureaucracy", so unconditional here is compliant with
  // the P12 artifact-tiering matrix, which marks both merely "optional" at
  // DURABLE_LOCAL, never "forbidden").
  durability = 'DURABLE_LOCAL', outcome = null, resultCommit = null,
  // P12-R3 §4: purely discoverability metadata — see
  // owner-task-controller.mjs's normalizeTaskRelations() for the exact
  // shape/validation. `null` for every task that doesn't reference another.
  relations = null,
}) {
  if (!projectRoot || typeof projectRoot !== 'string') throw new TypeError('materializeTaskHistory requires projectRoot');
  if (!taskId || typeof taskId !== 'string') throw new TypeError('materializeTaskHistory requires taskId');
  if (taskMode !== 'SINGLE' && taskMode !== 'COUNCIL') throw new TypeError('materializeTaskHistory requires taskMode SINGLE|COUNCIL');
  if (!createdAt) throw new TypeError('materializeTaskHistory requires createdAt (task creation/accepted time)');

  const folderName = taskFolderName({ taskId, createdAt, titleText: ownerTaskText });
  const modeDir = taskMode === 'COUNCIL' ? 'council' : 'single';
  assertSafeSegment(modeDir, 'mode directory');
  const historyRoot = join(projectRoot, 'docs', 'history');
  const taskDir = assertWithinProjectRoot(projectRoot, join(historyRoot, modeDir, folderName), 'history task directory');
  const progressPath = assertWithinProjectRoot(projectRoot, join(projectRoot, 'progress.md'), 'progress.md');
  const markerPath = join(taskDir, '.materialized.json');
  const historyPathRel = toPosixRelative(projectRoot, taskDir);

  // Part U/X/Y: idempotent no-op when this exact task was already fully
  // materialized AT THE CURRENT format version. P12-R2 retires the old
  // "COUNCIL never requires a version match" exception (both SINGLE and
  // COUNCIL now check `execution_log_version === EXECUTION_LOG_VERSION`) —
  // an existing marker from BEFORE this wave (no field, or an old number)
  // is correctly treated as stale and re-materialized with the new files.
  // This is exactly the mechanism the T2/T3 backfill script (Part N/O)
  // already relies on: it is the SAME materializeTaskHistory() call, not a
  // special-cased path.
  const existingMarker = readMarker(markerPath);
  const markerIsCurrent = existingMarker && existingMarker.task_id === taskId
    && existingMarker.execution_log_version === EXECUTION_LOG_VERSION;
  if (markerIsCurrent) {
    return Object.freeze({ status: MATERIALIZATION_STATUS.COMPLETED, historyPath: historyPathRel, folderName, reason: 'ALREADY_MATERIALIZED', idempotent: true });
  }

  const stagePidsByTurn = buildStagePidsByTurn(history, events);

  const files = taskMode === 'COUNCIL'
    ? buildCouncilFiles({ taskId, pmRunId, projectId, submittedVia, commandId, createdAt, completedAt, status, ownerTaskText, council: council ?? {}, history, resolveProfile, stagePidsByTurn })
    : buildSingleFiles({ taskId, pmRunId, projectId, submittedVia, commandId, createdAt, completedAt, status, ownerTaskText, pmProfileId, profile: resolveProfile(pmProfileId), finalOutput, finalData, history, stagePidsByTurn, events, historyPathRel });

  // P12-R2 — new additive files (docs/p12/01_P12_R0_*_SONNET5.md §5/§6.3).
  // `outcome` is caller-computed (production-pm-worker.mjs owns git-sync
  // results this pure primitive has no access to); when a caller omits it
  // (every pre-P12 call site/test), a minimal outcome is derived here from
  // `status` alone so task.json/ExecutiveSummary.md are still well-formed.
  const verificationStatus = outcome?.verification_status ?? verificationStatusFromFinalData(finalData);
  const degraded = Boolean(outcome?.degraded ?? (taskMode === 'COUNCIL' && finalData?.degraded === true));
  const localGitStatus = outcome?.local_git_status ?? 'NOT_REQUESTED';
  const remoteSyncStatus = outcome?.remote_sync_status ?? 'NOT_REQUESTED';
  const terminalMarker = outcome?.terminal_marker ?? (status === 'completed' ? (degraded ? 'COMPLETED_DEGRADED' : 'COMPLETED') : status.toUpperCase());

  if (verificationStatus === VERIFICATION_STATUS.PASSED || verificationStatus === VERIFICATION_STATUS.FAILED) {
    files['Verification.md'] = buildVerificationMarkdown({
      status: verificationStatus,
      summary: finalData?.verification?.summary ?? null,
      details: Array.isArray(finalData?.verification?.details) ? finalData.verification.details : [],
    });
  }

  files['ExecutiveSummary.md'] = buildExecutiveSummaryMarkdown({
    taskId, ownerTaskText, status, durability, degraded,
    outputExcerpt: taskMode === 'COUNCIL' ? (extractChairSynthesis(history)?.handoff?.output ?? '') : finalOutput,
    verificationStatus, localGitStatus, remoteSyncStatus, resultCommit, terminalMarker,
  });

  // Task-local Progress.md: distinct from the project-root progress.md
  // ledger below. Only meaningful with multiple durable checkpoints —
  // COUNCIL always has several (chair_plan/reports/critiques/synthesis);
  // SINGLE only when the run genuinely had more than one turn.
  if (taskMode === 'COUNCIL' || (Array.isArray(history) && history.length > 1)) {
    const checkpoints = (history ?? []).map((h) => ({
      label: h?.decision?.spec?.round !== undefined ? `turn ${h.turn} (round ${h.decision.spec.round})` : `turn ${h?.turn ?? '?'}`,
      timestamp: h?.outcome?.completedAt ?? h?.completedAt ?? null,
      status: handoffOf(h)?.ok === false ? 'FAILED' : 'OK',
    }));
    files['Progress.md'] = buildTaskProgressMarkdown({ taskId, checkpoints });
  }

  files['task.json'] = buildTaskMetadataJson({
    task_id: taskId, pm_run_id: pmRunId ?? null, mode: taskMode, durability,
    source: extractTaskSourceAndRuntimeClass(events).taskSource ?? null,
    parent_task_id: relations?.parent_task_id ?? null,
    related_task_ids: relations?.related_task_ids ?? [],
    remediation_of_task_id: relations?.remediation_of_task_id ?? null,
    review_of_task_id: relations?.review_of_task_id ?? null,
    execution_status: status === 'completed' ? 'EXECUTION_PASSED' : status === 'failed' ? 'EXECUTION_FAILED' : status === 'cancelled' ? 'EXECUTION_CANCELLED' : 'EXECUTION_RUNNING',
    verification_status: verificationStatus,
    artifact_status: 'ARTIFACTS_MATERIALIZED',
    local_git_status: localGitStatus,
    remote_sync_status: remoteSyncStatus,
    review_status: outcome?.review_status ?? 'NOT_REQUESTED',
    degraded, terminal_marker: terminalMarker,
    result_commit: resultCommit, history_path: `${historyPathRel}/`,
    created_at: createdAt, completed_at: completedAt,
  });

  // Part V: write every content file first; the `.materialized.json` marker
  // is written LAST and is the single "this is durably, fully materialized"
  // signal a reader (or a retried call) can trust.
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = assertWithinProjectRoot(projectRoot, join(taskDir, ...relPath.split('/')), `history file ${relPath}`);
    atomicWriteFile(fullPath, content);
  }

  const titleText = String(ownerTaskText ?? '').split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? taskId;
  const chairOrPmProfileId = taskMode === 'COUNCIL' ? (council?.chair_profile_id ?? null) : pmProfileId;
  if (!progressLineAlreadyPresent(progressPath, taskId)) {
    const progressLine = buildProgressLine({
      timestamp: completedAt ?? createdAt, taskType: taskMode, taskId, title: titleText, status,
      chairOrPmProfileId, historyPath: historyPathRel,
      outcome: taskMode === 'COUNCIL' ? `${(council?.participant_profile_ids ?? []).length}-backend council completed` : 'PM task completed',
    });
    appendProgressLine(progressPath, progressLine);
  }

  atomicWriteFile(markerPath, JSON.stringify({ task_id: taskId, pm_run_id: pmRunId ?? null, task_mode: taskMode, materialized_at: completedAt ?? createdAt, folder: folderName, execution_log_version: EXECUTION_LOG_VERSION }, null, 2));

  return Object.freeze({ status: MATERIALIZATION_STATUS.COMPLETED, historyPath: historyPathRel, folderName, reason: 'MATERIALIZED', idempotent: false });
}
