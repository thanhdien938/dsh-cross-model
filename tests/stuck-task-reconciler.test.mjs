import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { SqliteReconciliationRepository } from '../src/reconciliation/sqlite-reconciliation-repository.mjs';
import { PostgresCancellationReconciliationRepository } from '../src/reconciliation/postgres-cancellation-reconciliation-repository.mjs';
import { StuckTaskReconciler, RECONCILIATION_CLASS, projectReconciliation } from '../src/reconciliation/stuck-task-reconciler.mjs';

const fence = Object.freeze({ logical_coordinator_id: 'coord', owner_coordinator_incarnation_id: 'coord:1', leader_generation: 7, leadership_token: 'x'.repeat(43) });
const clearResources = () => ({ activeClaim: false, unexpiredLease: false, liveProviderProcess: false, workspaceOccupancy: false, activeProviderSlot: false, uncertainWorkerOwnership: false, openOwnerInteraction: null, resourceImpact: 'NONE' });

async function sqliteFixture({ pmStatus = 'failed', council = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-reconcile-')); const store = new SqlitePersistenceStore();
  await store.open({ path: join(dir, 'fixture.sqlite') }); await store.migrate();
  const pm = council ? 'pm-council' : 'pm-single'; const wf = council ? 'wf-participant' : 'wf-single'; const step = `${wf}-step`; const task = `${wf}-task`; const runId = `${wf}-run`; const at = '2026-09-01T00:00:00.000Z';
  store.run('INSERT INTO pm_requests(id,objective,context,envelope,created_at) VALUES(?,?,?,?,?)', [`req-${pm}`,'fixture','{}',JSON.stringify({id:`req-${pm}`,objective:'fixture',context:{},createdAt:at}),at]);
  store.run('INSERT INTO pm_runs(id,request_id,driver,status,output,started_at,completed_at,created_at,turn_count,state_revision) VALUES(?,?,?,?,?,?,?,?,?,?)', [pm,`req-${pm}`,council?'council:chair':'single:pm',pmStatus,'',at,at,at,1,4]);
  store.run('INSERT INTO pm_turns(id,pm_run_id,turn_index,decision,committed,created_at,phase,action_type,action_id,state_revision) VALUES(?,?,?,?,?,?,?,?,?,?)', [`turn-${pm}`,pm,0,JSON.stringify({type:'workflow',spec:{id:wf}}),1,at,'ACTION_STARTED','workflow',wf,3]);
  store.run('INSERT INTO workflows(id,spec,status,created_at,state_revision) VALUES(?,?,?,?,?)', [wf,JSON.stringify({id:wf,sender:'pm',steps:[]}), 'running',at,5]);
  store.run('INSERT INTO tasks(id,status,envelope,created_at) VALUES(?,?,?,?)', [task,'dispatched',JSON.stringify({id:task,body:'fixture'}),at]);
  store.run('INSERT INTO runs(id,task_id,status,created_at,state_revision) VALUES(?,?,?,?,?)', [runId,task,'running',at,6]);
  store.run('INSERT INTO workflow_steps(id,workflow_id,step_index,status,task_id,run_id,created_at,state_revision) VALUES(?,?,?,?,?,?,?,?)', [step,wf,0,'running',task,runId,at,8]);
  return { store, dir, pm, wf, step, task, runId, close: async () => { await store.close(); await rm(dir,{recursive:true,force:true}); } };
}

function reconciler(source, { resources = clearResources(), leadership } = {}) {
  const guard = leadership ?? { assertCurrent: async () => true };
  return new StuckTaskReconciler({ source, resourceGuard: { observe: async () => ({ ...resources }) }, leadershipGuard: guard, workerIncarnationId: 'worker:fixture', clock: () => '2026-09-07T00:00:00.000Z' });
}

for (const council of [false, true]) test(`${council ? 'failed Council + participant' : 'terminal PM + running'} workflow settles descendants without provider execution`, async (t) => {
  const f = await sqliteFixture({ council }); t.after(f.close); let providerSpawns = 0;
  const source = new SqliteReconciliationRepository({ store: f.store, clock: () => '2026-09-07T00:00:00.000Z' });
  const result = await new StuckTaskReconciler({ source, resourceGuard: { observe: async () => ({ ...clearResources(), providerSpawns }) }, leadershipGuard: { assertCurrent: async () => true }, workerIncarnationId: 'worker:fixture', clock: () => '2026-09-07T00:00:00.000Z' }).scan({ fence });
  assert.equal(result.outcomes[0].result, 'REPAIRED'); assert.equal(providerSpawns, 0);
  assert.equal(f.store.get('SELECT status FROM workflows WHERE id=?',[f.wf]).status,'failed');
  assert.equal(f.store.get('SELECT status FROM workflow_steps WHERE id=?',[f.step]).status,'failed');
  assert.equal(f.store.get('SELECT status FROM runs WHERE id=?',[f.runId]).status,'failed');
  assert.equal(f.store.get('SELECT phase FROM pm_turns WHERE pm_run_id=?',[f.pm]).phase,'TURN_COMPLETE');
  assert.equal(f.store.get('SELECT status FROM pm_runs WHERE id=?',[f.pm]).status,'failed','semantic parent outcome unchanged');
  assert.equal(f.store.get('SELECT COUNT(*) count FROM reconciliation_audit').count,1);
});

test('same reconciliation rerun is an idempotent no-op and audit exists once', async (t) => {
  const f=await sqliteFixture();t.after(f.close);const source=new SqliteReconciliationRepository({store:f.store});const r=reconciler(source);
  await r.scan({fence}); const second=await r.scan({fence});
  assert.equal(second.scanned,0);assert.equal(f.store.get('SELECT COUNT(*) count FROM reconciliation_audit').count,1);
});

test('cancelled task + REQUESTED cancellation terminalizes only bookkeeping', async (t) => {
  const f=await sqliteFixture({pmStatus:'cancelled'});t.after(f.close);
  const state={workItemId:'work-cancel',taskId:f.task,pmRunId:f.pm,claimState:'COMPLETED',claimEligible:false,workRevision:4,cancellationState:'REQUESTED',cancellationRevision:2,cancellationUpdatedAt:'2026-09-01T00:00:00.000Z'};let audits=0;
  const coordination={listStaleCancellationCandidates:async()=>[{kind:'POSTGRES_CANCELLATION',id:state.workItemId}],observeCancellationReconciliation:async()=>({...state}),reconcileTerminalCancellation:async(_f,{expected,audit})=>{assert.equal(expected.cancellationRevision,2);state.cancellationState='CANCELLED';state.cancellationRevision++;audits++;return{applied:true,reconciliationId:audit.reconciliationId};}};
  const source=new PostgresCancellationReconciliationRepository({coordinationStore:coordination,sqliteStore:f.store});const out=await reconciler(source).scan({fence});
  assert.equal(out.outcomes[0].result,'REPAIRED');assert.equal(state.cancellationState,'CANCELLED');assert.equal(audits,1);assert.equal(f.store.get('SELECT status FROM pm_runs WHERE id=?',[f.pm]).status,'cancelled');
});

function memorySubject(overrides={}) { return { classification:RECONCILIATION_CLASS.TERMINAL_PARENT_STALE_DESCENDANTS,taskId:'task',lineage:{pmRunId:'pm'},states:{pm:'failed',workflow:'running'},revisions:{pm:1,workflow:1},observationToken:'v1',...overrides}; }
function memorySource(subject=memorySubject()) { let repairs=0;return {scanCandidates:async()=>[{id:'x'}],observe:async()=>subject,repair:async()=>{repairs++;return{applied:true,reconciliationId:'r'};},get repairs(){return repairs;}}; }

test('valid AWAITING_OWNER is untouched with only backend-authorized actions',async()=>{const s=memorySource(memorySubject({validAwaitingOwner:true,safeOwnerActions:['APPROVE']}));const out=await reconciler(s).scan({fence});assert.equal(out.outcomes[0].classification,'OWNER_ACTION_REQUIRED');assert.deepEqual(out.outcomes[0].safeActions,['APPROVE']);assert.equal(s.repairs,0);});
for(const [name,patch] of [['active claim',{activeClaim:true}],['live provider PID',{liveProviderProcess:true}],['active workspace ownership',{workspaceOccupancy:true}],['active provider slot',{activeProviderSlot:true}],['unexpired lease',{unexpiredLease:true}]]) test(`${name} prevents auto-repair`,async()=>{const s=memorySource();const out=await reconciler(s,{resources:{...clearResources(),...patch}}).scan({fence});assert.equal(out.outcomes[0].classification,'RECOVERY_REQUIRED');assert.equal(s.repairs,0);});
test('ambiguous provider completion projects RECOVERY_REQUIRED only',async()=>{const s=memorySource(memorySubject({ambiguous:true,ambiguityReason:'AMBIGUOUS_PROVIDER_COMPLETION'}));const out=await reconciler(s).scan({fence});assert.equal(out.outcomes[0].classification,'RECOVERY_REQUIRED');assert.equal(s.repairs,0);});
test('stale revision fails closed before CAS mutation',async()=>{let reads=0;const s=memorySource();s.observe=async()=>memorySubject({observationToken:++reads===1?'v1':'v2'});const out=await reconciler(s).scan({fence});assert.equal(out.outcomes[0].result,'STALE_OBSERVATION');assert.equal(s.repairs,0);});
test('leadership change immediately before repair causes no mutation',async()=>{let checks=0;const s=memorySource();await assert.rejects(reconciler(s,{leadership:{assertCurrent:async()=>{if(++checks===3)throw Object.assign(new Error('lost'),{code:'LEADERSHIP_AUTHORITY_REJECTED'});}}}).scan({fence}),/lost/);assert.equal(s.repairs,0);});
test('desktop projection uses history indicator and never fabricates approval controls',()=>{const p=projectReconciliation({taskId:'t',classification:RECONCILIATION_CLASS.TERMINAL_PARENT_STALE_DESCENDANTS,repairResult:'APPLIED',repairReason:'RECONCILED_TERMINAL_PARENT',createdAt:'2026-09-01T00:00:00.000Z'},Date.parse('2026-09-07T00:00:00.000Z'));assert.equal(p.indicator,'RECONCILED');assert.equal(p.showApprovalCard,false);assert.deepEqual(p.safeAllowedActions,[]);});
test('unsupported semantic outcome repair never replays work',async()=>{const s=memorySource(memorySubject({classification:'POSSIBLE_MUTATION_REPLAY'}));const out=await reconciler(s).scan({fence});assert.equal(out.outcomes[0].classification,'RECOVERY_REQUIRED');assert.equal(s.repairs,0);});
