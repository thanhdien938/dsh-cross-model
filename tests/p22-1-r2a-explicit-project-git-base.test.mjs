import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {loadP5ProductionConfig} from '../src/runtime/p5-production-config.mjs';
import {OwnerTaskController} from '../src/owner/owner-task-controller.mjs';
import {deriveTaskBranchName,prepareTaskBranch,TaskBranchLifecycleError} from '../src/pm/task-branch-binding.mjs';

const ENV={DSH_TEST_PG:'postgresql://u:p@example.invalid/db',DSH_TEST_TG:'token'};
const AUTONOMY={revision:1,effects:{SUBMIT_TASK:'ALLOW',BRANCH_CREATE:'APPROVAL'}};
function git(cwd,args){return execFileSync('git',args,{cwd,encoding:'utf8',windowsHide:true}).trim();}
function configFixture(t,gitLines=''){
  const root=mkdtempSync(join(tmpdir(),'p22-r2a-config-'));t.after(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(join(root,'repo'));
  writeFileSync(join(root,'projects.yaml'),`projects:\n  - id: p\n    repo_path: ./repo\n    default_pm_profile_id: pm\n${gitLines}    autonomy: {revision: 1, effects: {SUBMIT_TASK: ALLOW}}\n`);
  writeFileSync(join(root,'profiles.yaml'),'pm_profiles:\n  - {id: pm, role_kind: PM, session_kind: STATELESS, product: scripted, transport: in-process}\n');
  writeFileSync(join(root,'config.yaml'),`mode: production\npostgres: {dsn_env: DSH_TEST_PG}\nsqlite: {path: ./state.db}\nprojects_file: ./projects.yaml\npm_profiles_file: ./profiles.yaml\ntelegram: {token_env: DSH_TEST_TG, user_id: '1', chat_id: '2', project_id: p}\ncoordinator: {logical_id: c}\nworker: {logical_id: w}\npm: {}\n`);
  return{root,path:join(root,'config.yaml')};
}
function remoteFixture(t){
  const root=mkdtempSync(join(tmpdir(),'p22-r2a-git-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const bare=join(root,'origin.git'),work=join(root,'work');mkdirSync(bare);git(bare,['init','-q','--bare','-b','main']);mkdirSync(work);git(work,['init','-q','-b','main']);git(work,['config','user.email','dsh@example.invalid']);git(work,['config','user.name','DSH']);writeFileSync(join(work,'base.txt'),'main\n');git(work,['add','-A']);git(work,['commit','-q','-m','main']);git(work,['remote','add','origin',bare]);git(work,['push','-q','origin','main']);git(work,['remote','set-head','origin','main']);git(work,['checkout','-q','-b','feature/deployment']);writeFileSync(join(work,'feature.txt'),'trusted\n');git(work,['add','-A']);git(work,['commit','-q','-m','feature']);git(work,['push','-q','origin','feature/deployment']);return{work,mainSha:git(work,['rev-parse','origin/main']),featureSha:git(work,['rev-parse','origin/feature/deployment'])};
}

test('project config accepts a complete explicit base, normalizes SHA, and preserves absence as null',async t=>{
  const explicit=configFixture(t,`    git_base_branch: feature/deployment\n    git_base_sha: ${'A'.repeat(40)}\n`);const loaded=await loadP5ProductionConfig(explicit.path,{env:ENV});assert.equal(loaded.projects[0].git_base_branch,'feature/deployment');assert.equal(loaded.projects[0].git_base_sha,'a'.repeat(40));
  const absent=configFixture(t);const legacy=await loadP5ProductionConfig(absent.path,{env:ENV});assert.equal(legacy.projects[0].git_base_branch,null);assert.equal(legacy.projects[0].git_base_sha,null);
});

// P24.1G6A: "branch without SHA" is no longer a config error — it is the
// NEW dynamic-with-explicit-branch capability this phase introduces (an
// explicit git_base_branch with no mandatory admission-time SHA gate at
// all). Moved to its own dedicated success assertion below.
test('branch without SHA and no explicit policy is valid — resolves to the dynamic default with an explicit base branch',async t=>{
  const f=configFixture(t,'    git_base_branch: feature/deployment\n');const loaded=await loadP5ProductionConfig(f.path,{env:ENV});
  assert.equal(loaded.projects[0].git_base_branch,'feature/deployment');assert.equal(loaded.projects[0].git_base_sha,null);
  assert.equal(loaded.projects[0].git_base_policy,'dynamic');assert.equal(loaded.projects[0].git_base_legacy_pin,false);
});

for(const [label,lines,pattern] of [
  ['SHA without branch',`    git_base_sha: ${'a'.repeat(40)}\n`,/git_base_sha requires git_base_branch/],
  ['malformed branch',`    git_base_branch: https://example.invalid/repo\n    git_base_sha: ${'a'.repeat(40)}\n`,/git_base_branch is invalid/],
  ['malformed SHA','    git_base_branch: feature/deployment\n    git_base_sha: abc123\n',/git_base_sha must be an exact 40-character/],
])test(`config fails closed: ${label}`,async t=>{const f=configFixture(t,lines);await assert.rejects(()=>loadP5ProductionConfig(f.path,{env:ENV}),pattern);});

test('legacy branch+SHA pair with NO explicit policy resolves to pinned (Option A migration — never silently reinterpreted as dynamic)',async t=>{
  const f=configFixture(t,`    git_base_branch: feature/deployment\n    git_base_sha: ${'A'.repeat(40)}\n`);const loaded=await loadP5ProductionConfig(f.path,{env:ENV});
  assert.equal(loaded.projects[0].git_base_policy,'pinned');assert.equal(loaded.projects[0].git_base_legacy_pin,true);
});

test('explicit git_base_policy: dynamic alongside a legacy SHA keeps it informational only, never a CAS at admission',async t=>{
  const f=configFixture(t,`    git_base_policy: dynamic\n    git_base_branch: feature/deployment\n    git_base_sha: ${'A'.repeat(40)}\n`);const loaded=await loadP5ProductionConfig(f.path,{env:ENV});
  assert.equal(loaded.projects[0].git_base_policy,'dynamic');assert.equal(loaded.projects[0].git_base_legacy_pin,false);assert.equal(loaded.projects[0].git_base_sha,'a'.repeat(40),'preserved as migration metadata, shape-validated');
});

test('explicit git_base_policy: pinned without a SHA fails config validation',async t=>{
  const f=configFixture(t,'    git_base_policy: pinned\n    git_base_branch: feature/deployment\n');
  await assert.rejects(()=>loadP5ProductionConfig(f.path,{env:ENV}),/git_base_policy "pinned" requires both/);
});

test('unknown git_base_policy value fails config validation',async t=>{
  const f=configFixture(t,'    git_base_policy: frozen\n    git_base_branch: feature/deployment\n');
  await assert.rejects(()=>loadP5ProductionConfig(f.path,{env:ENV}),/git_base_policy must be "dynamic" or "pinned"/);
});

test('OwnerTaskController threads the FRESH trusted project base facts unchanged to admitTaskGitBinding',async()=>{
  let observed=null;const created=[];const controller=new OwnerTaskController({repository:{createOwnerTask:t=>created.push(t)},startPm:async()=>null,admitTaskGitBinding:async args=>{observed=args;return{task_id:args.taskId,project_id:args.projectId,task_mode:args.taskMode,base_branch:args.project.git_base_branch,base_sha:args.project.git_base_sha,task_branch:deriveTaskBranchName(args.taskId),remote:args.remote,original_checkout:'feature/deployment'};}});
  await controller.submit({command:{command_id:'cmd-r2a',client_kind:'LOCAL',payload:{body:'x',git:{commit:true,push:false}}},project:{id:'p',repo_path:'C:/repo',autonomy:AUTONOMY,git_base_branch:'feature/deployment',git_base_sha:'a'.repeat(40)},profile:{id:'pm'}});
  assert.equal(observed.project.git_base_branch,'feature/deployment');assert.equal(observed.project.git_base_sha,'a'.repeat(40));assert.equal(observed.callerExpectedBaseSha,null);assert.match(created[0].context.taskBranch.task_branch,/^dsh\/task-task-/);
});

test('live failure regression: checkout may be feature while origin/HEAD is main; explicit base selects feature, never main',async t=>{
  const {work,mainSha,featureSha}=remoteFixture(t);assert.notEqual(featureSha,mainSha);assert.equal(git(work,['symbolic-ref','--short','refs/remotes/origin/HEAD']),'origin/main');assert.equal(git(work,['rev-parse','--abbrev-ref','HEAD']),'feature/deployment');
  const binding=await prepareTaskBranch({projectRepoPath:work,taskId:'task-live-r2a',baseBranch:'feature/deployment',expectedBaseSha:featureSha});assert.equal(binding.base_branch,'feature/deployment');assert.equal(binding.base_sha,featureSha);assert.equal(git(work,['rev-parse','HEAD']),featureSha);assert.equal(git(work,['rev-parse','--abbrev-ref','HEAD']),'dsh/task-task-live-r2a');assert.equal(readFileSync(join(work,'feature.txt'),'utf8'),'trusted\n');
});

test('explicit expected SHA drift fails closed without falling back, merging, rebasing, resetting, or creating a task branch',async t=>{
  const {work,featureSha}=remoteFixture(t);const before=git(work,['rev-parse','HEAD']);await assert.rejects(()=>prepareTaskBranch({projectRepoPath:work,taskId:'task-drift-r2a',baseBranch:'feature/deployment',expectedBaseSha:'f'.repeat(40)}),e=>e instanceof TaskBranchLifecycleError&&e.code==='TASK_BRANCH_BASE_SHA_DRIFT');assert.equal(git(work,['rev-parse','HEAD']),before);assert.equal(git(work,['branch','--list','dsh/task-task-drift-r2a']),'');assert.equal(git(work,['rev-parse','origin/feature/deployment']),featureSha);
});

test('absent explicit project base preserves the origin/HEAD fallback',async t=>{
  const {work,mainSha}=remoteFixture(t);git(work,['checkout','-q','feature/deployment']);const binding=await prepareTaskBranch({projectRepoPath:work,taskId:'task-fallback-r2a'});assert.equal(binding.base_branch,'main');assert.equal(binding.base_sha,mainSha);assert.equal(git(work,['rev-parse','HEAD']),mainSha);
});
