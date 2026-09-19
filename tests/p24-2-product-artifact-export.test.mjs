import {fakeReportBackend} from './fixtures/p20-report-helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {withStores,buildRuntime,backendResolver,PROJECT} from './fixtures/p20-durable-council-harness.mjs';
import {councilBackends} from './fixtures/p20-council-helpers.mjs';
import {normalizeCouncilSpec} from '../src/pm/council/council-contracts.mjs';
import {AgentBusRepository} from '../src/persistence/repositories/agentbus-repository.mjs';
import {OwnerTaskController} from '../src/owner/owner-task-controller.mjs';
import {deterministicOwnerId} from '../src/owner/owner-contracts.mjs';
import {createPmRequest} from '../src/pm/pm-contracts.mjs';
import {ProductionPmWorkHandler,pmWorkIdentity} from '../src/runtime/production-pm-worker.mjs';
import {buildProductArtifactPackage,materializeProductArtifactPackage} from '../src/pm/council/product-artifact-export.mjs';
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',windowsHide:true}).trim();
async function fixture(options, fn){
 await withStores(async ({sqlite,newArtifactStore,newPmRepo,newStepState})=>{
  const root=mkdtempSync(join(tmpdir(),'p24-export-'));const repo=join(root,'repo'),remote=join(root,'remote.git');
  mkdirSync(repo);mkdirSync(remote);git(remote,'init','-q','--bare','-b','main');git(repo,'init','-q','-b','main');
  git(repo,'config','user.name','DSH Test');git(repo,'config','user.email','dsh@example.invalid');git(repo,'config','core.autocrlf','false');
  writeFileSync(join(repo,'README.md'),'seed\n');git(repo,'add','-A');git(repo,'commit','-qm','seed');git(repo,'remote','add','origin',remote);git(repo,'push','-q','origin','main');
  const pushLog=join(root,'push.log');writeFileSync(join(repo,'.git/hooks/pre-push'),'#!/bin/sh\necho push >> "'+pushLog.replaceAll('\\','/')+'"\n',{mode:0o755});
  try{
   const council=normalizeCouncilSpec({chair_profile_id:'chair',participant_profile_ids:['alpha','beta','gamma'],rounds:2,debate:{enabled:Boolean(options.debate),max_rounds:2}});
   const project={id:PROJECT.id,repo_path:repo,autonomy:{revision:1,effects:{PUSH_REMOTE:'APPROVAL',BRANCH_CREATE:'APPROVAL'}}};
   const tasks=new AgentBusRepository({store:sqlite}),pm=newPmRepo(),store=newArtifactStore();
   const commandId='cmd-'+randomUUID(),taskId=deterministicOwnerId('task',commandId),pmRunId=deterministicOwnerId('pmrun',commandId);
   await new OwnerTaskController({repository:tasks,startPm:null,resolveTransportVersion:()=>"artifact_v1"}).submit({command:{command_id:commandId,client_kind:'LOCAL',payload:{body:'Review only',mode:'council',git:{commit:options.commit!==false,push:options.push!==false&&options.commit!==false},...(options.workspace?{workspace_output:{report_path:options.workspaceCollision?`reports/dsh-tasks/${taskId}/chair/../manifest.json`:'reports/final.md',non_empty:true}}:{})}},project,profile:{id:'chair'},council});
   const task=tasks.getOwnerTask(taskId);
   await pm.create(createPmRequest({objective:task.body,context:task.context}),{id:pmRunId,driver:'council:chair',startedAt:'2026-09-16T00:00:00Z'});
   const normal=options.crlf?((profileId)=>({backend:'fake',runReport:args=>fakeReportBackend({text:'# '+args.request.stage+'\r\n\r\nReport by '+profileId+'\r\n'}).runReport(args)})):backendResolver([],{debateTypedControl:true,continueDebate:({round})=>options.maxStop||round===1&&options.early!==true});
   const failing=councilBackends({plan:{gamma:{terminalState:'PROVIDER_ERROR',finishReason:'error'},...(options.failChair?{chair:{terminalState:'PROVIDER_ERROR',finishReason:'error'}}:{})}});
   const runtime=()=>buildRuntime({council,artifactStore:store,stepState:newStepState(),pmRepository:pm,calls:[],taskId,maxTurns:32,resolveReportBackend:options.degraded||options.failChair?failing:normal});
   const handler=new ProductionPmWorkHandler({coordinationStore:{completeClaim:async()=>{}},pmRepository:pm,ownerRepository:{},taskRepository:tasks,projects:[project],createRuntime:runtime,resolveProjectArtifactStore:()=>store});
   const work={pm_run_id:pmRunId,action_id:pmWorkIdentity({taskId,pmRunId}).action_id};
   const args=()=>({repoRoot:repo,store,taskId,projectId:project.id,baseSha:task.context.taskBranch?.base_sha??null,run:pm.load(pmRunId)});
   await fn({root,repo,remote,pushLog,taskId,pmRunId,task,pm,store,args,handler,work,runtime,council});
  }finally{rmSync(root,{recursive:true,force:true});}
 });
}
for(const options of [{},{workspace:true},{degraded:true},{debate:true},{debate:true,early:true},{debate:true,maxStop:true},{push:false}]){
 test('real worker product settlement '+JSON.stringify(options),async()=>fixture(options,async f=>{
  const first=await f.handler.execute({work:f.work,fence:{}});
  assert.equal(first.result?.outcome.local_git_status,'LOCAL_COMMIT_VERIFIED',JSON.stringify(first.result?.outcome));
  const binding=f.task.context.taskBranch,head=git(f.repo,'rev-parse',binding.task_branch);
  assert.equal(git(f.repo,'rev-list','--count',binding.base_sha+'..'+head),'1');
  const doc=JSON.parse(git(f.repo,'show',head+':reports/dsh-tasks/'+f.taskId+'/manifest.json'));
  assert.equal(doc.quorum,options.degraded?'degraded':'full_quorum');
  assert.equal(doc.artifacts.length,options.debate?(options.early?13:18):options.degraded?6:8);
  if(options.degraded){assert.equal(doc.participants[2].application_outcome,'FAILED');assert.equal(doc.participants[2].stage_artifacts.length,0);assert.equal(doc.participants[2].stage_outcomes[0].status,'FAILED');}
  if(options.debate){assert.equal(doc.debate.rounds_run,options.early?1:2);assert.equal(doc.debate.continuation.at(-1).engine_forced_stop,Boolean(options.maxStop));}
  if(options.workspace)assert.equal(git(f.repo,'show',head+':reports/final.md'),git(f.repo,'show',head+':reports/dsh-tasks/'+f.taskId+'/chair/synthesis.md'));
  if(options.push!==false){
   assert.equal(first.result.outcome.remote_sync_status,'REMOTE_PUSH_VERIFIED');
   assert.equal(git(f.repo,'ls-remote',f.remote,binding.task_branch).split(/\s/)[0],head);
   assert.ok(git(f.repo,'show',head+':docs/task-review/'+f.taskId+'.json'));
   assert.equal(readFileSync(f.pushLog,'utf8').trim().split('\n').length,1);
  }
  await f.handler.execute({work:f.work,fence:{}});
  assert.equal(git(f.repo,'rev-parse',binding.task_branch),head,'no second commit on recovery');
  if(options.push!==false)assert.equal(readFileSync(f.pushLog,'utf8').trim().split('\n').length,1,'no second push');
 }));
}
test('commit false retains sealed store but exports no package',async()=>fixture({commit:false},async f=>{
 await f.handler.execute({work:f.work,fence:{}});
 assert.equal(f.store.openTaskById(f.taskId).freshManifest().task_state,'COMPLETED');
 assert.equal(existsSync(join(f.repo,'reports/dsh-tasks')),false);
 assert.equal(git(f.repo,'rev-list','--count','HEAD'),'1');
}));
test('failed chair produces no settlement or package',async()=>fixture({failChair:true},async f=>{
 await f.handler.execute({work:f.work,fence:{}});
 assert.equal(existsSync(join(f.repo,'reports/dsh-tasks')),false);
 assert.equal(git(f.repo,'rev-list','--count',f.task.context.taskBranch.task_branch),'1');
 assert.equal(existsSync(f.pushLog),false);
}));
async function complete(f){await f.runtime().resume(f.pmRunId);assert.equal(f.pm.load(f.pmRunId).status,'completed');}
test('export replay byte identical before commit; partial package replay; collision fails closed',async()=>fixture({push:false},async f=>{
 await complete(f);const a=materializeProductArtifactPackage(f.args());
 const one=[...a.files.keys()][0];rmSync(join(f.repo,one));
 const b=materializeProductArtifactPackage(f.args());assert.deepEqual(a.files,b.files);
 for(const[path,bytes]of b.files)assert.deepEqual(readFileSync(join(f.repo,path)),bytes);
 writeFileSync(join(f.repo,one),'foreign');assert.throws(()=>materializeProductArtifactPackage(f.args()),/conflicting/);
}));
for(const corruption of ['missing','corrupt'])test(corruption+' sealed source blocks commit',async()=>fixture({},async f=>{
 await complete(f);const m=f.store.openTaskById(f.taskId).freshManifest();const ref=m.stages['chair-plan'].sealed_ref;
 const p=join(f.store.root,ref.artifact_relpath);if(corruption==='missing')rmSync(p);else writeFileSync(p,'corrupt');
 assert.throws(()=>materializeProductArtifactPackage(f.args()));
 await f.handler.execute({work:f.work,fence:{}});
 assert.equal(git(f.repo,'rev-list','--count',f.task.context.taskBranch.task_branch),'1');assert.equal(existsSync(f.pushLog),false);
}));
test('unsafe task id, alias collision, stage collision, destination junction fail closed',async()=>fixture({push:false},async f=>{
 await complete(f);assert.throws(()=>buildProductArtifactPackage({...f.args(),taskId:'../escape'}));
 const run=structuredClone(f.args().run);const handoffs=run.turns.map(t=>t.outcome?.finalResult?.handoff).filter(Boolean);
 handoffs.find(h=>h.profile_id==='beta').actor_alias='alpha';assert.throws(()=>buildProductArtifactPackage({...f.args(),run}),/alias collision/);
 const duplicate=structuredClone(f.args().run);duplicate.turns.push(duplicate.turns.find(t=>t.outcome?.finalResult?.handoff));
 assert.throws(()=>buildProductArtifactPackage({...f.args(),run:duplicate}),/duplicate/);
 const outside=join(f.root,'outside');mkdirSync(outside);symlinkSync(outside,join(f.repo,'reports'),'junction');
 assert.throws(()=>materializeProductArtifactPackage(f.args()),/symlink/);
}));


// Product bytes must survive Git's text normalization without a silent omission.
test('CRLF source remains byte-identical with autocrlf enabled',async()=>fixture({push:false,crlf:true},async f=>{
 await complete(f);git(f.repo,'config','core.autocrlf','true');
 const a=materializeProductArtifactPackage(f.args());git(f.repo,'add','-A');
 for(const[path,bytes]of a.files){const staged=execFileSync('git',['show',':'+path],{cwd:f.repo,windowsHide:true});assert.deepEqual(staged,bytes);}
 await f.handler.execute({work:f.work,fence:{}});
 assert.equal(git(f.repo,'rev-list','--count',f.task.context.taskBranch.base_sha+'..'+f.task.context.taskBranch.task_branch),'1');
}));
test('ignored task package fails closed before commit or push',async()=>fixture({},async f=>{
 writeFileSync(join(f.repo,'.git/info/exclude'),'reports/dsh-tasks/\n');
 await f.handler.execute({work:f.work,fence:{}});
 assert.equal(git(f.repo,'rev-list','--count',f.task.context.taskBranch.task_branch),'1');
 assert.equal(existsSync(f.pushLog),false);
}));
test('normalized workspace_output collision fails before package write',async()=>fixture({workspace:true,workspaceCollision:true},async f=>{
 await f.handler.execute({work:f.work,fence:{}});
 assert.equal(git(f.repo,'rev-list','--count',f.task.context.taskBranch.task_branch),'1');
 assert.equal(existsSync(join(f.repo,'reports/dsh-tasks')),false);
 assert.equal(existsSync(f.pushLog),false);
}));
test('manifest excludes failure prose and extra reference metadata',async()=>fixture({degraded:true,push:false},async f=>{
 await complete(f);const run=structuredClone(f.args().run);
 for(const turn of run.turns){const h=turn.outcome?.finalResult?.handoff;if(!h)continue;if(!h.ok)h.reason='DO_NOT_EXPORT_SECRET_DIAGNOSTIC';}
 run.data.final_ref.extra_transport_envelope='DO_NOT_EXPORT_SECRET_REQUEST';
 const pkg=buildProductArtifactPackage({...f.args(),run});
 assert.doesNotMatch(JSON.stringify(pkg.manifest),/DO_NOT_EXPORT|extra_transport_envelope/);
 assert.equal(pkg.manifest.participants[2].application_outcome,'FAILED');
 const altered=run.turns.find(t=>t.outcome?.finalResult?.handoff?.ok).outcome.finalResult.handoff;
 altered.sealed_ref.extra_transport_envelope='DO_NOT_EXPORT_SECRET_REQUEST';
 assert.throws(()=>buildProductArtifactPackage({...f.args(),run}),/sealed_ref does not match/);
}));
