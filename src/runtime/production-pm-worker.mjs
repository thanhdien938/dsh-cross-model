import { materializeProductArtifactPackage, ProductArtifactExportError } from '../pm/council/product-artifact-export.mjs';
import {join,posix} from 'node:path';
import {deterministicOwnerId} from '../owner/owner-contracts.mjs';
import {AwaitOwnerCoordinator} from '../owner/await-owner-coordinator.mjs';
import {buildTaskSummaryMarkdown,buildCouncilEvidenceJson} from './task-diagnostic-summary.mjs';
import {materializeTaskHistory,readEventsJsonlSafe} from './repo-history-materializer.mjs';
import {commitTaskResult,pushTaskResult,GitSyncError} from '../pm/task-result-git-sync.mjs';
import {verifyBoundBranch,assertTaskBranchPublishable,isWorktreeClean,restoreOriginalBranch,TaskBranchLifecycleError} from '../pm/task-branch-binding.mjs';
import {writeTaskReviewManifest,TaskReviewManifestError} from '../pm/task-review-manifest.mjs';
import {resolveExecutionRepoPath,resolveTaskWorkspaceBinding} from '../pm/task-execution-context.mjs';
import {cleanupTaskWorkspace as cleanupTaskWorkspaceImpl,TaskWorkspaceError} from '../pm/task-workspace-manager.mjs';
import {awaitOwnedSpawnReaping} from './backend-execution-observer.mjs';
import {normalizeAutonomyEnvelope} from '../owner/autonomy-envelope.mjs';
import {PM_OWNER_CANCEL_ABORT_REASON} from '../pm/durable-pm-runtime.mjs';
import {resolveTransportVersion} from '../artifacts/artifact-transport.mjs';
import {settlePmWorkFailure} from './pm-work-failure-settlement.mjs';
import {materializeWorkspaceOutput,assertWorkspaceOutputInResultCommit,assertWorkspaceOutputVerifiedOnRemote,WorkspaceOutputError} from '../pm/workspace-output-materializer.mjs';
import {GIT_SETTLEMENT_STATE,loadGitSettlement,transitionGitSettlement,buildTaskCommitTrailer,resolveCommitDescriptor,resolveRemoteBranchSha,computeStagedTreeSha,resolveCommitReuseDecision,COMMIT_REUSE_ACTION,verifyBaseIsAncestor} from '../pm/git-settlement-journal.mjs';

// P12-R5: PUSH_REMOTE is a pre-existing, real per-project autonomy effect
// (autonomy-envelope.mjs's LOCAL_ONLY_EFFECTS) — e.g. this repo's own
// `.runtime/live1/projects.yaml` sets it to FORBID for `live1-local`. This
// is DSH's first-ever capability that could actually trigger a remote
// push, so it is the first to consult that pre-existing authority, rather
// than silently bypassing it just because a task payload asked for
// `--push`. NOTE: this deliberately does NOT reuse
// assertEffectAuthorized()/GuardedEffectExecutor from autonomy-envelope.mjs
// — normalizeAutonomyEnvelope() unconditionally caps every LOCAL_ONLY_EFFECTS
// entry at 'APPROVAL' (never true 'ALLOW'), and assertEffectAuthorized()
// requires exactly 'ALLOW' to proceed, which would make a push
// UNCONDITIONALLY impossible regardless of project configuration — that
// framework appears designed for a different (interactive, park-and-await)
// approval flow this gate does not build. Instead: FORBID always blocks;
// APPROVAL is satisfied by the owner's own explicit, per-task `--push`
// request itself (a contemporaneous, authenticated approval act, not a
// standing grant); and — matching LOCAL_ONLY_EFFECTS' own intent exactly —
// a Telegram-originated task can never authorize it at any level, only a
// LOCAL (Desktop/pipe) dispatch can.
function isPushAuthorized(autonomy,{remote}={}){
  if(remote)return false;
  const mode=normalizeAutonomyEnvelope(autonomy).effects.PUSH_REMOTE??'FORBID';
  return mode!=='FORBID';
}
// P18-W4R2 — the PM's explicit push-policy instruction: "Replace the
// present blanket Telegram-origin refusal for the task-scoped publication
// path only. Do NOT simply make generic PUSH_REMOTE remotely unrestricted."
// isPushAuthorized() above is that generic gate and stays BYTE-FOR-BYTE
// unchanged — every task that never gets a task-branch binding (BRANCH_CREATE
// FORBID, or no branch bound) keeps the exact pre-P18 Telegram-origin
// refusal. This SEPARATE gate exists only for a task that already has a
// verified `dsh/task-<task_id>` binding (task-scoped, structurally
// incapable of touching main/master/release/production, force-push, or
// branch deletion — see assertTaskBranchPublishable()/task-branch-
// binding.mjs) — for that narrow, already-fenced case, Telegram origin is
// no longer an automatic veto (applies identically to Telegram/Desktop x
// SINGLE/COUNCIL/DEBATE, per the PM's mandate), gated only by the same
// PUSH_REMOTE effect every push already requires.
function isTaskBranchPushAuthorized(autonomy){
  const mode=normalizeAutonomyEnvelope(autonomy).effects.PUSH_REMOTE??'FORBID';
  return mode!=='FORBID';
}
import {executionStatusFromRunStatus,verificationStatusFromFinalData,buildTaskOutcome,ARTIFACT_STATUS,LOCAL_GIT_STATUS,REMOTE_SYNC_STATUS,REVIEW_STATUS} from '../pm/task-outcome-model.mjs';

export function pmWorkIdentity({taskId,pmRunId}){return Object.freeze({work_item_id:deterministicOwnerId('pmwork',pmRunId),work_kind:'PM_ACTION',pm_run_id:pmRunId,action_id:deterministicOwnerId('pmaction',taskId,pmRunId)});}
export function claimFence(claim){return Object.freeze({work_item_id:claim.work_item_id,owner_worker_incarnation_id:claim.owner_worker_incarnation_id,fencing_generation:claim.fencing_generation,fencing_token:claim.fencing_token});}

// P10-R0.2.3 Part K/M: the ONE shared, narrow, pure PM-identity resolver
// for a SINGLE (non-council) task — used identically by both the
// repository materializer's `pmProfileId` and the runtime diagnostic
// summary's `## PM` section, which previously duplicated (and, for the
// summary, WRONGLY re-derived) this. Evidence priority (Part K, exact):
//   1. `task.pmProfileId` — "task accepted pm_profile_id": the durable,
//      canonical field DSH itself used to launch this run
//      (`ProductionPmWorkHandler.execute()` passes this exact value to
//      `createRuntime({profileId:task.pmProfileId})` — never re-derived).
//   2. `run.pmProfileId` — "pm run canonical profile": `PmRepository
//      .load()`'s own durable `pm_runs.pm_profile_id` column, captured by
//      `DurablePmRuntime.prepare()` from the SAME profile-registry
//      resolution at run-creation time — independently durable from
//      `task`, so it survives even if the owner-task record itself were
//      ever unavailable.
//   3. `result.driver` — "production driver identity": DurablePmRuntime's
//      own driver identity string, an ALREADY-canonical DSH-owned
//      contract with the fixed shape `production:<product>:<profile.id>`
//      (createCliPmDriver() in production-pm-backend-registry.mjs) or
//      `scripted:<profile.id>` — parsed structurally (never scanned out
//      of arbitrary prose, per Part K's explicit prohibition), used only
//      when neither structured field above is available.
//   4. `null` (renders as `UNKNOWN`) only when none of the above exists.
// COUNCIL tasks never call this — `council.chair_profile_id` (durable,
// already correct) remains their one source, untouched by this wave.
// Matches BOTH real driver-name shapes DSH's own driver factories produce:
// `production:<product>:<profile.id>` (createCliPmDriver()) and
// `scripted:<profile.id>` (p5-production-composition.mjs's scripted-test
// driver) — never a generic 2-or-3-colon-segment heuristic that could
// misparse an unrelated string.
const DRIVER_NAME_RE=/^(?:production:[^:]+|scripted):(.+)$/;
export function resolveSinglePmProfileId({task,run,result}={}){
  if(task&&typeof task.pmProfileId==='string'&&task.pmProfileId)return task.pmProfileId;
  if(run&&typeof run.pmProfileId==='string'&&run.pmProfileId)return run.pmProfileId;
  const match=typeof result?.driver==='string'?result.driver.match(DRIVER_NAME_RE):null;
  return match?match[1]:null;
}

// P10-R0.1 Part L/M/P: finalize this task's summary.md (and, for a council
// task, its council.json) once a PmRun result reaches a terminal status.
// Reads ONLY what DurablePmRuntime's own `#result()` and `#history()`
// already expose (never raw model text) — see task-diagnostic-summary.mjs
// for what each section means. Best-effort by construction: `taskLog`'s own
// finalizeSummary()/writeCouncilJson() already never throw (Part P), and
// this function is itself wrapped by its only caller.
export function finalizeTaskDiagnostics({taskLog,taskId,projectId,taskMode,submittedVia,commandId=null,council,result,repoHandoff=null,timeoutDetail=null,pmDecisionContractDetail=null,pmProfileId=null}){
  if(!taskLog)return;
  const chairPlanTurn=(result.history??[]).find(h=>h.outcome?.finalResult?.handoff?.stepKind==='chair_plan');
  const chairPlanHandoff=chairPlanTurn?.outcome?.finalResult?.handoff??null;
  const repaired=chairPlanHandoff?.repaired===true;
  // P10-R0.1.1 Part I/K: per-real-attempt chair_plan evidence (bytes/parse
  // subreason/ok, zero-indexed) -- attached by CouncilStepWorkflowRunner
  // itself onto the chair_plan step's own handoff (council-step-workflow-
  // runner.mjs), never re-derived here from raw text.
  const chairPlanAttempts=Array.isArray(chairPlanHandoff?.attempts)?chairPlanHandoff.attempts:[];
  const participantIdRepairUsed=chairPlanHandoff?.participant_id_repair_used===true;
  // P10-R0.1.2 Part P: bounded native-structured-output evidence (never a
  // full schema/prompt dump) -- null for every non-chair_plan/non-claude
  // chair (council-step-workflow-runner.mjs's structuredOutputSummary()).
  const chairPlanStructuredOutput=chairPlanHandoff?.structured_output??null;
  // Part I: "participants spawned: NO / reason: chair plan never
  // validated" -- computed from REAL turn history, never inferred/guessed.
  const participantSpawned=(result.history??[]).some(h=>h.outcome?.finalResult?.handoff?.stepKind==='participant_report');
  const participantsSpawnedReason=!participantSpawned&&chairPlanHandoff&&!chairPlanHandoff.ok?'chair plan never validated':!participantSpawned?'no participant step reached':null;
  const timeline=(result.history??[]).map(h=>{const handoff=h.outcome?.finalResult?.handoff;if(!handoff)return `turn ${h.turn}: ${h.decision?.type??'unknown'}`;return `turn ${h.turn}: ${handoff.stepKind}${handoff.participantProfileId?` (${handoff.participantProfileId})`:''} -> ${handoff.ok?'ok':`failed: ${handoff.reason??'unknown'}`}`;});
  const data=result.data??{};
  taskLog.finalizeSummary(buildTaskSummaryMarkdown({
    taskId,projectId,taskMode,submittedVia,commandId,createdAt:result.startedAt??null,completedAt:result.completedAt??null,
    // P10-R0.2.3 Part K: was `data.pmProfileId` -- `result.data` is the
    // model's OWN optional `finish.data` payload, which never carried a
    // `pmProfileId` field for a SINGLE task in the first place (that field
    // name doesn't exist in the PM decision contract at all -- pm-
    // contracts.mjs); this always evaluated to `null` -> `UNKNOWN`, even
    // though the real profile identity was known durably the whole time.
    chairProfileId:council?council.chair_profile_id:pmProfileId,
    participantProfileIds:council?council.participant_profile_ids:[],rounds:council?council.rounds:null,
    status:result.status,errorCode:result.error?.code??result.error?.name??null,errorReason:result.error?.message??null,
    outputPreview:result.output??'',degraded:Boolean(data.degraded),
    completedParticipants:data.completed_participants??[],failedParticipants:data.failed_participants??[],
    repaired,timeline,chairPlanAttempts,participantIdRepairUsed,chairPlanStructuredOutput,
    participantsSpawned:council?participantSpawned:null,participantsSpawnedReason:council?participantsSpawnedReason:null,
    repoHandoff,timeoutDetail,pmDecisionContractDetail,
  }));
  if(council){
    taskLog.writeCouncilJson(buildCouncilEvidenceJson({
      councilId:result.pmRunId,chairProfileId:council.chair_profile_id,participantProfileIds:council.participant_profile_ids,
      rounds:council.rounds,strategy:council.strategy,degraded:Boolean(data.degraded),
      completedParticipants:data.completed_participants??[],failedParticipants:data.failed_participants??[],
      status:result.status,repaired,chairPlanAttempts,chairPlanValidated:chairPlanHandoff?chairPlanHandoff.ok===true:null,
      participantIdRepairUsed,chairPlanStructuredOutput,
    }));
  }
}

export class PmClaimAuthorityLostError extends Error{constructor(cause){super('PM claim authority was lost during execution');this.name='PmClaimAuthorityLostError';this.code='PM_CLAIM_AUTHORITY_LOST';this.cause=cause;}}

export function startPmClaimRenewal({coordinationStore,fence,leaseMs}={}){
  if(!coordinationStore||typeof coordinationStore.renewClaim!=='function')throw new TypeError('coordinationStore.renewClaim is required');
  const intervalMs=Math.max(25,Math.floor(leaseMs/3));let timer=null,inFlight=null,stopped=false,lost=null,count=0;
  const schedule=()=>{if(!stopped)timer=setTimeout(tick,intervalMs);};
  const tick=()=>{if(stopped)return;inFlight=(async()=>{try{await coordinationStore.renewClaim(fence,leaseMs);count+=1;}catch(cause){lost=new PmClaimAuthorityLostError(cause);stopped=true;}finally{inFlight=null;if(!stopped)schedule();}})();};
  schedule();
  return Object.freeze({get renewalCount(){return count;},get lost(){return lost;},async stop(){stopped=true;if(timer!==null)clearTimeout(timer);await inFlight;if(lost)throw lost;return count;}});
}

/**
 * P24.1G7A — the ONE Git-settlement primitive, shared by a fresh completion
 * (execute()'s normal path, below) AND by adoption-time crash recovery
 * (execute()'s `run.status!=='running'` branch) — reports/
 * P24_1G7_SINGLE_SETTLEMENT_GIT_WORKFLOW_AUDIT_20260916.md "Proposed
 * Settlement State Machine"/"Failure / Recovery Semantics".
 *
 * Materializes the typed workspace report and P20 review manifest
 * (deterministic bytes from immutable sources — idempotent, safe to redo on
 * recovery), creates AT MOST ONE result commit for this `taskId` ever
 * (reusing an existing one via its `DSH-Task-Id:` trailer on the task
 * branch tip rather than creating a second semantic commit — §12 CASE B),
 * then pushes AT MOST ONCE, verifying the remote branch BEFORE ever issuing
 * a push so an ambiguous/already-delivered prior attempt is reconciled
 * (§13) instead of blindly repeated. There is no separate "history" commit
 * — `materializeTaskHistory()` (called by the caller, after this returns)
 * now writes to a durable non-Git root and therefore never dirties this
 * task branch's tree at all.
 *
 * `handler` is the `ProductionPmWorkHandler` instance — only
 * `resolveProjectArtifactStore` and `tasks` (the settlement-journal
 * repository) are read from it. Journal writes are best-effort
 * observability: `git-settlement-journal.mjs` degrades to a no-op for a
 * `taskRepository` that predates schema v8 (a bare test stub), and any
 * journal write failure here is swallowed — the real, durable settlement
 * fact is always the Git object/ref itself, never the journal row alone.
 */
// P24.3B §13 — `execRepoPath` is the ONE explicit execution root every
// mutable Git operation below runs against: `task.workspace_path` for an
// isolated v1 task, or `project.repo_path` (byte-for-byte pre-P24.3
// behavior) for every legacy task — resolved ONCE by the caller
// (task-execution-context.mjs's resolveExecutionRepoPath()), never
// re-derived here. Every row this function touches is either a mutable
// workspace/HEAD/index operation (must move for v1 — the audit's own
// per-row classification) or a checkout-independent repository-identity
// read (`git rev-parse <branch-name>`/`resolveRemoteBranchSha`/etc. —
// safe against EITHER path, since linked worktrees of one repository
// share the same objects/refs) — there is no row where using
// `execRepoPath` uniformly is unsafe.
async function settleGitResult(handler,{project,taskBranchBinding,taskId,taskMode,gitSync,workspaceOutput,resultData,pmRunId,isTelegramOrigin,taskLog,execRepoPath}){
  const repoPath=execRepoPath??project.repo_path;
  let localGitStatus=LOCAL_GIT_STATUS.NOT_REQUESTED,remoteSyncStatus=REMOTE_SYNC_STATUS.NOT_REQUESTED,resultCommit=null,publishedHead=null;
  let workspaceOutputOutcome=null,workspaceOutputBlobSha1=null,productPackage=null;
  const journalSafe=(mutate)=>{try{transitionGitSettlement(handler.tasks,taskId,mutate);}catch{/* observability only; Git itself remains the durable truth */}};
  if(!gitSync){
    try{const{record}=loadGitSettlement(handler.tasks,taskId);if(record.state===GIT_SETTLEMENT_STATE.UNSETTLED)journalSafe(()=>({state:GIT_SETTLEMENT_STATE.NOT_APPLICABLE}));}catch{/* observability only */}
    return{localGitStatus,remoteSyncStatus,resultCommit,publishedHead,workspaceOutputOutcome};
  }
  // P24.1G7B §7/§9 — checkout-INDEPENDENT reuse detection, done BEFORE
  // anything that requires a specific checkout (workspace-output
  // materialization, review-manifest writing, the commit itself). `git
  // rev-parse <branch-name>` resolves a local branch by name regardless of
  // what is currently checked out, so a recovery call firing AFTER a prior
  // attempt already fully settled AND restored the worktree to its
  // original branch still recognizes "nothing left to do" without ever
  // requiring the task branch to be checked out again. Once durable tree
  // evidence exists, a `DSH-Task-Id:` trailer match ALONE is no longer
  // sufficient — `resolveCommitReuseDecision()` requires the tip's tree to
  // match the recorded evidence too, and fails closed (never silently
  // reuses, never blindly commits on top of unexplained content) on a
  // moved result commit, a mismatched tree, or foreign content already on
  // this exclusively-DSH-owned branch (§9 CASES 2/3/4).
  const {record:journalRecordForDecision}=loadGitSettlement(handler.tasks,taskId);
  const reuseDecision=gitSync.commit?await resolveCommitReuseDecision({projectRepoPath:repoPath,taskBranchBinding,taskId,journalRecord:journalRecordForDecision}):null;
  if(reuseDecision?.action===COMMIT_REUSE_ACTION.BLOCKED){
    localGitStatus=LOCAL_GIT_STATUS.FAILED;
    try{taskLog?.event('GIT_SYNC_COMMIT_BLOCKED',{code:reuseDecision.code,sha:reuseDecision.sha,tree:reuseDecision.treeSha});}catch{/* never let logging affect the real outcome */}
    journalSafe((cur)=>({...cur,state:GIT_SETTLEMENT_STATE.BLOCKED,error_code:reuseDecision.code}));
  }
  const alreadyCommitted=reuseDecision?.action===COMMIT_REUSE_ACTION.REUSE;
  if(alreadyCommitted){
    resultCommit=reuseDecision.sha;publishedHead=reuseDecision.sha;localGitStatus=LOCAL_GIT_STATUS.VERIFIED;
    try{taskLog?.event('GIT_SYNC_COMMIT_REUSED',{sha:resultCommit,backfilled:Boolean(reuseDecision.backfilled)});}catch{/* never let logging affect the real outcome */}
    journalSafe((cur)=>({state:GIT_SETTLEMENT_STATE.COMMIT_CREATED,task_branch:taskBranchBinding?.task_branch??cur.task_branch??null,task_base_sha:taskBranchBinding?.base_sha??cur.task_base_sha??null,result_commit_sha:resultCommit,result_tree_sha:reuseDecision.treeSha,commit_created_at:cur.commit_created_at??new Date().toISOString()}));
  }
  if(!alreadyCommitted&&localGitStatus!==LOCAL_GIT_STATUS.FAILED&&gitSync.commit&&taskMode==='COUNCIL'&&resultData?.transport_version==='artifact_v1'){
    try{
      if(taskBranchBinding)await verifyBoundBranch({projectRepoPath:repoPath,binding:taskBranchBinding,stage:'PRE_PRODUCT_EXPORT'});
      const prefix=`reports/dsh-tasks/${taskId}`;
      const requestedPath=workspaceOutput?.report_path?posix.normalize(workspaceOutput.report_path.replaceAll('\\','/')).toLowerCase():null;
      if(requestedPath&&(requestedPath===prefix.toLowerCase()||requestedPath.startsWith(prefix.toLowerCase()+'/')))throw new ProductArtifactExportError('workspace_output collides with task product package');
      productPackage=materializeProductArtifactPackage({repoRoot:repoPath,store:handler.resolveProjectArtifactStore?.(project.id),taskId,projectId:project.id,baseSha:taskBranchBinding?.base_sha??null,run:handler.pm.load(pmRunId)});
      taskLog?.event('PRODUCT_ARTIFACT_PACKAGE_MATERIALIZED',{path:productPackage.prefix,files:productPackage.files.size});
    }catch(error){
      localGitStatus=LOCAL_GIT_STATUS.FAILED;
      journalSafe(cur=>({...cur,state:GIT_SETTLEMENT_STATE.BLOCKED,error_code:error.code??'PRODUCT_ARTIFACT_EXPORT_FAILED'}));
      try{taskLog?.event('PRODUCT_ARTIFACT_EXPORT_FAILED',{code:error.code??'PRODUCT_ARTIFACT_EXPORT_FAILED'});}catch{}
    }
  }
  if(!alreadyCommitted&&localGitStatus!==LOCAL_GIT_STATUS.FAILED&&workspaceOutput){
    if(!gitSync.commit){
      // Defense in depth only — submit() already refuses this shape.
      localGitStatus=LOCAL_GIT_STATUS.FAILED;
      workspaceOutputOutcome={requested:true,path:workspaceOutput.report_path,materialization_status:'FAILED',error_code:'WORKSPACE_OUTPUT_REQUIRES_GIT_COMMIT'};
    }else{
      try{taskLog?.event('WORKSPACE_OUTPUT_MATERIALIZATION_START',{report_path:workspaceOutput.report_path});}catch{/* never let logging affect the real outcome */}
      try{
        if(taskBranchBinding)await verifyBoundBranch({projectRepoPath:repoPath,binding:taskBranchBinding,stage:'PRE_WORKSPACE_OUTPUT'});
        const finalRef=resultData?.final_ref??null;
        if(!finalRef)throw new WorkspaceOutputError('workspace_output requires a sealed final_ref; none is present on this completed result','WORKSPACE_OUTPUT_NO_SEALED_ARTIFACT');
        const store=handler.resolveProjectArtifactStore?handler.resolveProjectArtifactStore(project.id):null;
        if(!store)throw new WorkspaceOutputError('no artifact store is configured for this project; cannot materialize workspace_output','WORKSPACE_OUTPUT_STORE_UNAVAILABLE');
        const materialized=materializeWorkspaceOutput({repoRoot:repoPath,reportPath:workspaceOutput.report_path,storeRoot:store.root,artifactRelpath:finalRef.artifact_relpath,expectedSha256:finalRef.sha256,expectedBytes:finalRef.bytes,nonEmpty:workspaceOutput.non_empty});
        workspaceOutputBlobSha1=materialized.blobSha1;
        workspaceOutputOutcome={requested:true,path:materialized.relPath,sha256:materialized.sha256,bytes:materialized.bytes,materialization_status:'VERIFIED'};
        taskLog?.event('WORKSPACE_OUTPUT_MATERIALIZATION_COMPLETED',{path:materialized.relPath,sha256:materialized.sha256,bytes:materialized.bytes});
      }catch(error){
        localGitStatus=LOCAL_GIT_STATUS.FAILED;
        const code=error instanceof WorkspaceOutputError?error.code:(error instanceof TaskBranchLifecycleError?error.code:'WORKSPACE_OUTPUT_MATERIALIZATION_FAILED');
        workspaceOutputOutcome={requested:true,path:workspaceOutput.report_path,materialization_status:'FAILED',error_code:code};
        try{taskLog?.event('WORKSPACE_OUTPUT_MATERIALIZATION_FAILED',{code});}catch{/* never let logging affect the real outcome */}
      }
    }
  }
  if(!alreadyCommitted&&gitSync.commit&&localGitStatus!==LOCAL_GIT_STATUS.FAILED){
    try{taskLog?.event('GIT_SYNC_COMMIT_START',{});}catch{/* never let logging affect the real outcome */}
    journalSafe((cur)=>(cur.state===GIT_SETTLEMENT_STATE.UNSETTLED?{state:GIT_SETTLEMENT_STATE.PREPARING,task_branch:taskBranchBinding?.task_branch??null,task_base_sha:taskBranchBinding?.base_sha??null}:{}));
    try{
      // Reaching here means no existing result commit was found — this IS
      // genuinely new work, so the checkout MUST match the bound branch
      // before anything is written (defense in depth, unchanged from
      // pre-G7A behavior for a first-time completion).
      if(taskBranchBinding)await verifyBoundBranch({projectRepoPath:repoPath,binding:taskBranchBinding,stage:'PRE_COMMIT'});
      if(gitSync.push){
        const candidateFinalRef=resultData?.final_ref;
        if(candidateFinalRef!==undefined&&candidateFinalRef!==null){
          // Council/Debate share this exact outer worker lifecycle — the
          // review manifest alone must record Debate truthfully, per its
          // own already-durable `resultData` topology facts.
          const isDebate=taskMode==='COUNCIL'&&resultData?.type==='council_debate'&&resultData?.debate?.enabled===true;
          const reviewTaskMode=taskMode==='COUNCIL'?(isDebate?'DEBATE':'COUNCIL'):taskMode;
          const topology=taskMode==='SINGLE'?null:{
            chair_profile_id:resultData?.chair_profile_id??null,
            participant_profile_ids:Array.isArray(resultData?.participant_profile_ids)?resultData.participant_profile_ids:null,
            rounds:Number.isInteger(resultData?.rounds)?resultData.rounds:null,
            strategy:typeof resultData?.strategy==='string'?resultData.strategy:null,
            ...(isDebate?{debate:{enabled:true,rounds_run:Number.isInteger(resultData?.debate?.rounds_run)?resultData.debate.rounds_run:null,max_rounds:Number.isInteger(resultData?.debate?.max_rounds)?resultData.debate.max_rounds:null}}:{}),
          };
          const manifestOutcome=writeTaskReviewManifest({
            projectRepoPath:repoPath,taskId,projectId:project.id,taskMode:reviewTaskMode,
            branch:taskBranchBinding?.task_branch??null,baseSha:taskBranchBinding?.base_sha??null,
            artifactTransport:resultData?.transport_version??null,finalRef:candidateFinalRef,topology,
            workspaceOutput:workspaceOutputOutcome,
          });
          taskLog?.event('TASK_REVIEW_MANIFEST_WRITTEN',{path:manifestOutcome.relPath,written:manifestOutcome.written,task_mode:reviewTaskMode});
        }
      }
      // P24.1G7B §8 — compute the intended staged tree BEFORE committing
      // and record it durably now (PREPARING), not only after the commit
      // exists — closing the crash window between "commit created" and
      // "journal write" a purely post-commit read would leave open. A
      // `null` result (tree could not be determined) degrades to the
      // purely post-commit read below, never blocks settlement on its own.
      const intendedTreeSha=await computeStagedTreeSha({projectRepoPath:repoPath});
      if(productPackage){
        if(!intendedTreeSha)throw new ProductArtifactExportError('cannot verify staged product package');
        for(const blob of productPackage.blobs)await assertWorkspaceOutputInResultCommit({projectRepoPath:repoPath,commitSha:intendedTreeSha,reportPath:blob.path,expectedBlobSha1:blob.blobSha1});
      }
      if(intendedTreeSha){
        journalSafe((cur)=>({...cur,state:GIT_SETTLEMENT_STATE.PREPARING,task_branch:taskBranchBinding?.task_branch??cur.task_branch??null,task_base_sha:taskBranchBinding?.base_sha??cur.task_base_sha??null,result_tree_sha:intendedTreeSha}));
      }
      const commitOutcome=await commitTaskResult({projectRepoPath:repoPath,message:`DSH: ${taskMode.toLowerCase()} task ${taskId} result\n\n${buildTaskCommitTrailer(taskId)}`});
      const commitSha=commitOutcome.sha,committedNow=commitOutcome.committed;
      // P12-R5B Part J/K: `committed` is commitTaskResult()'s own
      // INDEPENDENTLY-VERIFIED fact — surfaced as a distinct status rather
      // than folded into the same VERIFIED value a real new commit gets,
      // so "nothing was actually dirty" is never indistinguishable from
      // "a change was committed".
      taskLog?.event('GIT_SYNC_COMMIT_COMPLETED',{sha:commitSha,committed:committedNow});
      localGitStatus=committedNow?LOCAL_GIT_STATUS.VERIFIED:LOCAL_GIT_STATUS.VERIFIED_NO_CHANGES;
      if(!committedNow){
        // P24.1G7B §5/§17 — a truly no-op task (nothing dirty at all —
        // never happens when workspace_output was requested, since that
        // always materializes a real file first) leaves `resultCommit`
        // `null`: there is no result to push, ever, regardless of
        // `gitSync.push` — internal settlement/history/journal machinery
        // existing is never allowed to manufacture a Git side effect for a
        // task with zero actual target-repository output.
        journalSafe((cur)=>({...cur,state:GIT_SETTLEMENT_STATE.SETTLED}));
      }else{
        resultCommit=commitSha;publishedHead=commitSha;
        if(workspaceOutputOutcome?.materialization_status==='VERIFIED'){
          await assertWorkspaceOutputInResultCommit({projectRepoPath:repoPath,commitSha,reportPath:workspaceOutputOutcome.path,expectedBlobSha1:workspaceOutputBlobSha1});
          taskLog?.event('WORKSPACE_OUTPUT_VERIFIED_IN_RESULT_COMMIT',{path:workspaceOutputOutcome.path,commit:commitSha});
        }
        const commitTreeSha=(await resolveCommitDescriptor({projectRepoPath:repoPath,ref:commitSha}))?.treeSha??null;
        if(intendedTreeSha&&commitTreeSha&&intendedTreeSha!==commitTreeSha){
          // Anomaly, never silently trusted: something changed the tree
          // between the pre-commit `write-tree` and the actual commit
          // (e.g. an uncontrolled hook, or a concurrent writer this
          // worktree's own ownership guarantees should have prevented).
          // Fail closed exactly like any other Git-lifecycle defect —
          // never journal a result whose evidence disagrees with itself.
          throw new GitSyncError('committed tree does not match the intended staged tree','LOCAL_GIT_FAILED',{reason:'TREE_MISMATCH_POST_COMMIT'});
        }
        journalSafe((cur)=>({state:GIT_SETTLEMENT_STATE.COMMIT_CREATED,task_branch:taskBranchBinding?.task_branch??cur.task_branch??null,task_base_sha:taskBranchBinding?.base_sha??cur.task_base_sha??null,result_commit_sha:commitSha,result_tree_sha:commitTreeSha??intendedTreeSha,commit_created_at:cur.commit_created_at??new Date().toISOString()}));
      }
    }catch(commitError){
      localGitStatus=LOCAL_GIT_STATUS.FAILED;
      const commitErrorCode=commitError instanceof TaskBranchLifecycleError?commitError.code:(commitError instanceof GitSyncError?commitError.code:(commitError instanceof TaskReviewManifestError?commitError.code:(commitError instanceof WorkspaceOutputError?commitError.code:'LOCAL_GIT_FAILED')));
      try{taskLog?.event('GIT_SYNC_COMMIT_FAILED',{code:commitErrorCode,...(commitError instanceof TaskBranchLifecycleError?{expected_task_branch:commitError.expected_task_branch??null,observed_branch:commitError.observed_branch??null,stage:commitError.stage??null}:{})});}catch{/* never let logging affect the real outcome */}
      journalSafe((cur)=>({...cur,state:GIT_SETTLEMENT_STATE.BLOCKED,error_code:commitErrorCode}));
      if(gitSync.push){try{taskLog?.event('GIT_SYNC_PUSH_SKIPPED',{reason:'COMMIT_FAILED'});}catch{/* never let logging affect the real outcome */}}
    }
  }
  // P24.1G6A §18 — the ONE settlement-side check the dynamic-base
  // migration adds: the task's OWN immutable admission pin
  // (`taskBranchBinding.base_sha`) must be an ancestor of the result
  // commit, verified entirely offline against already-local objects.
  // Never fetches or compares against the CURRENT remote base branch —
  // base movement after admission is expected and must never block
  // settlement (§2/§19). A bound task whose result fails this check is an
  // integrity anomaly (never expected in normal operation, since the task
  // branch is by construction created from base_sha) and fails closed
  // rather than publishing a result that cannot be proven to descend from
  // its own pin.
  if(resultCommit&&localGitStatus!==LOCAL_GIT_STATUS.FAILED&&taskBranchBinding?.base_sha){
    const isAncestor=await verifyBaseIsAncestor({projectRepoPath:repoPath,ancestorSha:taskBranchBinding.base_sha,descendantSha:resultCommit});
    if(!isAncestor){
      localGitStatus=LOCAL_GIT_STATUS.FAILED;
      try{taskLog?.event('GIT_SYNC_BASE_ANCESTRY_FAILED',{base:taskBranchBinding.base_sha,result:resultCommit});}catch{/* never let logging affect the real outcome */}
      journalSafe((cur)=>({...cur,state:GIT_SETTLEMENT_STATE.BLOCKED,error_code:'RESULT_BASE_ANCESTRY_FAILED'}));
    }
  }
  if(gitSync.push&&localGitStatus!==LOCAL_GIT_STATUS.FAILED&&resultCommit){
    const remoteName=gitSync.remote??'origin';
    const authorized=taskBranchBinding?isTaskBranchPushAuthorized(project.autonomy):isPushAuthorized(project.autonomy,{remote:isTelegramOrigin});
    if(!authorized){
      remoteSyncStatus=REMOTE_SYNC_STATUS.FAILED;
      const code=taskBranchBinding?'PUSH_REMOTE_FORBIDDEN':(isTelegramOrigin?'REMOTE_EFFECT_REFUSED':'PUSH_REMOTE_FORBIDDEN');
      try{taskLog?.event('GIT_SYNC_PUSH_FAILED',{code});}catch{/* never let logging affect the real outcome */}
    }else if(!taskBranchBinding){
      // P24.1G7A — the legacy UNBOUND path publishes to whatever branch is
      // currently checked out (e.g. `main`) — a SHARED, ever-advancing
      // branch that legitimately already has prior history unrelated to
      // this task. "Remote already has different content" is the NORMAL
      // case there, not a conflict, so the bound path's verify-then-decide
      // protocol below (designed for the exclusively-DSH-owned
      // `dsh/task-<id>` namespace, where any pre-existing divergent
      // content really would indicate tampering or a duplicate settlement)
      // does not apply. This branch is BYTE-FOR-BYTE the pre-G7A unbound
      // push behavior — ordinary `git push`, which itself already refuses
      // non-fast-forward updates.
      try{
        journalSafe((cur)=>({...cur,state:GIT_SETTLEMENT_STATE.PUSHING,push_remote:remoteName,push_attempt_consumed:true}));
        const pushOutcome=await pushTaskResult({projectRepoPath:repoPath,remote:remoteName});
        remoteSyncStatus=REMOTE_SYNC_STATUS.VERIFIED;
        taskLog?.event('GIT_SYNC_PUSH_COMPLETED',{remote:pushOutcome.remote,branch:pushOutcome.branch,sha:pushOutcome.sha});
        journalSafe((cur)=>({...cur,state:GIT_SETTLEMENT_STATE.SETTLED,remote_verified_sha:resultCommit,push_verified_at:cur.push_verified_at??new Date().toISOString()}));
        if(workspaceOutputOutcome?.materialization_status==='VERIFIED'){
          try{
            await assertWorkspaceOutputVerifiedOnRemote({projectRepoPath:repoPath,remoteSha:pushOutcome.sha,reportPath:workspaceOutputOutcome.path,expectedBlobSha1:workspaceOutputBlobSha1});
            taskLog?.event('WORKSPACE_OUTPUT_REMOTE_VERIFIED',{path:workspaceOutputOutcome.path,sha:pushOutcome.sha});
          }catch(verifyError){
            remoteSyncStatus=REMOTE_SYNC_STATUS.FAILED;
            try{taskLog?.event('WORKSPACE_OUTPUT_REMOTE_VERIFY_FAILED',{code:verifyError instanceof WorkspaceOutputError?verifyError.code:'WORKSPACE_OUTPUT_REMOTE_VERIFY_FAILED'});}catch{/* never let logging affect the real outcome */}
          }
        }
      }catch(pushError){
        remoteSyncStatus=REMOTE_SYNC_STATUS.FAILED;
        try{taskLog?.event('GIT_SYNC_PUSH_FAILED',{code:pushError instanceof GitSyncError?pushError.code:'REMOTE_SYNC_FAILED'});}catch{/* never let logging affect the real outcome */}
      }
    }else{
      try{
        const branchToPush=taskBranchBinding.task_branch;
        journalSafe((cur)=>({...cur,state:GIT_SETTLEMENT_STATE.PUSHING,push_remote:remoteName,push_branch:branchToPush,push_attempt_consumed:true}));
        // P24.1G7A §13 — the bound task branch is exclusively DSH's own
        // namespace: fetch it and compare against our result commit BEFORE
        // ever issuing a push, checkout-independent (a recovery call
        // firing after a prior attempt already fully settled AND restored
        // the worktree must still recognize "already published" without
        // requiring the task branch to be checked out again). Equal -> a
        // prior attempt already published it; record verified, never push
        // again (§13 CASE C/D) — and never even touch checkout/
        // cleanliness for that no-op case. Genuinely absent -> safe to
        // push for the first time (also covers a recovery whose prior
        // PUSHING record never actually reached the network) — ONLY this
        // branch requires the checkout-dependent guards, since it is the
        // one case that actually writes. A DIFFERENT SHA, or "could not
        // determine", fails closed rather than guessing (a foreign/
        // tampered task branch, never legitimate prior history).
        const verify=await resolveRemoteBranchSha({projectRepoPath:repoPath,remote:remoteName,branch:branchToPush});
        if(verify.determined&&verify.exists&&verify.sha===resultCommit){
          remoteSyncStatus=REMOTE_SYNC_STATUS.VERIFIED;
          try{taskLog?.event('GIT_SYNC_PUSH_ALREADY_VERIFIED',{remote:remoteName,branch:branchToPush,sha:verify.sha});}catch{/* never let logging affect the real outcome */}
        }else if(verify.determined&&verify.exists){
          remoteSyncStatus=REMOTE_SYNC_STATUS.FAILED;
          journalSafe((cur)=>({...cur,state:GIT_SETTLEMENT_STATE.BLOCKED,error_code:'REMOTE_BRANCH_CONFLICT'}));
          try{taskLog?.event('GIT_SYNC_PUSH_BLOCKED_REMOTE_CONFLICT',{remote:remoteName,branch:branchToPush,remote_sha:verify.sha,expected_sha:resultCommit});}catch{/* never let logging affect the real outcome */}
        }else if(verify.determined){
          assertTaskBranchPublishable({binding:taskBranchBinding,requestedBranch:taskBranchBinding.task_branch,requestedRemote:remoteName});
          await verifyBoundBranch({projectRepoPath:repoPath,binding:taskBranchBinding,stage:'PRE_PUSH'});
          const clean=await isWorktreeClean({projectRepoPath:repoPath});
          if(!clean)throw new TaskBranchLifecycleError('worktree is not clean after settlement','TASK_BRANCH_WORKTREE_NOT_CLEAN',{});
          const pushOutcome=await pushTaskResult({projectRepoPath:repoPath,remote:remoteName,branch:branchToPush});
          remoteSyncStatus=REMOTE_SYNC_STATUS.VERIFIED;
          try{taskLog?.event('GIT_SYNC_PUSH_COMPLETED',{remote:pushOutcome.remote,branch:pushOutcome.branch,sha:pushOutcome.sha});}catch{/* never let logging affect the real outcome */}
        }else{
          remoteSyncStatus=REMOTE_SYNC_STATUS.FAILED;
          try{taskLog?.event('GIT_SYNC_PUSH_BLOCKED_REMOTE_UNVERIFIED',{remote:remoteName,branch:branchToPush});}catch{/* never let logging affect the real outcome */}
        }
        if(remoteSyncStatus===REMOTE_SYNC_STATUS.VERIFIED){
          journalSafe((cur)=>({...cur,state:GIT_SETTLEMENT_STATE.SETTLED,remote_verified_sha:resultCommit,push_verified_at:cur.push_verified_at??new Date().toISOString()}));
          if(workspaceOutputOutcome?.materialization_status==='VERIFIED'){
            try{
              await assertWorkspaceOutputVerifiedOnRemote({projectRepoPath:repoPath,remoteSha:resultCommit,reportPath:workspaceOutputOutcome.path,expectedBlobSha1:workspaceOutputBlobSha1});
              taskLog?.event('WORKSPACE_OUTPUT_REMOTE_VERIFIED',{path:workspaceOutputOutcome.path,sha:resultCommit});
            }catch(verifyError){
              remoteSyncStatus=REMOTE_SYNC_STATUS.FAILED;
              try{taskLog?.event('WORKSPACE_OUTPUT_REMOTE_VERIFY_FAILED',{code:verifyError instanceof WorkspaceOutputError?verifyError.code:'WORKSPACE_OUTPUT_REMOTE_VERIFY_FAILED'});}catch{/* never let logging affect the real outcome */}
            }
          }
        }
      }catch(pushError){
        remoteSyncStatus=REMOTE_SYNC_STATUS.FAILED;
        const pushErrorCode=pushError instanceof TaskBranchLifecycleError?pushError.code:(pushError instanceof GitSyncError?pushError.code:'REMOTE_SYNC_FAILED');
        try{taskLog?.event('GIT_SYNC_PUSH_FAILED',{code:pushErrorCode,...(pushError instanceof TaskBranchLifecycleError?{expected_task_branch:pushError.expected_task_branch??null,observed_branch:pushError.observed_branch??null,stage:pushError.stage??null}:{})});}catch{/* never let logging affect the real outcome */}
      }
    }
  }else if(!gitSync.push&&resultCommit&&localGitStatus!==LOCAL_GIT_STATUS.FAILED){
    journalSafe((cur)=>({...cur,state:GIT_SETTLEMENT_STATE.SETTLED}));
  }
  return{localGitStatus,remoteSyncStatus,resultCommit,publishedHead,workspaceOutputOutcome};
}

export class ProductionPmWorkHandler{
  // P10-R0.1 Part H/L/M: `taskDiagnosticsFactory`, when supplied, is
  // `({taskId,projectId,pmRunId,taskMode})=>TaskDiagnosticLog|null` (same
  // shape OwnerTaskController/createRuntime already use — see
  // p5-production-composition.mjs). Optional and purely observational.
  // P10-R0.2 Part Q/S: `profileRegistry`/`enableRepoHistoryMaterialization`
  // are purely additive and default to a no-op (mirrors
  // `taskDiagnosticsFactory`'s own opt-in pattern) — the large existing
  // P2-P9 test suite, which constructs this handler directly without these
  // two deps, gets zero new disk I/O it never asked for.
  constructor({coordinationStore,pmRepository,ownerRepository,taskRepository,projects,createRuntime,taskDiagnosticsFactory=null,profileRegistry=null,enableRepoHistoryMaterialization=false,resolveProjectArtifactStore=null,resolveProjectHistoryRoot=null,cleanupTaskWorkspace=cleanupTaskWorkspaceImpl}={}){if(!coordinationStore||!pmRepository||!ownerRepository||!taskRepository||typeof createRuntime!=='function')throw new TypeError('PM work handler dependencies required');this.coordination=coordinationStore;this.pm=pmRepository;this.owner=ownerRepository;this.tasks=taskRepository;this.projects=new Map(projects.map(v=>[v.id,v]));this.createRuntime=createRuntime;this.taskDiagnosticsFactory=typeof taskDiagnosticsFactory==='function'?taskDiagnosticsFactory:null;this.profileRegistry=profileRegistry;this.enableRepoHistoryMaterialization=Boolean(enableRepoHistoryMaterialization);
    // P24.3B — the ONE isolated-workspace cleanup primitive every v1-aware
    // terminal path above calls through `this.cleanupTaskWorkspace(...)`,
    // never `cleanupTaskWorkspaceImpl` directly (so a test can inject a
    // fault-injected/fake implementation exactly like every other DI seam
    // on this class). Defaults to the real P24.3A implementation — every
    // existing caller that omits this is unaffected UNLESS it also stamps
    // a task with `context.taskWorkspace` (which nothing does yet; see
    // task-workspace-manager.mjs / owner-task-controller.mjs).
    this.cleanupTaskWorkspace=typeof cleanupTaskWorkspace==='function'?cleanupTaskWorkspace:cleanupTaskWorkspaceImpl;
    // P24.1G2 — `(projectId)=>ArtifactStore|null`, the SAME resolver
    // p5-production-composition.mjs already builds for artifact_v1 Council
    // wiring (`resolveProjectArtifactStore`) — reused here, never a second
    // artifact-store resolution mechanism, so a typed `workspace_output`
    // materializes from the EXACT store a SINGLE artifact_v1 task's own
    // sealed `final_ref` was written into.
    this.resolveProjectArtifactStore=typeof resolveProjectArtifactStore==='function'?resolveProjectArtifactStore:null;
    // P24.1G7A — `(projectId)=>absolutePath|null`, the durable non-Git root
    // `materializeTaskHistory()` writes into instead of `project.repo_path`
    // (single-settlement audit: history is DSH-internal provenance, never a
    // second result commit). `null` (the default) preserves the exact
    // pre-G7A in-repo destination for every existing test/DI caller that
    // does not pass this — only `scripts/p5-runtime.mjs` opts a real
    // deployment in.
    this.resolveProjectHistoryRoot=typeof resolveProjectHistoryRoot==='function'?resolveProjectHistoryRoot:null;
  }
  /**
   * P24.3B-R1 Gap #2 — the ONE owned-process-tree barrier every isolated-
   * workspace cleanup call site below goes through. Reuses
   * `backend-execution-observer.mjs`'s EXISTING per-signal owned-spawn
   * tracking (`withReapedOwnedSpawnLifecycle`/`awaitOwnedSpawnReaping`) —
   * no second process-supervision mechanism, and `TaskWorkspaceManager`
   * itself remains entirely unaware of process ownership (it only ever
   * receives a caller's decision to proceed).
   *
   * `awaitOwnedSpawnReaping(signal)` resolves once every spawn this
   * module's OWN provider bridges registered under `signal` has reached a
   * CONFIRMED-exited state (a no-op if none were ever registered — true
   * for a normal completion, whose `run()` promise chain cannot resolve
   * before its own child's exit event fires anyway), or throws
   * `PROCESS_OWNERSHIP_UNRESOLVED` if a termination sequence (owner
   * cancel / bridge-internal timeout) could not confirm the OS process
   * tree actually exited within its own bounded grace/reap window.
   *
   * Policy (§3 of the closure brief):
   *   A. confirmed exited / nothing tracked -> cleanup proceeds
   *   B/C. still active or genuinely unresolvable -> workspace retained,
   *        `cleanupTaskWorkspace()` is never even called, typed
   *        `TASK_WORKSPACE_PROCESS_STATE_UNKNOWN` reported
   *   D. the task's own execution outcome (`result.status`/`taskOutcome`)
   *      is computed entirely independently of this call and is NEVER
   *      touched here — see each call site's own comment.
   *
   * Known, documented limitation (KNOWN_LIMITATIONS in this phase's
   * report): `signal` only correlates to spawns THIS SAME `execute()`
   * call registered. On the adoption/crash-recovery path (a worker
   * restart picking up a task whose ORIGINAL execution ran under a
   * different, now-gone AbortController in a different process
   * lifetime), this call is a structural no-op — it cannot prove or
   * disprove anything about the crashed process's own descendants. That
   * is an inherent limit of an in-process WeakMap surviving a crash, not
   * a gap this barrier papers over silently; it is reported, not hidden.
   */
  async #tryCleanupIsolatedTaskWorkspace({taskId,project,signal,taskLog,phase=null,assumeProcessStateUnknown=false}){
    if(assumeProcessStateUnknown){
      // A pure, read-only durable-state check — never a process-safety
      // inference — first: if a PRIOR call already durably recorded
      // REMOVED, there is nothing left to remove and no process-safety
      // question even arises. Only when the record says otherwise does
      // "process state unknown" actually apply.
      try{
        const{record}=typeof this.tasks.getTaskWorkspace==='function'?this.tasks.getTaskWorkspace(taskId):{record:null};
        if(record?.state==='REMOVED')return{status:'REMOVED',already_removed:true};
      }catch{/* fall through to conservative deferral below */}
      try{taskLog?.event('TASK_WORKSPACE_CLEANUP_DEFERRED',{code:'TASK_WORKSPACE_PROCESS_STATE_UNKNOWN',...(phase?{phase}:{})});}catch{/* never let logging affect the real outcome */}
      return{status:'RETAINED',code:'TASK_WORKSPACE_PROCESS_STATE_UNKNOWN'};
    }
    try{
      await awaitOwnedSpawnReaping(signal);
    }catch(reapError){
      const code=reapError?.code==='PROCESS_OWNERSHIP_UNRESOLVED'?'TASK_WORKSPACE_PROCESS_STATE_UNKNOWN':'TASK_WORKSPACE_PROCESS_STATE_UNKNOWN';
      try{taskLog?.event('TASK_WORKSPACE_CLEANUP_DEFERRED',{code,...(phase?{phase}:{})});}catch{/* never let logging affect the real outcome */}
      return{status:'RETAINED',code};
    }
    try{
      const cleaned=await this.cleanupTaskWorkspace({taskRepository:this.tasks,projectRepoPath:project.repo_path,taskId});
      try{taskLog?.event('TASK_WORKSPACE_CLEANUP_COMPLETED',{state:cleaned.state,...(phase?{phase}:{})});}catch{/* never let logging affect the real outcome */}
      return{status:cleaned.state,already_removed:Boolean(cleaned.already_removed)};
    }catch(cleanupError){
      const code=cleanupError instanceof TaskWorkspaceError?cleanupError.code:'WORKSPACE_CLEANUP_FAILED';
      try{taskLog?.event('TASK_WORKSPACE_CLEANUP_FAILED',{code,...(phase?{phase}:{})});}catch{/* never let logging affect the real outcome */}
      return{status:'RETAINED',code};
    }
  }
  // P15-REM-R2-C (P15-C-006, docs/p15-rem/03_*.md): the entire risky section
  // below is wrapped in ONE try/catch — the single authoritative failure-
  // settlement boundary. Before this wave, a typed failure thrown by
  // `runtime.executePrepared()`/`resume()` (or the lineage/project checks
  // just below) escaped straight out of `execute()`, past `runOnce()`'s
  // `.then(success, error=>{...})` handler (which only ever freed the
  // process-local slot, never the durable claim) and relied on the claim's
  // lease to eventually expire — at which point ANY worker's next poll
  // reclaimed the exact same work item and hit the exact same failure again,
  // forever (confirmed live in docs/p12/06B_*.md's TEST 4 incident). `#settleFailure()`
  // (below) durably completes the claim exactly once, regardless of
  // disposition, so this specific work item is NEVER retried again.
  async execute({work,fence,signal,beforeTerminal=async()=>{}}={}){try{const run=this.pm.load(work.pm_run_id),commandId=run.request.context?.ownerCommandId,taskId=deterministicOwnerId('task',commandId??'');const task=this.tasks.getOwnerTask(taskId);if(!task||work.action_id!==pmWorkIdentity({taskId,pmRunId:run.id}).action_id)throw Object.assign(new Error('PM work lineage is invalid'),{code:'PM_WORK_LINEAGE_INVALID'});const project=this.projects.get(task.projectId);if(!project)throw Object.assign(new Error('PM project is unavailable'),{code:'PROJECT_REFUSED'});
    // P24.3B §6/§13 — resolved ONCE, from the task's OWN durable context
    // (never re-derived from live filesystem state), and reused for every
    // mutable Git operation below across BOTH the adoption/crash-recovery
    // branch and the normal-completion branch — see task-execution-
    // context.mjs. A legacy task (no `context.taskWorkspace`) resolves to
    // `project.repo_path`, byte-for-byte pre-P24.3 behavior.
    const execRepoPath=resolveExecutionRepoPath(project,task.context??null);
    const isolatedWorkspace=resolveTaskWorkspaceBinding(task.context??null);
    if(run.status!=='running'){
      // P22.6 §K: this pm_run already reached a terminal state on some
      // EARLIER execute() call — normally that same call already ran the
      // success-path restore below. The one gap this closes: a crash
      // between "pm_run persisted completed" and "restore ran" would
      // otherwise leave the worktree stranded on the task branch forever,
      // since every later adopt-and-release call for this pm_run would
      // return here without ever retrying it. `restoreOriginalBranch()` is
      // idempotent (a same-branch checkout is a safe no-op) and best-effort
      // — never allowed to affect this adoption's own outcome.
      const adoptedBinding=task.context?.taskBranch??null;
      // P24.1G7A — crash recovery (single-settlement audit §"Failure /
      // Recovery Semantics" CASE A-D): this pm_run reached `completed`
      // durably (DurablePmRuntime marks PM completion BEFORE worker
      // settlement — the exact gap the audit's own "Recovery Lifecycle"
      // section names) but a crash between that write and Git settlement
      // finishing may leave 0/1 commits and 0/1 pushes. Reconcile through
      // the SAME `settleGitResult()` primitive the first-attempt path
      // above uses — never a second, independent recovery implementation
      // — using `run.data`/`run.output` (already durable on the pm_run row
      // itself, exactly what `result.data`/`result.output` would have been
      // on the original call) to reconstruct what a fresh completion would
      // have seen. `settleGitResult()` is itself idempotent (reuses an
      // existing result commit via its identity trailer; verifies the
      // remote before ever pushing), so calling it again here for an
      // ALREADY-settled task is a safe, cheap no-op — never a second
      // semantic commit or a blind second push. Best-effort: a genuinely
      // blocked settlement (e.g. an unresolvable remote conflict) is left
      // for the owner, never forced, and never blocks this adoption's own
      // claim completion.
      if(run.status==='completed'&&task.context?.gitSync){
        try{
          const council=run.request.context?.council??null;
          const taskMode=council?'COUNCIL':'SINGLE';
          const taskLog=this.taskDiagnosticsFactory?this.taskDiagnosticsFactory({taskId,projectId:project.id,pmRunId:run.id,taskMode}):null;
          const isTelegramOrigin=run.request.context?.channel==='TELEGRAM';
          await settleGitResult(this,{project,taskBranchBinding:adoptedBinding,taskId,taskMode,gitSync:task.context.gitSync,workspaceOutput:task.context?.workspaceOutput??null,resultData:run.data??null,pmRunId:run.id,isTelegramOrigin,taskLog,execRepoPath});
        }catch{/* best-effort recovery only; a genuinely blocked settlement is left for the owner, never forced — restore below still runs */}
      }
      // P24.3B §14 — a v1 isolated task never switched `project.repo_path`
      // in the first place (its branch was created straight inside the
      // linked worktree — see owner-task-controller.mjs's
      // `materializeTaskBranch` override), so there is nothing to
      // "restore" there; `restoreOriginalBranch()` would only ever hit its
      // own harmless `TASK_BRANCH_RESTORE_NO_HOME_CAPTURED` refusal
      // (`original_checkout` is durably `null` for a v1 binding) while
      // leaking the now-terminal workspace forever uncleaned. Route
      // cleanup through the SAME conservative, fail-closed
      // `cleanupTaskWorkspace()` P24.3A already proved instead — still
      // strictly best-effort, still never allowed to affect this
      // adoption's own outcome.
      let adoptionWorkspaceCleanup=null;
      if(isolatedWorkspace){
        // P24.3B-R2 Gap #5 (deterministic defect, reproduced and fixed
        // this phase): THIS call's own `signal` has no relationship
        // whatsoever to whatever spawns the ORIGINAL execution may have
        // owned — adoption, by definition, means a genuinely different
        // process lifetime (a crashed/restarted worker) is running this
        // code, not a continuation of the same one. Treating "nothing is
        // tracked under my brand-new signal" as "confirmed nothing is
        // running" would be exactly the unsafe inference the qualification
        // brief prohibits ("new process sees empty WeakMap and blindly
        // removes potentially-active workspace"). `assumeProcessStateUnknown`
        // skips the (here, meaningless) `awaitOwnedSpawnReaping` check
        // entirely and always defers — Option 3 from that brief, and the
        // one this phase's own report documents as the chosen fix. A
        // normal, same-process completion (the success-path terminal
        // handling below, and the settlement-failure path) is UNAFFECTED
        // — both still use the real barrier, because their signal DOES
        // correspond to spawns from THIS SAME call.
        try{adoptionWorkspaceCleanup=await this.#tryCleanupIsolatedTaskWorkspace({taskId,project,signal,phase:'ADOPTION',assumeProcessStateUnknown:true});}catch{/* best-effort only; a retained/BLOCKED workspace is left for the owner, never forced */}
      }
      else if(adoptedBinding){try{await restoreOriginalBranch({projectRepoPath:project.repo_path,binding:adoptedBinding});}catch{/* best-effort only; a genuinely dirty/blocked worktree is left for the owner, never forced */}}
      await beforeTerminal();await this.coordination.completeClaim(fence);return{status:'COMPLETED',pmRunId:run.id,adopted:true,...(adoptionWorkspaceCleanup?{result:{workspaceCleanup:adoptionWorkspaceCleanup}}:{})};
    }
    const awaitOwner=new AwaitOwnerCoordinator({pmRepository:this.pm,ownerRepository:this.owner,coordinationStore:this.coordination});const ownerControl={openInteraction:async({turnIndex})=>{const current=await this.owner.getInteraction(deterministicOwnerId('interaction',run.id,String(turnIndex)));if(current?.status==='DECIDED')return{decision:await this.owner.readDecision(current.interaction_id)};
      // P12-R5D Part C/D/F: the interaction was CLOSED because the owner
      // requested cancellation while this task was parked AWAIT_OWNER
      // (AwaitOwnerCloser, await-owner-closer.mjs, restores claim
      // eligibility only after closing it) -- never re-park an already-
      // closed interaction (that would silently undo the closer's own
      // restoration and wait forever for an answer that will never come,
      // Part D), and never treat it as a decision. #processCommitted
      // (durable-pm-runtime.mjs) turns this signal into a real durable
      // CANCELLED terminal outcome.
      if(current?.status==='CLOSED')return{cancelled:true};
      await beforeTerminal();await awaitOwner.recover({fence,projectId:project.id,taskId,pmRunId:run.id,turnIndex});return{decision:null};}};
    // P7: `council` is carried on the durable pm_request.context (set once,
    // at SUBMIT_TASK/OwnerTaskController.submit time) — never re-derived, so
    // a restart always reconstructs the exact same runtime shape for this
    // pm_run. Absent for every existing single-PM task (undefined), so this
    // is a no-op for all pre-P7 behavior.
    const council=run.request.context?.council??null;
    // P10-R0.2.4 Part S: a resumed/worker-driven turn reads the SAME
    // `runtimeClass` stamped once at SUBMIT_TASK time off the durable
    // `pm_request.context` (never re-derived) — a LONG task's second/third
    // backend invocation (e.g. after an await_owner park/resume) gets the
    // identical LONG timeout policy every time, never silently reverting
    // to NORMAL.
    // P18-W4R2: "before execution ... current branch MUST equal bound
    // task_branch" (PM mandate, verbatim) — checked on EVERY turn this
    // handler drives (first turn AND every later resume, since both paths
    // reach this same line), never only the first. A mismatch throws
    // TASK_BRANCH_BINDING_VIOLATION straight into this method's ONE
    // authoritative failure-settlement boundary (#settleFailure() at the
    // bottom of this try) — never a silent checkout-back-and-continue.
    const taskBranchBinding=task.context?.taskBranch??null;
    if(taskBranchBinding)await verifyBoundBranch({projectRepoPath:execRepoPath,binding:taskBranchBinding,stage:'PRE_EXECUTION'});
    const runtime=this.createRuntime({profileId:task.pmProfileId,project,ownerControl,council,ownerTask:run.request.objective,pmRunId:run.id,taskId,runtimeClass:task.context?.runtimeClass??null,transportVersion:resolveTransportVersion(run.request?.context??task.context),taskContext:run.request?.context??task.context??null});const result=run.turnCount===0?await runtime.executePrepared(run.id,{signal}):await runtime.resume(run.id,{signal});if(result.status==='awaiting_owner')return{status:'PARKED',pmRunId:run.id,interactionId:result.interactionId};if(['completed','failed','cancelled'].includes(result.status)){
      const taskMode=council?'COUNCIL':'SINGLE';
      // P10-R0.2.3 Part K/M: resolved ONCE, shared by the materializer and
      // the diagnostic summary below — see resolveSinglePmProfileId()'s
      // own docstring for the evidence-priority rule this replaces the
      // old, wrong `result.data.pmProfileId` re-derivation with.
      const resolvedPmProfileId=council?council.chair_profile_id:resolveSinglePmProfileId({task,run,result});
      const taskLog=this.taskDiagnosticsFactory?this.taskDiagnosticsFactory({taskId,projectId:project.id,pmRunId:run.id,taskMode}):null;
      // P12-R2 Part durability: read back the SAME value stamped ONCE at
      // SUBMIT_TASK time (owner-task-controller.mjs) — never re-derived. A
      // pre-P12 durable task (no `context.durability` field at all) falls
      // back to the identical default computation so old in-flight tasks
      // are unaffected: LONG->DURABLE_LOCAL (byte-for-byte prior
      // behavior), NORMAL->DIRECT (the one owner-approved P12-R0 §3
      // default change, but only for tasks that resume AFTER this
      // deployment — an already-durable NORMAL task from before P12 has no
      // way to have opted out, so this fallback is the correct, honest
      // default for it too, not a regression).
      const durability=task.context?.durability??(task.context?.runtimeClass==='LONG'?'DURABLE_LOCAL':'DIRECT');
      // P12-R2 Part git-sync: optional, additive, owner-requested. Runs
      // whenever requested, independent of durability (a DIRECT task may
      // still ask for a commit) — but only ever for a task that reached
      // `status:'completed'` (never commit/push a failed/cancelled run's
      // partial state). Commit happens BEFORE materialization (not after,
      // despite the P12 plan doc's own conceptual ordering) so the
      // "result commit" SHA genuinely refers to the task's own code
      // change, not a self-referential commit that would also need to
      // describe its own SHA inside task.json — materialized docs/history
      // files are written afterward and, exactly like every pre-P12 task,
      // are left as an ordinary uncommitted addition to the working tree
      // unless a LATER task's commit (or the owner, by hand) sweeps them
      // in. A git-sync failure NEVER changes `result.status` (P12-R2-F) —
      // this whole block is wrapped the same way materialization already
      // is.
      // P24.1G7A — single-final-settlement (reports/
      // P24_1G7_SINGLE_SETTLEMENT_GIT_WORKFLOW_AUDIT_20260916.md): materialize
      // the typed workspace report + P20 review manifest, create AT MOST ONE
      // result commit, then push AT MOST ONCE, all inside `settleGitResult()`
      // — the ONE primitive this call site shares with adoption-time crash
      // recovery (see the `run.status!=='running'` branch above). A git-sync
      // failure NEVER changes `result.status` (P12-R2-F) — `settleGitResult`
      // itself is wrapped the same way materialization already was.
      const gitSync=result.status==='completed'?(task.context?.gitSync??null):null;
      // P12-R4 Part A/G: review is meaningful only once a verified remote
      // result exists — never merely because the owner asked for it.
      const reviewRequested=result.status==='completed'&&task.context?.review?.requested===true;
      const computeReviewStatus=(remoteStatus)=>!reviewRequested?REVIEW_STATUS.NOT_REQUESTED
        :remoteStatus===REMOTE_SYNC_STATUS.VERIFIED?REVIEW_STATUS.READY_FOR_REVIEW
        :REVIEW_STATUS.BLOCKED_REMOTE;
      const workspaceOutput=result.status==='completed'?(task.context?.workspaceOutput??null):null;
      const isTelegramOrigin=run.request.context?.channel==='TELEGRAM';
      const verificationStatus=verificationStatusFromFinalData(result.data??null);
      const degraded=Boolean(taskMode==='COUNCIL'&&result.data?.degraded===true);
      // P10-R0.2 Part T/AK-39: repository-context materialization is
      // attempted ONLY for a task that already reached `status:'completed'`
      // — a FAILED/CANCELLED run never gets auto-materialized history in
      // this wave (Part L: "automatic repo materialization is for
      // COMPLETED tasks only"). A materialization failure is recorded as a
      // DISTINCT `HANDOFF_MATERIALIZATION_FAILED` fact and NEVER changes
      // `result.status` itself (Part T) — this whole block is wrapped so a
      // throw here can only ever produce `repoHandoff.status==='FAILED'`.
      // P12-R2 Part durability: additionally gated on `durability!=='DIRECT'`
      // — a plain-prompt task now defaults to no docs/history write at all
      // (the one owner-approved behavior change this phase introduces);
      // every task-file/LONG task keeps producing exactly what it produced
      // before P12, unchanged, by default.
      //
      // P24.1G7A — ORDERING depends on WHERE history lands. A real
      // deployment that opted into `resolveProjectHistoryRoot` (a durable,
      // non-Git root) materializes AFTER settlement, exactly like before —
      // it never dirties the task branch, so it can safely reference the
      // REAL `resultCommit` once known, no self-reference problem. Every
      // existing test/DI caller (no `resolveProjectHistoryRoot`, the
      // pre-G7A in-repo destination) materializes BEFORE settlement instead
      // — those files must land as ordinary dirty files the ONE result
      // commit itself picks up (there is no second "materialization"
      // commit any more to sweep them in later), so `resultCommit` is
      // necessarily unresolvable yet and is passed as `null` (the exact
      // same self-reference-avoidance already used for a task with no git
      // request at all).
      const historyRoot=this.resolveProjectHistoryRoot?this.resolveProjectHistoryRoot(project.id):execRepoPath;
      const historyIsDurable=Boolean(this.resolveProjectHistoryRoot);
      let repoHandoff=null;
      let artifactStatus=ARTIFACT_STATUS.NOT_REQUESTED;
      const materializeHistoryIfNeeded=(resultCommitForHistory,{localGitStatus:lgs,remoteSyncStatus:rss,reviewStatus:rvs})=>{
        if(!(result.status==='completed'&&this.enableRepoHistoryMaterialization&&durability!=='DIRECT'))return;
        artifactStatus=ARTIFACT_STATUS.FAILED;
        try{taskLog?.event('HANDOFF_MATERIALIZATION_START',{});}catch{/* never let logging affect the real outcome */}
        try{
          const eventsPath=taskLog?join(taskLog.dir,'events.jsonl'):null;
          const events=eventsPath?readEventsJsonlSafe(eventsPath):[];
          const resolveProfile=(id)=>{if(!this.profileRegistry||!id)return null;try{return this.profileRegistry.get(id);}catch{return null;}};
          const outcomeForArtifacts=buildTaskOutcome({
            executionStatus:executionStatusFromRunStatus(result.status),verificationStatus,
            artifactStatus:ARTIFACT_STATUS.MATERIALIZED,localGitStatus:lgs,remoteSyncStatus:rss,reviewStatus:rvs,degraded,
          });
          const materialized=materializeTaskHistory({
            projectRoot:historyRoot,taskId,pmRunId:run.id,projectId:project.id,taskMode,
            submittedVia:run.request.context?.channel??'UNKNOWN',commandId:run.request.context?.ownerCommandId??null,
            createdAt:run.request.createdAt??result.startedAt??null,completedAt:result.completedAt??null,status:result.status,
            ownerTaskText:run.request.objective,pmProfileId:resolvedPmProfileId,
            council,history:result.history??[],finalOutput:result.output??'',finalData:result.data??null,resolveProfile,events,
            durability,outcome:outcomeForArtifacts,resultCommit:resultCommitForHistory,relations:task.context?.relations??null,
          });
          repoHandoff={status:'COMPLETED',historyPath:materialized.historyPath};
          artifactStatus=ARTIFACT_STATUS.MATERIALIZED;
          taskLog?.event('HANDOFF_MATERIALIZATION_COMPLETED',{history_path:materialized.historyPath,idempotent:materialized.idempotent});
        }catch(error){
          repoHandoff={status:'FAILED',historyPath:null,error:String(error?.message??error).slice(0,240)};
          try{taskLog?.event('HANDOFF_MATERIALIZATION_FAILED',{error_message:error?.message??String(error)});}catch{/* never let logging affect the real outcome */}
        }
      };
      if(!historyIsDurable)materializeHistoryIfNeeded(null,{localGitStatus:LOCAL_GIT_STATUS.NOT_REQUESTED,remoteSyncStatus:REMOTE_SYNC_STATUS.NOT_REQUESTED,reviewStatus:REVIEW_STATUS.NOT_REQUESTED});
      const settlement=await settleGitResult(this,{project,taskBranchBinding,taskId,taskMode,gitSync,workspaceOutput,resultData:result.data??null,pmRunId:run.id,isTelegramOrigin,taskLog,execRepoPath});
      const {localGitStatus,remoteSyncStatus,resultCommit,publishedHead,workspaceOutputOutcome}=settlement;
      if(historyIsDurable)materializeHistoryIfNeeded(resultCommit,{localGitStatus,remoteSyncStatus,reviewStatus:computeReviewStatus(remoteSyncStatus)});
      // P24.1G7A — there is no longer a second "materialization" commit or
      // a deferred bound-task push here: `settleGitResult()` above already
      // created AT MOST ONE result commit and pushed it AT MOST ONCE
      // (bound or unbound alike), and `materializeTaskHistory()` just
      // above no longer writes into this task's Git tree at all once a
      // real deployment opts into the durable history root — there is
      // nothing left to sweep into a second commit.
      // P12-R2 §6: the six independent outcome dimensions, computed once,
      // attached to the returned result WITHOUT ever mutating
      // `result.status` itself — a downstream artifact/git/push failure
      // can only ever change `outcome.*`, never the underlying execution
      // verdict (P12 principle 2.5). `reviewStatus` here is the FINAL,
      // post-push value (computeReviewStatus() re-evaluated against
      // whatever remoteSyncStatus settled to above) — the one that gets
      // durably persisted and drives the review interaction below.
      const reviewStatus=computeReviewStatus(remoteSyncStatus);
      const taskOutcome=buildTaskOutcome({
        executionStatus:executionStatusFromRunStatus(result.status),verificationStatus,artifactStatus,localGitStatus,remoteSyncStatus,reviewStatus,degraded,
      });
      // P12-R2: durably persist the outcome onto the ALREADY-EXISTING
      // pm_runs.data column (pm-repository.mjs's recordTaskOutcome() —
      // reserved `dsh_outcome` key, no schema migration) so it survives
      // this process and becomes visible to Telegram's terminal-result
      // notifier and Desktop's read projection, not just the in-memory
      // return value below. Best-effort: a persistence hiccup here never
      // fails the task result itself (same discipline as every other
      // diagnostic side-effect in this method).
      try{this.pm.recordTaskOutcome(run.id,taskOutcome);}catch{/* never let this affect the real task outcome */}
      // P12-R4 Part C/F: when a task genuinely reaches READY_FOR_REVIEW,
      // durably create ONE real, actionable owner interaction — reusing
      // 100% of the EXISTING await-owner/interaction machinery (kind
      // APPROVAL, same table/notifier/Telegram-and-Desktop delivery every
      // PM-originated approval already uses) rather than inventing a new
      // owner-mutation operation. The owner answers via the ALREADY
      // existing `/decide <id> <rev> ACCEPT|REMEDIATE` (Telegram) or
      // `decideInteraction` (Desktop) — no new command surface. A
      // remediation task is then just an ordinary SUBMIT_TASK with
      // `relations.remediation_of_task_id` (P12-R3, already built) — never
      // a bespoke "remediate" operation. Best-effort: never affects the
      // real task result.
      if(reviewStatus===REVIEW_STATUS.READY_FOR_REVIEW){
        try{
          await this.owner.createInteraction({
            interaction_id:deterministicOwnerId('review',run.id),
            project_id:project.id,task_id:taskId,pm_run_id:run.id,pm_turn_index:null,
            origin:'SYSTEM',kind:'APPROVAL',status:'OPEN',
            title:'DSH task ready for PM review',
            prompt_text:`Task ${taskId} completed and was pushed for review.\nResult commit: ${resultCommit??'UNKNOWN'}\nRespond ACCEPT to close review, or REMEDIATE to request a follow-up task.`,
            allowed_responses:['ACCEPT','REMEDIATE'],
            runtime_facts:{notification_kind:'REVIEW_READY',task_id:taskId,pm_run_id:run.id,project_id:project.id,result_commit:resultCommit,durability,terminal_marker:taskOutcome.terminal_marker},
            response_bindings:{},requires_response:true,local_only:false,
          });
        }catch{/* never let review-interaction creation affect the real task outcome */}
      }
      // P10-R0.2.1 Part L: read back the LAST BACKEND_TIMEOUT event (if any)
      // this run's events.jsonl already carries (task-diagnostic-log.mjs's
      // forwardBackendEventToTaskLog(), fed by production-pm-backend-
      // registry.mjs's `observe(observer,'timeout',...)` on the *_TIMEOUT
      // classified error) so summary.md's Timeout section (Part L) never
      // requires the owner to open raw events.jsonl. Gated to `status ===
      // 'failed'` only — every other terminal result pays zero extra disk
      // I/O for this. Deliberately NOT narrowed to `result.error.code`
      // itself ending in `_TIMEOUT`: for a COUNCIL task, a step-level
      // timeout is re-wrapped by CouncilChairDriver into its own typed
      // orchestration error (e.g. `COUNCIL_CHAIR_PLAN_FAILED` — council-
      // chair-driver.mjs), so the OUTER error code is never `*_TIMEOUT`
      // even though a real backend call inside that step did time out;
      // reading events.jsonl directly still finds it. `result.error` here
      // is already the durable, sanitized `{name,message,code}` shape
      // (bus/errors.mjs's toSanitizedError()) — it never carries the
      // richer fields itself, which is exactly why this reads them back
      // from events.jsonl instead.
      let timeoutDetail=null;
      // P10-R0.2.2 Part O/P: the SAME read-back pattern, one events.jsonl
      // read shared between the two — the LAST `AWAIT_OWNER_CONTRACT` event
      // (task-diagnostic-log.mjs, fed by production-pm-backend-registry.mjs's
      // `observe(observer,'awaitOwnerContract',...)`) whose normalization
      // still shows FAILED (i.e. the bounded repair — if any — did not
      // recover a valid decision) becomes summary.md's "## PM Decision
      // Contract" section. A repair that succeeded, or an await_owner
      // decision that was valid on the first attempt, never populates this
      // (Part P: this section exists specifically for "task fails because
      // await_owner repair still fails").
      let pmDecisionContractDetail=null;
      if(result.status==='failed'){
        try{
          const eventsPath=taskLog?join(taskLog.dir,'events.jsonl'):null;
          const events=eventsPath?readEventsJsonlSafe(eventsPath):[];
          const timeoutEvents=events.filter((e)=>e.event_type==='BACKEND_TIMEOUT');
          const last=timeoutEvents.length?timeoutEvents[timeoutEvents.length-1]:null;
          if(last){
            timeoutDetail={
              backend:last.product??null,stage:last.stage??null,profile:last.profile_id??null,
              configuredTimeoutMs:last.timeout_ms??null,elapsedMs:last.elapsed_ms??null,
              processPid:last.process_pid??null,outputObserved:last.assistant_output_present??null,
              terminalError:result.error?.code??null,
            };
          }
          const contractEvents=events.filter((e)=>e.event_type==='AWAIT_OWNER_CONTRACT'&&e.normalization_result==='FAILED');
          const lastContract=contractEvents.length?contractEvents[contractEvents.length-1]:null;
          if(lastContract){
            pmDecisionContractDetail={
              decisionType:lastContract.decision_type??null,normalizationResult:lastContract.normalization_result??null,
              normalizationError:lastContract.normalization_error??null,repairAttempted:lastContract.repair_attempted===true,
              repairResult:lastContract.repair_result??null,terminalError:result.error?.code??null,
            };
          }
        }catch{/* never let diagnostics enrichment affect the real outcome */}
      }
      if(taskLog){try{
        // P10-R0.1.1 Part J: real trusted origin (`channel`, set once at
        // OwnerTaskController.submit() time — owner-task-controller.mjs),
        // never inferred from task text; falls back to UNKNOWN only when
        // genuinely absent (e.g. a pre-P10-R0.1.1 durable task).
        const submittedVia=run.request.context?.channel??'UNKNOWN';
        finalizeTaskDiagnostics({taskLog,taskId,projectId:project.id,taskMode,submittedVia,commandId:run.request.context?.ownerCommandId??null,council,result,repoHandoff,timeoutDetail,pmDecisionContractDetail,pmProfileId:resolvedPmProfileId});}catch{/* Part P: diagnostics finalization is never allowed to fail the task */}}
      // P22.6 — post-settlement runtime branch return. Runs for EVERY
      // terminal status (completed/failed/cancelled) a task-branch-bound
      // task reaches, regardless of whether git-sync itself succeeded,
      // partially failed, or never ran at all (result.status!=='completed'
      // skips the whole gitSync block above but the worktree may still be
      // sitting on the prepared task branch from PREPARE time) — this is a
      // best-effort courtesy restore, never allowed to change `result.
      // status`/`taskOutcome`/the returned disposition (Part D: "do not
      // falsely mark the task successful", and symmetrically must never
      // mark a genuinely successful settlement as failed just because this
      // housekeeping step hit a snag). A non-task-branch task
      // (`taskBranchBinding===null`) never reaches this block at all — zero
      // extra Git mutation for a non-Git task (Part F).
      let branchRestore=null;
      let workspaceCleanup=null;
      // P24.3B §14/§15 — a v1 isolated task runs this SAME conservative,
      // fail-closed `cleanupTaskWorkspace()` instead of
      // `restoreOriginalBranch()` for every terminal status alike
      // (completed/failed/cancelled) — never special-cased per status,
      // because the cleanup primitive is ALREADY conservative on the
      // workspace's own physical state (P24.3A: refuses and retains on
      // ANY dirty/untracked/ignored content or removal failure). A failed/
      // cancelled task that left partial uncommitted output therefore
      // naturally retains its workspace (dirty -> BLOCKED/CLEANUP_PENDING,
      // never force-removed); a cleanly completed+pushed task's now-clean
      // workspace is removed. This never changes `result.status`/
      // `taskOutcome` either — best-effort, exactly like the legacy
      // restore it replaces.
      if(isolatedWorkspace){
        workspaceCleanup=await this.#tryCleanupIsolatedTaskWorkspace({taskId,project,signal,taskLog,phase:'TERMINAL'});
      }else if(taskBranchBinding){
        try{
          const restoreOutcome=await restoreOriginalBranch({projectRepoPath:project.repo_path,binding:taskBranchBinding});
          branchRestore={status:'RESTORED',branch:restoreOutcome.branch,already_home:restoreOutcome.alreadyHome};
          try{taskLog?.event('TASK_BRANCH_RESTORE_COMPLETED',{branch:restoreOutcome.branch,already_home:restoreOutcome.alreadyHome,sha:restoreOutcome.sha});}catch{/* never let logging affect the real outcome */}
        }catch(restoreError){
          const restoreErrorCode=restoreError instanceof TaskBranchLifecycleError?restoreError.code:'TASK_BRANCH_RESTORE_FAILED';
          branchRestore={status:'FAILED',code:restoreErrorCode,branch:taskBranchBinding.original_checkout??null};
          try{taskLog?.event('TASK_BRANCH_RESTORE_FAILED',{code:restoreErrorCode,branch:taskBranchBinding.original_checkout??null,task_branch:taskBranchBinding.task_branch??null});}catch{/* never let logging affect the real outcome */}
        }
      }
      await beforeTerminal();await this.coordination.completeClaim(fence);return{status:'COMPLETED',pmRunId:run.id,result:{...result,outcome:taskOutcome,...(branchRestore?{branchRestore}:{}),...(workspaceCleanup?{workspaceCleanup}:{})}};}return{status:'ACTIVE',pmRunId:run.id,result};}catch(error){return this.#settleFailure({work,fence,beforeTerminal,error,signal});}}

  // P15-REM-R2-C: best-effort task-log resolution for a work item whose
  // execution never reached the point where this class's own `taskLog` was
  // normally constructed (e.g. the pm_run itself failed to load, or the
  // lineage check refused before a project was even resolved). Purely
  // additive observability — never affects the real settlement decision
  // (classifyPmWorkFailure() below reads only `error.code`).
  #tryBuildTaskLogForSettlement(pmRunId){
    if(!this.taskDiagnosticsFactory)return null;
    try{
      const run=this.pm.load(pmRunId);
      const commandId=run.request?.context?.ownerCommandId;
      if(typeof commandId!=='string'||!commandId)return null;
      const taskId=deterministicOwnerId('task',commandId);
      const task=this.tasks.getOwnerTask(taskId);
      const projectId=task?this.projects.get(task.projectId)?.id??null:null;
      const taskMode=run.request?.context?.council?'COUNCIL':'SINGLE';
      return this.taskDiagnosticsFactory({taskId,projectId,pmRunId,taskMode});
    }catch{return null;}
  }

  // P22.6 — the failure-settlement mirror of the success-path restore
  // above (Part D: "runtime should make a best-effort safe restore when
  // task-branch preparation has already switched branches but later
  // settlement fails" — including task EXECUTION itself throwing, which
  // unwinds straight past the success path into #settleFailure() below,
  // outside that path's own `taskBranchBinding` lexical scope). Re-derives
  // the exact same task/project/binding chain #tryBuildTaskLogForSettlement()
  // already re-derives for the identical reason. Best-effort only: never
  // throws, never affects `settlement.*`/the real failure classification —
  // it can only ever produce a `TASK_BRANCH_RESTORE_*` diagnostic event
  // beside the original (preserved, unmodified) failure.
  async #tryRestoreTaskBranchForSettlement(pmRunId,taskLog,signal){
    try{
      const run=this.pm.load(pmRunId);
      const commandId=run.request?.context?.ownerCommandId;
      if(typeof commandId!=='string'||!commandId)return;
      const taskId=deterministicOwnerId('task',commandId);
      const task=this.tasks.getOwnerTask(taskId);
      const binding=task?.context?.taskBranch??null;
      if(!binding)return;
      const project=task?this.projects.get(task.projectId):null;
      if(!project?.repo_path)return;
      // P24.3B §14 — the identical v1-vs-legacy split execute()'s own
      // terminal handling uses (see this class's `execute()` above):
      // a v1 isolated task is never restored here (nothing was ever
      // switched in the registered checkout); it is conservatively
      // cleaned up instead, through the SAME Gap-#2 process barrier.
      if(resolveTaskWorkspaceBinding(task?.context??null)){
        await this.#tryCleanupIsolatedTaskWorkspace({taskId,project,signal,taskLog,phase:'SETTLEMENT_FAILURE'});
        return;
      }
      try{
        const outcome=await restoreOriginalBranch({projectRepoPath:project.repo_path,binding});
        try{taskLog?.event('TASK_BRANCH_RESTORE_COMPLETED',{branch:outcome.branch,already_home:outcome.alreadyHome,sha:outcome.sha,phase:'SETTLEMENT_FAILURE'});}catch{/* never let logging affect the real outcome */}
      }catch(restoreError){
        const code=restoreError instanceof TaskBranchLifecycleError?restoreError.code:'TASK_BRANCH_RESTORE_FAILED';
        try{taskLog?.event('TASK_BRANCH_RESTORE_FAILED',{code,branch:binding.original_checkout??null,task_branch:binding.task_branch??null,phase:'SETTLEMENT_FAILURE'});}catch{/* never let logging affect the real outcome */}
      }
    }catch{/* best-effort only, never let this affect the real settlement outcome */}
  }

  // P15-REM-R2-C: the one authoritative settlement path for every typed
  // failure that escapes the risky section of execute() above. Classifies
  // the failure (src/runtime/pm-work-failure-settlement.mjs), applies the
  // matching durable pm_run disposition, and — regardless of disposition —
  // ALWAYS completes the claim, so this exact work item is never reclaimed
  // and retried again. This mirrors the pre-existing "already terminal ->
  // adopt and release the claim" branch at the top of execute(): a resolved,
  // not thrown, outcome.
  async #settleFailure({work,fence,beforeTerminal,error,signal}){
    const pmRunId=work.pm_run_id;
    const taskLog=this.#tryBuildTaskLogForSettlement(pmRunId);
    const settlement=settlePmWorkFailure({pmRepository:this.pm,pmRunId,error,taskLog});
    // P22.6 Part D: the original failure (just classified/recorded above)
    // is preserved untouched — this runs strictly after, and can only ever
    // add a restore diagnostic, never alter `settlement`.
    await this.#tryRestoreTaskBranchForSettlement(pmRunId,taskLog,signal);
    await beforeTerminal();
    await this.coordination.completeClaim(fence);
    return{status:'FAILURE_SETTLED',pmRunId,code:settlement.code,classification:settlement.classification,disposition:settlement.disposition};
  }
}

// P13-R1 §4.3: the ONE shared, pure, SQLite-only (no Postgres round trip)
// identity chain used to admit a PM_ACTION work item BEFORE it is claimed.
// This deliberately re-walks the exact same chain `ProductionPmWorkHandler
// .execute()` already walks once execution actually starts
// (pm_run_id -> task -> project) -- re-derivation, not shared mutable
// state, so admission-time and execution-time identity can never disagree
// by construction. Returns `null` (never throws) when the chain cannot be
// resolved -- an unknown/mid-migration/adopted-elsewhere work item is
// refused admission, never crashes a poll tick. `projects` is the SAME
// `Map<id,project>` `ProductionPmWorkHandler` builds from the frozen
// config.projects list, so `project.workspace_id` (p5-production-
// config.mjs's `validateProjects()`) is always already computed --this
// function never derives it itself.
export function resolvePmWorkspaceIdentity({work,pmRepository,taskRepository,projects}={}){
  let run;
  try{run=pmRepository.load(work.pm_run_id);}catch{return null;}
  const commandId=run.request?.context?.ownerCommandId;
  if(typeof commandId!=='string'||!commandId)return null;
  const taskId=deterministicOwnerId('task',commandId);
  const task=taskRepository.getOwnerTask(taskId);
  if(!task)return null;
  const project=projects.get(task.projectId);
  if(!project)return null;
  // §3.2: `project.workspace_id` is the runtime-authoritative identity
  // computed ONCE by `loadP5ProductionConfig()`'s `validateProjects()`
  // (realpath + sha256). A composition built directly from a hand-built
  // config object (every existing pre-P13 test, and every composition
  // that does not route through the real config loader) never carries
  // that field -- falling back to refuse admission entirely would silently
  // stop scheduling ANY PM_ACTION work for such a caller, which is a much
  // larger behavior change than P13 is chartered to make. The fallback
  // below is deliberately NEVER `project.id` (D2/§3.2's one hard rule) --
  // it derives from `project.repo_path` instead, so two project records
  // that happen to share one physical path still serialize against each
  // other even without the validated realpath identity; it is simply not
  // realpath-normalized (this function must stay synchronous), which is
  // exactly the same "UNVERIFIED" conservatism §3.2 already specifies for
  // a path that cannot be resolved.
  // P24.3B §4 — the audit's own alias/common-dir concurrency gap: two
  // registered project records whose `repo_path`s are DIFFERENT linked-
  // worktree paths of the SAME underlying repository get DIFFERENT
  // `workspace_id`s (realpath-only) and would otherwise be treated as
  // unrelated for serialization. `project.repository_common_dir` (p5-
  // production-config.mjs's `validateProjects()`, computed once at config
  // load — same convention as `workspace_id` itself) is the trustworthy,
  // repository-wide identity that coalesces them; `null` for a project
  // that is not a Git worktree at all, or for a composition built from a
  // hand-built config that never computed it (every pre-P24.3 test/DI
  // caller), which falls back to the EXACT pre-P24.3 `workspace_id`/
  // `repo_path` chain, unchanged.
  const workspaceId=typeof project.repository_common_dir==='string'&&project.repository_common_dir?`repo:${project.repository_common_dir}`:typeof project.workspace_id==='string'&&project.workspace_id?project.workspace_id:typeof project.repo_path==='string'&&project.repo_path?`unverified:${project.repo_path}`:null;
  if(!workspaceId)return null;
  return Object.freeze({work_item_id:work.work_item_id,task_id:taskId,pm_run_id:run.id,project_id:project.id,workspace_id:workspaceId});
}

// P13-R4 (docs/p13/12_*.md): canonical BACKEND identity for the second
// admission dimension (global capacity AND backend/provider capacity).
// Re-walks the SAME pm_run_id -> task chain resolvePmWorkspaceIdentity()
// already does (independent re-derivation, not shared mutable state --
// the same discipline every P13 identity resolver already follows), then
// resolves the PM profile with the SAME evidence-priority function
// (`resolveSinglePmProfileId`) task diagnostics already use --
// `task.pmProfileId` first (the durable, canonical field DSH itself used
// to launch this run), falling back to `run.pmProfileId`. `result` (the
// third evidence source, a completed run's own driver-name string) is
// never available at ADMISSION time -- nothing has executed yet -- which
// is fine: `task.pmProfileId` is stamped once at SUBMIT_TASK time and is
// present for every normal task.
//
// COUNCIL tasks are the one deliberate exception, exactly as
// resolveSinglePmProfileId's own docstring requires ("COUNCIL tasks never
// call this -- council.chair_profile_id remains their one source"): a
// Council run's `context.council` is read the SAME way
// ProductionPmWorkHandler.execute() already does, and the CHAIR profile
// is what represents the whole task for backend-capacity purposes --
// consistent with Council's own P7 invariant that only the chair (then,
// sequentially, one participant at a time) is ever physically active for
// one Council task at once.
//
// The identity ITSELF is deliberately never simply `profile.product`:
// the generic `api` product (P11) fronts genuinely different HTTP
// providers (openrouter, deepseek, ...) with independent rate limits and
// quotas -- collapsing them into one shared "api" counter would be
// exactly the "ambiguous overlapping counter" the R4 brief explicitly
// forbids. Every other product (claude-code, codex, opencode, grok,
// antigravity) has no such sub-identity today, so the product name alone
// is the correct, unambiguous key.
export function resolvePmBackendIdentity({work,pmRepository,taskRepository,profileRegistry}={}){
  let run;
  try{run=pmRepository.load(work.pm_run_id);}catch{return null;}
  const commandId=run.request?.context?.ownerCommandId;
  if(typeof commandId!=='string'||!commandId)return null;
  const taskId=deterministicOwnerId('task',commandId);
  const task=taskRepository.getOwnerTask(taskId);
  if(!task)return null;
  const council=task.context?.council??null;
  const profileId=council?council.chair_profile_id:resolveSinglePmProfileId({task,run});
  if(typeof profileId!=='string'||!profileId)return null;
  let profile;
  try{profile=profileRegistry.get(profileId);}catch{return null;}
  if(!profile||typeof profile.product!=='string'||!profile.product)return null;
  const backendKey=profile.product==='api'&&typeof profile.provider==='string'&&profile.provider?`api:${profile.provider}`:profile.product;
  return Object.freeze({work_item_id:work.work_item_id,pm_run_id:run.id,profile_id:profile.id,backend_key:backendKey});
}

// P13-R1 §5.3: admission-refusal vocabulary. Derived, in-memory,
// observability values only -- never durable state, never a new lifecycle
// machine (§5.3, §6.1 of the architecture plan). R2 adds no new member
// here -- BACKEND_CAPACITY/RESOURCE_PRESSURE remain later-gate seams, per
// plan, and are introduced by R4/R5 respectively.
export const ADMISSION_REJECTED = Object.freeze({
  GLOBAL_CAPACITY: 'GLOBAL_CAPACITY',
  WORKSPACE_CAPACITY: 'WORKSPACE_CAPACITY',
  IDENTITY_UNRESOLVED: 'IDENTITY_UNRESOLVED',
  CLAIM_LOST: 'CLAIM_LOST',
  // P13-R4: a second, independent admission dimension -- backend/provider
  // capacity. Only ever produced when a caller configures
  // `resolveBackendIdentity` AND a limit for the resolved key (§R4 of
  // docs/p13/12_*.md); absent either, this reason is never reached.
  BACKEND_CAPACITY: 'BACKEND_CAPACITY',
  // P13-R5 (docs/p13/13_*.md): the local machine itself is under unsafe
  // resource pressure -- a whole-runtime condition, unrelated to any
  // configured capacity number. Only ever produced when a caller
  // configures `resourcePressureGovernor`; absent it, this reason is
  // never reached (resource-pressure-governor.mjs).
  RESOURCE_PRESSURE: 'RESOURCE_PRESSURE',
  // P15-B-002: external occupancy truth is UNKNOWN for this tick. This is
  // deliberately distinct from every capacity reason: UNKNOWN must never
  // be interpreted as zero and no claim may be attempted on this tick.
  OCCUPANCY_UNAVAILABLE: 'OCCUPANCY_UNAVAILABLE',
});

// P13-R2.5: a pure, generically-reusable mapping from the admission/queue
// vocabulary above (plus the two lifecycle states that also mean "not
// currently running") to an owner-facing label. Deliberately NOT a
// persisted/durable value (§6.1: QUEUED is derived, never stored) --
// this exists so a FUTURE presentation layer (Desktop's R6, a Telegram
// status command) never needs to invent its own copy of this vocabulary
// or pretend the database gained a new lifecycle column. Unknown reasons
// degrade to a bounded, honest fallback rather than throwing.
export const QUEUE_WAITING_LABELS = Object.freeze({
  [ADMISSION_REJECTED.GLOBAL_CAPACITY]: 'Waiting — global capacity',
  [ADMISSION_REJECTED.WORKSPACE_CAPACITY]: 'Waiting — workspace busy',
  [ADMISSION_REJECTED.IDENTITY_UNRESOLVED]: 'Waiting — identity unresolved',
  [ADMISSION_REJECTED.CLAIM_LOST]: 'Waiting — claim contested',
  [ADMISSION_REJECTED.BACKEND_CAPACITY]: 'Waiting — backend capacity',
  [ADMISSION_REJECTED.RESOURCE_PRESSURE]: 'Waiting — resource pressure',
  [ADMISSION_REJECTED.OCCUPANCY_UNAVAILABLE]: 'Waiting — occupancy unavailable',
  AWAIT_OWNER: 'Awaiting owner',
  RUNNING: 'Running',
});
export function describeQueueReason(reason){return QUEUE_WAITING_LABELS[reason]??`Waiting — ${String(reason??'unknown').toLowerCase()}`;}

// P13-R2.3 (docs/p13/10_*.md; §6.4 of the R1 architecture plan): a queued
// PM_ACTION work item -- one that has NEVER been claimed -- must be
// cancellable through the canonical owner cancel path WITHOUT ever
// acquiring an ACTIVE claim merely to tear it down. `requestCancel()`
// already writes an ordinary `cancellation_requests` row keyed by
// `work_item_id` (unchanged, existing P12 mechanism); this function is
// the missing CONSUMER for that row when the work item it targets was
// never claimed at all. Returns `true` when this candidate was
// terminalized by cancellation this tick (the caller must `continue` to
// the next candidate without attempting normal admission), `false`
// otherwise (never throws) -- an unresolvable/already-terminal/already-
// claimed candidate simply falls through to ordinary admission.
//
// Ordering is deliberate and crash-safe: the durable PM run is
// terminalized FIRST (`pmRepository.completeRun()`), and only THEN is the
// coordination work item marked terminal
// (`coordination.cancelUnclaimedWork()`). If the process dies between
// these two steps, the work item remains a normal candidate on the next
// incarnation; existing normal admission would claim it, and
// `ProductionPmWorkHandler.execute()`'s own pre-existing ADOPTION branch
// (`if (run.status !== 'running') { ...; completeClaim(fence); return
// {adopted:true}; }`) already completes the claim without ever invoking a
// backend -- the exact same safety net R1's crash-recovery already
// relies on, not a new mechanism.
export async function reconcileQueuedCancellation({work,coordinationStore,pmRepository}={}){
  let cancellation;
  try{cancellation=await coordinationStore.readCancellation(work.work_item_id);}catch{return false;}
  if(!cancellation||cancellation.state!=='REQUESTED')return false;
  let run;
  try{run=pmRepository.load(work.pm_run_id);}catch{return false;}
  if(run.status!=='running')return false; // already terminal by some other path -- let normal admission's adoption branch handle it
  if(run.turnCount!==0)return false; // has already committed a decision/turn -- not a "never claimed" queued item; leave it to normal admission/execution semantics
  try{pmRepository.completeRun(run.id,{status:'cancelled',output:'',data:null,error:null,completedAt:new Date().toISOString()});}
  catch{return false;} // could not durably terminalize -- refuse to touch coordination state; try again next tick
  try{await coordinationStore.cancelUnclaimedWork(work.work_item_id);}catch{/* best-effort: the PM run is already durably cancelled either way; the ADOPTION branch is the safety net if this half fails */}
  return true;
}

// P13-R1.1 (docs/p13/05_*.md): the drain-timeout ceiling for a genuinely
// hung/abort-unaware execution. Deliberately the SAME numeric value as
// production-pm-backend-registry.mjs's HANG_SAFETY_CEILING_MS (600_000 --
// "comfortably above every backend's own existing internal default"), for
// the identical reason: it must never fire before a healthy abort-aware
// execution would have already settled (raceWithWatchdog() -- consumed by
// every real backend product's decide() call -- settles a signal-aborted
// call in milliseconds, not minutes), so this is purely a last-resort
// backstop for a path that does not consume the signal at all. NOT
// imported from that module to avoid coupling the worker layer's drain
// policy to the backend layer's watchdog constant -- the two are allowed
// to diverge independently even though they start equal.
export const DRAIN_ABORT_CEILING_MS = 600_000;

// Resolves `true` once `promise` settles within `timeoutMs`, or `false` if
// the bound elapses first -- either way the timer is always cleared, so a
// timed-out race never leaves a dangling handle behind (the caller decides
// what "false" means; this helper never itself abandons or forgets the
// original promise, which keeps settling in the background regardless).
async function raceTimeout(promise,timeoutMs){
  let timer=null;
  const timeout=new Promise(resolve=>{timer=setTimeout(()=>resolve(false),timeoutMs);});
  try{return await Promise.race([promise.then(()=>true),timeout]);}
  finally{clearTimeout(timer);}
}

export class ProductionPmWorker{
  // P13-R1 §4/§5: `resolveWorkIdentity`, when supplied, is
  // `(work)=>{workspace_id,...}|null` (sync or async) -- see
  // resolvePmWorkspaceIdentity() above for the real production shape. When
  // omitted (every pre-P13 caller, and every existing test that constructs
  // this class directly), each work item is treated as occupying its OWN
  // unique workspace -- i.e. workspace exclusion is a no-op and only
  // `globalLimit` governs admission, byte-for-byte preserving this class's
  // pre-P13 single-flight behavior when `globalLimit` is also left at its
  // default of 1. `globalLimit` is an R1 PROOF CONSTANT/CONFIGURATION
  // value only (the architecture plan is explicit this is never a
  // SAFE_DEFAULT or HARD_MAX) -- the real production wiring for it lives
  // in p5-production-composition.mjs, not here.
  // P13-R2.3/R2.4: `resolveQueuedCancellation`, when supplied, is
  // `(work)=>Promise<boolean>` -- see reconcileQueuedCancellation() above
  // for the real production shape. Omitted by every pre-R2 caller and
  // every existing test that constructs this class directly, so this is
  // a no-op (queued cancellation simply isn't consumed) for anyone who
  // doesn't wire it -- byte-for-byte backward compatible.
  // P13-R4: `resolveBackendIdentity`, when supplied, is
  // `(work)=>{backend_key,...}|null` (sync or async) -- see
  // resolvePmBackendIdentity() above for the real production shape.
  // `backendConcurrencyLimits` is a plain `{[backend_key]: limit}` map --
  // TEST VALUES for this gate, never a product default (docs/p13/12_*.md).
  // Both are omitted by every pre-R4 caller/test, so backend capacity is
  // simply never enforced (no key ever has a configured limit) --
  // byte-for-byte backward compatible.
  // P13-R5: `resourcePressureGovernor`, when supplied, is an object
  // exposing `checkAdmission():{allowed,pressureActive,metrics,error}` --
  // see resource-pressure-governor.mjs's createResourcePressureGovernor().
  // Consulted ONCE per tick (a whole-runtime condition, unlike per-
  // workspace/per-backend capacity) and ONLY on the admission path --
  // never near an already-ACTIVE slot's lifecycle, so an existing
  // execution is never interrupted merely because a threshold was
  // crossed after it started. Omitted by every pre-R5 caller/test, so
  // resource pressure is simply never enforced -- byte-for-byte backward
  // compatible.
  constructor({coordinationStore,handler,workerIncarnationId,leaseMs=30000,discoveryLimit=32,resolveWorkIdentity=null,resolveQueuedCancellation=null,resolveBackendIdentity=null,backendConcurrencyLimits=null,resourcePressureGovernor=null,globalLimit=1,diagnosticSink=null,diagnosticRateLimitMs=30000,now=()=>Date.now()}={}){
    if(!coordinationStore||typeof coordinationStore.listPmActionCandidates!=='function'||!handler||typeof handler.execute!=='function'||!workerIncarnationId)throw new TypeError('production PM worker dependencies required');
    this.coordination=coordinationStore;this.handler=handler;this.workerIncarnationId=workerIncarnationId;this.leaseMs=leaseMs;this.discoveryLimit=discoveryLimit;
    this.resolveWorkIdentity=typeof resolveWorkIdentity==='function'?resolveWorkIdentity:null;
    this.resolveQueuedCancellation=typeof resolveQueuedCancellation==='function'?resolveQueuedCancellation:null;
    this.resolveBackendIdentity=typeof resolveBackendIdentity==='function'?resolveBackendIdentity:null;
    this.backendConcurrencyLimits=backendConcurrencyLimits&&typeof backendConcurrencyLimits==='object'?backendConcurrencyLimits:{};
    this.resourcePressureGovernor=resourcePressureGovernor&&typeof resourcePressureGovernor.checkAdmission==='function'?resourcePressureGovernor:null;
    this.globalLimit=Number.isInteger(globalLimit)&&globalLimit>=1?globalLimit:1;
    this.diagnosticSink=typeof diagnosticSink==='function'?diagnosticSink:(entry)=>console.error(JSON.stringify(entry));
    this.diagnosticRateLimitMs=Number.isInteger(diagnosticRateLimitMs)&&diagnosticRateLimitMs>=1000?diagnosticRateLimitMs:30000;
    this.now=typeof now==='function'?now:()=>Date.now();
    this.lastOccupancyDiagnosticAt=null;
    this.suppressedOccupancyDiagnostics=0;
    this.stopRequested=false;
    // P13-R1 §4.4: the in-process active-execution slot table. Ephemeral,
    // process-local, keyed by work_item_id (1:1 with pm_run_id -- §3.5).
    // Its authority is entirely DERIVED from the claims it holds; it is
    // never a second source of durable truth and disappears on process
    // exit by design (§6/§10 -- recovery is Postgres claim/lease, not this
    // table).
    this.slots=new Map();
    this.activeByWorkspace=new Map();
    this.activeByBackend=new Map();
    this.lastAdmission=null;
  }
  requestStop(){this.stopRequested=true;}
  activeCount(){return this.slots.size;}
  // Bounded, non-secret observability snapshot (§"OBSERVABILITY").
  activeSnapshot(){return[...this.slots.values()].map(slot=>({work_item_id:slot.work_item_id,workspace_id:slot.workspace_id,backend_key:slot.backend_key??null,started_at:slot.startedAt}));}
  // P13-R2.5: the most recent tick's admission outcome -- what started,
  // what was refused and why, what was cancelled-while-queued. Derived,
  // in-memory, ephemeral (§6.1: never a new persisted lifecycle value) --
  // this is the seam a future presentation layer (Desktop's R6, a
  // Telegram status command) reads to answer "why is this task waiting"
  // without inventing a second query path or a durable queue-reason
  // column. `null` before the first tick.
  lastAdmissionSnapshot(){return this.lastAdmission;}
  ownerStatusSnapshot(){
    const active=this.activeSnapshot();
    const rejected=Array.isArray(this.lastAdmission?.rejected)?this.lastAdmission.rejected.map(({work_item_id,reason})=>({work_item_id,reason})):[];
    return Object.freeze({global_limit:this.globalLimit,active_count:active.length,active,rejected,observed_at:this.lastAdmission?.at??Date.now()});
  }

  async #resolveIdentity(work){
    if(!this.resolveWorkIdentity)return{work_item_id:work.work_item_id,workspace_id:`__unscoped__:${work.work_item_id}`};
    try{return await this.resolveWorkIdentity(work);}catch{return null;}
  }

  // P13-R3: a freshly restarted worker's in-process slot table (and
  // therefore `activeByWorkspace`) is deliberately empty (§4.4/§10 -- it
  // is ephemeral by design). But a physical workspace can still be
  // genuinely occupied by a PRIOR incarnation's claim that has not yet
  // expired (a fast restart, well within the lease window). Without
  // accounting for this, a new incarnation could admit a different task
  // into the SAME physical workspace a still-unexpired-but-abandoned
  // claim already targets -- exactly the same-workspace-concurrent-write
  // hazard P13 must never introduce, even transiently across a restart.
  //
  // Computed FRESH every tick (not once at startup and cached): a claim
  // that later genuinely expires must stop counting on the very next
  // tick with no separate decay/cleanup path to maintain. In steady
  // state (no restart in progress, this process is the sole active
  // executor for everything it holds) every item this returns is already
  // in `this.slots` and is therefore skipped -- the map comes back empty
  // and costs one bounded, read-only, indexed query.
  //
  // Backward compatible: entirely skipped when the coordination store
  // does not implement `listActivePmActionWork` (every pre-R3 fake/test),
  // or per-dimension when the corresponding resolver
  // (`resolveWorkIdentity`/`resolveBackendIdentity`) is not configured.
  //
  // P13-R4 folds BACKEND occupancy into this SAME pass (one
  // `listActivePmActionWork()` query, not two) for the identical reason
  // R3 introduced it for workspaces: a fast restart's fresh, empty
  // `activeByBackend` map has no way to know a backend's concurrency pool
  // is still occupied by a prior incarnation's unexpired claim, and a
  // configured backend limit must hold across a restart just as reliably
  // as workspace exclusion does.
  async #computeExternalOccupancy(){
    const workspace=new Map();const backend=new Map();
    const needWorkspace=Boolean(this.resolveWorkIdentity);
    const needBackend=Boolean(this.resolveBackendIdentity);
    if((!needWorkspace&&!needBackend)||typeof this.coordination.listActivePmActionWork!=='function')return{workspace,backend};
    let activeElsewhere;
    try{activeElsewhere=await this.coordination.listActivePmActionWork({limit:this.discoveryLimit});}catch(error){this.#emitOccupancyDiscoveryFailure(error);return{workspace,backend,available:false};}
    for(const item of activeElsewhere){
      if(this.slots.has(item.work_item_id))continue; // already accounted for in this.activeByWorkspace/activeByBackend
      if(needWorkspace){
        const identity=await this.#resolveIdentity(item);
        if(identity&&typeof identity.workspace_id==='string'&&identity.workspace_id)workspace.set(identity.workspace_id,(workspace.get(identity.workspace_id)??0)+1);
      }
      if(needBackend){
        const backendIdentity=await this.#resolveBackendIdentity(item);
        if(backendIdentity&&typeof backendIdentity.backend_key==='string'&&backendIdentity.backend_key)backend.set(backendIdentity.backend_key,(backend.get(backendIdentity.backend_key)??0)+1);
      }
    }
    return{workspace,backend,available:true};
  }

  #emitOccupancyDiscoveryFailure(error){
    const observedAt=this.now();
    if(this.lastOccupancyDiagnosticAt!==null&&observedAt-this.lastOccupancyDiagnosticAt<this.diagnosticRateLimitMs){this.suppressedOccupancyDiagnostics+=1;return;}
    const rawMessage=typeof error?.message==='string'?error.message:'External occupancy discovery failed';
    const sanitizedMessage=rawMessage
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi,'$1<redacted>@')
      .replace(/\b(password|pass|secret|token|api[_-]?key|credential)\s*[=:]\s*[^\s,;]+/gi,'$1=<redacted>')
      .slice(0,240);
    const diagnostic=Object.freeze({
      event:'pm.occupancy.discovery_failed',
      code:'PM_OCCUPANCY_DISCOVERY_FAILED',
      worker_incarnation_id:this.workerIncarnationId,
      error_class:typeof error?.name==='string'?error.name.slice(0,80):'Error',
      error_message:sanitizedMessage,
      timestamp:new Date(observedAt).toISOString(),
      policy:'FAIL_CLOSED_FOR_TICK',
      suppressed_duplicates:this.suppressedOccupancyDiagnostics,
    });
    this.lastOccupancyDiagnosticAt=observedAt;
    this.suppressedOccupancyDiagnostics=0;
    try{this.diagnosticSink(diagnostic);}catch{/* diagnostics must never alter admission safety */}
  }

  async #resolveBackendIdentity(work){
    if(!this.resolveBackendIdentity)return null;
    try{return await this.resolveBackendIdentity(work);}catch{return null;}
  }

  // P13-R2.4: an ACTIVE slot's owner may cancel it at any time via the
  // canonical, pre-existing REQUEST_CANCEL path (a `cancellation_requests`
  // row keyed by `work_item_id` -- unchanged). This reuses the SAME
  // per-slot AbortController R1.1 built for shutdown/drain to make that
  // cancellation take effect immediately rather than only at the next
  // natural decision boundary -- consuming an EXISTING signal a real
  // backend call already races against (production-pm-backend-
  // registry.mjs's raceWithWatchdog(), built for P12-R5B), never a new
  // interrupt mechanism. Strictly per-slot (never a shared/global
  // controller, never a process-wide flag) and best-effort: a coordination
  // read failure here never affects any slot's execution. Checked at most
  // once more than necessary per slot (`cancelSignalled`), since firing an
  // already-fired AbortController is a safe no-op but a repeated Postgres
  // round trip per active slot per 250ms tick is not free at scale.
  async #wakeCancelledActiveSlots(){
    if(typeof this.coordination.readCancellation!=='function'||!this.slots.size)return;
    for(const slot of this.slots.values()){
      if(slot.cancelSignalled)continue;
      let cancellation;
      try{cancellation=await this.coordination.readCancellation(slot.work_item_id);}catch{continue;}
      // P13-R7.1 Part F/G: tagged with PM_OWNER_CANCEL_ABORT_REASON so
      // DurablePmRuntime's own catch block (durable-pm-runtime.mjs) can
      // prove this specific abort was caused by a canonical, durable
      // owner cancellation -- never merely inferred from "some abort
      // happened" -- and terminalize as CANCELLED rather than FAILED.
      // drainActive()'s OWN shutdown-triggered abort (below in this same
      // class) deliberately passes no reason, so it is completely
      // unaffected by this change.
      if(cancellation?.state==='REQUESTED'){slot.cancelSignalled=true;slot.controller.abort(PM_OWNER_CANCEL_ABORT_REASON);}
    }
  }

  // P13-R1 §5.1 (D1, PM-ratified): ADMIT-THEN-CLAIM. Local admission is
  // decided entirely before `acquireClaim()` is ever called, so an ACTIVE
  // Postgres claim continues to mean exactly what every recovery path
  // already assumes it means: there is an actual executor advancing this
  // work item. A refused candidate is never claimed and consumes no slot
  // -- it simply remains `claim_eligible` and is re-evaluated on a later
  // tick (the durable queue already exists; nothing new is stored -- §6.1).
  //
  // §4.2: this method now STARTS admitted work and returns promptly --
  // it never `await`s `handler.execute()` to completion. The existing
  // `ProductionWorkerRuntime` 250ms poll loop is therefore the ONLY
  // supervisor tick; no second polling runtime is introduced.
  async runOnce(){
    // P13-R2.4: wake any ACTIVE slot whose owner cancelled it, regardless
    // of draining/capacity state below -- an owner cancel must never wait
    // on global admission bookkeeping to take effect.
    await this.#wakeCancelledActiveSlots();
    if(this.stopRequested)return Object.freeze({status:'DRAINING'});
    // P13-R2.5: candidates are now listed even when already at capacity
    // (one bounded, read-only, indexed query) so every candidate blocked
    // purely by GLOBAL_CAPACITY is actually reported in `rejected` --
    // R1's original design intentionally skipped this query when full (a
    // cost-saving short-circuit), but that made it structurally
    // impossible to answer "why is task X still queued" whenever the
    // runtime was genuinely at capacity, which is exactly the steady
    // state R2's observability requirement cares about. The claim/admit
    // gates below are UNCHANGED -- no candidate discovered this way is
    // ever claimed while at capacity.
    const atCapacityAtStart=this.slots.size>=this.globalLimit;
    // P13-R3/R4: recomputed fresh every tick -- see
    // #computeExternalOccupancy()'s own docstring for why this must never
    // be cached across ticks.
    const{workspace:externalWorkspaceOccupancy,backend:externalBackendOccupancy,available:externalOccupancyAvailable=true}=await this.#computeExternalOccupancy();
    const candidates=await this.coordination.listPmActionCandidates({limit:this.discoveryLimit});
    // P13-R5: a whole-runtime condition, evaluated ONCE per tick (not
    // per-candidate -- every candidate reached this tick sees the exact
    // same machine-health snapshot). `null` when no governor is
    // configured, which is why every check below is gated on
    // `resourcePressure&&...` rather than assuming a shape.
    const resourcePressure=this.resourcePressureGovernor?this.resourcePressureGovernor.checkAdmission():null;
    const started=[];const rejected=[];const cancelled=[];
    for(const work of candidates){
      if(this.slots.has(work.work_item_id))continue; // already mine this tick
      // P13-R2.3: consume a queued-cancellation BEFORE any capacity/
      // admission gate -- and REGARDLESS of capacity state. A task being
      // torn down is not "eligible work" competing for a slot; it must be
      // cancellable even while the runtime is completely at capacity
      // (the whole point of R2.3 is that a queued task never has to wait
      // for a slot merely to be cancelled).
      if(this.resolveQueuedCancellation){
        let consumed=false;
        try{consumed=await this.resolveQueuedCancellation(work);}catch{consumed=false;}
        if(consumed){cancelled.push({work_item_id:work.work_item_id});continue;}
      }
      // P15-B-002 FAIL_CLOSED_FOR_TICK: cancellation remains available,
      // already-running slots remain untouched, but no new claim write is
      // attempted while the cross-incarnation occupancy view is UNKNOWN.
      if(!externalOccupancyAvailable){rejected.push({work_item_id:work.work_item_id,reason:ADMISSION_REJECTED.OCCUPANCY_UNAVAILABLE});continue;}
      // P13-R5: checked BEFORE global/workspace/backend capacity -- a
      // whole-machine-unhealthy signal makes those checks moot, and
      // (mirroring R2.3's cancellation precedent) this NEVER blocks the
      // queued-cancellation branch above, which already ran unconditionally.
      if(resourcePressure&&!resourcePressure.allowed){rejected.push({work_item_id:work.work_item_id,reason:ADMISSION_REJECTED.RESOURCE_PRESSURE});continue;}
      if(this.slots.size>=this.globalLimit){rejected.push({work_item_id:work.work_item_id,reason:ADMISSION_REJECTED.GLOBAL_CAPACITY});continue;}
      const identity=await this.#resolveIdentity(work);
      if(!identity||typeof identity.workspace_id!=='string'||!identity.workspace_id){rejected.push({work_item_id:work.work_item_id,reason:ADMISSION_REJECTED.IDENTITY_UNRESOLVED});continue;}
      // P13-R3: workspace occupancy is the union of slots THIS process
      // owns and any still-unexpired claim held by ANOTHER incarnation
      // that resolves to the same physical workspace (a restart-window
      // hazard -- see #computeExternalOccupancy()).
      const workspaceActive=(this.activeByWorkspace.get(identity.workspace_id)??0)+(externalWorkspaceOccupancy.get(identity.workspace_id)??0);
      if(workspaceActive>0){rejected.push({work_item_id:work.work_item_id,reason:ADMISSION_REJECTED.WORKSPACE_CAPACITY,workspace_id:identity.workspace_id});continue;}
      // P13-R4: the second, independent admission dimension -- backend/
      // provider capacity. A no-op unless BOTH `resolveBackendIdentity`
      // is configured AND a limit is actually configured for the
      // resolved key (§R4 of docs/p13/12_*.md -- absent either, this
      // gate always permits, exactly like an unfilled seam). An
      // unresolvable backend identity never blocks admission on its own
      // -- it degrades to "no limit known", not a refusal -- since
      // backend capacity is an OPTIONAL second dimension, unlike
      // workspace identity which is load-bearing for safety.
      let backendKey=null;
      if(this.resolveBackendIdentity){
        const backendIdentity=await this.#resolveBackendIdentity(work);
        backendKey=backendIdentity?.backend_key??null;
        if(backendKey){
          const limit=this.backendConcurrencyLimits[backendKey];
          if(Number.isInteger(limit)&&limit>=0){
            const backendActive=(this.activeByBackend.get(backendKey)??0)+(externalBackendOccupancy.get(backendKey)??0);
            if(backendActive>=limit){rejected.push({work_item_id:work.work_item_id,reason:ADMISSION_REJECTED.BACKEND_CAPACITY,backend_key:backendKey});continue;}
          }
        }
      }
      const claim=await this.coordination.acquireClaim({work_item_id:work.work_item_id,worker_incarnation_id:this.workerIncarnationId,leaseMs:this.leaseMs});
      if(!claim){rejected.push({work_item_id:work.work_item_id,reason:ADMISSION_REJECTED.CLAIM_LOST});continue;}
      const fence=claimFence(claim),renewal=startPmClaimRenewal({coordinationStore:this.coordination,fence,leaseMs:this.leaseMs});
      let drained=false;
      const stopRenewal=async()=>{if(drained){if(renewal.lost)throw renewal.lost;return renewal.renewalCount;}drained=true;return renewal.stop();};
      const workspaceId=identity.workspace_id;
      // P13-R1.1 (docs/p13/05_*.md): a PER-SLOT AbortController -- never
      // shared across slots (the R1 plan's own §8 prohibition on a
      // process-wide cancellation flag applies equally to a shutdown
      // signal). This is the SAME AbortSignal contract
      // DurablePmRuntime/CouncilStepWorkflowRunner's decide() calls already
      // consume via production-pm-backend-registry.mjs's raceWithWatchdog()
      // (built for P12-R5B's owner-cancel path) -- drain reuses it for
      // shutdown, never repurposing it as owner-cancellation semantics
      // (no cancellation_requests row is ever written here).
      const controller=new AbortController();
      const slot={work_item_id:work.work_item_id,workspace_id:workspaceId,backend_key:backendKey,startedAt:Date.now(),fence,renewal,controller};
      this.slots.set(work.work_item_id,slot);
      this.activeByWorkspace.set(workspaceId,workspaceActive+1);
      if(backendKey)this.activeByBackend.set(backendKey,(this.activeByBackend.get(backendKey)??0)+1);
      const release=()=>{
        this.slots.delete(work.work_item_id);
        const remaining=(this.activeByWorkspace.get(workspaceId)??1)-1;
        if(remaining<=0)this.activeByWorkspace.delete(workspaceId);else this.activeByWorkspace.set(workspaceId,remaining);
        if(backendKey){
          const backendRemaining=(this.activeByBackend.get(backendKey)??1)-1;
          if(backendRemaining<=0)this.activeByBackend.delete(backendKey);else this.activeByBackend.set(backendKey,backendRemaining);
        }
      };
      // P13-R1 Invariant 6 (mandatory): the terminal handler is attached
      // SYNCHRONOUSLY, in this same statement, so there is never an
      // interval where this promise is tracked but unattached. The
      // exposed slot/started promise NEVER rejects -- success and failure
      // both resolve to a discriminated result object -- so an unhandled
      // rejection can never occur here regardless of whether any caller
      // ever awaits it (Invariant 6's regression test proves this).
      const settlement=this.handler.execute({work,fence,signal:controller.signal,beforeTerminal:stopRenewal}).then(
        async outcome=>{const renewalCount=await stopRenewal();release();return{status:'WORK',work_item_id:work.work_item_id,generation:claim.fencing_generation,renewalCount,outcome};},
        async error=>{await stopRenewal().catch(lost=>{if(error?.code!=='PM_CLAIM_AUTHORITY_LOST')error=lost;});release();return{status:'FAILED',work_item_id:work.work_item_id,error};},
      ).catch(error=>{
        // R1 invariant 6 applies to failures raised by the settlement
        // callbacks too, not only to handler.execute() itself. In
        // particular, stopRenewal() can reject after an otherwise
        // successful handler when the renewal loop observed lost claim
        // authority. Never leave that callback rejection unhandled: free
        // the process-local slot and expose the same resolved FAILED shape
        // used by the ordinary handler-failure path.
        release();
        return{status:'FAILED',work_item_id:work.work_item_id,error};
      });
      slot.promise=settlement;
      started.push({work_item_id:work.work_item_id,workspace_id:workspaceId,promise:settlement});
    }
    // P13-R5: additive observability field -- `null` when no governor is
    // configured (every pre-R5 caller/test), so nothing that reads this
    // object's other fields is affected.
    this.lastAdmission={at:this.now(),started:started.map(s=>({work_item_id:s.work_item_id,workspace_id:s.workspace_id})),rejected,cancelled,resourcePressure};
    if(started.length||cancelled.length)return Object.freeze({status:'WORK',started,rejected,cancelled});
    // AT_CAPACITY is reported only when this tick started genuinely full
    // and nothing changed (no admission, no cancellation) -- preserves
    // the exact pre-R2.5 status contract every existing caller/test
    // checks; `rejected` is now populated even here (§ above), which is
    // the actual R2.5 change.
    if(atCapacityAtStart)return Object.freeze({status:'AT_CAPACITY',active:this.slots.size,limit:this.globalLimit,rejected,cancelled});
    return Object.freeze({status:'IDLE',rejected,cancelled});
  }

  // P13-R1.1 D4/§13 (docs/p13/05_*.md -- supersedes the R1.0 single-phase
  // timeout-then-abandon design, which could return `settled:false` while
  // the underlying handler.execute() promise was still genuinely running,
  // letting a caller close shared stores out from under it):
  //
  // Phase 1 -- GRACE: wait up to `gracePeriodMs` (default: worker.leaseMs,
  // the same provisional R1 bound as before) with NO signal fired, so a
  // naturally-finishing execution is never needlessly interrupted.
  //
  // Phase 2 -- ABORT + CONFIRM: for every slot still active after the
  // grace period, fire ITS OWN AbortController (never a shared/global
  // one). This is the SAME canonical AbortSignal contract
  // production-pm-backend-registry.mjs's raceWithWatchdog() already
  // consumes for every real backend product's decide() call (built for
  // P12-R5B's owner-cancel path) -- reused here for shutdown, never
  // written as a `cancellation_requests` row and never confused with
  // owner-cancel semantics. For a task whose in-flight call actually
  // consumes the signal, this settles handler.execute()'s promise within
  // milliseconds (the abort listener resolves the wrapping promise
  // immediately, independent of whether the real backend process has
  // exited). DSH then AWAITS that real settlement -- up to
  // `timeoutMs` (default DRAIN_ABORT_CEILING_MS) -- rather than assuming
  // it happened.
  //
  // Only if a slot is STILL unsettled once that bound elapses (meaning the
  // execution's current code path does not consume the signal at all --
  // see docs/p13/05_*.md "Known limitations" for exactly which paths that
  // is today) is its claim renewal stopped, so at least the renewal timer
  // does not run forever; the slot itself is deliberately NOT force-
  // released and `settled` is reported `false` so the caller (composition
  // close()) refuses to close shared stores while that promise may still
  // be running -- see STOP CONDITIONS, "blind claim expiry while executor
  // remains live" is exactly what this preserves against.
  async drainActive({gracePeriodMs=this.leaseMs,timeoutMs=DRAIN_ABORT_CEILING_MS}={}){
    const pending=[...this.slots.values()].map(slot=>slot.promise).filter(Boolean);
    if(!pending.length)return{settled:true,remaining:0,aborted:0};
    if(await raceTimeout(Promise.allSettled(pending),gracePeriodMs))return{settled:true,remaining:0,aborted:0};
    const stillActive=[...this.slots.values()];
    for(const slot of stillActive)slot.controller?.abort();
    const confirmed=await raceTimeout(Promise.allSettled(pending),timeoutMs);
    if(!confirmed)for(const slot of this.slots.values())slot.renewal?.stop().catch(()=>{});
    return{settled:Boolean(confirmed),remaining:this.slots.size,aborted:stillActive.length};
  }
}

export class CompositeProductionWorker{
  constructor(...workers){this.workers=workers.filter(Boolean);}
  requestStop(){for(const worker of this.workers)worker.requestStop();}
  // P13-R1 §4.6: tick EVERY wrapped worker every round -- never
  // short-circuit on the first non-IDLE worker. Once the PM worker returns
  // promptly (§4.2), short-circuiting on it would starve the task-dispatch
  // worker of ticks forever under sustained PM load. When exactly one
  // worker reports non-IDLE this tick, ITS result is returned verbatim --
  // byte-for-byte the pre-R1 shape -- so every existing single-worker-type
  // caller is unaffected. Only when MORE THAN ONE worker reports non-IDLE
  // in the same tick (impossible before this change, since the old code
  // never even ticked a second worker after the first returned work) is an
  // aggregate `{status:'WORK',results}` shape returned instead.
  async runOnce(){
    const results=[];
    for(const worker of this.workers)results.push(await worker.runOnce());
    const active=results.filter(r=>r.status!=='IDLE');
    if(active.length===0)return Object.freeze({status:'IDLE'});
    if(active.length===1)return active[0];
    if(active.every(r=>r.status==='DRAINING'))return Object.freeze({status:'DRAINING'});
    return Object.freeze({status:'WORK',results});
  }
  // D4: delegate the bounded drain to every wrapped worker that supports
  // it (today, only ProductionPmWorker tracks in-flight slots --
  // MultiProcessTaskWorker's runOnce() already awaits its one dispatch to
  // completion before returning, so it has nothing to drain).
  async drainActive(opts){
    const outcomes=await Promise.all(this.workers.map(worker=>typeof worker.drainActive==='function'?worker.drainActive(opts):Promise.resolve({settled:true,remaining:0,aborted:0})));
    return{settled:outcomes.every(o=>o.settled),remaining:outcomes.reduce((sum,o)=>sum+(o.remaining??0),0),aborted:outcomes.reduce((sum,o)=>sum+(o.aborted??0),0)};
  }
}
