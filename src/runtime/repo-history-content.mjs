/**
 * P10-R0.2 Part D-N/AD/AE/AF — pure, testable markdown/text builders for the
 * repository context materializer. Every function here takes plain data in
 * (already-durable DSH state: task/pm_run/pm_turn/profile-registry shapes —
 * see repo-history-materializer.mjs for where that data comes from) and
 * returns a plain UTF-8 string out. No filesystem, no model call, no clock
 * (every timestamp is caller-supplied), matching the same separation
 * task-diagnostic-summary.mjs already established for the runtime-diagnostic
 * layer (docs/p10/03_TASK_DIAGNOSTIC_LOG_CONTRACT_SONNET5.md).
 *
 * Part AF (security): normal assistant output legitimately produced during
 * the task/council is allowed content. What is NEVER written here is
 * private chain-of-thought (nothing upstream of this module exposes CoT —
 * DurablePmRuntime/CouncilStepWorkflowRunner only ever hand this module the
 * same `finish` decision `output`/`data` fields already delivered to the
 * owner) or secret-shaped strings (redactSecrets() below, applied to every
 * owner/model-sourced text field before it is bounded).
 */

// ---- Part AD: explicit, documented bounds -----------------------------
export const MAX_OWNER_TASK_CHARS = 8000;
export const MAX_BODY_CHARS = 20000;
export const MAX_LIST_ITEM_CHARS = 2000;
export const MAX_LIST_ITEMS = 50;

const TRUNCATION_NOTE = (label, max) => `\n\n[TRUNCATED — canonical full result remains available in DSH durable state; ${label} exceeded ${max} chars]`;

// Mirrors src/orchestration/audit-sanitize.mjs's secret-pattern regex
// (deliberately duplicated rather than imported: that module's
// `sanitizeAuditString` also hard-clips to 500 chars, which is wrong for
// these narrative fields — Part AD wants explicit, documented, much larger
// bounds with a truthful truncation marker, never a silent 500-char clip).
const SECRET_PATTERN = /\b(?:sk|xai|ghp|github_pat|Bearer)[-_A-Za-z0-9.]{8,}\b/gi;
const SENSITIVE_KEY = /(?:token|secret|password|credential|api[-_]?key|authorization|cookie)/i;

export function redactSecrets(text) {
  return String(text ?? '').replace(SECRET_PATTERN, '[REDACTED]');
}

export function bound(text, max, label) {
  const redacted = redactSecrets(text);
  return redacted.length > max ? `${redacted.slice(0, max)}${TRUNCATION_NOTE(label, max)}` : redacted;
}

export function boundList(items, { maxItems = MAX_LIST_ITEMS, maxItemChars = MAX_LIST_ITEM_CHARS, label = 'list' } = {}) {
  const arr = Array.isArray(items) ? items : [];
  const shown = arr.slice(0, maxItems).map((item) => bound(String(item ?? ''), maxItemChars, `${label} item`));
  if (arr.length > maxItems) shown.push(`[TRUNCATED — ${arr.length - maxItems} more ${label} item(s) omitted; canonical full list remains available in DSH durable state]`);
  return shown;
}

function mdList(items) {
  if (!items.length) return '- (none)';
  return items.map((i) => `- ${i}`).join('\n');
}

function kv(label, value) { return `- ${label}: ${value === null || value === undefined || value === '' ? 'UNKNOWN' : value}`; }

/** Never fabricated (Part L, Part AH "Session Evidence"): PROVEN only when real evidence is passed in; otherwise the honest UNKNOWN/NOT PROVEN/NOT EXPOSED vocabulary. */
export function nativeSessionReuseLabel(evidence) {
  if (evidence === 'PROVEN' || evidence === 'NOT PROVEN') return evidence;
  return 'UNKNOWN';
}

// ---- Profile identity block (Part AC: canonical id is authority; readable label is supplemental) ----
// P11-R1 Part O: `provider` is additive — present (openrouter/deepseek/
// xcode-best/...) only for an `api` profile; every existing (non-api)
// profile has no `.provider` field at all, so `kv()` renders the same
// honest `UNKNOWN` it already renders for any other absent field, never a
// fabricated value. Placed right after `product` since provider is the
// next-most-authoritative identity fact once product is `api`.
export function profileIdentityBlock(profileId, profile) {
  return [
    kv('profile_id (canonical)', profileId),
    kv('product', profile?.product),
    kv('provider', profile?.provider ?? null),
    kv('model', profile?.model),
    kv('reasoning', profile?.reasoning),
    kv('session_kind', profile?.session_kind),
    kv('transport', profile?.transport ?? null),
  ].join('\n');
}

export function displayLabel(profileId, profile) {
  const parts = [profile?.product, profile?.model, profile?.reasoning].filter((v) => v !== null && v !== undefined && v !== '');
  return parts.length ? `${parts.join(' · ')} (${profileId})` : profileId;
}

// =========================================================================
// Part D — SINGLE task materialization
// =========================================================================

// P10-R0.2.4 Part P: safe, bounded GIT_FILE task-source provenance — never
// duplicates the whole long-task file body here (the owner task text
// section right below it already carries the full resolved content); this
// section exists so a future reader can prove EXACTLY which task version
// ran without re-deriving it from Telegram history. `taskSource` is
// `null` for every SHORT/non-GIT_FILE task (byte-for-byte unchanged).
function buildTaskSourceSection(taskSource){
  if(!taskSource)return [];
  return [
    '## Task source', '',
    kv('type', taskSource.type ?? 'GIT_FILE'),
    kv('requested_ref', taskSource.requestedRef ?? taskSource.requested_ref ?? null),
    kv('resolved_commit_sha', taskSource.resolvedCommitSha ?? taskSource.resolved_commit_sha ?? null),
    kv('path', taskSource.path ?? null),
    kv('content_sha256', taskSource.contentSha256 ?? taskSource.content_sha256 ?? null),
    kv('content_bytes', taskSource.contentBytes ?? taskSource.content_bytes ?? null),
    '',
  ];
}

export function buildSingleTaskMarkdown({
  taskId, pmRunId, projectId, submittedVia, commandId, createdAt, completedAt, ownerTaskText, pmProfileId, status,
  runtimeClass = null, taskSource = null,
}) {
  return [
    '# Task', '',
    kv('task_id', taskId),
    kv('pm_run_id', pmRunId),
    kv('project_id', projectId),
    kv('source channel', submittedVia),
    kv('command_id', commandId),
    kv('created_at', createdAt),
    kv('completed_at', completedAt),
    kv('selected PM profile_id (canonical)', pmProfileId),
    kv('terminal status', status),
    kv('runtime class', runtimeClass ?? 'NORMAL'),
    '',
    ...buildTaskSourceSection(taskSource),
    '## Owner task text (bounded)', '',
    bound(ownerTaskText ?? '', MAX_OWNER_TASK_CHARS, 'owner task text'),
    '',
  ].join('\n');
}

export function buildSinglePmMarkdown({ profileId, profile, nativeSessionId = null, nativeSessionReuse = 'UNKNOWN' }) {
  return [
    '# PM', '',
    profileIdentityBlock(profileId, profile),
    kv('native session id', nativeSessionId ?? 'NOT EXPOSED'),
    kv('native session reuse', nativeSessionReuseLabel(nativeSessionReuse)),
    '',
  ].join('\n');
}

export function buildSinglePlanMarkdown({ isPlan, output, data }) {
  const lines = ['# Plan', ''];
  if (isPlan) {
    lines.push('This is the canonical PM plan/decision output.', '');
  } else {
    lines.push('This task result is not semantically a "plan" — the canonical PM result is included below verbatim (Part D: "state that clearly and include the canonical PM result instead").', '');
  }
  lines.push('## Output', '', bound(output ?? '', MAX_BODY_CHARS, 'PM output'), '');
  if (data && Object.keys(data).length) {
    lines.push('## Structured result data', '', '```json', bound(JSON.stringify(data, null, 2), MAX_BODY_CHARS, 'PM result data'), '```', '');
  }
  return lines.join('\n');
}

// P10-R0.2.3 Part S: a small, deterministic "Process / Session Evidence"
// section — a SUMMARY pointer, never a duplicate of ExecutionLog.md's own
// detailed operational sections (which remain the one detailed source —
// Part S: "Do not duplicate the entire ExecutionLog"). `processEvidence`
// is optional (`null` when the caller has none — e.g. no events.jsonl
// available) so this section degrades to an honest "not observed" rather
// than being omitted silently.
function buildProcessSessionEvidence(processEvidence) {
  if (!processEvidence) {
    return ['# Process / Session Evidence', '', '- backend process observed: NOT RECORDED', ''].join('\n');
  }
  const lines = [
    '# Process / Session Evidence', '',
    kv('backend process observed', processEvidence.processObserved ? 'YES' : 'NOT RECORDED'),
    kv('process_pid', processEvidence.processPid ?? 'NOT RECORDED'),
    kv('native session id', processEvidence.nativeSessionId ?? 'NOT EXPOSED'),
    kv('native session reuse', nativeSessionReuseLabel(processEvidence.nativeSessionReuse)),
  ];
  if (processEvidence.sandboxState) lines.push(kv('sandbox', processEvidence.sandboxState));
  lines.push('');
  return lines.join('\n');
}

export function buildSingleWalkthroughMarkdown({
  taskId, ownerTaskText, pmProfileId, profile, status, output, filesChanged = [], verification = [], knownLimitations = [], continuationContext = [], recommendedNextFiles = [],
  processEvidence = null,
}) {
  return [
    '# Walkthrough', '',
    '# Task Summary', '', bound(ownerTaskText ?? '', 1200, 'task summary'), '',
    '# Inputs', '', kv('task_id', taskId), '',
    '# PM Identity', '', profileIdentityBlock(pmProfileId, profile), '',
    '# Decision / Result', '', kv('status', status), '', bound(output ?? '', MAX_BODY_CHARS, 'decision result'), '',
    buildProcessSessionEvidence(processEvidence),
    '# Files Changed', '', mdList(filesChanged), '',
    '# Verification', '', mdList(verification), '',
    '# Known Limitations', '', mdList(knownLimitations), '',
    '# Continuation Context', '', mdList(continuationContext), '',
    '# Recommended Files To Read Next', '', mdList(recommendedNextFiles.length ? recommendedNextFiles : ['Task.md', 'PM.md', 'Plan.md', 'ExecutionLog.md']), '',
  ].join('\n');
}

export function buildExecutionLogMarkdown({ title = 'Execution Log', entries = [] }) {
  const lines = [`# ${title}`, ''];
  if (!entries.length) { lines.push('(no execution events recorded)'); return lines.join('\n'); }
  for (const e of entries) {
    lines.push(`## ${e.heading}`);
    if (e.timestamp) lines.push(kv('timestamp', e.timestamp));
    if (e.durationMs !== undefined && e.durationMs !== null) lines.push(kv('duration_ms', e.durationMs));
    for (const [k, v] of Object.entries(e.fields ?? {})) lines.push(kv(k, v));
    lines.push('');
  }
  return lines.join('\n');
}

// =========================================================================
// Part E-K — COUNCIL task materialization
// =========================================================================

export function buildCouncilTaskMarkdown({
  taskId, pmRunId, projectId, submittedVia, commandId, createdAt, completedAt, ownerTaskText,
  rounds, strategy, chairProfileId, chairProfile = null, participants /* [{profileId, profile}] (chair excluded) */, markers = [], status,
}) {
  const lines = [
    '# Task', '',
    kv('task_id', taskId),
    kv('pm_run_id', pmRunId),
    kv('project_id', projectId),
    kv('source channel', submittedVia),
    kv('command_id', commandId),
    kv('created_at', createdAt),
    kv('completed_at', completedAt),
    kv('rounds', rounds),
    kv('strategy', strategy),
    kv('terminal status', status),
    '',
    '## Owner task text (bounded)', '',
    bound(ownerTaskText ?? '', MAX_OWNER_TASK_CHARS, 'owner task text'),
    '',
    '## Chair (canonical identity)', '',
    profileIdentityBlock(chairProfileId, chairProfile),
    '',
    '## Participants (ordered, owner-selected)', '',
  ];
  for (const p of participants) {
    lines.push(`### ${displayLabel(p.profileId, p.profile)}`, profileIdentityBlock(p.profileId, p.profile), '');
  }
  if (markers.length) lines.push('## Markers found in owner task text', '', mdList(markers), '');
  return lines.join('\n');
}

export function buildChairPmMarkdown({
  chairProfileId, profile, invocations = [], /* [{stage, processPid, nativeSessionId, nativeSessionReuse}] */
}) {
  const lines = [
    '# Chair PM', '',
    profileIdentityBlock(chairProfileId, profile),
    '',
    '## Chair invocations by stage', '',
  ];
  if (!invocations.length) {
    lines.push('(no per-stage invocation evidence available)');
  } else {
    for (const inv of invocations) {
      lines.push(
        `### ${inv.stage}`,
        kv('process pid (operational evidence)', inv.processPid ?? 'UNKNOWN'),
        kv('native session/conversation id', inv.nativeSessionId ?? 'NOT EXPOSED'),
        kv('native session reuse', nativeSessionReuseLabel(inv.nativeSessionReuse)),
        '',
      );
    }
    lines.push('Separate chair invocations (e.g. `chair_plan` vs `chair_synthesis`) are never assumed to share a native session unless concrete evidence proves it — see each stage\'s own `native session reuse` line above.', '');
  }
  return lines.join('\n');
}

export function buildChairPlanMarkdown({
  participantInstructions = {}, /* {profileId: text} */ critiqueFocus, synthesisFocus,
  structuredOutput = null, repaired = false, attempts = [],
}) {
  const lines = ['# Chair Plan', ''];
  lines.push('## Participant instruction mapping', '');
  for (const [pid, text] of Object.entries(participantInstructions)) {
    lines.push(`### ${pid}`, bound(text ?? '', MAX_BODY_CHARS, 'participant instruction'), '');
  }
  lines.push('## Critique focus', '', bound(critiqueFocus ?? '', MAX_BODY_CHARS, 'critique focus'), '');
  lines.push('## Synthesis focus', '', bound(synthesisFocus ?? '', MAX_BODY_CHARS, 'synthesis focus'), '');
  lines.push('## Structured output', '');
  if (structuredOutput) {
    lines.push(
      kv('requested', structuredOutput.requested),
      kv('provider', structuredOutput.provider),
      kv('schema_kind', structuredOutput.schema_kind),
      kv('present', structuredOutput.present),
      '',
    );
  } else {
    lines.push('- (free-form decision mode — no native structured output was requested for this chair plan)', '');
  }
  lines.push(
    '## Repair / retry',
    kv('chair plan repaired (participant-id contract)', repaired ? 'YES' : 'NO'),
    kv('real backend attempts recorded', attempts.length),
    '',
  );
  return lines.join('\n');
}

export function buildChairSynthesisMarkdown({ output, markers = [] }) {
  const lines = ['# Chair Synthesis', '', 'Preserved verbatim (bounded) from the canonical chair-synthesis output DSH already delivered to the owner — never re-summarized by another model.', ''];
  lines.push('## Final synthesis', '', bound(output ?? '', MAX_BODY_CHARS, 'chair synthesis'), '');
  if (markers.length) lines.push('## Markers preserved', '', mdList(markers), '');
  return lines.join('\n');
}

export function buildMemberReportMarkdown({
  profileId, profile, round, stage = 'participant_report', processPid = null, nativeSessionId = null,
  analysis, recommendation, risks = [], uncertainties = [],
}) {
  return [
    '# Round 1 Report', '',
    profileIdentityBlock(profileId, profile),
    kv('round', round),
    kv('stage', stage),
    kv('process pid (operational evidence)', processPid ?? 'UNKNOWN'),
    kv('native session id', nativeSessionId ?? 'NOT EXPOSED'),
    '',
    '## Analysis', '', bound(analysis ?? '', MAX_BODY_CHARS, 'analysis'), '',
    '## Recommendation', '', bound(recommendation ?? '', MAX_BODY_CHARS, 'recommendation'), '',
    '## Risks', '', mdList(boundList(risks, { label: 'risk' })), '',
    '## Uncertainties', '', mdList(boundList(uncertainties, { label: 'uncertainty' })), '',
  ].join('\n');
}

export function buildMemberCritiqueMarkdown({
  profileId, profile, round, stage = 'participant_critique', processPid = null, nativeSessionId = null,
  criticisms = [], agreements = [], revisedRecommendation, remainingDisagreements = [], peerEvidenceSupplied = null,
}) {
  const lines = [
    '# Round 2 Critique', '',
    profileIdentityBlock(profileId, profile),
    kv('round', round),
    kv('stage', stage),
    kv('process pid (operational evidence)', processPid ?? 'UNKNOWN'),
    kv('native session id', nativeSessionId ?? 'NOT EXPOSED'),
    '',
    '## Criticisms', '', mdList(boundList(criticisms, { label: 'criticism' })), '',
    '## Agreements', '', mdList(boundList(agreements, { label: 'agreement' })), '',
    '## Revised recommendation', '', bound(revisedRecommendation ?? '', MAX_BODY_CHARS, 'revised recommendation'), '',
    '## Remaining disagreements', '', mdList(boundList(remainingDisagreements, { label: 'disagreement' })), '',
  ];
  lines.push('## Peer evidence supplied to this critique', '');
  if (Array.isArray(peerEvidenceSupplied) && peerEvidenceSupplied.length) {
    lines.push(mdList(peerEvidenceSupplied), '');
  } else {
    lines.push('- (DSH does not durably record the exact peer-report set handed to this critique call beyond the council\'s own round structure — not fabricated here)', '');
  }
  return lines.join('\n');
}

export function buildMemberFailureMarkdown({ profileId, profile, round, stage, reason, retryOccurred = false, attempts = [] }) {
  return [
    `# ${stage === 'participant_critique' ? 'Round 2 Critique' : 'Round 1 Report'} — Failure`, '',
    profileIdentityBlock(profileId, profile),
    kv('round', round),
    kv('stage', stage),
    kv('status', 'FAILED'),
    kv('typed error', reason ?? 'UNKNOWN'),
    kv('retry occurred', retryOccurred ? 'YES' : 'NO'),
    kv('real backend attempts recorded', attempts.length),
    '',
    'No report/critique content exists for this participant at this stage — this file records the failure itself; DSH does not fabricate a substitute report (Part L).',
    '',
  ].join('\n');
}

// =========================================================================
// P19-D2 — DEBATE round materialization (docs/p19/00_...md §11 /
// docs/p19/03_...md). Pure builders, same discipline as every COUNCIL
// builder above: bounded/redacted text only via bound()/boundList(), no
// model call, no clock. Written into the COUNCIL task directory's own
// Debate/Round-N/** subtree (see repo-history-materializer.mjs).
// =========================================================================

export function buildDebateBriefMarkdown({ round, brief }) {
  return [
    `# Debate Brief — Round ${round}`, '',
    'Canonical for every participant in this round — every participant received this exact text (same-round input freeze, docs/p19/00_...md §5).', '',
    '## Brief', '', bound(brief ?? '', MAX_BODY_CHARS, 'debate brief'), '',
  ].join('\n');
}

export function buildDebateResponseMarkdown({ profileId, profile, round, response, processPid = null }) {
  return [
    `# Debate Response — Round ${round}`, '',
    profileIdentityBlock(profileId, profile),
    kv('round', round),
    kv('process pid (operational evidence)', processPid ?? 'UNKNOWN'),
    '',
    '## Response', '', bound(response ?? '', MAX_BODY_CHARS, 'debate response'), '',
  ].join('\n');
}

export function buildDebateResponseFailureMarkdown({ profileId, profile, round, reason }) {
  return [
    `# Debate Response — Round ${round} — Failure`, '',
    profileIdentityBlock(profileId, profile),
    kv('round', round),
    kv('status', 'FAILED'),
    kv('typed error', reason ?? 'UNKNOWN'),
    '',
    'No response content exists for this participant at this round — this file records the failure itself; DSH does not fabricate a substitute response (Part L, same discipline as Council\'s own member-failure files).',
    '',
  ].join('\n');
}

export function buildDebateReportMarkdown({ round, ok = true, output, reason = null, continueDebate = null, unresolvedQuestions = [] }) {
  if (!ok) {
    return [
      `# Debate Report — Round ${round} — Failure`, '',
      kv('status', 'FAILED'),
      kv('typed error', reason ?? 'UNKNOWN'),
      '',
      'The chair failed to synthesize this debate round — no Debate Report content exists for it; not fabricated here.',
      '',
    ].join('\n');
  }
  return [
    `# Debate Report — Round ${round}`, '',
    kv('continue_debate (raw model value)', continueDebate === null ? 'UNKNOWN' : (continueDebate ? 'true' : 'false')),
    '',
    '## Report', '', bound(output ?? '', MAX_BODY_CHARS, 'debate report'), '',
    '## Unresolved questions', '', mdList(boundList(unresolvedQuestions, { label: 'unresolved question' })), '',
  ].join('\n');
}

/**
 * The canonical final Debate result — the LAST round whose synthesis
 * completed successfully (docs/p19/00_...md: "For max_rounds=1 or R1
 * STOP: final = Debate Report R1. For completed Round 2: final = Debate
 * Report R2."). Preserved verbatim (bounded) from that round's own chair
 * synthesis output — never a third model call, never re-summarized.
 */
export function buildFinalDebateReportMarkdown({ round, output, continueDebate = null, unresolvedQuestions = [], engineForcedStop = false }) {
  return [
    '# Final Debate Report', '',
    'This is the canonical final Debate result for this task.', '',
    kv('final round', round),
    kv('engine forced stop', engineForcedStop ? 'YES' : 'NO'),
    kv('continue_debate (raw model value at the final round)', continueDebate === null ? 'UNKNOWN' : (continueDebate ? 'true' : 'false')),
    '',
    '## Final report', '', bound(output ?? '', MAX_BODY_CHARS, 'final debate report'), '',
    '## Unresolved questions at the final round', '', mdList(boundList(unresolvedQuestions, { label: 'unresolved question' })), '',
  ].join('\n');
}

// ---- Global Walkthrough.md (council) ----
export function buildCouncilWalkthroughMarkdown({
  taskId, ownerTaskWhy, chairProfileId, chairProfile,
  round1 = [], /* [{profileId, profile, path, position}] */
  round2 = [], /* [{profileId, profile, path, position}] */
  finalDecisionPath, finalDecisionExcerpt,
  agreements = [], disagreements = [], rejectedAlternatives = [], unresolvedQuestions = [],
  repositoryChanges = [], runtimeEvidence = [], sessionEvidence = [], /* [{label, newProcessProven, nativeSessionId, nativeSessionReuse}] */
  continuationContext = [], readOrder = [],
}) {
  const lines = ['# Walkthrough', ''];
  lines.push('# Task', '', kv('task_id', taskId), '');
  lines.push('# Why This Task Existed', '', bound(ownerTaskWhy ?? '', 2000, 'why this task existed'), '');
  lines.push('# Chair', '', profileIdentityBlock(chairProfileId, chairProfile), '');
  lines.push('# Council Members', '');
  for (const m of [...round1]) lines.push(`- ${displayLabel(m.profileId, m.profile)}`);
  lines.push('');
  lines.push('# Round 1 Positions', '');
  if (!round1.length) lines.push('(no round 1 participants recorded)', '');
  for (const m of round1) {
    lines.push(`## ${displayLabel(m.profileId, m.profile)}`, kv('report', m.path ?? 'N/A'), '', bound(m.position ?? '', 1500, 'round 1 position excerpt'), '');
  }
  lines.push('# Round 2 Critiques', '');
  if (!round2.length) lines.push('(no round 2 critiques recorded)', '');
  for (const m of round2) {
    lines.push(`## ${displayLabel(m.profileId, m.profile)}`, kv('critique', m.path ?? 'N/A'), '', bound(m.position ?? '', 1500, 'round 2 critique excerpt'), '');
  }
  lines.push('# Final Chair Decision', '', kv('reference', finalDecisionPath ?? 'chair/Synthesis.md'), '', bound(finalDecisionExcerpt ?? '', MAX_BODY_CHARS, 'final chair decision'), '');
  lines.push('# Agreements', '', mdList(agreements), '');
  lines.push('# Disagreements', '', mdList(disagreements), '');
  lines.push('# Rejected Alternatives', '', mdList(rejectedAlternatives), '');
  lines.push('# Unresolved Questions', '', mdList(unresolvedQuestions), '');
  lines.push('# Repository Changes', '', mdList(repositoryChanges.length ? repositoryChanges : ['(none — this council step was analysis-only unless stated otherwise above)']), '');
  lines.push('# Runtime Evidence', '', mdList(runtimeEvidence.length ? runtimeEvidence : ['See the app diagnostic bundle referenced in this task\'s runtime-only `.runtime/<env>/logs/tasks/<task_id>/` folder (operational evidence, not part of this durable repo history).']), '');
  lines.push('# Session Evidence', '');
  if (!sessionEvidence.length) {
    lines.push('- (no per-invocation session evidence recorded)', '');
  } else {
    for (const s of sessionEvidence) {
      lines.push(
        `## ${s.label}`,
        kv('NEW_PROCESS', s.newProcessProven ? 'PROVEN' : 'UNKNOWN'),
        kv('NATIVE_SESSION_ID', s.nativeSessionId ?? 'NOT EXPOSED'),
        kv('NATIVE_SESSION_REUSE', nativeSessionReuseLabel(s.nativeSessionReuse)),
        '',
      );
    }
  }
  lines.push('# Continuation Context', '', mdList(continuationContext), '');
  lines.push('# Read Order For Next Agent', '', (readOrder.length ? readOrder : ['this Walkthrough.md', 'chair/Synthesis.md', 'relevant member reports', 'ExecutionLog.md', 'progress.md']).map((r, i) => `${i + 1}. ${r}`).join('\n'), '');
  return lines.join('\n');
}

// ---- Global progress.md line ----
export function buildProgressLine({ timestamp, taskType, taskId, title, status, chairOrPmProfileId, historyPath, outcome }) {
  const bounded = (s, max) => bound(String(s ?? ''), max, 'progress line field').replace(/\r?\n/g, ' ');
  return `${timestamp} | ${taskType} | ${taskId} | ${bounded(title, 120)} | ${status} | pm=${chairOrPmProfileId ?? 'UNKNOWN'} | history=${historyPath} | ${bounded(outcome, 200)}`;
}

// =========================================================================
// P12-R2 — new durable-artifact builders (docs/p12/01_P12_R0_*_SONNET5.md §5)
// Same discipline as everything above: pure, deterministic, no LLM call, no
// clock, secrets/CoT never present in the inputs these are given.
// =========================================================================

/**
 * Verification.md — only ever written when a task actually claims
 * verification evidence (`finish.data.verification`, an optional,
 * additive convention — no PM driver populates it yet, see
 * task-outcome-model.mjs's verificationStatusFromFinalData). Absent
 * verification data means this file is simply never written by the
 * caller — this builder is never invoked speculatively.
 */
export function buildVerificationMarkdown({ status, summary = null, details = [] }) {
  return [
    '# Verification', '',
    kv('status', status),
    '',
    '## Summary', '', bound(summary ?? '(no summary provided)', MAX_BODY_CHARS, 'verification summary'), '',
    '## Details', '', mdList(boundList(details, { label: 'verification detail' })), '',
  ].join('\n');
}

/**
 * ExecutiveSummary.md — concise PM/owner-facing result (P12-R0 §5.1).
 * Deterministic: every field is either already-known structured data
 * (status/durability/git outcome) or a bounded excerpt of the SAME
 * canonical output already delivered to the owner (never a second,
 * independent summarization call — that would violate the "no LLM
 * invocation of any kind" invariant every other builder in this file
 * already follows).
 */
export function buildExecutiveSummaryMarkdown({
  taskId, ownerTaskText, status, durability, degraded = false,
  outputExcerpt = '', verificationStatus = 'NOT_APPLICABLE',
  localGitStatus = 'NOT_REQUESTED', remoteSyncStatus = 'NOT_REQUESTED', resultCommit = null,
  terminalMarker,
}) {
  return [
    '# Executive Summary', '',
    kv('task_id', taskId),
    kv('objective (bounded)', bound(String(ownerTaskText ?? '').split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? '', 200, 'objective excerpt')),
    kv('durability', durability),
    kv('execution outcome', status),
    kv('degraded', degraded ? 'YES' : 'NO'),
    kv('verification', verificationStatus),
    kv('local git', localGitStatus),
    kv('remote sync', remoteSyncStatus),
    kv('result commit', resultCommit ?? 'N/A'),
    kv('terminal marker', terminalMarker),
    '',
    '## Result (bounded excerpt)', '', bound(outputExcerpt ?? '', 2000, 'result excerpt'), '',
  ].join('\n');
}

/**
 * Task-local Progress.md — DISTINCT from the project-root `progress.md`
 * ledger (buildProgressLine above). Only useful when a task actually had
 * multiple durable checkpoints (LONG/Council); the caller decides whether
 * to write this file at all (P12-R0 §5.1: "optional — only when there are
 * meaningful multi-turn checkpoints").
 */
export function buildTaskProgressMarkdown({ taskId, checkpoints = [] /* [{label, timestamp, status}] */ }) {
  const lines = ['# Progress', '', kv('task_id', taskId), '', '## Checkpoints', ''];
  if (!checkpoints.length) { lines.push('(no intermediate checkpoints recorded)'); return lines.join('\n'); }
  for (const c of checkpoints) lines.push(`- [${c.timestamp ?? 'UNKNOWN'}] ${bound(c.label ?? '', 200, 'checkpoint label')} — ${c.status ?? 'UNKNOWN'}`);
  return lines.join('\n');
}

/**
 * Council member Status.md — a compact, scannable companion to the
 * existing Round1_Report.md/Round1_Failure.md/Round2_Critique.md/
 * Round2_Failure.md files (unchanged). Every field here is the exact same
 * programmatic fact council-chair-driver.mjs already computes (`ok`,
 * `degraded`) — never re-derived from model text, never a substitute for
 * the detailed evidence files it sits alongside (P12-R0 §5.3: additive
 * only).
 */
export function buildMemberStatusMarkdown({
  profileId, profile, round1Ok, round2Ok, round1ErrorCode = null, round2ErrorCode = null,
}) {
  const overallStatus = round1Ok && round2Ok ? 'DONE' : 'FAILED';
  const stage = !round1Ok ? 'ROUND_1' : !round2Ok ? 'ROUND_2' : 'COMPLETE';
  return [
    '# Status', '',
    profileIdentityBlock(profileId, profile),
    kv('status', overallStatus),
    kv('stage', stage),
    kv('error', (round1ErrorCode ?? round2ErrorCode) ?? 'NONE'),
    kv('round1_report_created', round1Ok ? 'YES' : 'NO'),
    kv('round2_critique_created', round2Ok ? 'YES' : 'NO'),
    '',
  ].join('\n');
}

/**
 * task.json — versioned, machine-readable companion (P12-R0 §6.3). Plain
 * data in, a single JSON string out — same "pure builder" shape as every
 * Markdown function above, just a different serialization.
 */
export const TASK_METADATA_SCHEMA_VERSION = 1;

export function buildTaskMetadataJson(data) {
  return `${JSON.stringify({ schema_version: TASK_METADATA_SCHEMA_VERSION, ...data }, null, 2)}\n`;
}

export { SENSITIVE_KEY };
