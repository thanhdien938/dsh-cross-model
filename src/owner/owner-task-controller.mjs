import { createHash } from 'node:crypto';
import { deterministicOwnerId, stableJson, OwnerControlError } from './owner-contracts.mjs';
import { normalizeAutonomyEnvelope, narrowAutonomy } from './autonomy-envelope.mjs';
import { LONG_TASK_HARD_DEADLINE_MS } from '../pm/pm-execution-timeout-policy.mjs';
import { appendContextHint } from '../pm/task-context-hint.mjs';
import { TaskBranchLifecycleError, deriveTaskBranchName } from '../pm/task-branch-binding.mjs';
import { admitTaskGitBinding as admitTaskGitBindingImpl, BaseAdmissionError } from '../pm/task-base-admission.mjs';
import { ensureTaskWorkspace as ensureTaskWorkspaceImpl, TaskWorkspaceError } from '../pm/task-workspace-manager.mjs';
import { validateTaskWorkspaceRepositoryCapabilities, TaskWorkspaceCapabilityError } from '../pm/task-workspace-capability-preflight.mjs';
import { COMMIT_SHA_RE } from '../pm/task-result-git-sync.mjs';
import { stampTransportVersion, TRANSPORT_VERSION } from '../artifacts/artifact-transport.mjs';
import { ProductionPmBackendError } from '../pm/production-pm-backend-registry.mjs';
import { CliReportBackendError } from '../pm/report-backends/cli-report-backends.mjs';
import { assertWorkspaceOutputPathSafe, WorkspaceOutputError } from '../pm/workspace-output-materializer.mjs';

// P21.2 — Telegram poison-update fix. `startPm()` (p5-production-
// composition.mjs's createRuntime()) can throw BEFORE any backend process
// is ever spawned and BEFORE any pm_run/pm_request row exists — a
// deterministic composition/routing/config failure (an unsupported P20
// report route for the selected product, missing artifact wiring, an
// unavailable PM backend, ...), never something a retry could fix. Both
// error classes below are the EXISTING, already-typed vocabulary for
// exactly that class of failure (never a bare Error, never a DB/network
// error) — recognizing them here is not a new taxonomy, it is closing the
// gap where #submit() previously let ANY startPm() error (deterministic or
// transient alike) propagate identically. See isDeterministicTaskStartError()
// below for the one-line classification this depends on.
function isDeterministicTaskStartError(error) {
  return error instanceof ProductionPmBackendError || error instanceof CliReportBackendError;
}

// P20.8 §7 — production transport admission. `resolveTransportVersion`,
// when supplied, is `({project, council, runtimeClass}) => 'legacy'|
// 'artifact_v1'|null|undefined` — an explicit, DI-only decision never
// derived from `command.payload.body` (prompt prose is never consulted:
// §7 rule 1). The default resolver always returns 'legacy', so every
// existing caller/test that omits this dependency is byte-for-byte
// unaffected — this is the fail-closed feature switch §7 rule 5 requires.
// A NEW task is only ever stamped `transport_version:'artifact_v1'` in its
// durable context (§7 rule 4: BEFORE any execution); a 'legacy' or falsy
// resolver result stamps NOTHING (§7 rule 2: old/null/legacy tasks are
// never touched, and a legacy-resolved new task keeps the identical
// pre-P20.8 context shape). `stampTransportVersion()` still runs the same
// typed-allowlist validation an artifact_v1 resolver result must pass —
// an unsupported/malformed resolver result fails closed here, before the
// task/pm_run is ever created, never silently coerced to legacy (§7 rule 3
// is about EXISTING durable records; a bad NEW resolver result is a
// configuration bug that must be visible immediately, not swallowed).
const DEFAULT_RESOLVE_TRANSPORT_VERSION = () => TRANSPORT_VERSION.LEGACY;

// P18-W4R2 — BRANCH_CREATE is a pre-existing, real per-project autonomy
// effect (autonomy-envelope.mjs's LOCAL_ONLY_EFFECTS, projects.yaml) that,
// before this wave, had zero implementation anywhere (P18-W4R1 design
// review §2). Mirrors production-pm-worker.mjs's isPushAuthorized() exactly:
// FORBID always refuses; any other configured level (APPROVAL/ALLOW, both
// collapse to APPROVAL under normalizeAutonomyEnvelope()'s LOCAL_ONLY_EFFECTS
// cap) is satisfied by the owner's own explicit per-task `git` request
// itself — never GuardedEffectExecutor, which would make this
// unconditionally impossible for the same reason documented there. Unlike
// PUSH_REMOTE, branch creation carries no Telegram-origin restriction: the
// task-branch-bound flow is precisely FOR Telegram-origin dispatch (design
// §0.2) — only the later PUBLISH step keeps a channel distinction.
function isBranchCreateAuthorized(autonomy) {
  const mode = normalizeAutonomyEnvelope(autonomy).effects.BRANCH_CREATE ?? 'FORBID';
  return mode !== 'FORBID';
}

// P12-R2 — the three canonical durability levels (docs/p12/01_P12_R0_*
// §2/§3). Exported so callers (production-pm-worker.mjs, tests) share the
// exact same bounded vocabulary rather than re-typing string literals.
export const TASK_DURABILITY = Object.freeze({ DIRECT: 'DIRECT', DURABLE_LOCAL: 'DURABLE_LOCAL', DURABLE_REMOTE: 'DURABLE_REMOTE' });
const VALID_DURABILITIES = new Set(Object.values(TASK_DURABILITY));

// P12-R0 §3: an explicit owner value always wins; absent/invalid, default
// by runtimeClass — NORMAL -> DIRECT (the flagged, owner-approved behavior
// change), LONG -> DURABLE_LOCAL (byte-for-byte the pre-P12 default).
export function normalizeDurability(requested, runtimeClass) {
  const upper = typeof requested === 'string' ? requested.toUpperCase() : null;
  if (upper && VALID_DURABILITIES.has(upper)) return upper;
  return runtimeClass === 'LONG' ? TASK_DURABILITY.DURABLE_LOCAL : TASK_DURABILITY.DIRECT;
}

// P12-R2: `payload.git` is an optional, additive, owner-authored request
// shape — `{commit?: boolean, push?: boolean, remote?: string}`. Anything
// malformed collapses to "not requested" (null) here — this is a data-shape
// stamp, not an authority boundary (OwnerControlService already owns
// acceptance). `remote` defaults to 'origin' only once actually used
// (task-result-git-sync.mjs), never assumed here.
export function normalizeGitSyncRequest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const remoteWasSupplied = Object.hasOwn(raw, 'remote');
  const remote = typeof raw.remote === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(raw.remote) ? raw.remote : null;
  if (remoteWasSupplied && !remote) {
    throw new OwnerControlError('Git remote must be a valid configured remote name', 'GIT_REMOTE_INVALID');
  }
  const commit = raw.commit === true;
  const push = raw.push === true;
  // P24.1G6A §8/§24 — typed per-task caller base observation CAS,
  // independent of the project's own `git_base_policy`. Validated HERE,
  // before any Git mutation ever runs (this function executes early in
  // submit(), well before admission) — a present-but-malformed value
  // fails closed rather than being silently ignored; an absent value
  // means "no caller CAS" (task-base-admission.mjs never invents one from
  // internal project state).
  const expectedBaseShaWasSupplied = Object.hasOwn(raw, 'expected_base_sha');
  const expectedBaseSha = typeof raw.expected_base_sha === 'string' && COMMIT_SHA_RE.test(raw.expected_base_sha) ? raw.expected_base_sha.toLowerCase() : null;
  if (expectedBaseShaWasSupplied && !expectedBaseSha) {
    throw new OwnerControlError('git.expected_base_sha must be an exact 40-character hexadecimal commit SHA', 'CALLER_EXPECTED_BASE_SHA_INVALID');
  }
  if (expectedBaseShaWasSupplied && !commit && !push) {
    throw new OwnerControlError('git.expected_base_sha requires a Git-bound request (commit or push)', 'CALLER_EXPECTED_BASE_SHA_REQUIRES_GIT_REQUEST');
  }
  if (!commit && !push) return null;
  // Pushing without committing first is refused at the point of use
  // (production-pm-worker.mjs) — `push` alone still needs SOMETHING to
  // push, so it's normalized to also imply `commit` here rather than
  // silently pushing whatever the backend happened to leave uncommitted.
  // P12-R5B Part C: `remote: remote ?? undefined` used to set the key to a
  // literal `undefined` whenever no override was given — the OVERWHELMINGLY
  // common case (--push with no --remote, exactly R5's own TEST 3/TEST 4
  // commands). AgentBusRepository.createOwnerTask()'s durable envelope write
  // (json-durable.mjs's assertJsonFaithful — a deliberate, correct
  // fail-before-mutate guarantee) refuses ANY object containing an
  // `undefined` value anywhere, so this made createOwnerTask() throw a
  // PersistenceError('NOT_JSON_FAITHFUL') for that exact, common case — no
  // task was ever created, and the generic OwnerControlError-code fallback
  // then collapsed it to indistinguishable 'OWNER_COMMAND_FAILED'. This was
  // invisible in every existing unit test because they all fake
  // `createOwnerTask` as a plain array push, never actually serializing
  // anything. Omitting the key entirely (rather than setting it to
  // `undefined`) is the correct fix: `'remote' in gitSync` is now false
  // when no override was requested, exactly like every other optional field
  // in this module already behaves.
  return Object.freeze({
    commit: commit || push, push,
    ...(remote ? { remote } : {}),
    ...(expectedBaseSha ? { expectedBaseSha } : {}),
  });
}

// P12-R4: `payload.review: {requested: true}` is an optional, additive,
// owner-authored request — mirrors normalizeGitSyncRequest()'s exact shape
// and discipline. Absent for every existing caller. Review is meaningful
// only once a remote result exists to review (production-pm-worker.mjs
// resolves this to READY_FOR_REVIEW/REVIEW_BLOCKED_REMOTE based on the
// ACTUAL remote-sync outcome, never on the mere presence of this request).
export function normalizeReviewRequest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.requested !== true) return null;
  return Object.freeze({ requested: true });
}

// P24.1G2 — `payload.workspace_output: {report_path: string, non_empty?:
// boolean}` is an optional, additive, owner-authored typed request that a
// completed SINGLE artifact_v1 task's already-sealed report be materialized
// (verbatim, by DSH itself — never the model) into this ONE repo-relative
// path before Git settlement. This is a data-SHAPE stamp only, exactly like
// normalizeGitSyncRequest()/normalizeReviewRequest() above — no filesystem
// access here (the project repo root is not yet known/authoritative at this
// point), no path-safety check (that happens in submit() below, once
// `project.repo_path` is available, and again immediately before the write
// in production-pm-worker.mjs — defense in depth, never trusted once). This
// phase implements ONLY the `required` semantics the master design calls
// for (materialization must succeed or Git settlement fails closed) — there
// is no "requested but optional" mode, so `required` is always true and is
// not itself a caller-configurable input. `non_empty` defaults to true and
// is the one real toggle this phase exposes.
export function normalizeWorkspaceOutputRequest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.report_path !== 'string' || raw.report_path.trim() === '') return null;
  const nonEmpty = raw.non_empty !== false;
  return Object.freeze({ report_path: raw.report_path, required: true, non_empty: nonEmpty });
}

const RELATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function boundedRelationId(value) {
  return typeof value === 'string' && RELATION_ID_RE.test(value) ? value : null;
}

// P12-R3 §3/§4: purely discoverability metadata (docs/p12/01_P12_R0_*
// §5.1/§9) — `parent_task_id`/`related_task_ids`/`remediation_of_task_id`/
// `review_of_task_id` are links a future index/agent MAY choose to follow,
// never a mandatory-read instruction and never validated against durable
// history here (that already happened, if required at all, at the
// pre-acceptance "required context" resolution seam — see
// local-runtime-control.mjs's resolveRequiredContext). Anything malformed
// is silently dropped, never fatal — this is discovery metadata, not an
// authority boundary.
export function normalizeTaskRelations(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const parentTaskId = boundedRelationId(raw.parent_task_id);
  const remediationOfTaskId = boundedRelationId(raw.remediation_of_task_id);
  const reviewOfTaskId = boundedRelationId(raw.review_of_task_id);
  const relatedTaskIds = Array.isArray(raw.related_task_ids)
    ? [...new Set(raw.related_task_ids.map(boundedRelationId).filter(Boolean))].slice(0, 20)
    : [];
  if (!parentTaskId && !remediationOfTaskId && !reviewOfTaskId && relatedTaskIds.length === 0) return null;
  return Object.freeze({
    parent_task_id: parentTaskId,
    related_task_ids: Object.freeze(relatedTaskIds),
    remediation_of_task_id: remediationOfTaskId,
    review_of_task_id: reviewOfTaskId,
  });
}

export class OwnerTaskController {
  // P10-R0.1 Part H/K: `taskDiagnostics`, when supplied, is
  // `({taskId,projectId,pmRunId,taskMode})=>TaskDiagnosticLog|null` (see
  // src/runtime/task-diagnostic-log.mjs). Purely observational — a missing
  // dep or a throwing factory changes no task-acceptance behavior (mirrors
  // backend-execution-observer.mjs's B4 philosophy).
  // P15-REM-R3-B (P15-D-002, docs/p15-rem/04_*.md): `resolveRequiredContext`,
  // when supplied, is the SAME `({projectId,taskId}) => Promise<object|null>`
  // shape `local-runtime-control.mjs`'s pipe layer already used exclusively
  // — moved here so it is the ONE shared, decisive authority EVERY ingress
  // path (Desktop pipe, Telegram canonical, Telegram alias shorthand, any
  // future adapter) goes through, since every one of them ultimately calls
  // `submit()`. The pipe may still perform the identical check early as a
  // UX nicety (a faster local refusal, no round trip) — this is what makes
  // the shared check DECISIVE regardless of which ingress path a request
  // took.
  // P18-W4R2: `prepareTaskBranch`, when supplied, overrides the real
  // task-branch-binding.mjs implementation — same opt-in DI shape as
  // `taskDiagnostics`/`resolveRequiredContext` above, so the large existing
  // pre-P18 test suite (which never sets `payload.git`) never spawns a
  // real `git` process it never asked for, and unit tests of `submit()`
  // itself can fake branch preparation without a real repository.
  constructor({repository,startPm,requestCancellation,resolveWorkItem,supersedeInteractions,taskDiagnostics=null,resolveRequiredContext=null,resolveProjectForGit=null,admitTaskGitBinding=admitTaskGitBindingImpl,resolveTransportVersion=DEFAULT_RESOLVE_TRANSPORT_VERSION,workspaceAdmissionLock=null,ensureTaskWorkspace=null,taskWorkspaceRoot=null}={}){if(!repository)throw new TypeError('task repository required');this.repo=repository;this.startPm=startPm;this.cancel=requestCancellation;this.resolveWorkItem=resolveWorkItem;this.supersede=supersedeInteractions;this.taskDiagnostics=typeof taskDiagnostics==='function'?taskDiagnostics:null;this.resolveRequiredContext=typeof resolveRequiredContext==='function'?resolveRequiredContext:null;this.resolveProjectForGit=typeof resolveProjectForGit==='function'?resolveProjectForGit:null;this.admitTaskGitBinding=typeof admitTaskGitBinding==='function'?admitTaskGitBinding:admitTaskGitBindingImpl;this.resolveTransportVersion=typeof resolveTransportVersion==='function'?resolveTransportVersion:DEFAULT_RESOLVE_TRANSPORT_VERSION;
    // P24.1G6A §15 — same-physical-workspace admission fencing (workspace-
    // admission-lock.mjs). `null` (the default) preserves byte-for-byte
    // pre-G6A behavior for every existing test/DI caller that does not
    // pass it — only `p5-production-composition.mjs` wires the ONE shared
    // instance a real deployment's coordinator+worker roles both use.
    this.workspaceAdmissionLock=workspaceAdmissionLock&&typeof workspaceAdmissionLock.withLock==='function'?workspaceAdmissionLock:null;
    // P24.3B §3/§20 — isolated task-workspace allocation is OFF unless a
    // caller explicitly wires BOTH `ensureTaskWorkspace` (a function — the
    // real one is task-workspace-manager.mjs's own; every existing test/DI
    // caller that omits it is completely unaffected) AND `taskWorkspaceRoot`
    // (the DSH-owned root new workspaces are allocated under). Presence of
    // dependencies, never a separate boolean, is this codebase's own
    // established opt-in convention (see e.g. `resolveProjectHistoryRoot`/
    // `enableProductionArtifactWiring` in p5-production-composition.mjs) —
    // `scripts/p5-runtime.mjs` does NOT wire these yet (P24.3B ships the
    // capability; a later, separately authorized deployment decision turns
    // it on for real).
    this.ensureTaskWorkspace=typeof ensureTaskWorkspace==='function'?ensureTaskWorkspace:null;
    this.taskWorkspaceRoot=typeof taskWorkspaceRoot==='string'&&taskWorkspaceRoot?taskWorkspaceRoot:null;
  }
  async submit({command,project,profile,council=null}){const id=deterministicOwnerId('task',command.command_id),pmRunId=deterministicOwnerId('pmrun',command.command_id);const autonomy=normalizeAutonomyEnvelope(project.autonomy);
    // P15-REM-R3-B (P15-D-002): the ONE decisive "does this task's named
    // prior context actually exist" pre-flight — resolved BEFORE any pm_run
    // is ever created, exactly mirroring local-runtime-control.mjs's own
    // (now-redundant-but-harmless) early check. Never triggered unless the
    // owner explicitly names a `payload.requires_context.task_id` — every
    // existing caller that omits it is completely unaffected. Reuses the
    // EXACT canonical code (`TASK_CONTEXT_REQUIRED_UNAVAILABLE`) the pipe
    // layer already established, so no ingress-specific vocabulary exists.
    if(command.payload.requires_context!=null){
      const requiresContext=command.payload.requires_context;
      if(typeof requiresContext!=='object'||requiresContext===null||typeof requiresContext.task_id!=='string'||!requiresContext.task_id){
        throw new OwnerControlError('requires_context.task_id must be a non-empty string','REQUIRES_CONTEXT_MALFORMED');
      }
      if(!this.resolveRequiredContext)throw new OwnerControlError('required-context pre-flight is unavailable','TASK_CONTEXT_REQUIRED_UNAVAILABLE');
      let found;
      try{found=await this.resolveRequiredContext({projectId:project.id,taskId:requiresContext.task_id});}
      catch{found=null;}
      if(!found)throw new OwnerControlError(`required context task is unavailable: ${requiresContext.task_id}`,'TASK_CONTEXT_REQUIRED_UNAVAILABLE',{taskId:requiresContext.task_id});
    }
    // P7: `council` is the already-normalized+validated CouncilSpec (Part D)
    // when this SUBMIT_TASK is a COUNCIL-mode task (Part B); null for every
    // existing SINGLE-mode task, which is byte-for-byte unchanged. `profile`
    // is the CHAIR's profile for a council (see OwnerControlService), so
    // durable pm_profile pinning below is unaffected either way.
    // P10-R0.1.1 Part J: `channel` carries the command's ALREADY-TRUSTED
    // `client_kind` ('TELEGRAM'/'LOCAL' — owner-contracts.mjs's
    // normalizeOwnerCommand() already closes this to that exact enum)
    // through to the durable pm_request.context, so a task diagnostic
    // summary can report "Submitted via: TELEGRAM" from real origin
    // metadata instead of guessing from `task.sender` (always 'owner') or
    // inferring from task text (explicitly forbidden).
    // P10-R0.2.4 Part L/S: `task_source` (GIT_FILE provenance — already
    // fully resolved+validated by the caller BEFORE this command was ever
    // accepted — see telegram-owner-client.mjs's TelegramOwnerAdapter) is
    // additive JSON on the SAME durable `context` field — no schema
    // migration (Part AV). `runtimeClass` is stamped ONCE here — never
    // re-derived later from task-text length or guessed per-turn; every
    // subsequent resume of this task (production-pm-worker.mjs) reads this
    // SAME stamped value back off durable state.
    //
    // P18-W4 Part A: `command.payload.runtime_class` is a SEPARATE,
    // explicit typed owner payload fact (telegram-owner-client.mjs's
    // `--long` flag folds onto it) — LONG is now reachable WITHOUT a
    // git-provenanced task_source. `task_source` is NOT repurposed and
    // keeps meaning GIT_FILE provenance only; it still independently
    // implies LONG exactly as before (Part S), preserving `--task-file`
    // semantics byte-for-byte. Fail-closed: the ONLY legal values for an
    // explicitly-supplied `runtime_class` are the literal strings 'LONG'
    // and 'NORMAL' (the same two-value vocabulary this function has always
    // stamped) — anything else (wrong case, a number, an unrelated string)
    // is rejected here, before any task/pm_run is ever created, never
    // silently coerced or ignored.
    const taskSource=command.payload.task_source??null;
    const requestedRuntimeClass=command.payload.runtime_class;
    if(requestedRuntimeClass!=null&&requestedRuntimeClass!=='LONG'&&requestedRuntimeClass!=='NORMAL'){
      throw new OwnerControlError(`invalid runtime_class request: ${String(requestedRuntimeClass)}`,'INVALID_RUNTIME_CLASS_REQUEST');
    }
    const explicitLongRequested=requestedRuntimeClass==='LONG';
    const runtimeClass=(taskSource||explicitLongRequested)?'LONG':'NORMAL';
    // P18-W4 ACK-causal-correlation remediation: `command.payload.client_
    // correlation_id` is a DSH-owned, TRANSPORT-ONLY correlation fact (an
    // automated caller's own opaque id, e.g. a GitHub-relay correlation_id
    // — telegram-owner-client.mjs's `--client-correlation` flag) — never
    // task/PM content, never runtime-class or git authority, never folded
    // into `task_source`. Fail-closed here (the ONE ingress-neutral
    // authority every caller of submit() goes through, mirroring the
    // runtime_class validation immediately above) with the SAME bounded
    // charset the relay's own correlation_id already uses, so a malformed
    // value is rejected BEFORE any task/pm_run is ever created rather than
    // silently truncated/ignored. Purely additive/diagnostic below (Part
    // C): it is stored in the durable context and echoed back in the
    // acceptance ACK (renderOwnerAck()), and never read by anything that
    // makes an execution decision.
    const clientCorrelationId=command.payload.client_correlation_id??null;
    if(clientCorrelationId!=null&&(typeof clientCorrelationId!=='string'||!/^[A-Za-z0-9_.-]{6,128}$/.test(clientCorrelationId))){
      throw new OwnerControlError(`invalid client_correlation_id: ${String(clientCorrelationId)}`,'INVALID_CLIENT_CORRELATION_ID');
    }
    // P12-R2 Part durability: an explicit owner-supplied `payload.durability`
    // always wins; absent, the default is computed from `runtimeClass` —
    // NORMAL (plain-prompt) defaults to DIRECT (no docs/history write,
    // P12-R0 §3's flagged behavior change), LONG (task-file dispatch)
    // defaults to DURABLE_LOCAL, preserving P10's exact existing behavior
    // byte-for-byte. Stamped ONCE here, same as runtimeClass/council above
    // — never re-derived on a later resume.
    const durability=normalizeDurability(command.payload.durability,runtimeClass);
    // P12-R2 Part git-sync: optional, additive, owner-requested local
    // commit/remote push of the task's own result. Absent for every
    // existing caller (byte-for-byte pre-P12 behavior). Malformed shapes
    // invalid explicit remote names fail closed here with GIT_REMOTE_INVALID;
    // omission remains distinct and may use the established origin default.
    const gitSync=normalizeGitSyncRequest(command.payload.git);
    // P18-W4R2 §5.1/§5.4/§0.2: when a task requests git commit/push AND the
    // project's BRANCH_CREATE effect is not FORBID, DSH prepares and binds
    // exactly one `dsh/task-<task_id>` branch BEFORE this task (or its
    // pm_run) is ever created — a preparation failure (dirty workspace,
    // unresolved remote base, etc.) refuses the ENTIRE submission here,
    // never a half-created task and never a silent fallback to committing
    // on whatever branch happened to be checked out. `taskId` (`id`) is
    // already the deterministic value this method itself is about to stamp
    // durably — never re-derived later, exactly like durability/gitSync/
    // runtimeClass above. One task, one bound branch, regardless of mode
    // (SINGLE/COUNCIL/DEBATE) — this call is identical for all three;
    // council/debate participants never get an independent branch.
    let taskBranch=null;
    // P24.3B §3/§20 — isolated task-workspace binding, stamped alongside
    // `taskBranch` (never a separate durable authority — see this
    // function's own local `materializeTaskBranch` below, which is the
    // ONLY thing that can populate this). Absent (`null`) for every
    // legacy task and for every task submitted while isolation is not
    // wired in this composition — exactly the P24.3A `isolation_version`
    // absence convention (§19 "no marker => legacy path").
    let taskWorkspace=null;
    const isolationEnabled=Boolean(this.ensureTaskWorkspace&&this.taskWorkspaceRoot);
    if(gitSync&&isBranchCreateAuthorized(autonomy)){
      const taskMode=council?'COUNCIL':'SINGLE';
        try{
          // P22.7: only NEW Git-bound tasks read through to the established
          // projects registry.  The startup project remains the admission/
          // workspace identity authority; a path change is not silently
          // adopted by a live process.  Base branch/SHA changes are allowed,
          // validated by admitTaskGitBinding(), and then pinned in taskBranch.
          const gitProject=this.resolveProjectForGit?await this.resolveProjectForGit({projectId:project.id}):project;
          const sameWorkspace=gitProject?.workspace_id&&project.workspace_id
            ?gitProject.workspace_id===project.workspace_id
            :gitProject?.repo_path===project.repo_path;
          if(!gitProject||gitProject.id!==project.id||!sameWorkspace){
            throw new TaskBranchLifecycleError('fresh project Git binding does not match the admitted workspace','TASK_BRANCH_BINDING_VIOLATION',{stage:'PREPARE'});
          }
          // P24.3B-R1 Gap #4 — a minimum fail-closed preflight, ONLY for a
          // task actually opting into isolation (legacy/shared-worktree
          // admission is byte-for-byte unaffected — §8 test 27). Runs
          // BEFORE any base-pin resolution or worktree mutation: a
          // rejected repository never reaches G6A observation, never
          // allocates a worktree, never touches the registered checkout.
          if(isolationEnabled){
            await validateTaskWorkspaceRepositoryCapabilities({repoPath:gitProject.repo_path});
          }
          // P24.1G6A — admission authority moved from a single project-owned
          // `expectedBaseSha` pass-through to `admitTaskGitBinding()`: it
          // resolves the project's OWN `git_base_policy` (dynamic by
          // default; pinned only when the project explicitly says so, or a
          // legacy branch+SHA pair with no explicit policy) and combines it
          // with this task's own `gitSync.expectedBaseSha` (§8's typed
          // per-task caller CAS, independent of project policy) — never a
          // single hidden project SHA used as the caller's own assertion.
          // P24.3B §3 — when isolation is wired, the LOW-LEVEL branch-
          // materialization step admitTaskGitBinding() would otherwise
          // perform directly in the shared registered checkout
          // (`prepareTaskBranchImpl` — a `checkout -b` that both requires
          // and would touch `gitProject.repo_path`) is replaced by an
          // isolated linked-worktree allocation instead: the shared
          // checkout is NEVER switched, NEVER required to be clean, and
          // the resulting binding is synthesized with `original_checkout:
          // null` (there is nothing to restore — see production-pm-
          // worker.mjs's v1-aware terminal handling). `admitTaskGitBinding`
          // itself still owns base-pin resolution/validation/journaling
          // unchanged either way (this callback receives an ALREADY-
          // resolved `pinnedBaseSha`, never re-derives one).
          const materializeTaskBranch=isolationEnabled?async({projectRepoPath,taskId:tId,projectId:pId,taskMode:tMode,remote:rem,baseBranch,pinnedBaseSha,spawnImpl,timeoutMs})=>{
            const ws=await this.ensureTaskWorkspace({taskRepository:this.repo,projectRepoPath,projectId:pId,taskId:tId,taskBranch:deriveTaskBranchName(tId),pinnedBaseSha,runtimeWorktreeRoot:this.taskWorkspaceRoot,spawnImpl,timeoutMs});
            taskWorkspace={isolation_version:ws.isolation_version,workspace_path:ws.workspace_path,repository_common_dir:ws.repository_common_dir};
            return Object.freeze({task_id:tId,project_id:pId,task_mode:tMode,base_branch:baseBranch??null,base_sha:pinnedBaseSha,task_branch:ws.task_branch,remote:rem,original_checkout:null});
          }:undefined;
          const admit=()=>this.admitTaskGitBinding({taskRepository:this.repo,taskId:id,projectId:project.id,taskMode,project:gitProject,remote:gitSync.remote??'origin',callerExpectedBaseSha:gitSync.expectedBaseSha??null,...(materializeTaskBranch?{materializeTaskBranch}:{})});
          // P24.1G6A §15/§23 — same-physical-workspace admission fencing:
          // no second task may observe/branch/checkout on the SAME shared
          // workspace while this one is mid-admission. Different
          // workspace_ids (or no lock configured at all, e.g. every
          // pre-G6A test/DI caller) run exactly as before.
          taskBranch=this.workspaceAdmissionLock?await this.workspaceAdmissionLock.withLock(gitProject.workspace_id??gitProject.repo_path,admit):await admit();
      }catch(error){
        if(error instanceof TaskBranchLifecycleError)throw new OwnerControlError(error.message,error.code,{expected_task_branch:error.expected_task_branch,observed_branch:error.observed_branch,stage:error.stage});
        if(error instanceof BaseAdmissionError)throw new OwnerControlError(error.message,error.code,{expected:error.expected,live:error.live,remote:error.remote,baseBranch:error.baseBranch,taskBranch:error.taskBranch});
        // P24.3B — the isolated-workspace allocator's own typed fail-closed
        // vocabulary (P24.3A: foreign/ancestry-mismatched branch, blocked/
        // removed/cleanup-pending durable state, persistence unavailable,
        // ...). Never silently falls back to the legacy shared-checkout
        // path on ANY of these — a caller that opted a task into isolation
        // and hit a real allocation defect must see that refusal, not a
        // task that quietly ran unisolated.
        if(error instanceof TaskWorkspaceError)throw new OwnerControlError(error.message,error.code,{});
        // P24.3B-R1 Gap #4 — a capability-preflight rejection is NOT a
        // provider/model failure and NOT a base-admission/branch defect;
        // it is reported with its own typed code, deterministically,
        // before any Git mutation this task would otherwise have caused.
        if(error instanceof TaskWorkspaceCapabilityError)throw new OwnerControlError(error.message,error.code,{});
        throw error;
      }
    }
    // P12-R3 Part relations: discoverability-only links (parent/related/
    // remediation-of/review-of) — see normalizeTaskRelations()'s own
    // docstring. Absent for every existing caller.
    const relations=normalizeTaskRelations(command.payload.relations);
    // P12-R4 Part A: optional, additive, owner-requested review. Absent for
    // every existing caller.
    const review=normalizeReviewRequest(command.payload.review);
    // P20.8 §7 — resolved from project/council/runtimeClass ONLY, never
    // from `command.payload.body` (rule 1). A resolver result of anything
    // other than the literal string 'artifact_v1' stamps nothing at all —
    // this task's context stays byte-for-byte the pre-P20.8 shape (rule 2).
    const requestedTransportVersion=this.resolveTransportVersion({project,council,runtimeClass})??null;
    const transportVersionStamp=requestedTransportVersion===TRANSPORT_VERSION.ARTIFACT_V1
      ?stampTransportVersion({},TRANSPORT_VERSION.ARTIFACT_V1).transport_version
      :null;
    // P24.1G2 — typed workspace report materialization. Validated and
    // rejected EARLY (before any task/pm_run is ever created), exactly like
    // the taskBranch preparation above, whenever the request can never be
    // honored: it requires
    // an explicit `git.commit=true` request — a materialized-but-never-
    // committed file would be silently lost, so this fails closed rather
    // than accept a contract it can never hand off; it requires this
    // task to actually run on the artifact_v1 transport — a legacy/non-
    // artifact task never produces the one sealed `final_ref` this feature
    // materializes from, so there is nothing to ever copy; the typed
    // path itself must be a safe, repo-contained, non-`.git` path — checked
    // NOW, against this task's real `project.repo_path` (the exact same
    // physical worktree production-pm-worker.mjs will later write into),
    // re-verified again immediately before the write happens (defense in
    // depth, never trusted once).
    const workspaceOutput=normalizeWorkspaceOutputRequest(command.payload.workspace_output);
    if(workspaceOutput){
      if(!gitSync||gitSync.commit!==true){
        throw new OwnerControlError('workspace_output requires git.commit=true','WORKSPACE_OUTPUT_REQUIRES_GIT_COMMIT');
      }
      if(transportVersionStamp!==TRANSPORT_VERSION.ARTIFACT_V1){
        throw new OwnerControlError('workspace_output requires an artifact_v1 task (a sealed final_ref is the only supported materialization source)','WORKSPACE_OUTPUT_REQUIRES_ARTIFACT_TRANSPORT');
      }
      try{
        assertWorkspaceOutputPathSafe({repoRoot:project.repo_path,reportPath:workspaceOutput.report_path});
      }catch(error){
        if(error instanceof WorkspaceOutputError)throw new OwnerControlError(error.message,error.code,{reportPath:workspaceOutput.report_path});
        throw error;
      }
    }
    const context=council
      ?{ownerCommandId:command.command_id,council,...(workspaceOutput?{workspaceOutput}:{}),channel:command.client_kind??null,runtimeClass,durability,...(gitSync?{gitSync}:{}),...(taskBranch?{taskBranch}:{}),...(taskWorkspace?{taskWorkspace}:{}),...(relations?{relations}:{}),...(review?{review}:{}),...(taskSource?{taskSource}:{}),...(clientCorrelationId?{clientCorrelationId}:{}),...(transportVersionStamp?{transport_version:transportVersionStamp}:{})}
      :{ownerCommandId:command.command_id,channel:command.client_kind??null,runtimeClass,durability,...(gitSync?{gitSync}:{}),...(taskBranch?{taskBranch}:{}),...(taskWorkspace?{taskWorkspace}:{}),...(relations?{relations}:{}),...(review?{review}:{}),...(workspaceOutput?{workspaceOutput}:{}),...(taskSource?{taskSource}:{}),...(clientCorrelationId?{clientCorrelationId}:{}),...(transportVersionStamp?{transport_version:transportVersionStamp}:{})};
    // P12-R3 Part E: the ONE bounded context-discovery hint, appended ONLY
    // for a durable task (DIRECT stays byte-for-byte unaffected — the new
    // default for a plain-prompt task, P12-R0 §3). Never a "MUST read"
    // instruction, never a listing of files — see task-context-hint.mjs.
    const body=appendContextHint(command.payload.body,durability!==TASK_DURABILITY.DIRECT);
    const task={id,sender:'owner',recipient:'pm',body,context,createdAt:command.accepted_at??'1970-01-01T00:00:00.000Z'};const fingerprint=createHash('sha256').update(stableJson(project)).digest('hex');this.repo.createOwnerTask(task,{projectId:project.id,pmProfileId:profile.id,effectiveAutonomy:autonomy,envelopeRevision:autonomy.revision,projectConfigFingerprint:fingerprint});
    let taskLog=null;try{taskLog=this.taskDiagnostics?this.taskDiagnostics({taskId:id,projectId:project.id,pmRunId,taskMode:council?'COUNCIL':'SINGLE'}):null;}catch{taskLog=null;}
    taskLog?.event('TASK_ACCEPTED',{command_id:command.command_id,client_kind:command.client_kind??null,pm_profile_id:profile.id,task_mode:council?'COUNCIL':'SINGLE',runtime_class:runtimeClass,...(council?{chair_profile_id:council.chair_profile_id,participant_profile_ids:council.participant_profile_ids,rounds:council.rounds}:{})});
    // P10-R0.2.4 Part AE: emitted ONCE, at acceptance — never re-emitted on
    // a later resume/turn (production-pm-worker.mjs never calls submit()
    // again for the same task).
    if(taskSource){
      taskLog?.event('TASK_SOURCE_RESOLVED',{type:taskSource.type,requested_ref:taskSource.requestedRef??null,resolved_commit_sha:taskSource.resolvedCommitSha??null,path:taskSource.path??null,content_sha256:taskSource.contentSha256??null,content_bytes:taskSource.contentBytes??null});
      taskLog?.event('LONG_TASK_RUNTIME_STARTED',{runtime_class:'LONG',hard_deadline_ms:LONG_TASK_HARD_DEADLINE_MS});
    }
    // P21.2 — a deterministic startPm() failure (composition/routing/config
    // — see isDeterministicTaskStartError() above) must settle this task
    // and let the Telegram/local ingress layer ack + advance past it,
    // exactly like any other OwnerControlError already does (telegram-
    // owner-client.mjs's pollOnce() only ever withholds the offset advance
    // for a NON-OwnerControlError, by design — R1-F). No backend was
    // spawned (the throw happens before any process is ever created), so
    // there is nothing to cancel/reap; there is also no pm_run row to mark
    // FAILED (composition never got far enough to create one) — the
    // terminal record for this failed start is this taskLog event plus the
    // owner-visible ack below. A genuinely transient error (bare Error, a
    // DB/network failure) is untouched: it still propagates uncaught so
    // OwnerRuntime's existing at-least-once retry keeps retrying it exactly
    // as before this fix.
    let pm;
    try{
      pm=this.startPm?await this.startPm({task,project,pmProfileId:profile.id,pmRunId}):null;
    }catch(error){
      if(!isDeterministicTaskStartError(error))throw error;
      taskLog?.event('TASK_START_FAILED',{code:error.code??null,message:error.message,product:error.product??null,profile_id:error.profileId??profile.id});
      // Re-thrown as an OwnerControlError so ingress (Telegram pollOnce(),
      // the local control pipe) treats this exactly like any other
      // deterministic acceptance-time refusal — ack, advance past it, tell
      // the owner why — rather than the "unknown error, keep retrying
      // forever" path reserved for genuinely transient infra failures. The
      // ORIGINAL `.code`/`.message` are preserved verbatim (never replaced
      // with a new generic code) so every existing caller/test that already
      // asserts on e.g. SINGLE_ARTIFACT_WIRING_DISABLED or
      // COUNCIL_ARTIFACT_DEPS_MISSING keeps working unchanged.
      throw new OwnerControlError(error.message,error.code,{taskId:id,pmRunId});
    }
    if(pm&&pm.pmRunId!==pmRunId)throw new OwnerControlError('PM materializer returned conflicting lineage','PM_RUN_ID_CONFLICT');
    // P7 Part O: the acceptance ack needs participants/rounds too (chair is
    // already `pm_profile_id` above) — additive field, absent for SINGLE mode.
    // P19-D6 (D6-A/B): `debate`/`implementation_participant_id` are
    // additionally hand-picked through here (still the SAME bounded DTO
    // discipline as `participant_profile_ids`/`rounds` above — never the
    // raw `council` object) so `renderOwnerAck()` can tell the owner, at
    // acceptance time, whether this is a plain Council, a Council+Debate,
    // or a Council+Debate+implementation-participant dispatch. Absent for
    // every council that didn't request them — byte-for-byte unaffected.
    // P18-W4 Part B: `client_correlation_id` is echoed back through the
    // SAME canonical-result path `task_id`/`pm_profile_id` already use —
    // renderOwnerAck() reads it from here, never from any model output.
    // Absent (not present at all, never null) when the owner never
    // supplied one, so an ordinary dispatch's ack shape is byte-for-byte
    // unaffected.
    return {status:'MATERIALIZED',task_id:id,pm_run_id:pmRunId,pm_profile_id:profile.id,...(clientCorrelationId?{client_correlation_id:clientCorrelationId}:{}),...(council?{council:{participant_profile_ids:council.participant_profile_ids,rounds:council.rounds,...(council.debate?.enabled?{debate:{enabled:true,max_rounds:council.debate.max_rounds}}:{}),...(council.implementation_participant_id?{implementation_participant_id:council.implementation_participant_id}:{})}}:{})};}
  async requestCancel({taskId}){if(!this.cancel||!this.resolveWorkItem)throw new OwnerControlError('cancellation integration unavailable','CANCELLATION_UNAVAILABLE');const work=await this.resolveWorkItem(taskId);const intent=await this.cancel(work.work_item_id);return {status:'CANCEL_REQUESTED',task_id:taskId,cancellation:intent.state};}
  async changeAutonomy({taskId,expectedRevision,requested,expand=false}){const current=this.repo.getOwnerTask(taskId);if(!current)throw new OwnerControlError('task not found','TASK_NOT_FOUND');let next;if(expand){if(current.envelopeRevision!==expectedRevision)throw new OwnerControlError('stale autonomy revision','STALE_AUTONOMY_REVISION');next=normalizeAutonomyEnvelope({...requested,revision:expectedRevision+1});}else next=narrowAutonomy(current.effectiveAutonomy,requested);const updated=this.repo.updateOwnerAutonomy(taskId,{expectedRevision,effectiveAutonomy:next});if(this.supersede)await this.supersede(taskId,expectedRevision);return {status:'AUTONOMY_UPDATED',task_id:taskId,envelope_revision:updated.envelopeRevision,effective_autonomy:updated.effectiveAutonomy};}
  getTask(id){return this.repo.getOwnerTask(id);} listTasks(input){return this.repo.listOwnerTasks(input);} getSummary(id){const t=this.getTask(id);return t&&{id:t.id,status:t.status,projectId:t.projectId,pmProfileId:t.pmProfileId,envelopeRevision:t.envelopeRevision};}
}
