import test from 'node:test';
import assert from 'node:assert/strict';
import {ProductionPmWorker} from '../src/runtime/production-pm-worker.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const work={work_item_id:'work',work_kind:'PM_ACTION',pm_run_id:'pm',action_id:'action'};
const claim={...work,owner_worker_incarnation_id:'worker:one',fencing_generation:7,fencing_token:'opaque'};

// P13-R1 §4.2: runOnce() now STARTS admitted work and returns promptly --
// it no longer awaits handler.execute() to completion. These two tests
// (pre-P13, when runOnce() itself blocked until the task finished) are
// rewritten to observe the same claim-renewal guarantees through the
// tracked slot's settlement promise instead of through runOnce()'s own
// return/rejection.
test('long PM execution renews the same fence across multiple short lease periods before completion',async()=>{
  let renewals=0,completed=0;
  const coordination={listPmActionCandidates:async()=>[work],acquireClaim:async()=>claim,renewClaim:async fence=>{assert.equal(fence.fencing_generation,7);renewals++;return claim;}};
  const handler={execute:async({beforeTerminal})=>{await delay(380);await beforeTerminal();completed++;return{status:'COMPLETED'};}};
  const worker=new ProductionPmWorker({coordinationStore:coordination,handler,workerIncarnationId:'worker:one',leaseMs:150});
  const started=await worker.runOnce();
  assert.equal(started.status,'WORK');
  assert.equal(started.started.length,1);
  assert.equal(worker.activeCount(),1,'the slot is tracked while the handler is still in flight');
  const result=await started.started[0].promise;
  assert.equal(result.status,'WORK');
  assert.ok(renewals>=2);
  assert.equal(result.renewalCount,renewals);
  assert.equal(result.generation,7);
  assert.equal(completed,1);
  assert.equal(worker.activeCount(),0,'the slot is released exactly once on success');
});
test('renewal authority loss fails closed before terminal PM mutation',async()=>{
  let terminal=0;
  const lost=Object.assign(new Error('stale'),{code:'CLAIM_AUTHORITY_REJECTED'});
  const coordination={listPmActionCandidates:async()=>[work],acquireClaim:async()=>claim,renewClaim:async()=>{throw lost;}};
  const handler={execute:async({beforeTerminal})=>{await delay(80);await beforeTerminal();terminal++;return{status:'COMPLETED'};}};
  const worker=new ProductionPmWorker({coordinationStore:coordination,handler,workerIncarnationId:'worker:one',leaseMs:75});
  const started=await worker.runOnce();
  assert.equal(started.status,'WORK');
  // Invariant 6: the tracked settlement promise NEVER rejects -- failure is
  // encoded in the resolved result, so this can never become an unhandled
  // rejection regardless of whether a caller awaits it.
  const result=await started.started[0].promise;
  assert.equal(result.status,'FAILED');
  assert.equal(result.error.code,'PM_CLAIM_AUTHORITY_LOST');
  assert.equal(result.error.cause,lost);
  assert.equal(terminal,0);
  assert.equal(worker.activeCount(),0,'the slot is released exactly once on failure');
});
