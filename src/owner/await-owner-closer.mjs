export class AwaitOwnerCloser {
  constructor({ownerRepository,coordinationStore,getLeadershipFence,limit=20}={}){if(!ownerRepository||typeof ownerRepository.listDecidedAwaitingResumption!=='function'||!coordinationStore||typeof coordinationStore.restoreOwnerDecisionEligibility!=='function'||typeof getLeadershipFence!=='function')throw new TypeError('AWAIT_OWNER closer dependencies required');this.owner=ownerRepository;this.coordination=coordinationStore;this.getFence=getLeadershipFence;this.limit=Math.min(100,Math.max(1,limit));this.running=false;}
  async runOnce(){this.running=true;try{
    const fence=this.getFence();if(!fence)return{status:'FOLLOWER',observed:0,restored:0,cancelled:0};
    const items=await this.owner.listDecidedAwaitingResumption({limit:this.limit});
    let restored=0;
    for(const item of items){const value=await this.coordination.restoreOwnerDecisionEligibility(fence,{work_item_id:item.work_item_id,interaction_id:item.interaction_id});if(value)restored+=1;}
    // P12-R5D Part B/C/D/E/I: a task parked AWAIT_OWNER never resolves
    // through a decision when the owner instead requests cancellation
    // (OwnerTaskController.requestCancel()/coordination.requestCancellation()
    // already durably record that intent — R5C). This is the SAME
    // two-phase pattern as the decided-resumption loop just above: close
    // the interaction (a terminal state, never re-opened — Part D: it no
    // longer appears actionable in any inbox once CLOSED), then restore
    // the work item's claim eligibility so the worker's OWN next resume()
    // sees the CLOSED interaction and terminalizes the PmRun CANCELLED
    // (production-pm-worker.mjs/durable-pm-runtime.mjs) — never replayed,
    // never invented here. Both new ownerRepository methods are optional
    // (typeof-checked) so a caller/test that constructs this class with an
    // owner repository fake predating P12-R5D — every existing test — is
    // completely unaffected (Part I is generic no-op-safe: a repeated tick
    // after closure simply finds nothing left to close).
    let cancelled=0,cancelledObserved=0;
    if(typeof this.owner.listCancelledInteractionsAwaitingClosure==='function'&&typeof this.owner.closeInteractionForCancellation==='function'){
      const pending=await this.owner.listCancelledInteractionsAwaitingClosure({limit:this.limit});
      cancelledObserved=pending.length;
      for(const item of pending){
        // Approval-card CANCEL already closes the revision-guarded
        // interaction in its owner-command transaction. Generic task
        // cancellation still arrives with an OPEN interaction and uses the
        // existing close method. Both converge on the same restore path.
        const closed=item.status==='CLOSED'?item:await this.owner.closeInteractionForCancellation(item.interaction_id);
        if(!closed)continue;
        const value=await this.coordination.restoreOwnerDecisionEligibility(fence,{work_item_id:item.work_item_id,interaction_id:item.interaction_id});
        if(value)cancelled+=1;
      }
    }
    return{status:'LEADER',observed:items.length+cancelledObserved,restored,cancelled};
  }finally{this.running=false;}}
}
