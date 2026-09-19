import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {OwnerTaskController} from '../src/owner/owner-task-controller.mjs';
import {OwnerControlError,deterministicOwnerId} from '../src/owner/owner-contracts.mjs';
import {deriveTaskBranchName,prepareTaskBranch,restoreOriginalBranch} from '../src/pm/task-branch-binding.mjs';
import {admitTaskGitBinding as admitTaskGitBindingImpl} from '../src/pm/task-base-admission.mjs';
import {buildTaskReviewManifest} from '../src/pm/task-review-manifest.mjs';
import {loadP5Projects} from '../src/runtime/p5-production-config.mjs';

const AUTONOMY={revision:1,effects:{SUBMIT_TASK:'ALLOW',BRANCH_CREATE:'APPROVAL'}};
function git(cwd,args){return execFileSync('git',args,{cwd,encoding:'utf8',windowsHide:true}).trim();}
// Legacy branch+SHA pair, no explicit git_base_policy -> resolves to
// LEGACY pinned (Option A migration, unchanged strict semantics) — exactly
// what these P22.7-era tests were written to exercise.
function project(id,repoPath,branch,sha,workspaceId='workspace-1'){return{id,repo_path:repoPath,workspace_id:workspaceId,git_base_branch:branch,git_base_sha:sha,default_pm_profile_id:'pm',autonomy:AUTONOMY};}
// P24.1G6A: the injectable seam moved from the low-level `prepareTaskBranch`
// to `admitTaskGitBinding` (src/pm/task-base-admission.mjs), which owns
// base-policy/caller-CAS resolution BEFORE ever calling the (still real)
// `prepareTaskBranch()`. Tests that want the REAL end-to-end behavior omit
// `admit` (defaults to the real implementation); tests that want to
// observe/fake the call inject their own.
function controller({created=[],admit=admitTaskGitBindingImpl,resolveProjectForGit=null}={}){
  return new OwnerTaskController({repository:{createOwnerTask:t=>created.push(t)},startPm:async()=>null,admitTaskGitBinding:admit,resolveProjectForGit});
}
function command(id,{gitRequested=true}={}){return{command_id:id,client_kind:'LOCAL',payload:{body:'x',...(gitRequested?{git:{commit:true,push:false}}:{})}};}

function remoteFixture(t){
  const root=mkdtempSync(join(tmpdir(),'p22-7-base-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const bare=join(root,'origin.git'),work=join(root,'work'),publisher=join(root,'publisher');
  mkdirSync(bare);git(bare,['init','-q','--bare','-b','main']);mkdirSync(work);git(work,['init','-q','-b','main']);
  git(work,['config','user.email','dsh@example.invalid']);git(work,['config','user.name','DSH']);writeFileSync(join(work,'base.txt'),'A\n');
  git(work,['add','-A']);git(work,['commit','-q','-m','A']);git(work,['remote','add','origin',bare]);git(work,['push','-q','origin','main']);
  git(work,['checkout','-q','-b','runtime/home']);const a=git(work,['rev-parse','HEAD']);
  git(root,['clone','-q',bare,publisher]);git(publisher,['config','user.email','publisher@example.invalid']);git(publisher,['config','user.name','Publisher']);
  return{root,bare,work,publisher,a};
}
function advance(publisher,text){writeFileSync(join(publisher,'base.txt'),`${text}\n`);git(publisher,['add','-A']);git(publisher,['commit','-q','-m',text]);git(publisher,['push','-q','origin','main']);return git(publisher,['rev-parse','HEAD']);}
function sealedRef(taskId,projectId){return{schema_version:1,store_id:'store-p20-production-v1',project_id:projectId,task_id:taskId,invocation_id:`inv:${taskId}`,attempt_ordinal:0,artifact_relpath:'tasks/report.md',sha256:'a'.repeat(64),bytes:7,sealed_at:'2026-09-14T00:00:00.000Z'};}

test('fresh Git project authority overrides a stale startup base for a new task and is durably pinned',async()=>{
  const created=[],calls=[];
  const stale=project('p','C:/repo','feature/base','a'.repeat(40));
  const fresh=project('p','C:/repo','feature/base','b'.repeat(40));
  const c=controller({created,resolveProjectForGit:async()=>fresh,admit:async args=>{calls.push(args);return{task_id:args.taskId,project_id:args.projectId,task_mode:args.taskMode,base_branch:args.project.git_base_branch,base_sha:args.project.git_base_sha,task_branch:deriveTaskBranchName(args.taskId),remote:'origin',original_checkout:'runtime/home'};}});
  await c.submit({command:command('cmd-fresh-b'),project:stale,profile:{id:'pm'}});
  assert.equal(calls[0].project.git_base_sha,'b'.repeat(40));
  assert.equal(created[0].context.taskBranch.base_sha,'b'.repeat(40));
  assert.equal(created[0].context.taskBranch.base_branch,'feature/base');
});

test('non-Git submissions do not reload project authority or prepare a branch',async()=>{
  let reloads=0,prepares=0;
  const c=controller({resolveProjectForGit:async()=>{reloads++;return null;},admit:async()=>{prepares++;return null;}});
  await c.submit({command:command('cmd-no-git',{gitRequested:false}),project:project('p','C:/repo',null,null),profile:{id:'pm'}});
  assert.equal(reloads,0);assert.equal(prepares,0);
});

test('SINGLE, plain COUNCIL, and Debate-enabled COUNCIL use the same fresh pre-admission resolver',async()=>{
  for(const [label,council] of [['single',null],['council',{chair_profile_id:'pm',participant_profile_ids:['p1'],rounds:1,strategy:'independent_then_critique_then_synthesis'}],['debate',{chair_profile_id:'pm',participant_profile_ids:['p1'],rounds:1,strategy:'independent_then_critique_then_synthesis',debate:{enabled:true,max_rounds:1}}]]){
    let reloads=0,observed=null;const fresh=project('p','C:/repo','feature/base','b'.repeat(40));
    const c=controller({resolveProjectForGit:async()=>{reloads++;return fresh;},admit:async args=>{observed=args;return{task_id:args.taskId,project_id:'p',task_mode:args.taskMode,base_branch:args.project.git_base_branch,base_sha:args.project.git_base_sha,task_branch:deriveTaskBranchName(args.taskId),remote:'origin',original_checkout:'runtime/home'};}});
    await c.submit({command:command(`cmd-${label}`),project:project('p','C:/repo','feature/base','a'.repeat(40)),profile:{id:'pm'},council});
    assert.equal(reloads,1,label);assert.equal(observed.project.git_base_sha,'b'.repeat(40),label);assert.equal(observed.taskMode,council?'COUNCIL':'SINGLE',label);
  }
});

test('fresh project authority cannot silently repoint a running runtime to another physical workspace',async()=>{
  const c=controller({resolveProjectForGit:async()=>project('p','D:/other','feature/base','b'.repeat(40),'workspace-2'),admit:async()=>assert.fail('admit must not run')});
  await assert.rejects(()=>c.submit({command:command('cmd-wrong-workspace'),project:project('p','C:/repo','feature/base','a'.repeat(40),'workspace-1'),profile:{id:'pm'}}),e=>e instanceof OwnerControlError&&e.code==='TASK_BRANCH_BINDING_VIOLATION');
});

test('runtime starts at A; config and remote advance to B without restart; next real Git task (legacy pinned policy) pins and branches from B',async t=>{
  const f=remoteFixture(t),projectsPath=join(f.root,'projects.yaml');
  const writeProjects=sha=>writeFileSync(projectsPath,`projects:\n  - id: p\n    repo_path: ${f.work.replaceAll('\\','/')}\n    default_pm_profile_id: pm\n    git_base_branch: main\n    git_base_sha: ${sha}\n    autonomy: {revision: 1, effects: {SUBMIT_TASK: ALLOW, BRANCH_CREATE: APPROVAL}}\n`);
  writeProjects(f.a);
  const stale=(await loadP5Projects(projectsPath,{root:f.root}))[0];
  const b=advance(f.publisher,'B');
  writeProjects(b);
  const created=[];const c=controller({created,resolveProjectForGit:async({projectId})=>(await loadP5Projects(projectsPath,{root:f.root})).find(p=>p.id===projectId)});
  await c.submit({command:command('cmd-real-b'),project:stale,profile:{id:'pm'}});
  const taskId=deterministicOwnerId('task','cmd-real-b');
  assert.equal(created[0].context.taskBranch.base_sha,b);
  assert.equal(git(f.work,['rev-parse',taskId?`dsh/task-${taskId}`:'HEAD']),b);
  assert.equal(git(f.work,['merge-base',`dsh/task-${taskId}`,b]),b);
});

test('DYNAMIC policy: runtime starts at A; remote advances to B; NO config update needed; next task pins B',async t=>{
  const f=remoteFixture(t),projectsPath=join(f.root,'projects.yaml');
  // Explicit dynamic policy, base branch only — no git_base_sha at all.
  writeFileSync(projectsPath,`projects:\n  - id: p\n    repo_path: ${f.work.replaceAll('\\','/')}\n    default_pm_profile_id: pm\n    git_base_policy: dynamic\n    git_base_branch: main\n    autonomy: {revision: 1, effects: {SUBMIT_TASK: ALLOW, BRANCH_CREATE: APPROVAL}}\n`);
  const stale=(await loadP5Projects(projectsPath,{root:f.root}))[0];
  const b=advance(f.publisher,'B'); // remote moves -- config is NEVER touched again
  const created=[];const c=controller({created,resolveProjectForGit:async({projectId})=>(await loadP5Projects(projectsPath,{root:f.root})).find(p=>p.id===projectId)});
  await c.submit({command:command('cmd-dynamic-b'),project:stale,profile:{id:'pm'}});
  const taskId=deterministicOwnerId('task','cmd-dynamic-b');
  assert.equal(created[0].context.taskBranch.base_sha,b,'dynamic admission observed the CURRENT remote tip with no operator config update at all');
  assert.equal(git(f.work,['rev-parse',`dsh/task-${taskId}`]),b);
});

test('task pinned at A survives remote movement to B; manifest keeps A; next task pins B; home restore remains safe',async t=>{
  const f=remoteFixture(t);
  const bindingA=await prepareTaskBranch({projectRepoPath:f.work,taskId:'task-a',projectId:'p',taskMode:'COUNCIL',baseBranch:'main',expectedBaseSha:f.a});
  const b=advance(f.publisher,'B');
  const manifest=buildTaskReviewManifest({taskId:'task-a',projectId:'p',taskMode:'COUNCIL',branch:bindingA.task_branch,baseSha:bindingA.base_sha,artifactTransport:'artifact_v1',finalRef:sealedRef('task-a','p')});
  assert.equal(bindingA.base_sha,f.a);assert.equal(manifest.base_sha,f.a);assert.equal(git(f.work,['merge-base',bindingA.task_branch,f.a]),f.a);
  await restoreOriginalBranch({projectRepoPath:f.work,binding:bindingA});assert.equal(git(f.work,['branch','--show-current']),'runtime/home');
  const bindingB=await prepareTaskBranch({projectRepoPath:f.work,taskId:'task-b',projectId:'p',taskMode:'DEBATE',baseBranch:'main',expectedBaseSha:b});
  assert.equal(bindingB.base_sha,b);assert.equal(git(f.work,['rev-parse',bindingB.task_branch]),b);
  await restoreOriginalBranch({projectRepoPath:f.work,binding:bindingB});assert.equal(git(f.work,['branch','--show-current']),'runtime/home');
});
