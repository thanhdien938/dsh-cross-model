import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PostgresCoordinationStore} from '../src/coordination/postgres/postgres-coordination-store.mjs';
import {createP5ProductionComposition} from '../src/runtime/p5-production-composition.mjs';

const dsn=process.env.DSH_P5_R2_POSTGRES_DSN;

test('real production owner, PM worker, parking, leader restoration, and resume lifecycle',{skip:!dsn},async t=>{
  const bootstrap=await new PostgresCoordinationStore().open({connectionString:dsn});await bootstrap.migrate();await bootstrap.close();
  const root=mkdtempSync(join(tmpdir(),'p5-r3-pg-'));mkdirSync(join(root,'repo'));
  const updates=[];const sent=[];
  const fetchImpl=async(url,init)=>{if(url.includes('getUpdates'))return{ok:true,json:async()=>({result:updates.shift()??[]})};sent.push(JSON.parse(init.body).text);return{ok:true,json:async()=>({})};};
  const config={mode:'production',postgres:{connectionString:dsn},sqlitePath:join(root,'state.db'),projects:[{id:'p',repo_path:join(root,'repo'),default_pm_profile_id:'pm',autonomy:{revision:1,effects:{SUBMIT_TASK:'ALLOW'}}}],profiles:[{id:'pm',role_kind:'PM',session_kind:'STATELESS',product:'scripted',transport:'in-process'}],telegram:{token:'runtime-random-token',ownerUserId:'1',ownerChatId:'2',projectId:'p',pollIntervalMs:10},coordinator:{logicalId:'coord',leaseMs:5000,pollIntervalMs:10},worker:{logicalId:'worker',leaseMs:300,pollIntervalMs:10},pm:{scriptedDecisions:[{type:'await_owner',kind:'QUESTION',title:'Approve',prompt:'Continue?',allowedResponses:['YES','NO']},{type:'finish',output:'done'}]}};
  const composition=await createP5ProductionComposition(config,{fetchImpl});t.after(async()=>{await composition.close();rmSync(root,{recursive:true,force:true});});
  updates.push([{update_id:1,message:{from:{id:1},chat:{id:2},text:'bounded owner task'}}]);await composition.adapter.pollOnce();
  assert.equal((await composition.terminalNotifier.flush()).sent,0);
  assert.equal(composition.agentBusRepository.listOwnerTasks({}).length,1);assert.equal(composition.sqlite.get('SELECT count(*) n FROM pm_runs').n,1);assert.equal(composition.sqlite.get('SELECT count(*) n FROM pm_turns').n,0);
  assert.equal((await composition.coordination.listPmActionCandidates({})).length,1);
  // P13-R1 §4.2: runOnce() starts admitted work and returns promptly --
  // await the started slot's own settlement promise for the terminal
  // outcome this test asserted on synchronously before P13-R1.
  const worker=await composition.buildWorker();const firstStarted=await worker.runOnce();assert.equal(firstStarted.status,'WORK');const first=await firstStarted.started[0].promise;assert.equal(first.status,'WORK');assert.equal(first.outcome.status,'PARKED');
  const inbox=await composition.ownerRepository.listInbox({});assert.equal(inbox.length,1);const interaction=inbox[0];const parked=await composition.coordination.readClaim(first.work_item_id);assert.equal(parked.claim_state,'RELEASED');await new Promise(resolve=>setTimeout(resolve,150));assert.equal((await composition.coordination.readClaim(first.work_item_id)).touch_revision,parked.touch_revision);assert.equal((await composition.coordination.listPmActionCandidates({})).length,0);assert.equal((await worker.runOnce()).status,'IDLE');
  updates.push([{update_id:2,message:{from:{id:1},chat:{id:2},text:`/decide ${interaction.interaction_id} ${interaction.revision} YES`}}]);await composition.adapter.pollOnce();assert.equal((await composition.ownerRepository.getInteraction(interaction.interaction_id)).status,'DECIDED');
  assert.equal((await worker.runOnce()).status,'IDLE');const coordinator=await composition.buildCoordinator();const restored=await coordinator.runOnce();assert.equal(restored.status,'LEADER');assert.equal(restored.result.restored,1);assert.equal((await coordinator.runOnce()).result.restored,0);
  const resumedStarted=await worker.runOnce();assert.equal(resumedStarted.status,'WORK');const resumed=await resumedStarted.started[0].promise;assert.equal(resumed.status,'WORK');assert.equal(resumed.outcome.status,'COMPLETED');assert.equal(composition.pmRepository.load(first.outcome.pmRunId).status,'completed');assert.equal((await composition.coordination.readClaim(first.work_item_id)).claim_state,'COMPLETED');
  const terminal=await composition.terminalNotifier.flush();assert.equal(terminal.sent,1);assert.match(sent.at(-1),/DSH task completed/);assert.match(sent.at(-1),/Result:\ndone/);assert.equal((await composition.terminalNotifier.flush()).sent,0);
  assert.equal((await worker.runOnce()).status,'IDLE');assert.equal(composition.sqlite.get('SELECT count(*) n FROM pm_runs').n,1);assert.equal(composition.sqlite.get('SELECT count(*) n FROM pm_turns').n,2);assert.doesNotMatch(sent.join('\n'),/runtime-random-token/);
  assert.equal(await composition.coordination.readSchemaVersion(),4);assert.equal(await composition.sqlite.readSchemaVersion(),6);
});
