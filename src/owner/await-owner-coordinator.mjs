import { deterministicOwnerId } from './owner-contracts.mjs';

export class AwaitOwnerCoordinator {
  constructor({ pmRepository, ownerRepository, coordinationStore }={}) { this.pm=pmRepository; this.owner=ownerRepository; this.coordination=coordinationStore; }
  async commitAndPark({ fence, projectId, taskId, pmRunId, turnIndex, decision, runtimeFacts={} }) {
    const interactionId=deterministicOwnerId('interaction',pmRunId,String(turnIndex));
    const normalized={...decision,type:'await_owner',interactionId};
    this.pm.commitDecision(pmRunId,{id:deterministicOwnerId('pmturn',pmRunId,String(turnIndex)),turnIndex,decision:normalized,actionType:'await_owner',actionId:interactionId,createdAt:new Date().toISOString()});
    await this.owner.createInteraction({interaction_id:interactionId,project_id:projectId,task_id:taskId,pm_run_id:pmRunId,pm_turn_index:turnIndex,origin:'PM',kind:decision.kind,status:'OPEN',title:decision.title,prompt_text:decision.prompt,allowed_responses:decision.allowedResponses,runtime_facts:runtimeFacts,response_bindings:{},requires_response:true,local_only:decision.localOnly===true});
    this.pm.markActionStarted(pmRunId,turnIndex);
    await this.coordination.parkClaimForOwner(fence,interactionId);
    return {status:'AWAITING_OWNER',interactionId};
  }
  async recover({ fence, projectId, taskId, pmRunId, turnIndex }) {
    const run=this.pm.load(pmRunId), turn=run.turns[turnIndex];
    if(!turn||turn.decision.type!=='await_owner')throw Object.assign(new Error('PM recovery is not awaiting owner'),{code:'PM_RECOVERY_INVALID'});
    const id=turn.actionId; let interaction=await this.owner.getInteraction(id);
    if(!interaction) interaction=await this.owner.createInteraction({interaction_id:id,project_id:projectId,task_id:taskId,pm_run_id:pmRunId,pm_turn_index:turnIndex,origin:'PM',kind:turn.decision.kind,status:'OPEN',title:turn.decision.title,prompt_text:turn.decision.prompt,allowed_responses:turn.decision.allowedResponses,runtime_facts:{recovered:true},response_bindings:{},requires_response:true,local_only:turn.decision.localOnly===true});
    if(turn.phase==='DECISION_COMMITTED')this.pm.markActionStarted(pmRunId,turnIndex);
    await this.coordination.parkClaimForOwner(fence,id);
    return {status:'AWAITING_OWNER',interactionId:id,recovered:true};
  }
}
