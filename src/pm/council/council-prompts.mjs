/**
 * P7 — council prompt builders (Part Q/Q1).
 *
 * DSH owns the phase topology (council-chair-driver.mjs decides WHEN each
 * step runs); these builders own only the per-step TEXT. Nothing here is
 * domain-specific — the owner task text is the only content that varies by
 * request. The chair supplies task-specific per-participant framing via its
 * chair_plan step; these builders just render it into the prompt.
 */

import {
  truncateForBudget, REPORT_CHAR_BUDGET, CRITIQUE_CONTEXT_CHAR_BUDGET, SYNTHESIS_CHAR_BUDGET,
  DEBATE_BRIEF_CHAR_BUDGET, DEBATE_RESPONSE_CONTEXT_CHAR_BUDGET, DEBATE_SYNTHESIS_CHAR_BUDGET,
} from './council-contracts.mjs';

const READ_ONLY_NOTICE = 'Do not modify files. Do not perform destructive actions. Do not execute tools beyond read-only analysis. Return analysis only. (Part U: council participants are analysis-only for this MVP.)';

// P18-W4R6-R1: the ONE narrowly-scoped notice for the single council
// participant DSH has structurally granted execution capability to for
// THIS `participant_report` step — CouncilStepWorkflowRunner resolves
// `bypassPermissions` for exactly this same participant/step, derived
// solely from the council's own owner-selected `implementation_
// participant_id` (council-chair-driver.mjs's #isImplementationParticipant(),
// never inferred from prompt text). Explicitly excludes DSH's own Git
// lifecycle authority: task-branch-binding.mjs remains the sole create/
// checkout/commit/push/merge authority regardless of what this notice
// says or what the participant does inside its own turn — this notice
// states that boundary to the model too, so it never attempts it.
const IMPLEMENTATION_NOTICE = 'You are the DESIGNATED IMPLEMENTATION PARTICIPANT for this step and are execution-capable for it: you may edit files required by the task, run relevant project tests/build commands, and inspect repository-wide read-only Git context (e.g. `git show`, `git log`, `git diff` against other refs). Do NOT manage the Git lifecycle yourself: do not checkout/switch/create a branch, do not commit, do not push, do not merge, do not reset/clean/stash. DSH owns branch creation, commit, push, and publication outside your turn — never perform any of those yourself.';

// Council/Debate WORKSPACE_READ remediation (docs/evidence/
// DSH_COUNCIL_PARTICIPANT_EXECUTION_AUDIT_20260906.md §14/§16): these two
// notices REPLACE (never merge with) READ_ONLY_NOTICE for a step whose
// council declared `workspace_requirement:'READ'` — the caller
// (council-chair-driver.mjs) selects exactly one of
// WORKSPACE_READ_NATIVE_NOTICE / WORKSPACE_READ_EVIDENCE_NOTICE /
// READ_ONLY_NOTICE from the participant's own resolved capability
// (workspace-capability.mjs), never from prompt text or profile display
// name. Both are still explicitly read-only/no-mutate — WORKSPACE_READ is
// never execution/implementation capability (that stays the pre-existing,
// unrelated `implementation_participant_id` mechanism above).
//
// Owner-review remediation Gap A (docs/evidence/DSH_COUNCIL_WORKSPACE_READ_
// IMPLEMENTATION_20260906.md): workspace-capability.mjs's native allowlist
// is currently EMPTY (no proven secret-safe native route exists), so
// WORKSPACE_READ_NATIVE_NOTICE is not reachable from any real production
// profile today — it is kept, tested, and selectable by construction so a
// FUTURE proven-safe native backend needs zero prompt-layer changes.
// Final stabilization patch (§10 of the brief): shared across every
// workspace-read notice — the packet now marks each file
// `FULL_FILE_VISIBLE: YES` or `NO` (workspace-evidence-packet.mjs's
// renderWorkspaceEvidencePacketText()). A model must never claim to have
// reviewed an "entire file" when the packet itself marked that file
// partial/truncated.
const VISIBILITY_CLAIM_RULE = 'The packet marks each file FULL_FILE_VISIBLE: YES or NO. Never claim to have reviewed "the entire file" for a file marked NO — say explicitly that only the supplied (bounded) chunks were reviewed.';
const WORKSPACE_READ_NATIVE_NOTICE = `This task requires WORKSPACE_READ: you must independently inspect the project repository (read-only) before answering — do not answer from assumption or general knowledge alone. You have real, read-only access to the project working directory for this turn via your own tool use (no writes, no destructive actions, no tool use beyond read-only repository inspection — this does NOT grant execution/implementation capability). Every claim in your analysis that depends on repository content must be justified in the required "evidence" field below: the exact file path (relative to the project root), a sha256 of the content you inspected, and, when practical, a line range. A response with no repository evidence does not satisfy this requirement. ${VISIBILITY_CLAIM_RULE}`;
const WORKSPACE_READ_EVIDENCE_NOTICE = `This task requires WORKSPACE_READ. You do NOT have native filesystem access for this turn — the ONLY authoritative repository evidence available to you is the bounded evidence packet supplied below by DSH. Do not claim to have inspected any file, path, or content outside this packet. Do not fabricate file paths, hashes, or excerpts. Every claim in your analysis that depends on repository content must be justified in the required "evidence" field below, citing a path/sha256 pair copied EXACTLY from the packet. A response with no repository evidence, or evidence not drawn from the packet, does not satisfy this requirement. ${VISIBILITY_CLAIM_RULE}`;

// Appended to a `finish` JSON shape's `data` object ONLY for a step whose
// participant was given one of the two notices above — omitted entirely
// (byte-for-byte unchanged shape) for every workspace_requirement:'NONE'
// step, which is every pre-existing council/debate.
const EVIDENCE_FIELD_SCHEMA = ',"evidence":[{"path":"<repo-relative file path>","sha256":"<sha256 hex of the content you inspected>","line_start":<int or null>,"line_end":<int or null>,"claim":"<what this evidence supports>"}]';

function workspaceReadNotice(workspaceMode) {
  if (workspaceMode === 'WORKSPACE_READ_NATIVE') return WORKSPACE_READ_NATIVE_NOTICE;
  if (workspaceMode === 'TEXT_ONLY') return WORKSPACE_READ_EVIDENCE_NOTICE;
  return null;
}

// Final owner-review micro-patch, Blocker A: a READ-required CHAIR step
// (chair_plan/chair_synthesis/debate_brief/debate_synthesis) previously
// received no repository evidence at all, even though it is squarely a
// repository-reasoning stage (planning participant focuses / synthesizing
// participant claims against source of truth). The chair is DSH's own
// orchestration profile — never a participant — so it deliberately does
// NOT emit a participant-style `data.evidence` array (Part 2: "Do NOT
// require the chair to emit... unless necessary"); this notice instead
// tells it plainly that the packet below is its only repository evidence
// and that repository-backed conclusions must be grounded in it. No
// product is currently WORKSPACE_READ_NATIVE (workspace-capability.mjs),
// so a chair step never needs the native/evidence branching a participant
// step does — one notice covers every current chair.
const CHAIR_WORKSPACE_READ_NOTICE = `This council/debate requires WORKSPACE_READ. You do NOT have native filesystem access for this step — the ONLY authoritative repository evidence available to you is the bounded evidence packet supplied below by DSH. Do not claim to have inspected any file, path, or content outside this packet. Do not fabricate file paths, hashes, or excerpts. Ground any repository-backed conclusion in the supplied evidence, and instruct participants accordingly. This is read-only and does not grant execution/implementation capability. ${VISIBILITY_CLAIM_RULE}`;

// Shared rendering for the chair's copy of the evidence packet — the exact
// same section title/body shape a TEXT_ONLY participant already gets
// (evidencePacketSection() below), so the packet TEXT itself is
// byte-identical across every stage in one run (Part 5 invariant); only
// the surrounding prose differs (participant vs chair framing).
function chairEvidencePacketSection(evidencePacketText) {
  return section('Repository evidence packet (authoritative, bounded — your ONLY source of repository content for this step)', evidencePacketText);
}

function section(title, body) { return body ? `\n## ${title}\n${body}` : ''; }
function constraintsSection(constraints) { return constraints.length ? section('Constraints', constraints.map((c) => `- ${c}`).join('\n')) : ''; }

// P19-D5.1R2: the chair_plan prompt previously had NO structural signal
// telling it which participant (if any) DSH already granted execution
// capability to — the chair only ever saw the owner's free-text task and a
// bare participant id list. Live evidence (docs/p19/11_...md; the D5.1
// canary, task-9n-VhovYdRZ3z7-JcLHwVUCMRvigcsEn): a real chair, given no such
// signal, independently planned the designated implementation participant's
// round-1 turn as "read-only; no file edits" — directly contradicting the
// `bypassPermissions` capability CouncilChairDriver's own
// #isImplementationParticipant() had already granted it. The participant
// itself detected the contradiction and, correctly, deferred to the chair's
// explicit text over its own structural capability, so no implementation
// ever happened. This section is the fix: state the selection explicitly and
// forbid the exact contradiction observed live. Called ONLY when the owner
// selected an implementation participant (buildChairPlanPrompt() below wires
// this in conditionally) — omitted entirely otherwise, so a debate-less or
// implementation-less council's chair_plan prompt is untouched.
function implementationParticipantSection(implementationParticipantId) {
  return section('Implementation participant', [
    `Implementation participant: ${implementationParticipantId}`,
    'This participant is the sole Council participant authorized to perform task-required repository edits/tests during its participant_report turn.',
    'Do not assign it a read-only-only responsibility that conflicts with this role.',
    'Other participants remain analysis/review only.',
  ].join('\n'));
}

// P10-R0.1 Part B/C: `profile_id` values are OPAQUE authority-bearing
// identifiers, not natural-language labels — a real live chair run
// (docs/p10/02_COUNCIL_PARTICIPANT_ID_CONTRACT.md) produced
// `live1-opencode-pm_note` as an object key instead of the owner-selected
// `live1-opencode-pm`, which the strict validator correctly rejected
// (COUNCIL_CHAIR_PLAN_INVALID:UNKNOWN_PARTICIPANT_INSTRUCTION). The fix here
// is prompt-side hardening: state the copy-exact contract as its own
// numbered rule set, immediately next to the id list, so it cannot be missed
// inside a longer instruction block. The validator itself is UNCHANGED and
// stays strict (Part D) — this only reduces how often a compliant chair
// mangles a key in the first place.
const ID_COPY_EXACT_RULES = [
  '- Every `profile_id` below is an OPAQUE authority-bearing identifier — treat it as an opaque token, not as words to edit.',
  '- Copy each `profile_id` EXACTLY, character for character, into your JSON keys.',
  '- Do NOT append suffixes, annotations, or notes to a `profile_id` (e.g. never turn `live1-opencode-pm` into `live1-opencode-pm_note`).',
  '- Do NOT abbreviate, reformat, re-case, or reorder any `profile_id`.',
  '- Do NOT invent a new `profile_id` that is not in the list below.',
  '- Every `participant_instructions` key MUST be exactly one of the listed `profile_id` values — no more, no fewer, no others.',
].join('\n');

// P10-R0.1.1 Part D: a live owner failure (task-D5PT4CbNpjeUamnegQDN6kvM34w3NMdo,
// docs/p10/02_COUNCIL_PARTICIPANT_ID_CONTRACT_SONNET5.md) never reached
// schema/participant-id validation at all — both real chair_plan attempts
// failed at parseDecision() itself (PM_DECISION_PARSE_FAILED). The raw
// output was never captured (the deficiency P10-R0.1.1 closes for future
// failures — see council-step-workflow-runner.mjs), so the exact byte-level
// cause of THIS failure cannot be reconstructed after the fact. What IS
// certain: parseDecision() requires the assistant's ENTIRE trimmed response
// to be exactly one JSON object — the first non-whitespace character must
// be `{` and the response must contain nothing else. This rule block states
// that boundary explicitly and only once, right next to the required shape,
// rather than relying on the (already-present, universal, unchanged) outer
// M09 contract in production-pm-backend-registry.mjs's renderRequest() alone.
const JSON_BOUNDARY_RULES = [
  '- Your entire response must be ONLY the JSON object below — nothing else on any line before or after it.',
  '- The first character of your response must be `{` and the last character must be `}`.',
  '- Do NOT wrap the object in a Markdown code fence (no ``` anywhere).',
  '- Do NOT prefix it with the word "json" or any other label.',
  '- Do NOT add explanation, acknowledgement, or commentary before or after the object.',
].join('\n');

export function buildChairPlanPrompt({
  ownerTask, constraints = [], participantProfileIds, implementationParticipantId = null,
  workspaceRequirement = 'NONE', evidencePacketText = null,
}) {
  // Final owner-review micro-patch, Blocker A: chair_plan is a repository-
  // reasoning stage (it assigns participant focuses) — for READ it must
  // receive the same packet every participant/other chair stage in this
  // run receives, so its plan can be grounded in real evidence rather than
  // written blind. READ_ONLY_NOTICE stays for `NONE` — byte-for-byte
  // unchanged (this branch is never taken for a pre-existing council).
  const notice = workspaceRequirement === 'READ' ? CHAIR_WORKSPACE_READ_NOTICE : READ_ONLY_NOTICE;
  const parts = [
    'You are the CHAIR of a DSH multi-model council. This step is PLANNING the council — you are not analyzing the task yet.',
    notice,
    section('Owner task', ownerTask),
    constraintsSection(constraints),
    section('ALLOWED_PARTICIPANTS (authoritative, owner-selected — see rules below)', participantProfileIds.map((id) => `- profile_id: ${id}`).join('\n')),
  ];
  // Spliced in only when present, never as an empty array entry — an absent
  // implementationParticipantId must reproduce the pre-D5.1R2 prompt
  // byte-for-byte (see the byte-for-byte-unchanged regression).
  if (implementationParticipantId) parts.push(implementationParticipantSection(implementationParticipantId));
  // Council/Debate WORKSPACE_READ remediation: informational only — DSH's
  // own per-participant notice/evidence contract is what actually gates
  // this (workspace-read-required participants get it regardless of what
  // the chair writes here); this only helps the chair write instructions
  // that do not contradict it (mirrors implementationParticipantSection's
  // "do not assign a conflicting responsibility" pattern above). Omitted
  // entirely for `workspace_requirement:'NONE'` — byte-for-byte unchanged.
  if (workspaceRequirement === 'READ') {
    parts.push(section('Workspace read requirement', 'This council requires WORKSPACE_READ: every participant is required to independently inspect the project repository (via DSH\'s supplied evidence packet) and cite repository evidence in their report. You have received the SAME evidence packet below — use it to assign focuses that are consistent with what is actually available, and do not instruct a participant to skip repository inspection or to answer from assumption alone.'));
    parts.push(chairEvidencePacketSection(evidencePacketText));
  }
  parts.push(
    section('Participant id rules (read carefully — violating any of these invalidates your plan)', ID_COPY_EXACT_RULES),
    '\nProduce a short focus instruction for EACH participant listed above (no more, no fewer), a critique focus for round 2, and a synthesis focus for your own final synthesis.',
    '\nReply with exactly one JSON object and nothing else — no Markdown, no code fences, no prose before or after it. Use this exact shape (use these exact key names, and the exact profile_id values above as keys):',
    `{"type":"finish","output":"council plan ready","data":{"type":"council_plan","participant_instructions":{${participantProfileIds.map((id) => `"${id}":"<focus text for ${id}>"`).join(',')}},"critique_focus":"<focus text>","synthesis_focus":"<focus text>"}}`,
    section('Output format rules (read carefully — violating any of these makes your response unparseable)', JSON_BOUNDARY_RULES),
  );
  return parts.join('\n');
}

/**
 * P10-R0.1 Part E/F: a bounded, ONE-TIME repair prompt for a chair_plan that
 * failed schema validation specifically on its participant-instruction keys
 * (missing/unknown/empty — never on critique_focus/synthesis_focus, which
 * are content quality, not identifier-contract issues). Reuses the SAME
 * owner task / constraints / participants as the original prompt (Part F:
 * "preserve original planning intent") and adds only a correction notice —
 * it never asks the chair to re-plan from scratch, and it never changes the
 * owner-selected participant set (that set is fixed upstream in
 * council-contracts.mjs regardless of what the chair returns here).
 */
export function buildChairPlanRepairPrompt({ originalPrompt, participantProfileIds, invalidReason }) {
  return [
    'REPAIR REQUEST — your previous council plan used one or more participant ids that are not in the allowed set below, or was otherwise missing/malformed for the required participant_instructions keys.',
    section('What was wrong with your previous attempt', invalidReason || 'participant_instructions keys did not exactly match the allowed profile_id set'),
    section('Allowed profile_id values — copy these EXACTLY, verbatim, as your participant_instructions keys', participantProfileIds.map((id) => `- ${id}`).join('\n')),
    'Return the corrected plan using these ids verbatim. Do not introduce any other participant id. Preserve the same owner task and the same participant set — only correct the identifier contract.',
    '\n---\nOriginal instructions (unchanged) follow:\n---',
    originalPrompt,
  ].join('\n');
}

// P10-R0.1.1 Part F: human-readable text for each classifyParseSubreason()
// code (production-pm-backend-registry.mjs) — presentation only, the
// classification itself lives with the parser that computes it.
const PARSE_SUBREASON_TEXT = Object.freeze({
  PM_DECISION_EMPTY_TEXT: 'Your previous response was empty or whitespace-only — no JSON object was present at all.',
  PM_DECISION_TRAILING_PROSE: 'Your previous response had prose text before the JSON object started. The response must start with `{`.',
  PM_DECISION_FENCE_INVALID: 'Your previous response used a Markdown code fence, and the content inside it was not valid JSON (or the fence was not the only content).',
  PM_DECISION_JSON_INVALID: 'Your previous response started with `{` but the overall text was not valid JSON (e.g. a missing/extra brace, an unterminated string, or a trailing character after the closing `}`).',
  PM_DECISION_UNEXPECTED_SHAPE: 'Your previous response could not be recognized as a single JSON object at all.',
});

/**
 * P10-R0.1.1 Part F: a bounded repair prompt for a GENERIC parse failure
 * (PM_DECISION_PARSE_FAILED — the response was not parseable as JSON at
 * all), usable for any council step kind, distinct from
 * buildChairPlanRepairPrompt() above (which repairs a chair_plan that DID
 * parse but had invalid participant-instruction keys). Reuses the original,
 * unmodified prompt — never re-derives or paraphrases the owner task/
 * constraints/participants — and deliberately does NOT echo back any of the
 * previous (malformed) output: Part F explicitly discourages including an
 * excerpt "if not required", and echoing a broken JSON fragment back risks
 * the model reproducing the exact same mistake rather than correcting it.
 */
export function buildParseRepairPrompt({ originalPrompt, parseSubreason }) {
  return [
    'REPAIR REQUEST — your previous response could not be parsed as the required JSON decision object.',
    section('What was wrong with your previous attempt', PARSE_SUBREASON_TEXT[parseSubreason] ?? 'Your previous response was not valid, parseable JSON.'),
    section('Output format rules (read carefully — violating any of these makes your response unparseable)', JSON_BOUNDARY_RULES),
    'Return ONLY a valid object matching the exact contract below. No Markdown. No commentary.',
    '\n---\nOriginal instructions (unchanged) follow:\n---',
    originalPrompt,
  ].join('\n');
}

/**
 * DSH-COUNCIL-PARTICIPANT-CONTRACT-HARDENING (Implementation B): ONE bounded
 * semantic repair re-prompt for a read-only Council/Debate PARTICIPANT step
 * whose decision PARSED cleanly (finish, non-empty output — transport and
 * parseDecision both healthy) but failed the typed `COUNCIL_*_INVALID`
 * semantic-shape validation. Deliberately DIFFERENT from the chair_plan
 * repair above: the original participant prompt embeds the (potentially
 * ~248KB) WORKSPACE_READ packet, which is NEVER re-sent here. The repair
 * prompt carries only bounded, safe facts:
 *   - the exact typed validator reason (unchanged codes),
 *   - the content-free data/evidence diagnostics (counts, types, lengths —
 *     never a path/hash/claim value),
 *   - the model's OWN prior normalized `data` object (the smallest safe
 *     semantic representation that lets a STATELESS backend correct its own
 *     contract violations without DSH fabricating anything — the analysis/
 *     recommendation/evidence content is the model's own prior output,
 *     bounded via truncateForBudget; it is never persisted to any durable
 *     diagnostics surface).
 * The model must produce the corrected decision object itself. DSH never
 * invents analysis, recommendation, evidence, claims, or hashes, never
 * auto-corrects paths/hashes, and re-runs the EXACT same fail-closed
 * validator; a still-invalid repair leaves the participant FAILED. The
 * terminal contract capsule (production-pm-backend-registry.mjs's
 * renderRequest()) is appended automatically because the repair reuses the
 * same Council-gated request context — it is not duplicated here.
 */
const PARTICIPANT_REPAIR_CONTEXT_CHAR_BUDGET = 12000;
export function buildParticipantSemanticRepairPrompt({ stepKind, reason, dataDiagnostics = null, evidenceDiagnostics = null, priorData = null }) {
  return [
    'REPAIR REQUEST — your previous response was rejected by DSH\'s strict Council participant contract validation. This is a fresh, read-only, tool-free repair turn: do not inspect the repository, do not use tools, do not perform Git operations.',
    section('What was wrong with your previous attempt', reason ?? 'the structured data did not match the required contract'),
    section('Structural facts about your previous data object (counts, types, and lengths only — no content values)', JSON.stringify({ data: dataDiagnostics ?? null, evidence: evidenceDiagnostics ?? null })),
    section('Your previous report content (normalized from your own prior answer — correct ONLY the identified contract violations, keep your analysis/recommendation substance, and do not invent new evidence entries, paths, or hashes that were not already present)', truncateForBudget(JSON.stringify(priorData ?? null), PARTICIPANT_REPAIR_CONTEXT_CHAR_BUDGET, 'previous report data')),
    'Return exactly ONE corrected DSH decision object now — no prose before or after it, no Markdown. Change only what the identified violations require; everything else about your report must stay as it was.',
  ].join('\n');
}

/**
 * P18-W4R6-R1: `isImplementationParticipant` (default `false` — every
 * existing caller that omits it gets byte-for-byte prior behavior, the
 * READ_ONLY_NOTICE) selects which notice this ONE prompt carries. The
 * caller (council-chair-driver.mjs) derives it exclusively from the
 * already-validated `implementation_participant_id` and this step's own
 * typed identity (`participant_report`, this exact participant) — never
 * from `ownerTask`/`instructions` free-form text, and never re-derived
 * here from prompt content.
 */
// DSH-ANTIGRAVITY-COUNCIL-PARTICIPANT-CONTRACT (T5 live evidence
// task-y2dkRWx6CIrY4mNulAVSk476ZxTlf52D, 2026-09-07): the real Antigravity
// participant returned a `council_report`-typed `data` object whose
// `analysis` was not a non-empty string (COUNCIL_PARTICIPANT_REPORT_INVALID:
// MISSING_ANALYSIS) while the identical contract passed a short structured
// SINGLE — evidence that the single example line at the end of a very long
// participant prompt is not sufficient TYPE enforcement for this backend.
// This sentence states the field-TYPE contract explicitly next to the shape
// example. Prompt-side hardening only: validateStepData()'s fail-closed
// checks are byte-for-byte unchanged, and nothing here copies or salvages
// content (no fabrication path is introduced).
const REPORT_FIELD_TYPE_RULE = 'Field types are strict: "analysis" and "recommendation" must each be ONE non-empty JSON string (never an array, an object, null, or omitted); "risks" and "uncertainties" must each be a JSON array of strings (use [] when empty); every field sits directly on "data" — never renamed and never nested inside another key.';

export function buildParticipantReportPrompt({
  ownerTask, constraints = [], instructions, participantProfileId, isImplementationParticipant = false,
  workspaceMode = null, evidencePacketText = null,
}) {
  const workspaceNotice = isImplementationParticipant === true ? null : workspaceReadNotice(workspaceMode);
  const notice = isImplementationParticipant === true ? IMPLEMENTATION_NOTICE : (workspaceNotice ?? READ_ONLY_NOTICE);
  const evidencePacketSection = workspaceMode === 'TEXT_ONLY' ? section('Repository evidence packet (authoritative, bounded — your ONLY source of repository content)', evidencePacketText) : '';
  const schema = workspaceNotice
    ? `{"type":"finish","output":"<one-line summary of your recommendation>","data":{"type":"council_report","analysis":"<your analysis>","recommendation":"<your recommendation>","risks":["..."],"uncertainties":["..."]${EVIDENCE_FIELD_SCHEMA}}}`
    : '{"type":"finish","output":"<one-line summary of your recommendation>","data":{"type":"council_report","analysis":"<your analysis>","recommendation":"<your recommendation>","risks":["..."],"uncertainties":["..."]}}';
  return [
    'You are an INDEPENDENT council analyst. You have NOT seen any other participant\'s answer and must not assume one — analyze the task fresh, on your own.',
    notice,
    section('Owner task', ownerTask),
    constraintsSection(constraints),
    section(`Chair focus for you (${participantProfileId})`, instructions),
    evidencePacketSection,
    '\nReply with exactly one JSON object and nothing else — no Markdown, no code fences, no prose before or after it. Use this exact shape (use these exact key names):',
    schema,
    REPORT_FIELD_TYPE_RULE,
  ].join('\n');
}

export function buildParticipantCritiquePrompt({ ownerTask, ownReport, peerReports, critiqueFocus, participantProfileId, workspaceMode = null, evidencePacketText = null }) {
  const perPeerBudget = Math.max(500, Math.floor(CRITIQUE_CONTEXT_CHAR_BUDGET / Math.max(1, peerReports.length)));
  const peerText = peerReports
    .map(({ profileId, report }) => `### ${profileId}\nRecommendation: ${report?.recommendation ?? ''}\nAnalysis: ${truncateForBudget(report?.analysis ?? '', perPeerBudget, `${profileId} analysis`)}\nRisks: ${(report?.risks ?? []).join('; ')}`)
    .join('\n\n');
  const workspaceNotice = workspaceReadNotice(workspaceMode);
  const evidencePacketSection = workspaceMode === 'TEXT_ONLY' ? section('Repository evidence packet (authoritative, bounded — your ONLY source of repository content)', evidencePacketText) : '';
  return [
    'You are a council participant in the CRITIQUE round.',
    workspaceNotice ?? READ_ONLY_NOTICE,
    evidencePacketSection,
    section('Owner task', ownerTask),
    `\n## Your own previous report (${participantProfileId})\nRecommendation: ${ownReport?.recommendation ?? ''}\nAnalysis: ${truncateForBudget(ownReport?.analysis ?? '', REPORT_CHAR_BUDGET, 'own report')}`,
    section("Other participants' reports you MUST address", peerText),
    section('Chair critique focus', critiqueFocus),
    '\nCritique the other proposals. Identify disagreements, missing evidence, architectural risks, invalid assumptions, and places where another proposal is stronger than yours. Update your recommendation if warranted. Do not agree merely for consensus.',
    '\nReply with exactly one JSON object and nothing else — no Markdown, no code fences, no prose before or after it. Use this exact shape (use these exact key names):',
    '{"type":"finish","output":"<one-line summary of your revised position>","data":{"type":"council_critique","criticisms":["..."],"agreements":["..."],"revised_recommendation":"<string>","remaining_disagreements":["..."]}}',
  ].join('\n');
}

// =========================================================================
// P19-D1 — Debate extension prompt builders (docs/p19/00_...md §10 /
// docs/p19/01_...md). DEBATE = COUNCIL + bounded iterative challenge/
// synthesis: these three builders render the debate_brief/debate_response/
// debate_synthesis step text CouncilChairDriver's #debateDecide() emits,
// only ever reached after chair_synthesis has already completed
// successfully (Council Report first — a hard invariant, see the driver).
// =========================================================================

/**
 * Chair step, once per debate round. Produces ONE canonical brief every
 * participant in this round receives byte-identically — this is what
 * structurally guarantees the "same-round input freeze" invariant: there
 * is no per-participant variant of the brief for a caller to accidentally
 * diverge. Round 1 derives from the council's own round-1 evidence
 * (reports/critiques); round 2+ derives from the PREVIOUS debate round's
 * synthesis output and its own unresolved_questions — never a verbatim
 * replay of round 1 (Part: "Do not simply replay Round 1 verbatim").
 */
export function buildDebateBriefPrompt({
  ownerTask, constraints = [], canonicalSynthesis, round, maxRounds, unresolvedQuestions = [], reports = [], critiques = [],
  workspaceRequirement = 'NONE', evidencePacketText = null,
}) {
  const isRound1 = round <= 1;
  const evidenceSection = isRound1
    ? section('Round 1 council evidence (disagreements/uncertainty to surface)', truncateForBudget(
        [
          reports.map(({ profileId, report }) => `### ${profileId} report\nRecommendation: ${report?.recommendation ?? ''}\nRisks: ${(report?.risks ?? []).join('; ')}\nUncertainties: ${(report?.uncertainties ?? []).join('; ')}`).join('\n\n'),
          critiques.length ? critiques.map(({ profileId, critique }) => `### ${profileId} critique\nRemaining disagreements: ${(critique?.remaining_disagreements ?? []).join('; ')}`).join('\n\n') : '',
        ].filter(Boolean).join('\n\n'),
        DEBATE_BRIEF_CHAR_BUDGET, 'round-1 evidence',
      ))
    : section('Unresolved questions from the previous debate round', unresolvedQuestions.length ? unresolvedQuestions.map((q) => `- ${q}`).join('\n') : '(none recorded)');
  // Final owner-review micro-patch, Blocker A: debate_brief is a chair
  // repository-reasoning stage (Council READ policy == Debate READ policy,
  // §5 invariant) — receives the SAME packet. READ_ONLY_NOTICE stays for
  // `NONE` — byte-for-byte unchanged.
  const notice = workspaceRequirement === 'READ' ? CHAIR_WORKSPACE_READ_NOTICE : READ_ONLY_NOTICE;
  return [
    `You are the CHAIR preparing the DEBATE ROUND ${round} BRIEF (of at most ${maxRounds} debate rounds).`,
    notice,
    section('Owner task', ownerTask),
    constraintsSection(constraints),
    workspaceRequirement === 'READ' ? chairEvidencePacketSection(evidencePacketText) : '',
    section('Latest canonical synthesis', truncateForBudget(canonicalSynthesis ?? '', DEBATE_BRIEF_CHAR_BUDGET, 'canonical synthesis')),
    evidenceSection,
    round > 1 ? '\nDo NOT simply replay the Round 1 brief verbatim — this brief must focus on what remains unresolved after the previous round.' : '',
    '\nProduce ONE canonical debate brief. Every participant in this round will receive this exact text — do not write anything participant-specific. Identify the key disagreements, unresolved uncertainty, and open questions participants must address.',
    '\nReply with exactly one JSON object and nothing else — no Markdown, no code fences, no prose before or after it. Use this exact shape (use these exact key names):',
    '{"type":"finish","output":"debate brief ready","data":{"type":"debate_brief","brief":"<the canonical debate brief text every participant will see>"}}',
    section('Output format rules (read carefully — violating any of these makes your response unparseable)', JSON_BOUNDARY_RULES),
  ].filter(Boolean).join('\n');
}

/**
 * Participant step, once per participant per round. Deliberately accepts
 * NO same-round peer argument — unlike buildParticipantCritiquePrompt()
 * (which legitimately sees round-1 peers because round 1 is already fully
 * complete by the time critique starts), a debate response prompt must
 * never be able to leak participant N-1's same-round response to
 * participant N. Any extra field a caller mistakenly passes (e.g. a
 * `peerResponses`) is simply ignored by this destructuring — it can never
 * reach the rendered text. See docs/p19/01_...md's structural test for
 * this contract.
 */
export function buildDebateResponsePrompt({
  ownerTask, constraints = [], canonicalSynthesis, debateBrief, round, participantProfileId,
  workspaceMode = null, evidencePacketText = null,
}) {
  const workspaceNotice = workspaceReadNotice(workspaceMode);
  const evidencePacketSection = workspaceMode === 'TEXT_ONLY' ? section('Repository evidence packet (authoritative, bounded — your ONLY source of repository content)', evidencePacketText) : '';
  const schema = workspaceNotice
    ? `{"type":"finish","output":"<one-line summary of your Round ${round} response>","data":{"type":"debate_response","response":"<your full response>"${EVIDENCE_FIELD_SCHEMA}}}`
    : `{"type":"finish","output":"<one-line summary of your Round ${round} response>","data":{"type":"debate_response","response":"<your full response>"}}`;
  return [
    `You are an INDEPENDENT council participant responding in DEBATE ROUND ${round}. You have NOT seen any other participant's Round ${round} response and must not assume one — respond fresh, on your own, addressing the debate brief below.`,
    workspaceNotice ?? READ_ONLY_NOTICE,
    section('Owner task', ownerTask),
    constraintsSection(constraints),
    section('Latest canonical synthesis', truncateForBudget(canonicalSynthesis ?? '', DEBATE_RESPONSE_CONTEXT_CHAR_BUDGET, 'canonical synthesis')),
    section(`Debate brief for Round ${round} (identical for every participant this round)`, truncateForBudget(debateBrief ?? '', DEBATE_RESPONSE_CONTEXT_CHAR_BUDGET, 'debate brief')),
    evidencePacketSection,
    `\nChallenge, defend, or revise your position (${participantProfileId}) based on the debate brief above. Address the disagreements/uncertainty it raises directly.`,
    '\nReply with exactly one JSON object and nothing else — no Markdown, no code fences, no prose before or after it. Use this exact shape (use these exact key names):',
    schema,
    section('Output format rules (read carefully — violating any of these makes your response unparseable)', JSON_BOUNDARY_RULES),
  ].join('\n');
}

/**
 * Chair step, once per debate round. Produces the typed continuation
 * decision (`continue_debate`/`reason`/`unresolved_questions` —
 * docs/p19/00_...md §6) alongside the round's owner-facing narrative
 * output (the Debate Report text). `isFinalRound` tells the chair the
 * engine will force `continue_debate=false` regardless of what it writes
 * — stated honestly rather than silently overridden without notice
 * (mirrors chair_synthesis's own degraded-disclosure honesty pattern).
 */
export function buildDebateSynthesisPrompt({
  ownerTask, constraints = [], canonicalSynthesis, debateBrief, responses = [], round, maxRounds,
  workspaceRequirement = 'NONE', evidencePacketText = null,
}) {
  const perResponseBudget = Math.max(500, Math.floor(DEBATE_SYNTHESIS_CHAR_BUDGET / 2 / Math.max(1, responses.length)));
  const responsesText = responses
    .map(({ profileId, response }) => `### ${profileId}\n${truncateForBudget(response?.response ?? '', perResponseBudget, `${profileId} response`)}`)
    .join('\n\n');
  const isFinalRound = round >= maxRounds;
  // Final owner-review micro-patch, Blocker A: debate_synthesis, like
  // chair_synthesis, compares participant claims against source of truth —
  // receives the SAME packet. READ_ONLY_NOTICE stays for `NONE` —
  // byte-for-byte unchanged.
  const notice = workspaceRequirement === 'READ' ? CHAIR_WORKSPACE_READ_NOTICE : READ_ONLY_NOTICE;
  return [
    `You are the CHAIR synthesizing DEBATE ROUND ${round} (of at most ${maxRounds} debate rounds) into a Debate Report.`,
    notice,
    section('Owner task', ownerTask),
    constraintsSection(constraints),
    workspaceRequirement === 'READ' ? chairEvidencePacketSection(evidencePacketText) : '',
    section('Latest canonical synthesis (before this round)', truncateForBudget(canonicalSynthesis ?? '', Math.floor(DEBATE_SYNTHESIS_CHAR_BUDGET / 4), 'canonical synthesis')),
    section(`Round ${round} debate brief`, truncateForBudget(debateBrief ?? '', Math.floor(DEBATE_SYNTHESIS_CHAR_BUDGET / 4), 'debate brief')),
    section(`Round ${round} participant responses`, truncateForBudget(responsesText, Math.floor(DEBATE_SYNTHESIS_CHAR_BUDGET / 2), 'round responses')),
    isFinalRound
      ? `\nIMPORTANT: this is the FINAL allowed debate round (max_rounds=${maxRounds}) — "continue_debate" MUST be false in your reply. DSH will also enforce this programmatically regardless of what you write here.`
      : '\nDecide honestly whether a further debate round is genuinely warranted, or whether the disagreement is now resolved enough to stop.',
    '\nSynthesize this round into a Debate Report: what was resolved, what remains disputed, risks/uncertainties, and your typed continuation decision.',
    '\nReply with exactly one JSON object and nothing else — no Markdown, no code fences, no prose before or after it. Use this exact shape (use these exact key names):',
    `{"type":"finish","output":"<the full owner-facing Round ${round} Debate Report text>","data":{"type":"debate_synthesis","continue_debate":<true or false>,"reason":"<why>","unresolved_questions":["..."]}}`,
    section('Output format rules (read carefully — violating any of these makes your response unparseable)', JSON_BOUNDARY_RULES),
  ].filter(Boolean).join('\n');
}

export function buildChairSynthesisPrompt({
  ownerTask, constraints = [], reports, critiques, failures, synthesisFocus, degraded,
  workspaceRequirement = 'NONE', evidencePacketText = null,
}) {
  const reportsText = reports
    .map(({ profileId, report }) => `### ${profileId} — round 1 report\nRecommendation: ${report?.recommendation ?? ''}\nAnalysis: ${report?.analysis ?? ''}\nRisks: ${(report?.risks ?? []).join('; ')}\nUncertainties: ${(report?.uncertainties ?? []).join('; ')}`)
    .join('\n\n');
  const critiquesText = critiques
    .map(({ profileId, critique }) => `### ${profileId} — round 2 critique\nRevised recommendation: ${critique?.revised_recommendation ?? ''}\nCriticisms: ${(critique?.criticisms ?? []).join('; ')}\nAgreements: ${(critique?.agreements ?? []).join('; ')}\nRemaining disagreements: ${(critique?.remaining_disagreements ?? []).join('; ')}`)
    .join('\n\n');
  const failuresText = failures.length ? failures.map((f) => `- ${f.profileId}: ${f.reason}`).join('\n') : '';
  const degradedDisclosure = reports.length === 1
    ? 'Council degraded: only one participant completed.'
    : 'Council degraded: one or more participants failed.';
  // Final owner-review micro-patch, Blocker A: chair_synthesis compares
  // participant claims against source of truth — for READ it receives the
  // SAME packet as every other stage this run, ADDITIVE to (never
  // replacing) the participant reports/critiques below. READ_ONLY_NOTICE
  // stays for `NONE` — byte-for-byte unchanged.
  const notice = workspaceRequirement === 'READ' ? CHAIR_WORKSPACE_READ_NOTICE : READ_ONLY_NOTICE;
  return [
    'You are the CHAIR synthesizing a DSH multi-model council into ONE final owner-facing answer.',
    notice,
    section('Owner task', ownerTask),
    constraintsSection(constraints),
    workspaceRequirement === 'READ' ? chairEvidencePacketSection(evidencePacketText) : '',
    section('Round 1 reports (evidence)', truncateForBudget(reportsText, Math.floor(SYNTHESIS_CHAR_BUDGET / 2), 'round-1 reports')),
    critiquesText ? section('Round 2 critiques (evidence)', truncateForBudget(critiquesText, Math.floor(SYNTHESIS_CHAR_BUDGET / 2), 'round-2 critiques')) : '',
    failuresText ? section('Participants that FAILED — do not fabricate their content', failuresText) : '',
    section('Chair synthesis focus', synthesisFocus),
    workspaceRequirement === 'READ' ? '\nCompare participant claims against the repository evidence packet above where relevant — do not simply trust a participant summary that contradicts the supplied evidence.' : '',
    degraded ? `\nIMPORTANT: this council is DEGRADED — ${reports.length} of ${reports.length + failures.length} selected participants completed. Your "output" MUST begin with the exact sentence: "${degradedDisclosure}" (DSH will also enforce this programmatically; write it anyway.)` : '',
    '\nSynthesize — do NOT simply concatenate the participant outputs. Your output must cover: summary, recommendation, important agreements, important disagreements, risks/uncertainties, and next actions where useful.',
    '\nReply with exactly one JSON object and nothing else — no Markdown, no code fences, no prose before or after it. Use this exact shape (use these exact key names):',
    '{"type":"finish","output":"<required non-empty string — the full owner-facing synthesis text>","data":{"type":"council_synthesis"}}',
  ].filter(Boolean).join('\n');
}
