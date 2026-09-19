import { callbackDigest, deterministicOwnerId, OwnerControlError } from './owner-contracts.mjs';
import { sanitizeOperatorOutput } from '../runtime/operator-control-service.mjs';
// P9-R0.4 Part A/B: the ONE canonical PM-profile display helper — Telegram
// never derives its own "backend | model | reasoning" string, it only
// formats around the same label Desktop shows.
import { formatPmProfileLabel, formatPmProfileCompact } from '../pm/pm-profile-display.mjs';
import { LONG_TASK_HARD_DEADLINE_MS } from '../pm/pm-execution-timeout-policy.mjs';
// P10-R0.2.4.2 Part D/J/K/L/M: preflight diagnostics for a `--task-file`
// dispatch that FAILS source resolution — written only on failure (Part
// W #9/#10: the success path, which gets its own real task bundle via
// owner-task-controller.mjs, is completely untouched by this import/wiring).
import { TASK_LOG_EVENT_TYPES } from '../runtime/task-diagnostic-log.mjs';
import { buildDispatchFailureSummaryMarkdown } from '../runtime/task-diagnostic-summary.mjs';
// Owner-review remediation Gap B (docs/evidence/DSH_COUNCIL_WORKSPACE_READ_
// IMPLEMENTATION_20260906.md): the SAME bound normalizeCouncilSpec()
// enforces server-side (council-contracts.mjs) — reused here only so an
// owner typo/oversized manifest fails fast at the Telegram layer with a
// specific message, never a second independent source of truth for the
// bound itself (same discipline as --debate-rounds above).
import { MAX_WORKSPACE_EVIDENCE_PATHS } from '../pm/council/council-contracts.mjs';

const PROJECT_MENTION = /^@([A-Za-z0-9][A-Za-z0-9._:-]{0,127})(?:\s+([\s\S]+))?$/;

// P14-R0C: bounds every outbound Telegram sendMessage call — see send()
// below. A normal send completes in well under a second; 15s is a
// generous ceiling that only ever fires on a genuine network stall, never
// on ordinary latency.
const TELEGRAM_SEND_TIMEOUT_MS = 15000;
// Telegram accepts at most 4096 characters of message text. Keep a small
// reserve for the continuation label and future formatting, and count
// Unicode code points rather than JavaScript UTF-16 code units so an astral
// character is never split across messages.
export const TELEGRAM_MESSAGE_CHAR_LIMIT = 4096;
export const TELEGRAM_MESSAGE_CHUNK_BUDGET = 4000;

export function chunkTelegramMessage(value,{budget=TELEGRAM_MESSAGE_CHUNK_BUDGET}={}){
  if(!Number.isInteger(budget)||budget<1||budget>TELEGRAM_MESSAGE_CHUNK_BUDGET)throw new TypeError('Telegram message chunk budget is invalid');
  const text=String(value??'');
  const characters=Array.from(text);
  if(characters.length<=budget)return[text];
  const chunks=[];
  let start=0;
  while(start<characters.length){
    let end=Math.min(start+budget,characters.length);
    if(end<characters.length){
      let newline=-1;
      for(let index=end-1;index>start;index-=1){if(characters[index]==='\n'){newline=index;break;}}
      if(newline>start)end=newline+1;
    }
    chunks.push(characters.slice(start,end).join(''));
    start=end;
  }
  if(chunks.length===1)return chunks;
  return chunks.map((chunk,index)=>{
    const label=`[continued ${index+1}/${chunks.length}]`;
    return index===0?`${chunk}\n\n${label}`:`${label}\n\n${chunk}`;
  });
}

// P7-R0.3 Part C/K: bounded, allow-listed structured observability for the
// terminal-delivery pipeline — reuses the existing runtime structured-log
// path (plain stdout/stderr, already captured by RuntimeLogBuffer in the
// Electron main process and by any plain `node scripts/p5-runtime.mjs`
// invocation) rather than introducing a second logging subsystem. Only ever
// receives a small, explicit field allow-list from call sites in this file
// (stage/pmRunId/taskId/projectId/notificationId/status/messageBytes/
// attempt/error) — never a token, chat id, HTTP auth URL, or the full
// rendered/result text.
function defaultNotifierLog(event) {
  try { console.error(`##DSH_OWNER_NOTIFY## ${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}`); }
  catch { /* observability must never itself break delivery */ }
}

// P7-R0.3 Part J: a terminal result's `output` (single-PM result text or a
// council's full chair synthesis) is bounded here, well above the generic
// sanitizer's MAX_STRING=512, but still well under
// renderTerminalResult()'s own final ~3500-char message budget (leaving
// room for that function's header/footer text) — so a long real synthesis
// is usefully readable in Telegram instead of clipped to 512 chars with no
// indication anything was cut.
const TERMINAL_OUTPUT_CHAR_BUDGET = 3000;
function truncateTerminalOutput(value) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (text.length <= TERMINAL_OUTPUT_CHAR_BUDGET) return text;
  return `${text.slice(0, TERMINAL_OUTPUT_CHAR_BUDGET)}\n[TRUNCATED — full result remains available in DSH Desktop]`;
}

// P7 Part C/C1/C2: `@<project_id> [--pm <profile_id>] [--debate <p1,p2,...>] [--debate-extend [--debate-rounds 1|2] [--implementation <profile_id>]] <task>`.
// Flags are stripped, left to right, from the front of the mention body only
// — the remaining text (after all recognized flags) is the task body, exactly
// as bare `@project_id <task>` already worked pre-P7 when no flags are
// present. `--debate auto` is REJECTED explicitly (Part C: auto-selection
// semantics are not implemented in this wave) rather than silently choosing
// participants. Throws a plain Error with a human-readable message on any
// malformed flag — callers must catch it and never let it escape as an
// internal JSON error (Part C2).
// P10-R0.2.4 Part B: `--task-file <ref> <path>` is a TWO-value-token flag
// (unlike `--pm`/`--debate`'s single token) — handled as an explicit
// special case below rather than generalizing the single-value regex,
// since it is the only flag with this shape. Part M: "no task-file
// overrides" — a task-file directive combined with trailing prose is
// still syntactically PARSED here (so a clear, specific error can be
// raised) but the caller (routeTelegramUpdate) refuses it rather than
// silently concatenating the prose onto the resolved file content.
// P12-R5: `--commit`/`--push`/`--review` are bare boolean flags (never
// consume a following word as a value — matched with their own strict,
// non-greedy pattern BEFORE the generic value-consuming regex, exactly
// like `--task-file`'s two-token special case above them). `--durability`
// takes exactly one of three values. All four are optional and additive —
// omitting them (every existing caller) is byte-for-byte the pre-P12
// payload; they map onto the exact same owner-task-controller.mjs
// normalizeDurability()/normalizeGitSyncRequest()/normalizeReviewRequest()
// contract Desktop's IPC payload already used, formalizing it as real
// Telegram syntax so P12-R5's owner-live DURABLE_REMOTE test is actually
// reachable from Telegram, not just from a raw pipe call.
// P19-D4: `--debate-extend`/`--debate-rounds` are DELIBERATELY named apart
// from the pre-existing `--debate <p1,p2,...>` flag above (P7-era —
// selects COUNCIL participants, predates the actual Debate extension by
// several phases and has nothing to do with it). Reusing `--debate` for
// this would silently collide with that flag's established meaning —
// see docs/p19/07_P19_D4_FIRST_PROMPT.md's own note not to guess the
// existing grammar. `--debate-extend` is boolean (mirrors `--commit`/
// `--push`/`--review`'s bare-flag shape); `--debate-rounds` is a value
// flag (mirrors `--durability`), validated to exactly 1 or 2 — the same
// bound normalizeCouncilSpec()'s own `debate.max_rounds` enforces
// server-side, never re-derived independently here.
// P18-W4: `--long` explicitly requests the LONG runtime-class execution
// budget (pm-execution-timeout-policy.mjs's OWNER_SINGLE_LONG, 1800000ms)
// for a SINGLE task WITHOUT requiring the `--task-file <ref> <path>`
// git-provenance mechanism (P10-R0.2.4) that was previously the only way
// to reach it. A bare boolean flag, same shape as `--commit`/`--push`/
// `--review`/`--debate-extend` above — never a value flag, never inferred
// from task text length. Folded onto `payload.runtime_class` (a NEW,
// separate typed owner payload fact — see applyLifecycleFlags() below)
// rather than onto `payload.task_source`, which continues to mean GIT_FILE
// provenance ONLY (owner-task-controller.mjs's own docstring) — never
// repurposed.
// Council/Debate WORKSPACE_READ remediation (docs/evidence/
// DSH_COUNCIL_PARTICIPANT_EXECUTION_AUDIT_20260906.md §12): `--workspace-read`
// is Council/Debate-only (folded onto `payload.council.workspace_requirement`
// by applyWorkspaceReadFlag() below) — never inferred from task text, never
// valid without a council dispatch (checked explicitly at each routing
// branch, same discipline as `--debate-extend`'s existing "requires a
// council" checks).
const BOOLEAN_FLAGS = Object.freeze(['commit', 'push', 'review', 'debate-extend', 'long', 'workspace-read']);
const BOOLEAN_FLAG_RE = new RegExp(`^--(${BOOLEAN_FLAGS.join('|')})\\b`);
const DURABILITY_VALUES = Object.freeze({ direct: 'DIRECT', local: 'DURABLE_LOCAL', remote: 'DURABLE_REMOTE' });
// P24.1G4: `--report-non-empty <true|false>` — same case-insensitive
// enum-lookup shape as DURABILITY_VALUES above.
const REPORT_NON_EMPTY_VALUES = Object.freeze({ true: true, false: false });
const DEBATE_ROUNDS_VALUES = Object.freeze(new Set(['1', '2']));
// P18-W4 ACK-causal-correlation remediation: `--client-correlation <id>` is
// a DSH-owned, TRANSPORT-ONLY correlation fact -- a relay (or any other
// automated Telegram client) can supply its own opaque correlation id so
// DSH's own accepted-ACK can echo it back verbatim (renderOwnerAck() below),
// giving that caller an AUTHORITATIVE way to bind DSH's task_id to its own
// dispatch without depending on an unauthenticated "some bot message newer
// than X" assumption. This is never model/task content, never PM
// authority, never runtime-class authority, never git authority -- see
// applyLifecycleFlags() (folds onto the separate payload.client_correlation_id
// field, never payload.task_source/body/runtime_class/git) and
// owner-task-controller.mjs (fail-closed validation, durable context
// storage only, zero effect on any execution decision). Bounded to the
// SAME charset/length shape the relay's own correlation_id already uses
// (relay/contract_v3.py's CORRELATION_ID_RE) so one value can round-trip
// between the two systems unchanged.
const CLIENT_CORRELATION_RE = /^[A-Za-z0-9_.-]{6,128}$/;

export function parseOwnerFlags(text) {
  let rest = String(text ?? '');
  const flags = {};
  for (;;) {
    const trimmed = rest.replace(/^\s+/, '');
    if (!trimmed.startsWith('--')) {
      // P19-D4: --debate-rounds is only ever meaningful alongside
      // --debate-extend — checked here (not silently dropped) so a typo'd
      // ordering fails fast with a specific message, exactly like every
      // other flag-combination rule in this function.
      if (flags.debateRounds != null && flags['debate-extend'] !== true) throw new Error('--debate-rounds requires --debate-extend');
      // P19-D5: implementation capability is available only as an explicit
      // Debate extension selection at this transport. The runtime remains
      // the final authority for participant membership/profile validation.
      if (flags.implementation != null && flags['debate-extend'] !== true) throw new Error('--implementation requires --debate-extend');
      // Owner-review remediation Gap B: `--workspace-evidence` is only ever
      // meaningful alongside `--workspace-read` — same "fails fast with a
      // specific message" discipline as --debate-rounds/--implementation
      // above.
      if (flags['workspace-evidence'] != null && flags['workspace-read'] !== true) throw new Error('--workspace-evidence requires --workspace-read');
      // P24.1G4: `--report-non-empty` only ever qualifies a
      // `--report-path` request — same "fails fast with a specific
      // message" discipline as --debate-rounds/--implementation/
      // --workspace-evidence above. Never silently dropped.
      if (flags.reportNonEmpty != null && flags.reportPath == null) throw new Error('--report-non-empty requires --report-path');
      return {
        pmProfileId: flags.pm ?? null, debateProfileIds: flags.debate ?? null, taskFile: flags.taskFile ?? null,
        durability: flags.durability ?? null, commit: flags.commit === true, push: flags.push === true, review: flags.review === true,
        long: flags.long === true,
        remote: flags.remote ?? null,
        parentTaskId: flags.parent ?? null, remediatesTaskId: flags.remediates ?? null, reviewsTaskId: flags.reviews ?? null,
        requiresContextTaskId: flags.requiresContext ?? null,
        // P19-D4: additive. `debateExtend` deliberately named apart from
        // `debateProfileIds` above (the pre-existing, unrelated `--debate
        // <participants>` flag) — see this file's BOOLEAN_FLAGS comment.
        debateExtend: flags['debate-extend'] === true, debateRounds: flags.debateRounds ?? null,
        workspaceRead: flags['workspace-read'] === true,
        workspaceEvidencePaths: flags['workspace-evidence'] ?? null,
        // P24.1G4: DSH Telegram workspace_output transport bridge — explicit
        // typed flags only, never derived from task prose. `reportPath` is
        // forwarded verbatim (no path normalization at this layer — see
        // applyLifecycleFlags() below); `reportNonEmpty`, when present, is
        // already coerced to a real boolean here (never the raw string).
        reportPath: flags.reportPath ?? null,
        reportNonEmpty: flags.reportNonEmpty ?? null,
        ...(flags.implementation != null ? { implementationParticipantId: flags.implementation } : {}),
        clientCorrelationId: flags.clientCorrelation ?? null,
        text: trimmed,
      };
    }
    if (trimmed.startsWith('--task-file')) {
      const m = trimmed.match(/^--task-file\s+(\S+)\s+(\S+)/);
      if (!m) throw new Error('--task-file requires a ref and a path: --task-file <ref> <path>');
      if (flags.taskFile) throw new Error('--task-file specified more than once');
      const [full, ref, path] = m;
      flags.taskFile = { ref, path };
      rest = trimmed.slice(full.length);
      continue;
    }
    const boolMatch = trimmed.match(BOOLEAN_FLAG_RE);
    if (boolMatch) {
      const name = boolMatch[1];
      if (flags[name]) throw new Error(`--${name} specified more than once`);
      flags[name] = true;
      rest = trimmed.slice(boolMatch[0].length);
      continue;
    }
    const m = trimmed.match(/^--([A-Za-z][A-Za-z-]*)(?:\s+(\S+))?/);
    if (!m) throw new Error('malformed flag');
    const [full, name, value] = m;
    if (value === undefined) throw new Error(`--${name} requires a value`);
    if (name === 'pm') {
      if (flags.pm) throw new Error('--pm specified more than once');
      flags.pm = value;
    } else if (name === 'debate') {
      if (flags.debate) throw new Error('--debate specified more than once');
      if (value === 'auto') throw new Error('--debate auto is not supported yet; specify an explicit comma-separated participant list');
      const ids = value.split(',').map((s) => s.trim()).filter(Boolean);
      if (ids.length === 0) throw new Error('--debate requires a non-empty participant list');
      flags.debate = ids;
    } else if (name === 'durability') {
      if (flags.durability) throw new Error('--durability specified more than once');
      const resolved = DURABILITY_VALUES[value.toLowerCase()];
      if (!resolved) throw new Error('--durability must be one of: direct, local, remote');
      flags.durability = resolved;
    } else if (name === 'debate-rounds') {
      // P19-D4: max_rounds for the Debate extension — same bound
      // normalizeCouncilSpec()'s debate.max_rounds enforces server-side
      // (council-contracts.mjs), checked here only so an owner typo fails
      // fast at the Telegram layer with a specific message, never as a
      // second, independent source of truth for the bound itself.
      if (flags.debateRounds != null) throw new Error('--debate-rounds specified more than once');
      if (!DEBATE_ROUNDS_VALUES.has(value)) throw new Error('--debate-rounds must be 1 or 2');
      flags.debateRounds = Number(value);
    } else if (name === 'implementation') {
      // P19-D5: one scalar flag maps to the already-proven W4R6 scalar
      // contract. Repeating it can never be interpreted as a list.
      if (flags.implementation != null) throw new Error('--implementation specified more than once');
      flags.implementation = value;
    } else if (name === 'remote') {
      // P12-R5: names a non-default remote for --push (e.g. a deliberately
      // unconfigured name for a controlled, safe remote-sync-failure
      // rehearsal — R5 TEST 5 — never the credential/URL itself, just a
      // git remote NAME already configured, or deliberately not, in the
      // target project's own repository).
      if (flags.remote) throw new Error('--remote specified more than once');
      flags.remote = value;
    } else if (name === 'parent') {
      // P12-R5/R3: discoverability-only link (relations.parent_task_id) —
      // never validated against durable history here; that already
      // happened, if required at all, at the requires-context pre-flight.
      if (flags.parent) throw new Error('--parent specified more than once');
      flags.parent = value;
    } else if (name === 'remediates') {
      if (flags.remediates) throw new Error('--remediates specified more than once');
      flags.remediates = value;
    } else if (name === 'reviews') {
      if (flags.reviews) throw new Error('--reviews specified more than once');
      flags.reviews = value;
    } else if (name === 'client-correlation') {
      // P18-W4 ACK-causal-correlation remediation: fails closed here, at
      // parse time, on any malformed value -- BEFORE any task/pm_run is
      // ever created (owner-task-controller.mjs's submit() independently
      // re-validates the same bound, since Telegram is not the only
      // ingress path into OwnerTaskController).
      if (flags.clientCorrelation) throw new Error('--client-correlation specified more than once');
      if (!CLIENT_CORRELATION_RE.test(value)) throw new Error('--client-correlation must match ^[A-Za-z0-9_.-]{6,128}$');
      flags.clientCorrelation = value;
    } else if (name === 'requires-context') {
      // P12-R3: the ONE owner-facing way to request the pre-flight "this
      // task requires a specific prior task's durable context to exist"
      // check (local-runtime-control.mjs's resolveRequiredContext) —
      // resolved BEFORE any pm_run is created; a missing referenced task
      // blocks the whole dispatch with TASK_CONTEXT_REQUIRED_UNAVAILABLE.
      if (flags.requiresContext) throw new Error('--requires-context specified more than once');
      flags.requiresContext = value;
    } else if (name === 'workspace-evidence') {
      // Owner-review remediation Gap B: explicit, typed, owner-authored
      // evidence manifest — comma-separated repo-relative paths. Only
      // LIGHT shape validation happens here (non-empty list, a friendly
      // early bound) — the authoritative validation (path-escape/`..`/
      // absolute/duplicate/deny-list) happens server-side in
      // normalizeCouncilSpec()/council-workspace-admission.mjs, never a
      // second, diverging source of truth.
      if (flags['workspace-evidence']) throw new Error('--workspace-evidence specified more than once');
      const paths = value.split(',').map((s) => s.trim()).filter(Boolean);
      if (paths.length === 0) throw new Error('--workspace-evidence requires a non-empty comma-separated path list');
      if (paths.length > MAX_WORKSPACE_EVIDENCE_PATHS) throw new Error(`--workspace-evidence accepts at most ${MAX_WORKSPACE_EVIDENCE_PATHS} paths`);
      flags['workspace-evidence'] = paths;
    } else if (name === 'report-path') {
      // P24.1G4: the ONE typed, explicit, owner-authored source of a
      // workspace_output repo path (P24.1G2's OwnerTaskController product
      // contract). Transport SHAPE validation only (non-empty — guaranteed
      // by the shared tokenizer's `\S+` value capture, which can never
      // yield an empty string) — repo containment / `.git` deny / symlink-
      // escape / artifact_v1 / git.commit / SINGLE-only remain EXCLUSIVELY
      // OwnerTaskController's authority (owner-task-controller.mjs), never
      // duplicated here. The value is forwarded byte-for-byte, never
      // normalized/reshaped at this layer.
      if (flags.reportPath) throw new Error('--report-path specified more than once');
      flags.reportPath = value;
    } else if (name === 'report-non-empty') {
      // P24.1G4: optional qualifier for --report-path. Same case-
      // insensitive enum-lookup discipline as --durability above — an
      // invalid value fails closed here, at parse time, rather than
      // silently coercing to a default.
      if (flags.reportNonEmpty != null) throw new Error('--report-non-empty specified more than once');
      const resolved = REPORT_NON_EMPTY_VALUES[value.toLowerCase()];
      if (resolved === undefined) throw new Error('--report-non-empty must be one of: true, false');
      flags.reportNonEmpty = resolved;
    } else {
      throw new Error(`unknown flag: --${name}`);
    }
    rest = trimmed.slice(full.length);
  }
}

// P12-R5: folds parseOwnerFlags()'s `durability`/`commit`/`push`/`review`
// booleans into the exact `payload.durability`/`payload.git`/`payload.review`
// shapes owner-task-controller.mjs's normalizeDurability()/
// normalizeGitSyncRequest()/normalizeReviewRequest() already expect —
// Telegram never re-implements that validation, only forwards what the
// owner typed. A no-op (mutates nothing) when none of these flags were
// used — every existing dispatch is byte-for-byte unaffected.
function applyLifecycleFlags(payload,flags){
  if(flags.durability)payload.durability=flags.durability;
  if(flags.commit||flags.push){
    payload.git={commit:true,push:Boolean(flags.push)};
    if(flags.remote)payload.git.remote=flags.remote;
  }
  if(flags.review)payload.review={requested:true};
  // P24.1G4: folds `--report-path`/`--report-non-empty` into the exact
  // `payload.workspace_output` shape owner-task-controller.mjs's
  // normalizeWorkspaceOutputRequest() already expects (P24.1G2) — never
  // `required:true` (that normalization stays OwnerTaskController's own
  // internal concern, never re-derived/duplicated here). A no-op when
  // `--report-path` was never given — every existing dispatch (SINGLE,
  // COUNCIL, DEBATE, task-file) stays byte-for-byte unaffected.
  if(flags.reportPath){
    payload.workspace_output={report_path:flags.reportPath};
    if(flags.reportNonEmpty!=null)payload.workspace_output.non_empty=flags.reportNonEmpty;
  }
  // P18-W4 Part A: `--long` folds onto `payload.runtime_class` — a
  // separate typed owner payload fact from `payload.task_source`, which
  // continues to mean GIT_FILE provenance only (owner-task-controller.mjs
  // is the one place that combines the two into the final durable
  // `context.runtimeClass`). Omitted (not set to 'NORMAL') when the flag
  // is absent, matching every other optional flag's byte-for-byte-
  // unaffected-when-omitted convention above.
  if(flags.long)payload.runtime_class='LONG';
  // P18-W4 ACK-causal-correlation remediation: a SEPARATE typed fact from
  // every other field here -- never task_source (GIT_FILE provenance
  // only), never runtime_class, never body/git. Omitted entirely (not set
  // to null) when the flag is absent, matching every other optional
  // flag's byte-for-byte-unaffected-when-omitted convention above.
  if(flags.clientCorrelationId)payload.client_correlation_id=flags.clientCorrelationId;
  if(flags.parentTaskId||flags.remediatesTaskId||flags.reviewsTaskId){
    payload.relations={};
    if(flags.parentTaskId)payload.relations.parent_task_id=flags.parentTaskId;
    if(flags.remediatesTaskId)payload.relations.remediation_of_task_id=flags.remediatesTaskId;
    if(flags.reviewsTaskId)payload.relations.review_of_task_id=flags.reviewsTaskId;
  }
  if(flags.requiresContextTaskId)payload.requires_context={task_id:flags.requiresContextTaskId};
}

// P19-D4: folds `--debate-extend`/`--debate-rounds` onto
// `payload.council.debate` — the exact shape D1's normalizeCouncilSpec()
// already validates server-side (council-contracts.mjs). A no-op when
// `--debate-extend` was never given, or when this dispatch has no
// `payload.council` at all (every pre-D4 dispatch, and every SINGLE/
// task-file dispatch) — byte-for-byte unaffected. Deliberately
// non-throwing, matching applyLifecycleFlags()'s own discipline — this
// runs AFTER the shared parseOwnerFlags() try/catch at each call site, so
// it must never throw; the "--debate-extend without a council" case is
// instead refused EARLY and explicitly, with a structured FLAGS_INVALID
// response, at each routing branch below (matching this file's existing
// "--debate requires --pm" convention) — never silently dropped, never a
// second uncaught throw path.
function applyDebateExtension(payload,flags){
  if(flags.debateExtend&&payload.council)payload.council.debate={enabled:true,...(flags.debateRounds!=null?{max_rounds:flags.debateRounds}:{})};
  // P19-D5: transport wiring only. This is the existing W4R6 CouncilSpec
  // field; no Debate step receives capability and no new execution path is
  // introduced. normalizeCouncilSpec() remains the decisive authority.
  if(flags.debateExtend&&flags.implementationParticipantId&&payload.council)payload.council.implementation_participant_id=flags.implementationParticipantId;
}

// Council/Debate WORKSPACE_READ remediation: folds `--workspace-read` onto
// `payload.council.workspace_requirement` — the exact typed field
// normalizeCouncilSpec() validates server-side (council-contracts.mjs). A
// no-op when `--workspace-read` was never given, or when this dispatch has
// no `payload.council` at all — byte-for-byte unaffected (every pre-
// existing SINGLE/Council/Debate dispatch). The "`--workspace-read` without
// a council" case is refused EARLY and explicitly at each routing branch
// below (matching `--debate-extend`'s own "requires a council" convention)
// — never silently dropped.
function applyWorkspaceReadFlag(payload,flags){
  if(flags.workspaceRead&&payload.council)payload.council.workspace_requirement='READ';
  // Owner-review remediation Gap B: folds `--workspace-evidence` onto
  // `payload.council.workspace_evidence_paths`. `--workspace-evidence`
  // already requires `--workspace-read` (parseOwnerFlags' own ordering
  // guard), which itself already requires a council at each routing
  // branch below — so reaching here with a manifest but no `payload.council`
  // cannot happen via any routed dispatch; the `payload.council` guard is
  // kept anyway for defense in depth, matching every other fold above.
  if(flags.workspaceEvidencePaths&&payload.council)payload.council.workspace_evidence_paths=flags.workspaceEvidencePaths;
}

// P8-R0 Part D/K: `<projectAlias>-<pmAlias> <task>` (single-task shorthand)
// and `/c <projectAlias> <chairAlias> <p1Alias,p2Alias,...> <task>` (council
// shorthand). Alias tokens are bounded to 1-4 digits (see telegram-alias-
// registry.mjs) so splitting on the first hyphen is always unambiguous.
const SHORTHAND_TASK = /^([0-9]{1,4})-([0-9]{1,4})\s+([\s\S]+)$/;
const SHORTHAND_COUNCIL = /^\/c\s+([0-9]{1,4})\s+([0-9]{1,4})\s+([0-9]{1,4}(?:\s*,\s*[0-9]{1,4})*)\s+([\s\S]+)$/;

// M4: with exactly one registered project, bare task text is unambiguous and
// remains valid. With more than one, bare new-task text fails closed and the
// owner must address the task with `@<project_id>`. Interaction replies and
// callbacks always resolve their own bound interaction's project lineage and
// never require a project prefix.
//
// P8-R0: `aliasRegistry` (a TelegramAliasRegistry, or any duck-typed
// equivalent — Part A/B) is OPTIONAL and purely additive. When absent, every
// branch below behaves byte-for-byte as it did pre-P8 (Part 24: canonical
// P7 Telegram syntax unchanged); the new `/pms`, `/profiles`, `/aliases`,
// `/c ...` and `<alias>-<alias> <task>` forms simply do not exist. When
// present, alias resolution happens HERE, before canonical acceptance
// (Part M), and always produces the exact same routed shape a canonical
// `@<project_id> [--pm ...] [--debate ...] <task>` command would have
// produced — same `project_id`, same `payload.pm_profile_id`/`payload.
// council`, same `payload.body` (Part P/Q) — plus an additive `alias` field
// carrying the raw alias tokens for the richer shorthand ack (Part F). Only
// a DIFFERENT front-end parser: the routed object still flows into the
// exact same, single OwnerControlService/OwnerTaskController authority path
// as every other command (Part R — alias parsing grants no new authority).
export function routeTelegramUpdate(update,{projects,projectId,boundInteraction=null,aliasRegistry=null}={}) {
  const projectList=normalizeProjectList({projects,projectId});
  const actor=String(update.message?.from?.id ?? update.callback_query?.from?.id ?? ''); const chat=String(update.message?.chat?.id ?? update.callback_query?.message?.chat?.id ?? '');
  const command_id=deterministicOwnerId('tg',String(update.update_id));
  if(update.callback_query){return {command_id,actor_id:actor,chat_id:chat,client_kind:'TELEGRAM',operation:'DECIDE_INTERACTION',target_id:update.callback_query.message?.interaction_id??boundInteraction?.interaction_id,expected_revision:boundInteraction?.revision,payload:{callback_data:update.callback_query.data}};}
  const text=update.message?.text;if(typeof text!=='string')return null;
  if(update.message?.reply_to_message&&boundInteraction)return {command_id,actor_id:actor,chat_id:chat,client_kind:'TELEGRAM',operation:'REPLY_TO_INTERACTION',target_id:boundInteraction.interaction_id,expected_revision:boundInteraction.revision,payload:{text}};
  const decide=text.match(/^\/decide\s+([A-Za-z0-9._:-]+)\s+([1-9][0-9]*)\s+([A-Za-z0-9._:-]+)$/);
  if(decide)return {command_id,actor_id:actor,chat_id:chat,client_kind:'TELEGRAM',operation:'DECIDE_INTERACTION',target_id:decide[1],expected_revision:Number(decide[2]),payload:{response:decide[3]}};
  if(/^\/projects$/.test(text))return {command_id,actor_id:actor,chat_id:chat,client_kind:'TELEGRAM',read:'LIST_PROJECTS'};
  // P9-R0.4 Part P: `/profiles all` (and `/pms all`) is the explicit,
  // opt-in way to see INACTIVE profiles too — bare `/profiles` stays
  // active-only (Part N/P).
  const profilesMatch=aliasRegistry?text.match(/^\/(?:pms|profiles)(?:\s+(all))?$/):null;
  if(profilesMatch)return {command_id,actor_id:actor,chat_id:chat,client_kind:'TELEGRAM',read:'LIST_PM_PROFILES',all:Boolean(profilesMatch[1])};
  if(aliasRegistry&&/^\/aliases$/.test(text))return {command_id,actor_id:actor,chat_id:chat,client_kind:'TELEGRAM',read:'LIST_ALIASES'};
  if(aliasRegistry){
    const council=text.match(SHORTHAND_COUNCIL);
    if(council){
      const [,projectAlias,chairAlias,participantsRaw,rawBody]=council;
      const resolved=resolveAliasRoute({command_id,actor,chat,aliasRegistry,projectAlias,pmAliases:[chairAlias,...participantsRaw.split(',').map((s)=>s.trim()).filter(Boolean)]});
      if(resolved.read)return resolved.route;
      const [chairProfileId,...participantProfileIds]=resolved.pmProfileIds;
      // P15-REM-R3-A (P15-D-001, docs/p15-rem/04_*.md): council shorthand's
      // trailing text now feeds the SAME shared parseOwnerFlags()/
      // applyLifecycleFlags() the canonical `@project` syntax already uses
      // below — never a second, silent grammar branch that drops
      // `--durability`/`--commit`/`--push`/`--review`/`--parent`/
      // `--remediates`/`--reviews`/`--requires-context` into prompt prose.
      // PM identity for shorthand comes from the alias tokens ONLY — a
      // stray `--pm`/`--debate` in the body is refused explicitly rather
      // than silently accepted or silently dropped.
      let flags;
      try{flags=parseOwnerFlags(rawBody);}
      catch(error){return {command_id,actor_id:actor,chat_id:chat,client_kind:'TELEGRAM',read:'FLAGS_INVALID',detail:error.message,requested_project_id:resolved.projectId};}
      if(flags.pmProfileId||flags.debateProfileIds)return {command_id,actor_id:actor,chat_id:chat,client_kind:'TELEGRAM',read:'FLAGS_INVALID',detail:'--pm/--debate are not valid in alias shorthand — PM identity comes from the resolved alias',requested_project_id:resolved.projectId};
      if(flags.implementationParticipantId&&!participantProfileIds.includes(flags.implementationParticipantId))return {command_id,actor_id:actor,chat_id:chat,client_kind:'TELEGRAM',read:'FLAGS_INVALID',detail:'--implementation must name one of this council\'s participants',requested_project_id:resolved.projectId};
      // P10-R0.2.4 Part C: LONG COUNCIL dispatch is explicitly DEFERRED this
      // wave — never silently half-supported (Part C: "Do not silently
      // half-support it"). A `--task-file` directive in a council dispatch
      // fails closed with a distinct, honest message rather than being
      // treated as literal council task text — now caught by the shared
      // parser too, so `--task-file <ref> <path>` PLUS lifecycle flags is
      // refused the same way a bare directive already was.
      if(flags.taskFile)return {command_id,actor_id:actor,chat_id:chat,client_kind:'TELEGRAM',read:'TASK_FILE_COUNCIL_NOT_SUPPORTED',requested_project_id:resolved.projectId};
      if(!flags.text)return {command_id,actor_id:actor,chat_id:chat,client_kind:'TELEGRAM',read:'PROJECT_TASK_TEXT_REQUIRED',requested_project_id:resolved.projectId};
      const participantAliases=participantsRaw.split(',').map((s)=>s.trim()).filter(Boolean);
      const payload={body:flags.text,pm_profile_id:chairProfileId,council:{chair_profile_id:chairProfileId,participant_profile_ids:participantProfileIds}};
      applyLifecycleFlags(payload,flags);
      applyDebateExtension(payload,flags); // P19-D4: council identity already comes from the resolved aliases here — no extra guard needed.
      applyWorkspaceReadFlag(payload,flags); // Council/Debate WORKSPACE_READ remediation: council identity already resolved above — no extra guard needed.
      return {command_id,actor_id:actor,chat_id:chat,client_kind:'TELEGRAM',operation:'SUBMIT_TASK',project_id:resolved.projectId,payload,alias:{project:projectAlias,pm:chairAlias,participants:participantAliases}};
    }
  }
  const match=text.match(/^\/(cancel|status|inbox)(?:\s+([A-Za-z0-9._:-]+))?$/);
  if(match?.[1]==='cancel'&&match[2])return {command_id,actor_id:actor,chat_id:chat,client_kind:'TELEGRAM',operation:'REQUEST_CANCEL',target_id:match[2],payload:{}};
  if(match)return {command_id,actor_id:actor,chat_id:chat,client_kind:'TELEGRAM',read:match[1]==='inbox'?'GET_INBOX':'GET_TASK',target_id:match[2]??null};
  if(text.startsWith('/'))throw new OwnerControlError('unknown command','TELEGRAM_COMMAND_REFUSED');
  const mention=text.match(PROJECT_MENTION);
  if(mention){
    const requested=mention[1];const rawBody=(mention[2]??'').trim();
    if(!projectList.some((p)=>p.id===requested))return {command_id,actor_id:actor,chat_id:chat,client_kind:'TELEGRAM',read:'PROJECT_UNKNOWN',requested_project_id:requested,projects:projectList};
    let flags;
    try{flags=parseOwnerFlags(rawBody);}
    catch(error){return {command_id,actor_id:actor,chat_id:chat,client_kind:'TELEGRAM',read:'FLAGS_INVALID',detail:error.message,requested_project_id:requested};}
    if(flags.debateProfileIds&&!flags.pmProfileId)return {command_id,actor_id:actor,chat_id:chat,client_kind:'TELEGRAM',read:'FLAGS_INVALID',detail:'--debate requires --pm <chair_profile_id> to select the chair',requested_project_id:requested};
    // P19-D4: --debate-extend requires a council to extend — this canonical
    // form only ever constructs one when --debate <participants> is also
    // given (below). Checked here, early, matching the --debate/--pm check
    // just above — never silently dropped.
    if(flags.debateExtend&&!flags.debateProfileIds)return {command_id,actor_id:actor,chat_id:chat,client_kind:'TELEGRAM',read:'FLAGS_INVALID',detail:'--debate-extend requires a council dispatch (--pm <chair_profile_id> --debate <p1,p2,...>)',requested_project_id:requested};
    if(flags.implementationParticipantId&&!flags.debateProfileIds?.includes(flags.implementationParticipantId))return {command_id,actor_id:actor,chat_id:chat,client_kind:'TELEGRAM',read:'FLAGS_INVALID',detail:'--implementation must name one of this council\'s participants',requested_project_id:requested};
    // Council/Debate WORKSPACE_READ remediation: `--workspace-read` requires
    // a council to apply to — same "requires a council dispatch" discipline
    // as `--debate-extend` just above.
    if(flags.workspaceRead&&!flags.debateProfileIds)return {command_id,actor_id:actor,chat_id:chat,client_kind:'TELEGRAM',read:'FLAGS_INVALID',detail:'--workspace-read requires a council dispatch (--pm <chair_profile_id> --debate <p1,p2,...>)',requested_project_id:requested};
    // P10-R0.2.4 Part B/C/M: `--task-file <ref> <path>` is SINGLE-only this
    // wave — a canonical `@project --pm X --debate ... --task-file ...`
    // (council) fails closed exactly like the shorthand `/c` form above.
    // Part M: "no task-file overrides" — trailing prose after the flags
    // (`flags.text`) is refused rather than silently concatenated onto the
    // resolved file content.
    if(flags.taskFile){
      if(flags.debateProfileIds)return {command_id,actor_id:actor,chat_id:chat,client_kind:'TELEGRAM',read:'TASK_FILE_COUNCIL_NOT_SUPPORTED',requested_project_id:requested};
      if(flags.text)return {command_id,actor_id:actor,chat_id:chat,client_kind:'TELEGRAM',read:'FLAGS_INVALID',detail:'--task-file does not accept additional task text — the resolved file content is the entire task body',requested_project_id:requested};
      const payload={task_file:flags.taskFile};
      if(flags.pmProfileId)payload.pm_profile_id=flags.pmProfileId;
      applyLifecycleFlags(payload,flags);
      return {command_id,actor_id:actor,chat_id:chat,client_kind:'TELEGRAM',operation:'SUBMIT_TASK',project_id:requested,payload};
    }
    if(!flags.text)return {command_id,actor_id:actor,chat_id:chat,client_kind:'TELEGRAM',read:'PROJECT_TASK_TEXT_REQUIRED',requested_project_id:requested};
    const payload={body:flags.text};
    if(flags.pmProfileId)payload.pm_profile_id=flags.pmProfileId;
    if(flags.debateProfileIds)payload.council={chair_profile_id:flags.pmProfileId,participant_profile_ids:flags.debateProfileIds};
    applyLifecycleFlags(payload,flags);
    applyDebateExtension(payload,flags);
    applyWorkspaceReadFlag(payload,flags);
    return {command_id,actor_id:actor,chat_id:chat,client_kind:'TELEGRAM',operation:'SUBMIT_TASK',project_id:requested,payload};
  }
  if(aliasRegistry){
    const shorthand=text.match(SHORTHAND_TASK);
    if(shorthand){
      const [,projectAlias,pmAlias,rawBody]=shorthand;
      const resolved=resolveAliasRoute({command_id,actor,chat,aliasRegistry,projectAlias,pmAliases:[pmAlias]});
      if(resolved.read)return resolved.route;
      // P15-REM-R3-A (P15-D-001, docs/p15-rem/04_*.md): single-task
      // shorthand's trailing text now feeds the SAME shared
      // parseOwnerFlags()/applyLifecycleFlags() the canonical `@project`
      // syntax uses above — `--durability`/`--commit`/`--push`/`--review`/
      // `--parent`/`--remediates`/`--reviews`/`--requires-context` are
      // parsed as real lifecycle semantics here too, never silently
      // absorbed into the prompt body. PM identity comes from the alias
      // token ONLY; a stray `--pm`/`--debate` in the body is refused.
      let flags;
      try{flags=parseOwnerFlags(rawBody);}
      catch(error){return {command_id,actor_id:actor,chat_id:chat,client_kind:'TELEGRAM',read:'FLAGS_INVALID',detail:error.message,requested_project_id:resolved.projectId};}
      if(flags.pmProfileId||flags.debateProfileIds)return {command_id,actor_id:actor,chat_id:chat,client_kind:'TELEGRAM',read:'FLAGS_INVALID',detail:'--pm/--debate are not valid in alias shorthand — PM identity comes from the resolved alias',requested_project_id:resolved.projectId};
      // P19-D4: this is single-task shorthand — no council exists to
      // extend (matches the --pm/--debate refusal immediately above).
      if(flags.debateExtend)return {command_id,actor_id:actor,chat_id:chat,client_kind:'TELEGRAM',read:'FLAGS_INVALID',detail:'--debate-extend requires a council dispatch — not valid for single-task shorthand',requested_project_id:resolved.projectId};
      // P10-R0.2.4 Part B: the preferred compact LONG SINGLE dispatch
      // syntax — `<projectAlias>-<pmAlias> --task-file <ref> <path>` — now
      // recognized via the shared parser (Part M below), which also covers
      // a task-file directive combined with trailing lifecycle flags
      // (previously silently unmatched and folded into a literal prompt).
      if(flags.taskFile){
        if(flags.text)return {command_id,actor_id:actor,chat_id:chat,client_kind:'TELEGRAM',read:'FLAGS_INVALID',detail:'--task-file does not accept additional task text — the resolved file content is the entire task body',requested_project_id:resolved.projectId};
        const payload={task_file:flags.taskFile,pm_profile_id:resolved.pmProfileIds[0]};
        applyLifecycleFlags(payload,flags);
        return {command_id,actor_id:actor,chat_id:chat,client_kind:'TELEGRAM',operation:'SUBMIT_TASK',project_id:resolved.projectId,payload,alias:{project:projectAlias,pm:pmAlias}};
      }
      if(!flags.text)return {command_id,actor_id:actor,chat_id:chat,client_kind:'TELEGRAM',read:'PROJECT_TASK_TEXT_REQUIRED',requested_project_id:resolved.projectId};
      const payload={body:flags.text,pm_profile_id:resolved.pmProfileIds[0]};
      applyLifecycleFlags(payload,flags);
      return {command_id,actor_id:actor,chat_id:chat,client_kind:'TELEGRAM',operation:'SUBMIT_TASK',project_id:resolved.projectId,payload,alias:{project:projectAlias,pm:pmAlias}};
    }
  }
  if(projectList.length===1)return {command_id,actor_id:actor,chat_id:chat,client_kind:'TELEGRAM',operation:'SUBMIT_TASK',project_id:projectList[0].id,payload:{body:text}};
  return {command_id,actor_id:actor,chat_id:chat,client_kind:'TELEGRAM',read:'PROJECT_REQUIRED',projects:projectList};
}

// P8-R0 Part M: shared alias-resolution helper for both shorthand forms —
// resolves ONE project alias and one-or-more PM aliases against
// `aliasRegistry`, returning either `{read:false,projectId,pmProfileIds}`
// (all resolved) or `{read:true,route}` where `route` is an already-shaped
// fail-closed routed read (`ALIAS_PROJECT_UNKNOWN`/`ALIAS_PM_UNKNOWN`) ready
// to return verbatim from routeTelegramUpdate. Never falls back to a
// default and never guesses — the first unresolvable alias wins the error.
function resolveAliasRoute({command_id,actor,chat,aliasRegistry,projectAlias,pmAliases}) {
  // P8-R0.1 Part "FAILURE POLICY": alias state can be OFF (never
  // reconciled/unavailable) independent of any single alias being unknown —
  // that fails the WHOLE shorthand attempt closed with a distinct message
  // ("use canonical syntax") rather than the per-alias ALIAS_*_UNKNOWN
  // refusal, since no lookup is trustworthy while state is unavailable.
  let projectId;
  try{projectId=aliasRegistry.resolveProject(projectAlias);}
  catch(error){
    if(error?.code==='ALIAS_STATE_UNAVAILABLE')return {read:true,route:{command_id,actor_id:actor,chat_id:chat,client_kind:'TELEGRAM',read:'ALIAS_STATE_UNAVAILABLE'}};
    if(error?.code==='ALIAS_PROJECT_UNKNOWN')return {read:true,route:{command_id,actor_id:actor,chat_id:chat,client_kind:'TELEGRAM',read:'ALIAS_PROJECT_UNKNOWN',alias:projectAlias}};
    throw error;
  }
  const pmProfileIds=[];
  for(const pmAlias of pmAliases){
    try{pmProfileIds.push(aliasRegistry.resolvePmProfile(pmAlias));}
    catch(error){
      if(error?.code==='ALIAS_STATE_UNAVAILABLE')return {read:true,route:{command_id,actor_id:actor,chat_id:chat,client_kind:'TELEGRAM',read:'ALIAS_STATE_UNAVAILABLE'}};
      if(error?.code==='ALIAS_PM_UNKNOWN')return {read:true,route:{command_id,actor_id:actor,chat_id:chat,client_kind:'TELEGRAM',read:'ALIAS_PM_UNKNOWN',alias:pmAlias}};
      throw error;
    }
  }
  return {read:false,projectId,pmProfileIds};
}

function normalizeProjectList({projects,projectId}){
  if(Array.isArray(projects))return projects.map((p)=>(typeof p==='string'?{id:p}:{id:p.id,display_name:p.display_name??p.id}));
  if(typeof projectId==='string'&&projectId)return [{id:projectId}];
  return [];
}
// P8-R0: mirrors normalizeProjectList's shape/tolerance for the adapter's
// own (secret-free — pm-profile-registry.mjs never carries a secret field)
// display copy of the PM profile catalogue, used only for `/pms`,
// `/profiles`, `/aliases` and the richer shorthand ack (Part F/I/J).
function normalizePmProfileList(pmProfiles){
  if(!Array.isArray(pmProfiles))return [];
  return pmProfiles.map((p)=>(typeof p==='string'?{id:p,product:null,model:null,reasoning:null}:{id:p.id,product:p.product??null,model:p.model??null,reasoning:p.reasoning??null}));
}

export class TelegramOwnerAdapter {
  // P10-R0.2.4 Part D/N: `taskFileResolver`, when supplied, is an async
  // `({projectId,ref,path})=>TaskSourceResult` (see p5-production-
  // composition.mjs — closes over the canonical project registry to find
  // `repo_path`). Optional and purely additive: a deployment that never
  // configures it simply cannot accept a `--task-file` dispatch at all
  // (Part N below fails closed with a clear message rather than crashing).
  // P10-R0.2.4.2 Part D: `taskDiagnosticsFactory`, when supplied, is the
  // SAME `({taskId,projectId,pmRunId,taskMode})=>TaskDiagnosticLog` factory
  // p5-production-composition.mjs already builds for real task bundles
  // (task-diagnostic-log.mjs). Optional and purely additive: a deployment
  // that omits it simply gets no preflight-failure diagnostic bundle (Telegram
  // rejection/backend-not-spawned behavior is completely unaffected either way).
  // P14-R0C: `sendTimeoutMs` (optional, default TELEGRAM_SEND_TIMEOUT_MS)
  // — injectable purely so a test can use a tiny value against a
  // deliberately-hung fake fetchImpl (matching the SAME
  // `runApiBackendRequest({timeoutMs})` pattern api-backend-adapter.mjs
  // already established) instead of a real production deployment ever
  // needing to override this.
  constructor({token,ownerUserId,ownerChatId,service,fetchImpl=fetch,projects,projectId,pmProfiles,aliasRegistry=null,maxUpdatesPerPoll=100,taskFileResolver=null,taskDiagnosticsFactory=null,sendTimeoutMs=TELEGRAM_SEND_TIMEOUT_MS}){this.token=token;this.ownerUserId=String(ownerUserId);this.ownerChatId=String(ownerChatId);this.service=service;this.fetch=fetchImpl;this.projects=normalizeProjectList({projects,projectId});this.pmProfiles=normalizePmProfileList(pmProfiles);this.aliasRegistry=aliasRegistry;this.offset=0;this.maxUpdatesPerPoll=Math.min(100,Math.max(1,maxUpdatesPerPoll));this.taskFileResolver=typeof taskFileResolver==='function'?taskFileResolver:null;this.taskDiagnosticsFactory=typeof taskDiagnosticsFactory==='function'?taskDiagnosticsFactory:null;this.sendTimeoutMs=Number.isInteger(sendTimeoutMs)&&sendTimeoutMs>0?sendTimeoutMs:TELEGRAM_SEND_TIMEOUT_MS;}
  // P11-R4.2 Part A/E/F/J: refreshes the display/routing copy of the PM
  // profile catalogue AND the alias registry this adapter consults fresh
  // on every pollOnce() (`this.pmProfiles`/`this.aliasRegistry` are plain
  // instance fields, never captured into a deeper closure) — the ONE
  // caller is p5-production-composition.mjs's reloadPmProfiles(), right
  // after it admits a newly-discovered profile into profileRegistry/
  // ownerService above. `pmProfiles` goes through the SAME
  // normalizePmProfileList() the constructor already uses, so this can
  // never diverge in shape from the constructor-time value.
  refreshRouting({pmProfiles,aliasRegistry}){if(pmProfiles!==undefined)this.pmProfiles=normalizePmProfileList(pmProfiles);if(aliasRegistry!==undefined)this.aliasRegistry=aliasRegistry;}
  async pollOnce({signal}={}){const response=await this.fetch(`https://api.telegram.org/bot${this.token}/getUpdates?timeout=25&limit=${this.maxUpdatesPerPoll}&offset=${this.offset}`,{signal});if(!response.ok)throw new Error('Telegram getUpdates failed');const body=await response.json();for(const update of (body.result??[]).slice(0,this.maxUpdatesPerPoll)){const actor=String(update.message?.from?.id??update.callback_query?.from?.id??'');const chat=String(update.message?.chat?.id??update.callback_query?.message?.chat?.id??'');if(actor!==this.ownerUserId||chat!==this.ownerChatId){this.offset=Math.max(this.offset,update.update_id+1);continue;}let binding=null;if(update.callback_query){try{binding=await this.service.resolveCallback(update.callback_query.data);}catch(error){if(!(error instanceof OwnerControlError)||error.code!=='STALE_CALLBACK')throw error;this.offset=Math.max(this.offset,update.update_id+1);await this.send(renderOwnerError(error));continue;}}let routed;try{routed=routeTelegramUpdate(update,{projects:this.projects,boundInteraction:binding,aliasRegistry:this.aliasRegistry});}catch(error){if(error?.code==='TELEGRAM_COMMAND_REFUSED'){await this.send('Unknown command.');this.offset=Math.max(this.offset,update.update_id+1);continue;}throw error;}
    if(routed){if(binding)routed.payload={response:binding.response};
      if(routed.read==='LIST_PROJECTS'){await this.send(renderProjectList(this.projects,this.aliasRegistry));}
      else if(routed.read==='PROJECT_UNKNOWN'){await this.send(renderProjectUnknown(routed.requested_project_id,this.projects));}
      else if(routed.read==='PROJECT_REQUIRED'){await this.send(renderProjectRequired(this.projects));}
      else if(routed.read==='PROJECT_TASK_TEXT_REQUIRED'){await this.send(`Task text is required after @${routed.requested_project_id}.`);}
      else if(routed.read==='FLAGS_INVALID'){await this.send(renderFlagsInvalid(routed.detail));}
      else if(routed.read==='TASK_FILE_COUNCIL_NOT_SUPPORTED'){await this.send(renderTaskFileCouncilNotSupported());}
      // P8-R0 Part M: an unresolvable alias must fail BEFORE canonical
      // acceptance, exactly like FLAGS_INVALID above — no service call, no
      // task materialized, no fallback/guessing.
      else if(routed.read==='ALIAS_STATE_UNAVAILABLE'){await this.send(renderAliasStateUnavailable());}
      else if(routed.read==='ALIAS_PROJECT_UNKNOWN'){await this.send(renderAliasProjectUnknown(routed.alias));}
      else if(routed.read==='ALIAS_PM_UNKNOWN'){await this.send(renderAliasPmUnknown(routed.alias));}
      else if(routed.read==='LIST_PM_PROFILES'){const profiles=await this.service.read('GET_PM_PROFILES',routed);await this.send(renderPmProfileList(profiles,this.aliasRegistry,{all:routed.all}));}
      else if(routed.read==='LIST_ALIASES'){const profiles=await this.service.read('GET_PM_PROFILES',routed);await this.send(renderAliasesHelp({projects:this.projects,profiles,aliasRegistry:this.aliasRegistry}));}
      // P7 Part C2: --pm/--debate validation (unknown profile, duplicate
      // participant, zero participants, ...) throws a typed, DETERMINISTIC
      // OwnerControlError from deep inside service.mutate()/service.read()
      // (always BEFORE any canonical acceptance — #validateBeforeAcceptance
      // runs first) — this must render as a human-readable Telegram message
      // (never internal JSON), and the update's offset must still advance
      // (below), or one malformed command would permanently jam the owner's
      // whole Telegram queue on a retry that can never succeed. This is
      // narrower than "any thrown error": R1-F requires a genuinely
      // TRANSIENT infrastructure failure (bare Error, no .code — e.g. "PG
      // down") to keep propagating uncaught so the offset does NOT advance
      // and the SAME update is retried — that existing crash-safety
      // guarantee is preserved by only intercepting OwnerControlError here.
      else if(routed.read){try{const result=await this.service.read(routed.read,routed);await this.send(renderOwnerRead(routed.read,result));}catch(error){if(!(error instanceof OwnerControlError))throw error;await this.send(renderOwnerError(error));}}
      else{
        // P10-R0.2.4 Part D/N: a `--task-file` dispatch is resolved HERE —
        // async I/O, strictly BEFORE `service.mutate()` (canonical
        // acceptance). On any resolution failure, a typed error is sent
        // and `service.mutate()` is never called at all — the backend is
        // NEVER spawned on a preflight failure (Part N). On success, the
        // resolved file content becomes `payload.body` (the canonical task
        // text) and `payload.task_source` carries the immutable provenance
        // (owner-task-controller.mjs stamps this onto durable
        // `pm_request.context`). The Telegram dispatch envelope itself
        // (`routed.payload.task_file`) is never treated as task text.
        let skipMutate=false;
        if(routed.operation==='SUBMIT_TASK'&&routed.payload?.task_file){
          if(!this.taskFileResolver){await this.send(renderTaskFileError({code:'TASK_FILE_FETCH_FAILED',message:'long-task dispatch is not configured on this runtime'}));skipMutate=true;}
          else{
            try{
              const resolved=await this.taskFileResolver({projectId:routed.project_id,ref:routed.payload.task_file.ref,path:routed.payload.task_file.path});
              const {task_file,...rest}=routed.payload;
              routed.payload={...rest,body:resolved.content,task_source:{type:resolved.type,requestedRef:resolved.requestedRef,resolvedCommitSha:resolved.resolvedCommitSha,path:resolved.path,contentSha256:resolved.contentSha256,contentBytes:resolved.contentBytes}};
            }catch(error){
              this.#recordDispatchFailureDiagnostics({routed,error});
              await this.send(renderTaskFileError(error));skipMutate=true;
            }
          }
        }
        if(!skipMutate){try{const result=await this.service.mutate(routed);
        // P8-R0 Part F: a shorthand-originated SUBMIT_TASK acks with BOTH
        // the alias AND the canonical identity (project/PM/backend/model/
        // reasoning) so the owner can never accidentally target the wrong
        // repo/model from a fat-fingered alias. `routed.alias` is only ever
        // set by the shorthand branches in routeTelegramUpdate above —
        // canonical `@project --pm ...` submissions are entirely unaffected.
        if(routed.alias&&routed.operation==='SUBMIT_TASK')await this.send(this.renderShorthandAck(routed,result));
        else await this.send(renderOwnerAck(routed.operation,result,routed.project_id,routed.payload?.task_source??null));
      }catch(error){if(!(error instanceof OwnerControlError))throw error;await this.send(renderOwnerError(error));}}}
    }
    this.offset=Math.max(this.offset,update.update_id+1);}return this.offset;}
  // P14-R0C: `send()` used to `await this.fetch()` with NO timeout and NO
  // abort signal at all — every `routed.read`/`routed.operation` branch in
  // pollOnce() above calls `await this.send(...)` sequentially, unguarded,
  // so a single stalled outbound Telegram request (network stall, TLS
  // hang, a dead connection Telegram's own server never closes) blocked
  // that pollOnce() call forever. OwnerRuntime#run() (owner-runtime.mjs)
  // awaits pollOnce() with no per-cycle timeout of its own, so a hung
  // send() silently, permanently wedged the ENTIRE owner Telegram loop —
  // no error, no backoff, no retry, every subsequent command (not just the
  // one being answered) stops being processed, while the rest of the
  // runtime (readiness, the local control pipe Desktop polls) stays
  // completely unaffected, since it does not depend on this loop at all.
  // TELEGRAM_SEND_TIMEOUT_MS bounds that single point of failure: on
  // timeout this throws instead of hanging forever, which is enough — the
  // EXISTING at-least-once retry/backoff already documented above (R1-F:
  // a bare, uncoded Error propagates uncaught, the update's offset does
  // not advance, OwnerRuntime#run() logs `owner_loop_failure` and retries
  // after `backoffMs`) already recovers correctly from a thrown error; it
  // just never got the chance to before, because nothing ever threw.
  async send(text){
    const chunks=chunkTelegramMessage(text);
    for(const chunk of chunks)await this.#sendChunk(chunk);
  }
  async #sendChunk(text){
    // A manual AbortController+setTimeout (never `AbortSignal.timeout()`)
    // deliberately: `setTimeout` is ref'd by default, so this timer alone
    // is guaranteed to keep the event loop alive until it fires or is
    // cleared -- a plain, predictable guarantee this file's tests rely on.
    // Checking `controller.signal.aborted` (rather than the rejection's
    // `.name`) to detect the timeout is also more robust than matching an
    // error name that varies across fetch implementations/Node versions.
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),this.sendTimeoutMs);
    let response;
    try{response=await this.fetch(`https://api.telegram.org/bot${this.token}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:this.ownerChatId,text}),signal:controller.signal});}
    catch(error){if(controller.signal.aborted)throw new Error(`Telegram sendMessage timed out after ${this.sendTimeoutMs}ms`);throw error;}
    finally{clearTimeout(timer);}
    if(!response.ok)throw new Error('Telegram sendMessage failed');
  }
  // P10-R0.2.4.2 Part D/J/K/L/M: a `--task-file` dispatch that FAILS source
  // resolution never reaches owner-task-controller.mjs (no `task-<hash>` id
  // is ever allocated for it — Part I's root finding), so the owner's
  // "newest task diagnostics folder" evidence never saw it. This writes a
  // bounded, truthfully-labeled bundle under a DISTINCT `dispatch-<hash>`
  // id (never collides with a real task id, same deterministic-hash
  // family as owner-task-controller.mjs's `task-<hash>`) so the SAME
  // `logs/tasks/` "pick the newest folder" evidence convention just works.
  // Best-effort only (TaskDiagnosticLog itself never throws — Part P of its
  // own contract); a missing/throwing factory changes no Telegram-visible
  // behavior at all.
  #recordDispatchFailureDiagnostics({routed,error}){
    if(!this.taskDiagnosticsFactory)return;
    try{
      const dispatchId=deterministicOwnerId('dispatch',routed.command_id);
      const taskLog=this.taskDiagnosticsFactory({taskId:dispatchId,projectId:routed.project_id,pmRunId:null,taskMode:'SINGLE'});
      if(!taskLog)return;
      const requestedRef=routed.payload?.task_file?.ref??error?.ref??null;
      const path=routed.payload?.task_file?.path??error?.path??null;
      const requestedPmProfileId=routed.payload?.pm_profile_id??null;
      const errorCode=error?.code??'TASK_FILE_READ_FAILED';
      const createdAt=new Date().toISOString();
      taskLog.event(TASK_LOG_EVENT_TYPES.TASK_DISPATCH_RECEIVED,{command_id:routed.command_id,client_kind:routed.client_kind??null,project_id:routed.project_id,requested_pm_profile_id:requestedPmProfileId,runtime_class:'LONG',task_source_type:'GIT_FILE',requested_ref:requestedRef,path});
      taskLog.event(TASK_LOG_EVENT_TYPES.TASK_SOURCE_RESOLUTION_FAILED,{error_code:errorCode,requested_ref:requestedRef,path,backend_started:false});
      taskLog.finalizeSummary(buildDispatchFailureSummaryMarkdown({dispatchId,projectId:routed.project_id,submittedVia:routed.client_kind??'UNKNOWN',commandId:routed.command_id,requestedPmProfileId,requestedRef,path,errorCode,errorMessage:error?.message??null,createdAt}));
    }catch{ /* Part P: diagnostics must never affect the real Telegram rejection flow */ }
  }
  renderShorthandAck(routed,result){
    const project=this.projects.find((p)=>p.id===routed.project_id)??{id:routed.project_id};
    const chairId=routed.payload.pm_profile_id;
    const pmProfile=this.pmProfiles.find((p)=>p.id===chairId)??{id:chairId};
    void result; // canonical_result carries only ids already reflected above; the ack shows the SUBMITTED task body, not a re-fetch.
    return renderShorthandTaskAck({project,projectAlias:routed.alias.project,pmProfile,pmAlias:routed.alias.pm,taskBody:routed.payload.body,taskSource:routed.payload.task_source??null,council:routed.payload.council?{participantAliases:routed.alias.participants,participantProfileIds:routed.payload.council.participant_profile_ids}:null});
  }
}
// P8-R0 Part I: an optional `aliasRegistry` decorates each row with its
// stable alias when one is configured (`3 — example-project (...)`) —
// purely a display enhancement; the underlying project id/list is
// unaffected, so this stays byte-for-byte the pre-P8 rendering when no
// aliasRegistry is supplied (every existing call site/test).
export function renderProjectList(projects,aliasRegistry=null){if(!projects.length)return 'No projects are registered.';return `Registered projects:\n${projects.map((p)=>{const alias=aliasRegistry?.projectAliasFor?.(p.id);return `${alias?`${alias} — `:'- '}${p.id}${p.display_name&&p.display_name!==p.id?` (${p.display_name})`:''}`;}).join('\n')}`;}
export function renderProjectUnknown(requested,projects){return `Unknown project "${String(requested).slice(0,128)}".\n${renderProjectList(projects)}\n\nUse @<project_id> <task text>.`;}
export function renderProjectRequired(projects){return `More than one project is registered; a bare task requires a project.\n${renderProjectList(projects)}\n\nUse @<project_id> <task text>, e.g. @${projects[0]?.id??'project'} fix the reconciliation report.`;}
// P7 Part C2: a rejected --pm/--debate command must read as plain English,
// never as internal command JSON.
export function renderFlagsInvalid(detail){return `❌ Command rejected: ${String(detail ?? 'malformed command').slice(0,300)}`;}
// P10-R0.2.4 Part C: council long-task dispatch is explicitly deferred —
// never silently accepted as literal task text.
export function renderTaskFileCouncilNotSupported(){return '❌ LONG COUNCIL dispatch (--task-file for /c) is not supported yet — use a SINGLE dispatch, e.g. <projectAlias>-<pmAlias> --task-file <ref> <path>.';}
// P10-R0.2.4 Part O/N: a typed TaskSourceError (task-source-resolver.mjs)
// rendered as plain, bounded English — never internal JSON, never a raw
// git stderr dump. `error.path`/`error.ref` are already validated,
// bounded, sanitized strings (or null) by the time they reach here.
export function renderTaskFileError(error){
  const code=error?.code??'TASK_FILE_READ_FAILED';
  const detail=[error?.ref?`ref=${String(error.ref).slice(0,128)}`:null,error?.path?`path=${String(error.path).slice(0,256)}`:null].filter(Boolean).join(' ');
  return `❌ Long-task file could not be resolved (${code})${detail?`\n${detail}`:''}\n\nThe backend was NOT started.`;
}

// P10-R0.2.4.1 Part B-I: bounded, owner-visible LONG-task runtime/
// liveness Telegram notifications. Every function here renders exactly
// ONE `src/runtime/telegram-long-task-notifier.mjs` event into plain,
// bounded text — never internal JSON, never a raw event dump. Wording
// deliberately never says "hung"/"failed"/"frozen" for STALLED (Part E —
// that state means only "no trustworthy activity observed", the process
// may still be alive and DSH has not terminated it), and HARD_DEADLINE is
// always worded as the 30-minute ceiling, never as a stall (Part G).
function formatDurationMs(ms){
  if(!Number.isFinite(ms)||ms<0)return'unknown duration';
  const totalSeconds=Math.round(ms/1000);
  const m=Math.floor(totalSeconds/60);
  const s=totalSeconds%60;
  return m>0?`${m}m ${s}s`:`${s}s`;
}
function longTaskHeader(event){
  return [`Task: ${String(event.taskId??'unknown').slice(0,64)}`,event.profileId?`PM: ${String(event.profileId).slice(0,128)}`:null,event.product?`Backend: ${String(event.product).slice(0,64)}`:null].filter(Boolean).join('\n');
}
export function renderLongTaskStarted(event){
  return`▶ LONG TASK STARTED\n\n${longTaskHeader(event)}\n\nRuntime: LONG\nHard deadline: ${Math.round(LONG_TASK_HARD_DEADLINE_MS/60000)} min\nLiveness: ACTIVE`;
}
export function renderLongTaskStalled(event){
  return`⚠ LONG TASK STALLED\n\n${longTaskHeader(event)}\n\nNo backend activity has been observed for approximately ${formatDurationMs(event.lastActivityAgeMs)}.\n\nProcess is still running.\n\nDSH has NOT terminated the task.\n\nHard deadline remains active.`;
}
export function renderLongTaskActiveRecovered(event){
  return`▶ LONG TASK ACTIVE AGAIN\n\n${longTaskHeader(event)}\n\nBackend activity resumed after a quiet period. Hard deadline was not reset.`;
}
export function renderLongTaskHardDeadline(event){
  return`⏱ LONG TASK HARD DEADLINE REACHED\n\n${longTaskHeader(event)}\n\nThe 30-minute hard deadline was reached.\nBackend termination requested.\nNo automatic retry.\nNo partial-result success.`;
}
// P10-R0.2.4.1: the one dispatcher composition root wires as `notify` for
// withTelegramLongTaskNotifications() — an unrecognized/future event type
// is silently ignored rather than throwing (defense in depth; the
// notifier module's own allowlist already only ever emits these four).
export function renderLongTaskNotification(event){
  switch(event?.type){
    case'LONG_TASK_STARTED':return renderLongTaskStarted(event);
    case'LONG_TASK_STALLED':return renderLongTaskStalled(event);
    case'LONG_TASK_ACTIVE_RECOVERED':return renderLongTaskActiveRecovered(event);
    case'LONG_TASK_HARD_DEADLINE':return renderLongTaskHardDeadline(event);
    default:return null;
  }
}
export function renderOwnerError(error){const message=typeof error?.message==='string'&&error.message?error.message:'the command could not be completed';return `❌ ${String(message).slice(0,500)}`;}
// P8-R0 Part M: unknown alias fails BEFORE canonical acceptance — no
// fallback, no guessing, no array-position lookup.
export function renderAliasProjectUnknown(alias){return `❌ Unknown project alias: ${String(alias).slice(0,8)}\n\nUse /projects or /aliases.`;}
export function renderAliasPmUnknown(alias){return `❌ Unknown PM alias: ${String(alias).slice(0,8)}\n\nUse /profiles or /aliases.`;}
// P8-R0.1 Part "FAILURE POLICY": alias state itself is unavailable (never
// reconciled, or reconciliation failed) — shorthand/`/aliases` refuse
// safely, but canonical Telegram (`@<project_id> --pm <profile_id>`) is
// completely unaffected (routeTelegramUpdate's `@mention` branch never
// consults aliasRegistry at all). Never echoes the internal reason/path —
// same "no internal error surfaces to Telegram" discipline as every other
// refusal in this file.
export function renderAliasStateUnavailable(){return '❌ Aliases are temporarily unavailable.\n\nUse the canonical @<project_id> --pm <profile_id> syntax, or /projects and /profiles for the canonical ids.';}
// P8-R0 Part I: `/pms` and `/profiles` — safe fields only (id/product/model/
// reasoning; `profiles` is already OwnerControlService's GET_PM_PROFILES
// read, which strips `secret` — and pm-profile-registry.mjs never even
// carries auth material to begin with).
// P8-R0.2 Part B/J: a PM profile's canonical id is a stable EXECUTION
// IDENTITY (product+model+reasoning), never a mutable label — so its
// display must never collapse to just model/reasoning (Part I's reported
// bug: "1 = sonnet / high" hides which profile that even is). Nor may a
// null `model` (Codex: model is legitimately unset/CLI-inherited) ever be
// silently dropped — that produced the exact same ambiguity (a bare
// reasoning value with nothing next to it reads as if it WERE the whole
// identity). `null` is displayed honestly as "default/inherited", never
// fabricated as a discovered CLI default.
// P9-R0.4 Part A/B: thin wrappers around the ONE canonical helper —
// `formatPmExecutionLabeled` keeps `/profiles`'s existing multi-line shape
// (canonical id as the primary line, the label indented underneath),
// `formatPmExecutionCompact` keeps `/aliases`'s denser one-line-under-the-
// alias shape. Neither invents its own product/model/reasoning string.
function formatPmExecutionLabeled(profile){return `    ${formatPmProfileLabel(profile)}`;}
function formatPmExecutionCompact(profile){return formatPmProfileCompact(profile);}
// Part P: `/profiles` (and its `/pms` synonym) shows ACTIVE profiles only
// by default — `all:true` (routed from `/profiles all`) shows every
// profile, each marked `[INACTIVE]` when deactivated. Never hides an
// inactive profile from `all` and never mixes one silently into the
// default (active-only) listing.
// P9-R0.4.2 Part G: `profiles` here is already lifecycle-FRESH — every
// entry's `status` was just re-resolved at request time by
// OwnerControlService#read('GET_PM_PROFILES') (see owner-control-
// service.mjs), reusing the same PmProfileStatusStore the SUBMIT_TASK gate
// does. `statusStale` (set on every entry together, never per-entry) means
// that fresh re-read itself failed and every `status` value shown is the
// frozen, possibly-outdated snapshot instead — surfaced as an explicit
// diagnostic line rather than silently presenting it as current truth.
function staleStatusNote(profiles){return profiles.some((p)=>p.statusStale)?'\n\n⚠ live lifecycle status could not be confirmed — statuses below may be out of date.':'';}
export function renderPmProfileList(profiles,aliasRegistry=null,{all=false}={}){
  const visible=all?profiles:profiles.filter((p)=>p.status!=='INACTIVE');
  const note=staleStatusNote(profiles);
  if(!visible.length)return (profiles.length?'No ACTIVE PM profiles are registered.\n\nUse /profiles all to see inactive profiles too.':'No PM profiles are registered.')+note;
  const rows=visible.map((p)=>{const alias=aliasRegistry?.pmAliasFor?.(p.id);const inactive=p.status==='INACTIVE'?' [INACTIVE]':'';return `${alias?`${alias} — `:'- '}${p.id}${inactive}\n${formatPmExecutionLabeled(p)}`;});
  const hiddenCount=all?0:profiles.length-visible.length;
  const hint=hiddenCount>0?`\n\n${hiddenCount} inactive profile${hiddenCount===1?'':'s'} hidden — use /profiles all to see them.`:'';
  return `PM profiles:\n\n${rows.join('\n\n')}${hint}${note}`;
}
// P8-R0 Part J: `/aliases` — a compact cheat sheet mapping every configured
// alias to its display name, plus one worked single-task example built from
// the FIRST project/PM alias actually configured (deterministic: lowest
// alias token wins), so the example is always resolvable if any aliases
// exist at all.
// P9-R0.4 Part P: `/aliases` always lists EVERY reserved alias, active or
// inactive — an alias is never dropped from this listing just because its
// profile was deactivated (the alias itself stays reserved forever, Part
// E/I) — an inactive one is simply marked `[INACTIVE]`.
export function renderAliasesHelp({projects,profiles,aliasRegistry}){
  if(aliasRegistry&&aliasRegistry.available===false)return renderAliasStateUnavailable();
  const projectAliases=aliasRegistry?.listProjectAliases?.()??[];
  const pmAliases=aliasRegistry?.listPmAliases?.()??[];
  if(!projectAliases.length&&!pmAliases.length)return 'No aliases are configured yet.\n\nUse the canonical @<project_id> --pm <profile_id> syntax, or ask an owner to configure telegram_aliases.';
  const projectLines=projectAliases.map(({alias,project_id})=>{const p=projects.find((v)=>v.id===project_id);return `${alias} = ${p?.display_name??project_id}`;});
  // Part I: canonical pm_profile_id is always the primary line — the
  // execution config (product | model | reasoning) is secondary detail
  // underneath it, never a replacement for the id.
  const pmLines=pmAliases.map(({alias,pm_profile_id})=>{const p=profiles.find((v)=>v.id===pm_profile_id);const inactive=p?.status==='INACTIVE'?' [INACTIVE]':'';return `${alias} = ${pm_profile_id}${inactive}\n    ${p?formatPmExecutionCompact(p):'(profile details unavailable)'}`;});
  const sortedProjects=[...projectAliases].sort((a,b)=>a.alias.localeCompare(b.alias,undefined,{numeric:true}));
  const sortedPms=[...pmAliases].sort((a,b)=>a.alias.localeCompare(b.alias,undefined,{numeric:true}));
  const example=sortedProjects[0]&&sortedPms[0]?`\n\nUsage:\n\n${sortedProjects[0].alias}-${sortedPms[0].alias} inspect repository architecture\n\nCanonical equivalent:\n\n@${sortedProjects[0].project_id} --pm ${sortedPms[0].pm_profile_id} inspect repository architecture`:'';
  // P19-D6 (D6-C): Debate discoverability. Council/Debate dispatches are
  // canonical-form only (alias shorthand is SINGLE-only — see
  // routeTelegramUpdate()'s own "--pm/--debate are not valid in alias
  // shorthand" guard), so these examples always use `@<project_id> --pm
  // <chair>`, never an alias. Built from the SAME deterministic
  // lowest-alias-wins profile selection as `example` above, so it is only
  // ever shown when it is actually resolvable; omitted entirely (not a
  // broken partial example) when fewer than two PM profiles are
  // registered — a Debate council needs a chair plus at least one
  // participant.
  const debateExamples=sortedProjects[0]&&sortedPms.length>=2?(()=>{
    const projectId=sortedProjects[0].project_id;
    const chair=sortedPms[0].pm_profile_id;
    const p1=sortedPms[1].pm_profile_id;
    const p2=sortedPms[2]?.pm_profile_id??null;
    const participants=p2?`${p1},${p2}`:p1;
    return `\n\nDebate examples (canonical form only — see note below):\n\n`
      +`Analysis-only Council:\n@${projectId} --pm ${chair} --debate ${participants} review the current architecture\n\n`
      +`Council + Debate:\n@${projectId} --pm ${chair} --debate ${participants} --debate-extend --debate-rounds 2 review the current architecture\n\n`
      +`Council + Debate + implementation participant:\n@${projectId} --pm ${chair} --debate ${participants} --debate-extend --implementation ${p1} fix the failing test\n\n`
      +`Council requiring independent repository inspection (WORKSPACE_READ):\n@${projectId} --pm ${chair} --debate ${participants} --workspace-read audit the repository for X\n\n`
      +`Council with an explicit, owner-authored evidence manifest (deep-file audit):\n@${projectId} --pm ${chair} --debate ${participants} --workspace-read --workspace-evidence src/owner/telegram-owner-client.mjs,src/pm/council/council-chair-driver.mjs audit these files\n\n`
      +`Durable local + commit (materializes Council/Debate history to docs/history/ and commits it on the task branch — never on your current branch; --commit alone with no --durability stays DIRECT and materializes nothing):\n@${projectId} --pm ${chair} --debate ${participants} --debate-extend --durability local --commit fix the failing test\n\n`
      +`Explicit no-push (same as above, but under Durable Remote — the commit is still made and materialized, and nothing is ever pushed unless --push is also given):\n@${projectId} --pm ${chair} --debate ${participants} --debate-extend --durability remote --commit fix the failing test\n\n`
      +`Note: "--debate <participants>" selects Council members (since P7) — it always means Council, with or without the extension below. "--debate-extend" turns on the separate P19 Debate extension: after the Council Report, participants challenge/respond to a shared chair brief for up to 2 rounds. "--implementation <profile_id>" names the ONE participant (must already be in --debate) authorized to edit the repository during its own Council report turn; every other participant, and every Debate round, stays analysis-only. "--workspace-read" requires every participant to independently inspect the project repository (via a DSH-supplied bounded evidence packet — every backend, native CLI included, is routed through this for secret-isolation reasons) and cite repository evidence in its report/response — omit it for a normal analysis-only Council/Debate (the default, unchanged). "--workspace-evidence <path1,path2,...>" (requires --workspace-read) names an explicit, bounded set of repo-relative source files the evidence packet must contain and evidence must cite — use it for a deep-file audit the generic top-of-repo anchors would miss; never inferred from task text.`;
  })():'';
  return `Projects\n${projectLines.join('\n')||'(none configured)'}\n\nPM profiles\n${pmLines.join('\n\n')||'(none configured)'}${example}${debateExamples}${staleStatusNote(profiles)}`;
}
export class OwnerInteractionNotifier {
  constructor({repository,send}){if(!repository||typeof send!=='function')throw new TypeError('notifier dependencies required');this.repository=repository;this.send=send;}
  async flush({limit=20}={}){const claimed=await this.repository.claimNotifications({limit,terminal:false});let sent=0;for(const item of claimed){try{await this.send(renderInteraction(item));await this.repository.markNotified(item.interaction_id);sent+=1;}catch{/* At-least-once: lease expiry makes canonical interaction retryable. */}}return {claimed:claimed.length,sent};}
}
export class OwnerTerminalResultNotifier {
  constructor({repository,pmRepository,send,log=defaultNotifierLog}){if(!repository||!pmRepository||typeof send!=='function')throw new TypeError('terminal notifier dependencies required');this.repository=repository;this.pmRepository=pmRepository;this.send=send;this.log=log;}
  async flush({limit=20}={}){
    let materialized=0;let conflicted=0;
    for(const run of this.pmRepository.listTerminalRuns({limit})){
      const command=await this.repository.findMaterializedCommandByPmRunId(run.id);if(!command)continue;
      // P7 Part P: `data` (run.data — a plain FINISH.data object, e.g. this
      // council's {type:'council',...} summary) is additive; every existing
      // single-PM terminal result carries `data:null` exactly as before.
      const rawFacts={notification_kind:'TERMINAL_PM_RESULT',task_id:command.canonical_result?.task_id??null,pm_run_id:run.id,project_id:command.project_id??null,status:run.status,pm_profile_id:run.pmProfileId,driver:run.driver,output:run.output,error:run.error,data:run.data};
      const sanitized=sanitizeOperatorOutput(rawFacts);
      // P7-R0.3 Part J/I: sanitizeOperatorOutput()'s generic MAX_STRING=512
      // cap (correct and unchanged for every OTHER field/use in this
      // codebase — never weakened) was silently clipping a real council
      // chair synthesis (observed: 5,517 bytes) down to 512 chars with no
      // marker, long before renderTerminalResult()'s own deliberate,
      // explicit up-to-3500-char truncation-with-marker ever got a chance to
      // matter. `output` is re-bounded here at a purpose-specific, larger
      // limit — but ONLY when the generic sanitizer did NOT already flag the
      // full raw string as sensitive ('[REDACTED]' from sanitizeOperatorOutput
      // always wins; redaction is never bypassed). Not council-specific — a
      // long single-PM result gets the exact same benefit.
      const facts=sanitized.output==='[REDACTED]'?sanitized:Object.freeze({...sanitized,output:truncateTerminalOutput(run.output)});
      // P7-R0.3 (M03): createInteraction() enforces strict semantic-equality
      // on a repeat call for the same deterministic id (by design, elsewhere
      // in this codebase, to catch two DIFFERENT logical events colliding on
      // one id — a real safety property this call site must never weaken).
      // But THIS call site recomputes `facts` from scratch on every single
      // flush() cycle, for every still-terminal run within `limit` — INCLUDING
      // runs whose interaction was already durably created (and possibly
      // already notified) in a past process/code version. If the shape of
      // sanitizeOperatorOutput()'s output legitimately changes across a
      // deploy (a real, confirmed root cause here — see
      // docs/p7/04_P7_MANUAL_ACCEPTANCE.md's P7-M03), the freshly-recomputed
      // `facts` for an OLD already-materialized run stops matching what was
      // durably stored, createInteraction() throws OWNER_INTERACTION_CONFLICT
      // — and, uncaught here, that used to abort this ENTIRE for-loop, so
      // claimNotifications() below was NEVER reached again, for ANY run, for
      // as long as that one old row stayed within the `limit` window. A
      // terminal interaction id is derived one-to-one from the immutable
      // pm_run.id, so a real different-content collision on this specific id
      // family cannot happen — every OWNER_INTERACTION_CONFLICT reachable
      // here is exactly this "recomputation shape drifted" case, safe to
      // skip. Any other error is also skipped (never let one run's
      // materialization failure block every other run's delivery), but
      // logged distinctly for visibility (Part C/K).
      try{
        await this.repository.createInteraction({interaction_id:deterministicOwnerId('terminal',run.id),project_id:command.project_id,task_id:command.canonical_result?.task_id??null,pm_run_id:run.id,pm_turn_index:null,origin:'SYSTEM',kind:'INFO',status:'CLOSED',title:`DSH task ${run.status}`,prompt_text:'Durable PM terminal result',allowed_responses:[],runtime_facts:facts,response_bindings:{},requires_response:false,local_only:true});
        materialized+=1;
        this.log({stage:'terminal_materialized',pmRunId:run.id,taskId:command.canonical_result?.task_id??null,projectId:command.project_id??null,status:run.status});
      }catch(error){
        if(error?.code==='OWNER_INTERACTION_CONFLICT')conflicted+=1;
        this.log({stage:'terminal_materialize_failed',pmRunId:run.id,taskId:command.canonical_result?.task_id??null,projectId:command.project_id??null,status:run.status,error:error?.code??error?.message??'MATERIALIZE_ERROR'});
      }
    }
    const claimed=await this.repository.claimNotifications({limit,terminal:true});let sent=0;
    for(const item of claimed){
      this.log({stage:'terminal_claimed',pmRunId:item.pm_run_id??null,taskId:item.task_id??null,projectId:item.project_id??null,notificationId:item.interaction_id,attempt:item.notification_attempts??null});
      try{
        const text=renderTerminalResult(item);
        this.log({stage:'terminal_rendered',notificationId:item.interaction_id,messageBytes:Buffer.byteLength(text,'utf8')});
        await this.send(text);
        this.log({stage:'telegram_send_success',notificationId:item.interaction_id,messageBytes:Buffer.byteLength(text,'utf8')});
        await this.repository.markNotified(item.interaction_id);
        this.log({stage:'terminal_marked_notified',notificationId:item.interaction_id});
        sent+=1;
      }catch(error){
        // At-least-once: an expired durable lease makes delivery retryable —
        // never mark notified on a failed/partial send.
        this.log({stage:'telegram_send_failed',notificationId:item.interaction_id,error:error?.code??error?.message??'SEND_ERROR'});
      }
    }
    return {materialized,conflicted,claimed:claimed.length,sent};
  }
}
// P12-R4: `origin:'SYSTEM'` (e.g. the new "ready for PM review" interaction
// — production-pm-worker.mjs) is DSH-authored text, never model prose —
// the "[UNTRUSTED PM PROSE]" label is specifically about `origin:'PM'`
// (an await_owner decision's title/prompt_text, which genuinely IS
// model-authored and must never be presented as trusted). Every existing
// PM-origin interaction keeps the exact same label/behavior.
export function renderInteraction(item){const safe=sanitizeOperatorOutput(item.runtime_facts??{});const facts=Object.entries(safe).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}: ${typeof v==='string'?v:JSON.stringify(v)}`).join('\n');const label=item.origin==='SYSTEM'?'[DSH SYSTEM]':'[UNTRUSTED PM PROSE]';return `${facts}${facts?'\n\n':''}${label}\n${String(item.title).slice(0,256)}\n${String(item.prompt_text).slice(0,2000)}`;}
// P12-R2: `dsh_outcome` (src/pm/task-outcome-model.mjs's buildTaskOutcome(),
// durably persisted onto pm_runs.data by
// src/persistence/repositories/pm-repository.mjs's recordTaskOutcome()) is
// rendered ONLY when there is something genuinely noteworthy — a
// persistence warning, a degraded council, or any git-sync activity at
// all. A plain DIRECT task with nothing requested stays byte-for-byte the
// same clean message it always was (P12 principle: DIRECT tasks are never
// made noisier by this). Never dumps the raw outcome object — every line
// is hand-picked and bounded, same M05 discipline as every other renderer
// in this file.
function renderOutcomeSuffix(dshOutcome){
  if(!dshOutcome||typeof dshOutcome!=='object')return '';
  const noteworthy=dshOutcome.persistence_warning===true||dshOutcome.degraded===true
    ||(dshOutcome.local_git_status&&dshOutcome.local_git_status!=='NOT_REQUESTED')
    ||(dshOutcome.remote_sync_status&&dshOutcome.remote_sync_status!=='NOT_REQUESTED');
  if(!noteworthy)return '';
  const lines=[`\n\nOutcome: ${String(dshOutcome.terminal_marker??'UNKNOWN').slice(0,64)}`];
  if(dshOutcome.local_git_status&&dshOutcome.local_git_status!=='NOT_REQUESTED')lines.push(`Local git: ${String(dshOutcome.local_git_status).slice(0,64)}`);
  if(dshOutcome.remote_sync_status&&dshOutcome.remote_sync_status!=='NOT_REQUESTED')lines.push(`Remote sync: ${String(dshOutcome.remote_sync_status).slice(0,64)}`);
  return lines.join('\n');
}
export function renderTerminalResult(item){
  const sanitized=sanitizeOperatorOutput(item.runtime_facts??{});
  // P7-R0.3 Part I/J: this function independently re-sanitizes
  // item.runtime_facts (the SAME MAX_STRING=512 generic cap
  // OwnerTerminalResultNotifier.flush() already had to re-bound `output`
  // past once) — so the exact same re-bounding is required here too, or a
  // long real result would still arrive clipped to 512 chars regardless of
  // what got durably stored. Never bypasses genuine redaction: only widens
  // `output` when the sanitizer did NOT flag it as sensitive.
  const facts=sanitized.output==='[REDACTED]'?sanitized:{...sanitized,output:truncateTerminalOutput(item.runtime_facts?.output)};
  const status=String(facts.status??'failed').toLowerCase();
  // P7 Part P: a council's terminal result is a DIFFERENT, richer format —
  // still built only from hand-picked/bounded facts, same as the single-PM
  // format below.
  // P19-D6 (D6-D): a debate-concluded run's finish data is `type:
  // 'council_debate'` (council-chair-driver.mjs's #debateDecide(), D1), not
  // `'council'` — before this fix, that type mismatch meant a Debate task's
  // terminal Telegram message silently fell through to the generic
  // single-PM format below, losing chair/participants/rounds entirely. Both
  // types are recognized here now; `isDebate` only ever adds detail, never
  // removes any pre-existing Council field.
  if(facts.data&&typeof facts.data==='object'&&(facts.data.type==='council'||facts.data.type==='council_debate')&&status==='completed'){
    const isDebate=facts.data.type==='council_debate';
    const project=facts.project_id?`\nProject: ${String(facts.project_id).slice(0,128)}`:'';
    const chair=String(facts.data.chair_profile_id??facts.pm_profile_id??'unknown').slice(0,128);
    const participants=Array.isArray(facts.data.participant_profile_ids)?facts.data.participant_profile_ids.slice(0,8).map((v)=>String(v).slice(0,128)):[];
    const rounds=Number.isInteger(facts.data.rounds)?facts.data.rounds:'unknown';
    const body=String(facts.output??'');
    const outcomeSuffix=renderOutcomeSuffix(facts.data.dsh_outcome);
    // P19-D6: never implies a code implementation occurred merely because
    // the task reached TASK_COMPLETED (D6-D's own stated concern) — this
    // states the Debate round count and, separately, whether an
    // implementation participant was ever authorized; it never claims edits
    // actually happened (that remains the git-sync/materialization lines in
    // outcomeSuffix, unchanged).
    const debateSuffix=isDebate?`\nDebate rounds run: ${Number.isInteger(facts.data.debate?.rounds_run)?facts.data.debate.rounds_run:'unknown'}${facts.data.debate?.engine_forced_stop?' (engine forced stop at max rounds)':''}${Array.isArray(facts.data.debate?.unresolved_questions)&&facts.data.debate.unresolved_questions.length>0?`\nUnresolved questions: ${facts.data.debate.unresolved_questions.length}`:''}`:'';
    // P18-W5 multimode correlation rendering: the FINAL Council/Debate
    // terminal previously carried no machine-readable task identity at all
    // (renderTerminalResult's fallback single-PM shape below already had
    // one; this branch never did) even though `item.task_id` (this
    // function's own caller, OwnerTerminalResultNotifier.flush()) already
    // threads the durable task_id through unconditionally, Council/Debate
    // included. Rendered only when present (never fabricated) and placed
    // on the Rounds: line's own trailing suffix so the existing
    // Chair/Council/Rounds/Result presentation stays otherwise unchanged.
    const taskIdSuffix=typeof facts.task_id==='string'&&facts.task_id?`\nTask: ${String(facts.task_id).slice(0,48)}`:'';
    if(facts.data.degraded){
      const failed=Array.isArray(facts.data.failed_participants)?facts.data.failed_participants.slice(0,8).map((v)=>String(v).slice(0,128)):[];
      const completed=Array.isArray(facts.data.completed_participants)?facts.data.completed_participants.slice(0,8).map((v)=>String(v).slice(0,128)):[];
      const text=`⚠️ Council${isDebate?'/Debate':''} completed with degraded participation${project}\nChair: ${chair}\nRounds: ${rounds}${debateSuffix}${taskIdSuffix}\n\nFailed:\n${failed.join('\n')}\n\nCompleted:\n${completed.join('\n')}\n\nResult:\n${body}${outcomeSuffix}`;
      return text.length<=3500?text:`${text.slice(0,3488)}\n[TRUNCATED]`;
    }
    const text=`✅ DSH council${isDebate?'/debate':''} completed${project}\nChair: ${chair}\nCouncil: ${participants.join(', ')}\nRounds: ${rounds}${debateSuffix}${taskIdSuffix}\n\nResult:\n${body}${outcomeSuffix}`;
    return text.length<=3500?text:`${text.slice(0,3488)}\n[TRUNCATED]`;
  }
  const icon=status==='completed'?'✅':status==='cancelled'?'⚪':'❌',task=String(facts.task_id??'unknown').slice(0,48),profile=String(facts.pm_profile_id??facts.driver??'unknown').slice(0,128),body=status==='completed'?String(facts.output??''):String(facts.error?.message??facts.error??facts.output??'No error detail available');
  const outcomeSuffix=status==='completed'&&facts.data&&typeof facts.data==='object'?renderOutcomeSuffix(facts.data.dsh_outcome):'';
  const text=`${icon} DSH task ${status}\n\nTask: ${task}\nPM: ${profile}\nStatus: ${status}\n\nResult:\n${body}${outcomeSuffix}`;return text.length<=3500?text:`${text.slice(0,3488)}\n[TRUNCATED]`;
}
export function renderOwnerRead(operation,value){const safe=sanitizeOperatorOutput(value);const text=JSON.stringify({operation,data:safe},null,2);return text.length<=3500?text:`${text.slice(0,3488)}\n[TRUNCATED]`;}
// M05: the owner ACK for a mutation is a small, hand-picked presentation
// DTO — it NEVER serializes the raw owner_command row (command_id,
// actor_id, client_kind, payload, payload_digest, revision, or the bare
// canonical_result object). Every user-facing field below is copied
// individually, bounded, and only from the operation-specific fields
// that field is documented to carry.
export function renderOwnerAck(operation,result,projectId,taskSource=null){
  const canonical=result?.canonical_result??{};
  const project=projectId?`\nProject: ${String(projectId).slice(0,128)}`:'';
  const taskId=typeof canonical.task_id==='string'?String(canonical.task_id).slice(0,64):null;
  const pmProfileId=typeof canonical.pm_profile_id==='string'?String(canonical.pm_profile_id).slice(0,128):null;
  if(operation==='SUBMIT_TASK'){
    // P18-W5 multimode correlation rendering: read once, shared by both the
    // Council/Debate branch below and the SINGLE branch further down — same
    // durable canonical_result field either way (owner-task-controller.mjs
    // sets client_correlation_id unconditionally, Council/Debate included),
    // never from any model output.
    const clientCorrelationId=typeof canonical.client_correlation_id==='string'?String(canonical.client_correlation_id).slice(0,128):null;
    const correlationLine=clientCorrelationId?`\nCorrelation: ${clientCorrelationId}`:'';
    // P7 Part O: a council acceptance ack is a DIFFERENT, richer shape —
    // still hand-picked/bounded per M05, never the raw canonical object.
    const council=canonical.council&&typeof canonical.council==='object'?canonical.council:null;
    if(council){
      const participants=Array.isArray(council.participant_profile_ids)?council.participant_profile_ids.slice(0,8).map((v)=>String(v).slice(0,128)):[];
      const rounds=Number.isInteger(council.rounds)?council.rounds:null;
      // P19-D6 (D6-A/B): the acceptance ack is the owner's FIRST look at
      // what they just dispatched — it must distinguish analysis-only
      // Council from Council+Debate from Council+Debate+implementation
      // right here, not only much later in the terminal result. Both
      // fields are read straight off the same normalized CouncilSpec
      // already accepted server-side; nothing is re-derived or guessed.
      const debateLine=council.debate?.enabled?`\n\nDebate:\nenabled, max ${Number.isInteger(council.debate.max_rounds)?council.debate.max_rounds:2} round(s)`:'';
      const implementationLine=typeof council.implementation_participant_id==='string'&&council.implementation_participant_id?`\n\nImplementation participant:\n${String(council.implementation_participant_id).slice(0,128)}`:'';
      // P18-W5 multimode correlation rendering: a Council/Debate acceptance
      // previously carried no machine-readable Task:/Correlation: identity
      // at all (a relay-parseable authoritative anchor existed only for the
      // SINGLE branch below) even though canonical.task_id/
      // client_correlation_id are already present here — same durable
      // fields, unconditionally set by owner-task-controller.mjs regardless
      // of council. Appended as its own trailing block so the existing
      // human-readable Chair/Participants/Rounds/Debate/Implementation
      // presentation stays byte-for-byte unchanged; Task is included
      // whenever the durable task_id is present (always, for a real
      // acceptance) and Correlation only when the caller actually supplied
      // --client-correlation, mirroring the SINGLE branch's own rule below.
      const identityLine=taskId?`\n\nTask: ${taskId}${correlationLine}`:'';
      return `✅ DSH council accepted${project}\n\nChair:\n${pmProfileId??'unknown'}\n\nParticipants:\n${participants.join('\n')}\n\nRounds:\n${rounds??'unknown'}${debateLine}${implementationLine}${identityLine}`;
    }
    // P10-R0.2.4 Part AC: same hard-deadline visibility as the shorthand ack.
    const taskSourceSuffix=taskSource?renderTaskSourceLines(taskSource).join('\n'):'';
    // P18-W4 Part B (ACK-causal-correlation remediation): echoed ONLY when
    // the owner/caller explicitly supplied `--client-correlation` — an
    // ordinary dispatch's ack shape is byte-for-byte unaffected. Read
    // straight off the durable canonical_result (owner-task-controller.mjs
    // Part B), never from any model output.
    if(taskId)return `✅ DSH task accepted${project}\nTask: ${taskId}${pmProfileId?`\nPM: ${pmProfileId}`:''}${correlationLine}${taskSourceSuffix}`;
    return `✅ DSH task accepted${project}\nCommand accepted and queued.${correlationLine}${taskSourceSuffix}`;
  }
  if(operation==='REQUEST_CANCEL'){
    const cancellation=typeof canonical.cancellation==='string'?String(canonical.cancellation).slice(0,64):'requested';
    return `⏳ Cancellation requested${project}${taskId?`\nTask: ${taskId}`:''}\nStatus: ${cancellation}\nWaiting for the runtime to confirm the outcome.`;
  }
  if(operation==='DECIDE_INTERACTION')return `✅ Decision recorded${project}`;
  if(operation==='REPLY_TO_INTERACTION')return `✅ Reply recorded${project}`;
  if(operation==='NARROW_AUTONOMY'||operation==='EXPAND_AUTONOMY')return `✅ Autonomy updated${project}${taskId?`\nTask: ${taskId}`:''}`;
  return `✅ Accepted${project}`;
}
// P8-R0 Part F: the ack for a shorthand-originated SUBMIT_TASK — every
// field is hand-picked/bounded exactly like renderOwnerAck (M05); the only
// difference is showing BOTH the alias the owner typed and the canonical
// identity it resolved to, for every axis that can go wrong (project repo,
// PM backend/model/reasoning), so a fat-fingered alias is never invisible.
// Never exposes secrets — `pmProfile` here is always the adapter's own
// secret-free display copy (normalizePmProfileList), same guarantee
// pm-profile-registry.mjs already provides for every other profile read.
// P10-R0.2.4 Part AC: a LONG-runtime task's acceptance ack always shows the
// hard deadline up front — the owner must never have to infer LONG-ness
// from task length. `taskSource` is the resolved GIT_FILE provenance
// (optional; `null` for a normal SHORT task — byte-for-byte unaffected).
function renderTaskSourceLines(taskSource){
  if(!taskSource)return [];
  return [
    '','Runtime:',`LONG — hard deadline ${Math.round(LONG_TASK_HARD_DEADLINE_MS/60000)}m`,
    '','Task source:','GIT_FILE',
    `ref: ${String(taskSource.requestedRef??'unknown').slice(0,128)}`,
    `commit: ${String(taskSource.resolvedCommitSha??'unknown').slice(0,64)}`,
    `path: ${String(taskSource.path??'unknown').slice(0,256)}`,
  ];
}
export function renderShorthandTaskAck({project,projectAlias,pmProfile,pmAlias,taskBody,council=null,taskSource=null}){
  const displayName=project.display_name&&project.display_name!==project.id?project.display_name:project.id;
  const lines=[
    '✅ DSH task accepted','',
    'Project:',`${String(projectAlias).slice(0,8)} — ${String(displayName).slice(0,128)}`,`id: ${String(project.id).slice(0,128)}`,'',
    'PM:',`${String(pmAlias).slice(0,8)} — ${String(pmProfile.id).slice(0,128)}`,
  ];
  if(council){
    lines.push('','Council:',council.participantProfileIds.map((id,i)=>`${String(council.participantAliases[i]??'?').slice(0,8)} — ${String(id).slice(0,128)}`).join('\n'));
  }
  // Part J: a null model/reasoning is never fabricated as a discovered CLI
  // default — displayed honestly as "default/inherited" instead.
  lines.push('','Backend:',String(pmProfile.product??'unknown').slice(0,64));
  lines.push('','Model:',(pmProfile.model?String(pmProfile.model):'default/inherited').slice(0,64));
  lines.push('','Reasoning:',(pmProfile.reasoning?String(pmProfile.reasoning):'default/inherited').slice(0,64));
  lines.push(...renderTaskSourceLines(taskSource));
  lines.push('','Task:',String(taskBody??'').slice(0,500));
  const text=lines.join('\n');
  return text.length<=3500?text:`${text.slice(0,3488)}\n[TRUNCATED]`;
}
export function redeemCallbackBinding(interaction,nonce){const digest=callbackDigest(nonce);for(const [response,binding] of Object.entries(interaction.response_bindings??{}))if(binding===digest)return response;throw new OwnerControlError('callback is invalid or stale','STALE_CALLBACK');}
