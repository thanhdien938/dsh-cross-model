import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
import {SqlitePersistenceStore} from '../src/persistence/sqlite/sqlite-persistence-store.mjs';import {AgentBusRepository} from '../src/persistence/repositories/agentbus-repository.mjs';import {PmRepository} from '../src/persistence/repositories/pm-repository.mjs';import {PostgresCoordinationStore} from '../src/coordination/postgres/postgres-coordination-store.mjs';import {PostgresOwnerRepository} from '../src/owner/postgres-owner-repository.mjs';import {OwnerControlService} from '../src/owner/owner-control-service.mjs';import {OwnerTaskController} from '../src/owner/owner-task-controller.mjs';import {PmProfileRegistry} from '../src/pm/pm-profile-registry.mjs';import {DurablePmRuntime} from '../src/pm/durable-pm-runtime.mjs';
import {startLocalOwnerServer,requestLocalOwner} from '../prototypes/p6/shared/local-owner-channel.mjs';import {ReadProjectionService,stable} from '../prototypes/p6/p0-c-read-projection/read-projection.mjs';import {ProjectArmModel,routeMultiProjectTelegram} from '../prototypes/p6/p0-d-multiproject-safety/safety-model.mjs';import {acquireRuntimeLock} from '../prototypes/p6/p0-a-electron-supervision/runtime-lock.mjs';
import {createP5ProductionComposition} from '../src/runtime/p5-production-composition.mjs';import {pmWorkIdentity} from '../src/runtime/production-pm-worker.mjs';

const dsn=process.env.DSH_P6_P0_POSTGRES_DSN;
test('P0-A runtime lock refuses live owner and reclaims stale owner',async()=>{const root=mkdtempSync(join(tmpdir(),'p6-lock-')),path=join(root,'runtime.lock');try{const first=await acquireRuntimeLock(path);assert.equal(first.status,'ACQUIRED');assert.equal((await acquireRuntimeLock(path)).status,'HELD');await first.release();writeFileSync(path,JSON.stringify({pid:99999999}));const reclaimed=await acquireRuntimeLock(path,{isAlive:()=>false});assert.equal(reclaimed.status,'RECLAIMED');await reclaimed.release();}finally{rmSync(root,{recursive:true,force:true});}});
test('P0-D select/arm prevents loaded draft retarget attack',()=>{const model=new ProjectArmModel(['p0-project-a','p0-project-b']);model.select('p0-project-a');model.arm('p0-project-a');model.type('for A');model.select('p0-project-b');assert.deepEqual(model.submit(),{status:'REFUSED',code:'PROJECT_NOT_ARMED'});model.arm('p0-project-b');model.type('for B');assert.equal(model.submit().project_id,'p0-project-b');});
test('P0-D Telegram routing fails closed and explicit targets survive restart',()=>{const projects=[{id:'p0-project-a'},{id:'p0-project-b'}],base={projects,ownerUserId:'1',ownerChatId:'2'},update=text=>({update_id:1,message:{from:{id:1},chat:{id:2},text}});assert.equal(routeMultiProjectTelegram(update('bare'),base).code,'TELEGRAM_PROJECT_REQUIRED');assert.equal(routeMultiProjectTelegram(update('/projects'),base).read,'GET_PROJECTS');const a=routeMultiProjectTelegram(update('@p0-project-a inspect'),base);assert.equal(a.project_id,'p0-project-a');assert.match(a.acknowledgement,/p0-project-a/);assert.equal(routeMultiProjectTelegram(update('bare'),base).code,'TELEGRAM_PROJECT_REQUIRED');});
test('P0-C stable merge is repeatable and lineage-based',()=>{const rows=[{event_kind:'PM',project_id:'p',task_id:'t',pm_run_id:'r',source:'sqlite',timestamp:'2026-01-01T00:00:00.000Z',stable_source_id:'2',human_summary:'pm'},{event_kind:'USER_GUI',project_id:'p',task_id:'t',pm_run_id:'r',source:'postgres',timestamp:'2026-01-01T00:00:00.000Z',stable_source_id:'1',human_summary:'owner'}];assert.deepEqual(stable(rows),stable([...rows].reverse()));assert.ok(stable(rows).every(v=>v.lineage_key==='t'));});
test('P0-B channel is closed and sanitizes controlled secret canaries',async()=>{const pipe=`\\\\.\\pipe\\dsh-p6-p0-secret-${process.pid}-${randomUUID()}`,server=await startLocalOwnerServer({pipeName:pipe,ownerService:{mutate:async()=>({dsn:'postgresql://user:canary@host/db',token:'canary-token',message:'Bearer canary-bearer https://user:pass@example.test/path'})}});try{const response=await requestLocalOwner({pipeName:pipe,request:{id:'secret',operation:'SUBMIT_TASK',command:{operation:'SUBMIT_TASK'}}});const rendered=JSON.stringify(response);assert.doesNotMatch(rendered,/canary|user:pass|token|dsn/i);const refused=await requestLocalOwner({pipeName:pipe,request:{id:'shell',operation:'shell'}});assert.equal(refused.error.code,'LOCAL_OPERATION_REFUSED');}finally{await server.close();}});
test('P0-B/C real stores prove idempotent LOCAL materialization, conflict, projection and notification non-interference',{skip:!dsn},async()=>{
  const root=mkdtempSync(join(tmpdir(),'p6-p0-')),repoPath=join(root,'repo'),sqlitePath=join(root,'state.db');mkdirSync(repoPath);
  const coordination=await new PostgresCoordinationStore().open({connectionString:dsn});await coordination.migrate();const owner=await new PostgresOwnerRepository().open({connectionString:dsn}),sqlite=await new SqlitePersistenceStore().open({path:sqlitePath});await sqlite.migrate();
  const bus=new AgentBusRepository({store:sqlite}),pmRepo=new PmRepository({store:sqlite}),profiles=new PmProfileRegistry([{id:'p0-pm',role_kind:'PM',session_kind:'STATELESS',product:'scripted',transport:'in-process'}]);let calls=0;
  const runtime=new DurablePmRuntime({driver:{name:'p0-production-shape',decide:async()=>{calls++;return{type:'finish',output:'P0 complete'}}},workflowRunner:{run:async()=>{},result:()=>null},peerRelay:{exchange:async()=>{},createConversation(){},getConversation(){},result:()=>null},repository:pmRepo,profileRegistry:profiles,pmProfileId:'p0-pm'});
  const project={id:'p0-project-a',repo_path:repoPath,default_pm_profile_id:'p0-pm',autonomy:{revision:1,effects:{SUBMIT_TASK:'ALLOW'}}};const controller=new OwnerTaskController({repository:bus,startPm:({task,pmRunId})=>runtime.run({objective:task.body,context:task.context,pmRunId})}),service=new OwnerControlService({repository:owner,taskController:controller,projects:[project],pmProfiles:[profiles.get('p0-pm')]});
  const pipe=`\\\\.\\pipe\\dsh-p6-p0-test-${process.pid}-${randomUUID()}`,server=await startLocalOwnerServer({pipeName:pipe,ownerService:service});const command={command_id:`p0-${randomUUID()}`,actor_id:'1',client_kind:'LOCAL',operation:'SUBMIT_TASK',project_id:project.id,payload:{body:'inspect only'}};
  try{
    const first=await requestLocalOwner({pipeName:pipe,request:{id:'1',operation:'SUBMIT_TASK',command}});assert.equal(first.ok,true);const replay=await requestLocalOwner({pipeName:pipe,request:{id:'2',operation:'SUBMIT_TASK',command}});assert.deepEqual(replay.result,first.result);
    const conflict=await requestLocalOwner({pipeName:pipe,request:{id:'3',operation:'SUBMIT_TASK',command:{...command,payload:{body:'different'}}}});assert.equal(conflict.error.code,'OWNER_COMMAND_CONFLICT');await requestLocalOwner({pipeName:pipe,request:{id:'4',operation:'SUBMIT_TASK',command},disconnectAfterWrite:true});await new Promise(r=>setTimeout(r,30));
    assert.equal(bus.listOwnerTasks().length,1);assert.equal(sqlite.get('SELECT count(*) n FROM pm_runs').n,1);assert.equal(calls,1);
    const notificationId=`p0-notification-${randomUUID()}`;await owner.createInteraction({interaction_id:notificationId,project_id:project.id,task_id:first.result.canonical_result.task_id,pm_run_id:first.result.canonical_result.pm_run_id,pm_turn_index:null,origin:'SYSTEM',kind:'INFO',status:'CLOSED',title:'P0 visible',prompt_text:'Sanitized notification',allowed_responses:[],runtime_facts:{notification_kind:'P0_PROOF'},response_bindings:{},requires_response:false,local_only:true});
    const before=await owner.getInteraction(notificationId);assert.equal(before.notified_at,null);assert.equal(before.notification_attempts,0);
    const projection=await new ReadProjectionService({connectionString:dsn,sqlitePath}).open();let one;const started=performance.now();try{one=await projection.timeline(project.id);for(let i=0;i<10;i++)assert.deepEqual(await projection.timeline(project.id),one);assert.ok(one.some(v=>v.event_kind==='USER_GUI'));assert.ok(one.some(v=>v.event_kind==='PM'));assert.ok(one.some(v=>v.stable_source_id===notificationId));}finally{await projection.close();}
    assert.ok(performance.now()-started<2000);const after=await owner.getInteraction(notificationId);assert.equal(after.notified_at,null);assert.equal(after.notification_attempts,0);
    const reconnect=await new ReadProjectionService({connectionString:dsn,sqlitePath}).open();try{assert.deepEqual(await reconnect.timeline(project.id),one);}finally{await reconnect.close();}
    assert.ok((await owner.claimNotifications({limit:20})).some(v=>v.interaction_id===notificationId));
  }finally{await server.close();await sqlite.close();await owner.close();await coordination.close();rmSync(root,{recursive:true,force:true});}
});
// P13-R1: this P6-era prototype proved GLOBAL serialization across every
// project, unconditionally -- that specific claim is no longer the
// architecture (see docs/p13/04_P13_R1_BOUNDED_CROSS_WORKSPACE_PARALLELISM_
// IMPLEMENTATION_OPUS5.md and the new p13-r1-*.test.mjs cross-workspace
// proofs). `pmConcurrencyLimit:1` is passed explicitly below so THIS
// regression keeps testing what it always tested (single-flight owner
// command/claim plumbing) rather than silently starting to exercise R1's
// new default concurrency of 2 by accident.
test('P0-D real two-project composition is globally serialized and preserves exact project routing',{skip:!dsn},async()=>{
  const root=mkdtempSync(join(tmpdir(),'p6-p0-d-')),a=join(root,'repo-a'),b=join(root,'repo-b');mkdirSync(a);mkdirSync(b);
  let release;const gate=new Promise(r=>release=r);let calls=0;const invokedPaths=[];
  const profile={id:'p0-delay',role_kind:'PM',session_kind:'STATELESS',product:'p0-delay',transport:'in-process'};
  const projects=[a,b].map((repo_path,index)=>({id:`p0-project-${index?'b':'a'}`,repo_path,default_pm_profile_id:profile.id,autonomy:{revision:1,effects:{SUBMIT_TASK:'ALLOW'}}}));
  const config={postgres:{connectionString:dsn},sqlitePath:join(root,'state.db'),projects,profiles:[profile],telegram:{token:'opaque-fake',ownerUserId:'1',ownerChatId:'2',projectId:projects[0].id,pollIntervalMs:10},coordinator:{logicalId:`p0-d-coord-${randomUUID()}`,leaseMs:5000,pollIntervalMs:10},worker:{logicalId:`p0-d-worker-${randomUUID()}`,leaseMs:1000,pollIntervalMs:10},pm:{scriptedDecisions:null}};
  const composition=await createP5ProductionComposition(config,{pmConcurrencyLimit:1,pmDriverFactories:{'p0-delay':(_profile,{project})=>({name:'p0-delay',decide:async()=>{invokedPaths.push(project.repo_path);calls++;if(calls===1)await gate;return{type:'finish',output:`done:${project.id}`};}})},fetchImpl:async()=>({ok:true,json:async()=>({result:[]})})});
  try{
    const results=[];
    for(const project of projects)results.push(await composition.ownerService.mutate({command_id:`p0-d-${project.id}-${randomUUID()}`,actor_id:'1',client_kind:'LOCAL',operation:'SUBMIT_TASK',project_id:project.id,payload:{body:`inspect ${project.repo_path}`}}));
    assert.deepEqual(composition.agentBusRepository.listOwnerTasks().map(v=>v.projectId).sort(),projects.map(v=>v.id).sort());
    for(const project of projects)await composition.ownerRepository.createInteraction({interaction_id:`p0-d-interaction-${project.id}`,project_id:project.id,task_id:null,pm_run_id:null,pm_turn_index:null,origin:'PM',kind:'QUESTION',status:'OPEN',title:'Project approval',prompt_text:'Continue?',allowed_responses:['YES'],runtime_facts:{},response_bindings:{},requires_response:true,local_only:true});
    const projection=await new ReadProjectionService({connectionString:dsn,sqlitePath:config.sqlitePath}).open();try{for(const project of projects){const rows=await projection.timeline(project.id);assert.ok(rows.length>=3);assert.ok(rows.every(v=>v.project_id===project.id));assert.deepEqual((await composition.ownerRepository.listInbox({limit:20})).filter(v=>v.project_id===project.id).map(v=>v.project_id),[project.id]);}}finally{await projection.close();}
    const worker=await composition.buildWorker(),active=worker.runOnce();
    for(let i=0;i<100&&calls===0;i++)await new Promise(r=>setTimeout(r,10));
    assert.equal(calls,1,'first PM action must be active before observing global serialization');
    const pmRuns=composition.sqlite.all('SELECT id FROM pm_runs ORDER BY id');
    assert.equal(pmRuns.length,2);
    const works=await Promise.all(pmRuns.map(({id})=>composition.coordination.readClaim(pmWorkIdentity({taskId:'lineage-read-only',pmRunId:id}).work_item_id)));
    assert.equal(works.filter(v=>v?.claim_state==='ACTIVE').length,1);
    assert.equal(works.filter(v=>v===null).length,1);
    assert.equal((await composition.coordination.listPmActionCandidates({limit:10})).length,1);
    // P13-R1 §4.2: `runOnce()` itself now resolves as soon as the work item
    // is admitted/claimed and started, not once `decide()` finishes -- the
    // gated `decide()` completion is observed through the started slot's
    // own settlement promise instead.
    const startedFirst=await active;assert.equal(startedFirst.status,'WORK');
    release();await startedFirst.started[0].promise;assert.equal(calls,1);
    const startedSecond=await worker.runOnce();assert.equal(startedSecond.status,'WORK');await startedSecond.started[0].promise;assert.equal(calls,2);
    assert.deepEqual(invokedPaths.sort(),[a,b].sort());assert.equal(composition.pmRepository.listTerminalRuns().length,2);
  }finally{release?.();composition.requestDrain();await composition.close();rmSync(root,{recursive:true,force:true});}
});
