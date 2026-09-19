import { callbackDigest, deterministicOwnerId, normalizeOwnerCommand, OwnerControlError } from './owner-contracts.mjs';
import { normalizeAutonomyEnvelope } from './autonomy-envelope.mjs';
import { normalizeCouncilSpec, CouncilValidationError } from '../pm/council/council-contracts.mjs';
import { admitCouncilWorkspaceRequirement, CouncilWorkspaceAdmissionError } from '../pm/council/council-workspace-admission.mjs';

export class OwnerControlService {
  // P9-R0.4 Part J/W: `statusResolver` (optional) is an async
  // `(pmProfileId) => 'ACTIVE'|'INACTIVE'|undefined` callback — see
  // src/pm/pm-profile-status-store.mjs — that lets a SUBMIT_TASK see a
  // deactivate/reactivate flip immediately, without waiting for this
  // process's frozen `pmProfiles` snapshot to be rebuilt by a restart.
  // Omitted (every existing test construction of this class) falls back to
  // the snapshot's own `.status` field, defaulting to ACTIVE for a profile
  // with none — byte-for-byte pre-R0.4 behavior.
  // P9-R0.4.2 Part A/B: `statusListResolver` (optional) is an async
  // `() => Map<pmProfileId, 'ACTIVE'|'INACTIVE'> | null` callback — see
  // PmProfileStatusStore#getAllStatuses — reusing the SAME underlying
  // store `statusResolver` above already wraps (never a second
  // independent lifecycle store). GET_PM_PROFILES reads (Telegram's
  // /profiles, /pms, /aliases — telegram-owner-client.mjs) resolve
  // through this so a Desktop deactivate/reactivate is visible on the
  // very next Telegram list command, with no restart — closing the exact
  // gap `statusResolver` already closed for SUBMIT_TASK acceptance.
  constructor({ repository, taskController, projects = [], pmProfiles = [], statusResolver = null, statusListResolver = null } = {}) { if (!repository) throw new TypeError('repository required'); this.repository=repository;this.tasks=taskController; this.projects=new Map(projects.map(v=>[v.id,Object.freeze({...v})])); this.pmProfiles=new Map(pmProfiles.map(v=>[v.id,Object.freeze({...v})])); this.statusResolver=statusResolver; this.statusListResolver=statusListResolver; }
  async mutate(input) {
    const command=normalizeOwnerCommand(input);
    const validated=await this.#validateBeforeAcceptance(command);
    // An approval-card CANCEL is the existing canonical REQUEST_CANCEL
    // action with an interaction guard, not a DECIDE_INTERACTION response.
    // Validate and close the exact OPEN interaction in the owner-command
    // transaction, then record cancellation through OwnerTaskController's
    // existing leader-fenced path. A rollback leaves the interaction OPEN;
    // an already-recorded cancellation is idempotent and the generic
    // AwaitOwnerCloser can still settle it safely.
    if(command.operation==='REQUEST_CANCEL'&&validated.interactionId){
      if(typeof this.repository.closeOpenInteractionForTaskCancellation!=='function')throw new OwnerControlError('guarded interaction cancellation is unavailable','OWNER_INTEGRATION_UNAVAILABLE');
      if(!this.tasks)throw new OwnerControlError('canonical task integration unavailable','OWNER_INTEGRATION_UNAVAILABLE');
      return this.repository.acceptCommand(command,async(client)=>{
        const interaction=await this.repository.closeOpenInteractionForTaskCancellation(client,{interactionId:validated.interactionId,expectedRevision:command.expected_revision,taskId:command.target_id,projectId:command.project_id});
        const canonical=await this.tasks.requestCancel({taskId:command.target_id});
        return {...canonical,interaction_id:interaction.interaction_id,interaction_status:interaction.status};
      });
    }
    if(!['DECIDE_INTERACTION','REPLY_TO_INTERACTION'].includes(command.operation)){
      const accepted=await this.repository.beginCommand(command);if(accepted.status==='COMPLETED')return accepted;if(!this.tasks)throw new OwnerControlError('canonical task integration unavailable','OWNER_INTEGRATION_UNAVAILABLE');let canonical;
      if(command.operation==='SUBMIT_TASK'){canonical=await this.tasks.submit({command:{...command,accepted_at:accepted.created_at},project:validated.project,profile:validated.profile,council:validated.council??null});}
      else if(command.operation==='REQUEST_CANCEL')canonical=await this.tasks.requestCancel({taskId:command.target_id});
      else canonical=await this.tasks.changeAutonomy({taskId:command.target_id,expectedRevision:command.expected_revision,requested:command.payload.autonomy,expand:command.operation==='EXPAND_AUTONOMY'});
      return this.repository.completeCommand(command.command_id,canonical);
    }
    return this.repository.acceptCommand(command, async (client) => {
      if (command.operation === 'DECIDE_INTERACTION' || command.operation === 'REPLY_TO_INTERACTION') {
        const p=command.payload; return this.repository.decide(client,{interactionId:command.target_id,commandId:command.command_id,actorId:command.actor_id,expectedRevision:command.expected_revision,selectedResponse:command.operation==='DECIDE_INTERACTION'?p.response:null,responseText:command.operation==='REPLY_TO_INTERACTION'?p.text:null,decisionId:deterministicOwnerId('decision',command.command_id,command.target_id)});
      }
      throw new OwnerControlError('unsupported owner mutation','OWNER_OPERATION_REFUSED');
    });
  }
  async read(operation, input={}) { if(operation==='GET_INBOX') return this.repository.listInbox(input); if(operation==='GET_PROJECTS') return [...this.projects.values()]; if(operation==='GET_PM_PROFILES') return this.#freshPmProfiles();if(!this.tasks)throw new OwnerControlError('task reads unavailable','OWNER_INTEGRATION_UNAVAILABLE');if(operation==='GET_TASK')return this.tasks.getTask(input.target_id);if(operation==='LIST_TASKS')return this.tasks.listTasks(input);if(operation==='GET_TASK_SUMMARY')return this.tasks.getSummary(input.target_id);throw new OwnerControlError('unsupported owner read','OWNER_OPERATION_REFUSED'); }
  async resolveCallback(nonce){const interaction=await this.repository.resolveCallbackDigest(callbackDigest(nonce));return {interaction_id:interaction.interaction_id,revision:interaction.revision,response:interaction.callback_response};}
  // P11-R4.2 Part A/E/J: admits ONE newly hot-reloaded profile into this
  // ALREADY-LIVE service's frozen-at-construction `pmProfiles` Map — see
  // p5-production-composition.mjs's reloadPmProfiles(), the only caller.
  // Idempotent/never overwrites: an id already present is left completely
  // untouched (execution identity stays immutable — Part C), so calling
  // this again for an id the reload already admitted is always a safe
  // no-op, never a silent identity swap.
  admitPmProfile(profile){if(!this.pmProfiles.has(profile.id))this.pmProfiles.set(profile.id,Object.freeze({...profile}));}
  // P9-R0.4.2 Part A/B/G: GET_PM_PROFILES is the ONE read Telegram's
  // /profiles, /pms, and /aliases all resolve through. Execution-identity
  // fields (id/product/model/reasoning/session_kind/transport) always come
  // from the immutable frozen `pmProfiles` snapshot — untouched here; only
  // `status` is ever refreshed, via the SAME statusListResolver/
  // PmProfileStatusStore the SUBMIT_TASK gate already reuses (Part B: no
  // second independent lifecycle store). Part G failure policy: a failed
  // live read never silently reports every profile as ACTIVE — it falls
  // back to each profile's own frozen snapshot status, but the whole
  // response is flagged `statusStale: true` so a Telegram render can show
  // an explicit "may be out of date" diagnostic instead of presenting
  // stale data as current truth.
  async #freshPmProfiles(){
    const list=[...this.pmProfiles.values()].map(({secret,...v})=>v);
    if(!this.statusListResolver) return list;
    let fresh=null;
    try{fresh=await this.statusListResolver();}catch{fresh=null;}
    if(!fresh) return list.map(v=>({...v,status:v.status??'ACTIVE',statusStale:true}));
    return list.map(v=>({...v,status:fresh.get(v.id)??v.status??'ACTIVE'}));
  }
  // P9-R0.4 Part J: fail-closed, typed rejection for a SUBMIT_TASK that
  // names a currently-INACTIVE PM profile — checked AFTER "does this id
  // exist at all" (PM_PROFILE_UNAVAILABLE / COUNCIL_UNKNOWN_CHAIR/
  // PARTICIPANT), so an unregistered id and a registered-but-deactivated
  // id are always distinguishable. Prefers a live re-read via
  // `statusResolver` (Part W: sees a Desktop deactivate/reactivate
  // immediately, no restart) and falls back to this process's frozen
  // snapshot — defaulting to ACTIVE — only when no resolver is configured
  // or the live read comes back unresolved (Part J note: never a hard
  // failure of an unrelated command over a transient disk hiccup).
  async #assertProfileActive(id){
    const snapshotStatus=this.pmProfiles.get(id)?.status??'ACTIVE';
    const liveStatus=this.statusResolver?await this.statusResolver(id):undefined;
    const status=liveStatus??snapshotStatus;
    if(status==='INACTIVE')throw new OwnerControlError(`PM profile is inactive: ${id}`,'PM_PROFILE_INACTIVE',{profileId:id});
  }
  async #validateBeforeAcceptance(command){
    const requireTarget=()=>{if(typeof command.target_id!=='string'||!command.target_id)throw new OwnerControlError('target_id is required','INVALID_OWNER_COMMAND');};
    const requireRevision=()=>{if(!Number.isSafeInteger(command.expected_revision)||command.expected_revision<1)throw new OwnerControlError('expected_revision is required','INVALID_OWNER_COMMAND');};
    if(command.operation==='SUBMIT_TASK'){
      if(typeof command.payload.body!=='string'||command.payload.body.length===0)throw new OwnerControlError('task body is required','INVALID_OWNER_COMMAND');
      const project=this.projects.get(command.project_id);if(!project)throw new OwnerControlError('unknown project','PROJECT_REFUSED');
      if(project.path_missing)throw new OwnerControlError('project working directory is missing','PROJECT_PATH_MISSING');
      normalizeAutonomyEnvelope(project.autonomy);
      // P7 Part B/N: COUNCIL mode (command.payload.council present) validates
      // a full CouncilSpec against the owner-selected authority boundary
      // (every registered PM profile id — Part R/T) and returns the CHAIR's
      // profile as the task's profile-of-record. SINGLE mode (the `else`
      // branch) is byte-for-byte the pre-P7 behavior.
      if(command.payload.council){
        let council;
        try{council=normalizeCouncilSpec(command.payload.council,{knownProfileIds:new Set(this.pmProfiles.keys())});}
        catch(error){if(error instanceof CouncilValidationError)throw new OwnerControlError(error.message,error.code,{profileId:error.profileId});throw error;}
        // P9-R0.4 Part O: chair and every participant must be ACTIVE — a
        // new council request may not silently drop an inactive
        // participant, it must reject before execution.
        await this.#assertProfileActive(council.chair_profile_id);
        for(const participantId of council.participant_profile_ids)await this.#assertProfileActive(participantId);
        // Council/Debate WORKSPACE_READ remediation (docs/evidence/
        // DSH_COUNCIL_PARTICIPANT_EXECUTION_AUDIT_20260906.md §13): a no-op
        // for `workspace_requirement:'NONE'` (every pre-existing council
        // dispatch) — rejects BEFORE this task ever reaches durable
        // acceptance when it cannot be satisfied for the current project.
        try{await admitCouncilWorkspaceRequirement({council,project,resolveProfile:(id)=>this.pmProfiles.get(id)});}
        catch(error){if(error instanceof CouncilWorkspaceAdmissionError)throw new OwnerControlError(error.message,error.code,{offendingProfileIds:error.offendingProfileIds,offendingPaths:error.offendingPaths,reasonCode:error.reasonCode,requestedFileCount:error.requestedFileCount,requiredBytesAtLeast:error.requiredBytesAtLeast,configuredLimit:error.configuredLimit});throw error;}
        return {project,profile:this.pmProfiles.get(council.chair_profile_id),council};
      }
      const profileId=command.payload.pm_profile_id??project.default_pm_profile_id;if(typeof profileId!=='string'||!this.pmProfiles.has(profileId))throw new OwnerControlError('PM profile unavailable','PM_PROFILE_UNAVAILABLE');
      await this.#assertProfileActive(profileId);
      return {project,profile:this.pmProfiles.get(profileId)};
    }
    if(command.operation==='REQUEST_CANCEL'){
      requireTarget();
      if(command.payload.interaction_id===undefined)return{};
      requireRevision();
      if(typeof command.payload.interaction_id!=='string'||!command.payload.interaction_id)throw new OwnerControlError('interaction_id is invalid','INVALID_OWNER_COMMAND');
      return{interactionId:command.payload.interaction_id};
    }
    if(command.operation==='NARROW_AUTONOMY'||command.operation==='EXPAND_AUTONOMY'){requireTarget();requireRevision();normalizeAutonomyEnvelope(command.payload.autonomy);return{};}
    if(command.operation==='DECIDE_INTERACTION'){requireTarget();requireRevision();if(typeof command.payload.response!=='string'||!command.payload.response)throw new OwnerControlError('response is required','INVALID_OWNER_COMMAND');return{};}
    if(command.operation==='REPLY_TO_INTERACTION'){requireTarget();requireRevision();if(typeof command.payload.text!=='string'||!command.payload.text)throw new OwnerControlError('reply text is required','INVALID_OWNER_COMMAND');return{};}
    throw new OwnerControlError('unsupported owner mutation','OWNER_OPERATION_REFUSED');
  }
}
