/**
 * P10-R0.1 Part L/M — pure, testable builders for a task's finalized
 * `summary.md` (Part L) and council-only `council.json` (Part M).
 *
 * Deliberately separated from src/runtime/task-diagnostic-log.mjs (the
 * sink) and from wherever a task actually reaches a terminal status
 * (production-pm-worker.mjs's `ProductionPmWorkHandler.execute()`) — these
 * functions take plain data in and return plain markdown/JSON out, so they
 * are trivial to unit test without a real PmRun, worker, or filesystem.
 *
 * Bounding/redaction of the text these produce is NOT this module's job —
 * `TaskDiagnosticLog.finalizeSummary()`/`writeCouncilJson()` already bound
 * and sanitize whatever they're given (Part N/O). This module only decides
 * WHAT goes in the document, never how big a byte budget it gets.
 */

function bounded(text, max = 800) {
  const value = typeof text === 'string' ? text : String(text ?? '');
  return value.length > max ? `${value.slice(0, max)}…[truncated]` : value;
}

function line(label, value) { return `- ${label}: ${value ?? 'UNKNOWN'}`; }

/**
 * Part L: the human/AI-readable finalized summary for ONE task (single or
 * council). Every section is present even when its content is sparse —
 * "an external AI reading only this file" (Part W) should never have to
 * guess whether a section was omitted vs. genuinely empty.
 */
// P10-R0.1.1 Part H: names for each classifyParseSubreason() code that
// mean something to a human reading summary.md, without needing to also
// read production-pm-backend-registry.mjs's classifier.
const PARSE_SUBREASON_LABEL = Object.freeze({
  PM_DECISION_EMPTY_TEXT: 'response was empty/whitespace-only',
  PM_DECISION_TRAILING_PROSE: 'prose text appeared before the JSON object',
  PM_DECISION_FENCE_INVALID: 'a Markdown code fence was used and its content was not valid JSON',
  PM_DECISION_JSON_INVALID: 'started with `{` but the overall text was not valid JSON (e.g. an extra/missing brace)',
  PM_DECISION_UNEXPECTED_SHAPE: 'response could not be recognized as a JSON object at all',
});

// P10-R0.1.1 Part I: one line per real chair_plan backend attempt.
function chairPlanAttemptLines(attempts) {
  if (!attempts.length) return '- (no attempts recorded)';
  return attempts.map((a) => {
    const header = `Attempt ${a.attempt}`;
    const parserResult = a.ok ? 'OK' : (a.error_code ?? 'FAILED');
    const parseReason = a.ok ? null : (PARSE_SUBREASON_LABEL[a.parse_subreason] ?? a.parse_subreason ?? 'unclassified');
    const rows = [
      `- parser result: ${parserResult}`,
      a.output_bytes !== undefined && a.output_bytes !== null ? `- output bytes: ${a.output_bytes}` : null,
      parseReason ? `- parse reason: ${parseReason}` : null,
      '- PID: see events.jsonl BACKEND_PROCESS_SPAWN for this task_id/attempt (not duplicated here)',
    ].filter(Boolean).join('\n');
    return `${header}\n${rows}`;
  }).join('\n\n');
}

export function buildTaskSummaryMarkdown({
  taskId, projectId, taskMode = 'SINGLE', submittedVia = 'UNKNOWN', commandId = null, createdAt = null, completedAt = null,
  chairProfileId = null, participantProfileIds = [], rounds = null,
  status = 'UNKNOWN', errorCode = null, errorReason = null, outputPreview = '',
  degraded = false, completedParticipants = [], failedParticipants = [],
  repaired = false, timeline = [], chairPlanAttempts = [], participantIdRepairUsed = false,
  participantsSpawned = null, participantsSpawnedReason = null, chairPlanStructuredOutput = null,
  repoHandoff = null, timeoutDetail = null, pmDecisionContractDetail = null,
} = {}) {
  const sections = [];
  sections.push('# DSH Task Diagnostic Summary', '');
  sections.push(
    line('Task ID', taskId),
    line('Project', projectId),
    line('Mode', taskMode),
    line('Submitted via', submittedVia),
    line('Created', createdAt),
    line('Completed', completedAt),
    '',
  );
  // P10-R0.1.1 Part J: the real trusted origin (Telegram `client_kind`),
  // never inferred from task text.
  sections.push('## Submission', line('channel', submittedVia), line('command id', commandId), '');
  if (taskMode === 'COUNCIL') {
    sections.push('## PM / Chair', line('profile', chairProfileId), '');
    sections.push(
      '## Council Participants',
      participantProfileIds.length ? participantProfileIds.map((id) => `- ${id}${failedParticipants.includes(id) ? ' (FAILED)' : completedParticipants.includes(id) ? ' (completed)' : ''}`).join('\n') : '- (none recorded)',
      '',
    );
    if (rounds !== null) sections.push(line('Rounds', rounds), '');
    if (degraded) sections.push(`**DEGRADED**: ${completedParticipants.length} of ${participantProfileIds.length} selected participants completed.`, '');
    // P10-R0.1.1 Part I: per-attempt chair_plan evidence, present whenever
    // any real chair_plan backend call happened — including when the
    // council failed before participant-id validation was ever reached.
    if (chairPlanAttempts.length) {
      // P10-R0.1.2 Part O/P: one bounded line distinguishing native
      // structured-output mode from free-form decision mode, when known.
      const structuredOutputLine = chairPlanStructuredOutput
        ? `- native structured output: requested (schema: ${chairPlanStructuredOutput.schema_kind}), present: ${chairPlanStructuredOutput.present ? 'YES' : 'NO'}`
        : null;
      sections.push('## Chair Plan Attempts', [structuredOutputLine, chairPlanAttemptLines(chairPlanAttempts)].filter(Boolean).join('\n'), '');
    }
    sections.push(
      '## Council Progress',
      line('participants spawned', participantsSpawned === null ? 'UNKNOWN' : participantsSpawned ? 'YES' : 'NO'),
      participantsSpawned === false && participantsSpawnedReason ? line('reason', participantsSpawnedReason) : null,
      '',
    );
  } else {
    sections.push('## PM', line('profile', chairProfileId), '');
  }
  sections.push(
    '## Execution Timeline',
    timeline.length ? timeline.map((t) => `- ${t}`).join('\n') : '- (no timeline events recorded)',
    '',
  );
  if (repaired || participantIdRepairUsed) sections.push('## Retries', '- chair_plan participant-instruction contract was repaired once (bounded, single re-prompt)', '');
  sections.push(
    '## Terminal Result',
    line('status', status),
    errorCode ? line('error_code', errorCode) : null,
    errorReason ? line('error_reason', bounded(errorReason, 400)) : null,
    '',
    '### Result summary (bounded)',
    bounded(outputPreview, 2000) || '(no output)',
    '',
  );
  // P10-R0.2.1 Part L: a dedicated section — present only when this task's
  // terminal failure was actually a backend timeout (Part K's
  // BACKEND_TIMEOUT diagnostic event, read back from events.jsonl by
  // production-pm-worker.mjs) — so an owner/AI reading only summary.md
  // never has to open raw events.jsonl to learn the basic cause.
  if (timeoutDetail) {
    sections.push(
      '## Timeout',
      line('backend', timeoutDetail.backend),
      line('stage', timeoutDetail.stage),
      line('profile', timeoutDetail.profile),
      line('timeout policy', timeoutDetail.stage),
      line('configured timeout', timeoutDetail.configuredTimeoutMs !== null && timeoutDetail.configuredTimeoutMs !== undefined ? `${timeoutDetail.configuredTimeoutMs} ms` : null),
      line('elapsed', timeoutDetail.elapsedMs !== null && timeoutDetail.elapsedMs !== undefined ? `${timeoutDetail.elapsedMs} ms` : null),
      line('PID', timeoutDetail.processPid),
      line('output observed before timeout', timeoutDetail.outputObserved === null || timeoutDetail.outputObserved === undefined ? null : (timeoutDetail.outputObserved ? 'YES' : 'NO')),
      line('terminal typed error', timeoutDetail.terminalError),
      '',
    );
  }
  // P10-R0.2.2 Part P: present only when this task's terminal failure was
  // an await_owner decision whose contract stayed invalid even after the
  // bounded repair attempt (or was never repairable — e.g. the repair
  // invocation itself failed) — read back from events.jsonl by
  // production-pm-worker.mjs. Never present for a valid (first-attempt or
  // successfully-repaired) await_owner decision, which is not a failure.
  if (pmDecisionContractDetail) {
    sections.push(
      '## PM Decision Contract',
      line('decision type', pmDecisionContractDetail.decisionType),
      line('parse', 'OK'),
      line('normalization', pmDecisionContractDetail.normalizationResult),
      line('reason', pmDecisionContractDetail.normalizationError),
      line('repair attempted', pmDecisionContractDetail.repairAttempted ? 'YES' : 'NO'),
      line('repair result', pmDecisionContractDetail.repairResult),
      line('terminal typed error', pmDecisionContractDetail.terminalError),
      '',
    );
  }
  // P10-R0.2 Part AG: the runtime-diagnostic layer's own visibility into the
  // SEPARATE repo-history-materializer.mjs outcome — never the materialized
  // content itself (that lives in the owner's own repo, docs/history/**).
  sections.push(
    '## Repository Handoff',
    line('status', repoHandoff ? repoHandoff.status : 'NOT REQUESTED'),
    repoHandoff?.historyPath ? line('history path', repoHandoff.historyPath) : null,
    repoHandoff?.status === 'FAILED' && repoHandoff.error ? line('error', bounded(repoHandoff.error, 400)) : null,
  );
  return sections.filter((v) => v !== null).join('\n');
}

/**
 * P10-R0.2.4.2 Part L: the bounded summary for a `--task-file` dispatch that
 * FAILED preflight source resolution — never reached canonical acceptance,
 * so there is no PmRun/task lifecycle to describe, only the dispatch/
 * rejection facts themselves. Deliberately separate from
 * `buildTaskSummaryMarkdown` above (a real task's richer lifecycle summary)
 * rather than overloading it with a "maybe this never started" mode.
 */
export function buildDispatchFailureSummaryMarkdown({
  dispatchId, projectId, submittedVia = 'UNKNOWN', commandId = null, requestedPmProfileId = null,
  requestedRef = null, path = null, errorCode = null, errorMessage = null, createdAt = null,
} = {}) {
  const sections = [];
  sections.push('# DSH Task-File Dispatch Diagnostic Summary', '');
  sections.push(
    line('Task/dispatch ID', dispatchId),
    line('Project', projectId),
    line('Submitted via', submittedVia),
    line('Requested PM profile', requestedPmProfileId),
    line('Runtime class', 'LONG'),
    line('Task source', 'GIT_FILE'),
    line('Requested ref', requestedRef),
    line('Path', path),
    line('Created', createdAt),
    '',
  );
  sections.push('## Submission', line('channel', submittedVia), line('command id', commandId), '');
  sections.push(
    '## Source Resolution',
    line('status', 'FAILED'),
    line('typed error code', errorCode),
    errorMessage ? line('error', bounded(errorMessage, 400)) : null,
    '',
  );
  sections.push(
    '## Backend',
    line('started', 'NO'),
    line('PM_RUN_CREATED', 'NO'),
    line('BACKEND_PROCESS_SPAWN', 'NO'),
  );
  return sections.filter((v) => v !== null).join('\n');
}

/**
 * Part M: council-only structured evidence. Never raw model reasoning —
 * only the same normal assistant-visible fields DSH's own council
 * orchestration already reads (council-chair-driver.mjs's finish `data`).
 */
export function buildCouncilEvidenceJson({
  councilId = null, chairProfileId = null, participantProfileIds = [], rounds = null, strategy = null,
  degraded = false, completedParticipants = [], failedParticipants = [], status = 'UNKNOWN', repaired = false,
  chairPlanAttempts = [], chairPlanValidated = null, participantIdRepairUsed = false, chairPlanStructuredOutput = null,
} = {}) {
  return {
    council_id: councilId,
    chair_profile_id: chairProfileId,
    participant_profile_ids: participantProfileIds,
    rounds,
    strategy,
    degraded,
    completed_participants: completedParticipants,
    failed_participants: failedParticipants,
    status,
    chair_plan_repaired: repaired,
    // P10-R0.1.1 Part K: bounded per-attempt chair-plan evidence — never
    // raw model output, never chain-of-thought, only the same sanitized
    // structural facts (attempt/ok/error_code/parse_subreason/output_bytes)
    // the task log's PARSER_RESULT events already carry.
    chair_plan: {
      attempts: chairPlanAttempts,
      validated: chairPlanValidated,
      participant_id_repair_used: participantIdRepairUsed,
    },
    // P10-R0.1.2 Part P: bounded native-structured-output evidence (never a
    // full schema/prompt dump) — null unless the chair actually used
    // claude-code for chair_plan this run.
    structured_output: chairPlanStructuredOutput,
  };
}
