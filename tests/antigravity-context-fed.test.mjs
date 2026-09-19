import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';import {PassThrough} from 'node:stream';import {mkdtempSync,rmSync,writeFileSync,realpathSync} from 'node:fs';import {join,basename} from 'node:path';import {tmpdir} from 'node:os';import {execFileSync} from 'node:child_process';
import {buildAntigravityContextBlock,buildAntigravityPrompt,extractAntigravityAssistantText,gatherAntigravityContextFacts,ANTIGRAVITY_CONTEXT_CHAR_BUDGET,summarizeAntigravityCliRun} from '../src/session/antigravity-cli-session-bridge.mjs';
import {gatherGitFactsAsync} from '../src/pm/git-facts-async.mjs';
import {ProductionPmBackendRegistry} from '../src/pm/production-pm-backend-registry.mjs';

// P9-R0.1 — context-fed plan mode + tool-denial resilience. Every scenario
// below is either a pure function test (no I/O) or driven by an injected
// fake spawn — never a real CLI — mirroring tests/production-antigravity-
// backend.test.mjs's existing conventions.

function fakeSpawn({stdout='',stderr='',code=0,capture={}}={}){return(binary,args,options)=>{Object.assign(capture,{binary,args,options});const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};queueMicrotask(()=>{child.stdout.end(stdout);child.stderr.end(stderr);queueMicrotask(()=>child.emit('close',code));});return child;};}
function resultLine(result){return JSON.stringify({event:'result',result});}

// ---- Part A/B: context packet -----------------------------------------

test('context block includes project id, repo path, branch, working tree, PM profile',()=>{
  const block=buildAntigravityContextBlock({project:{id:'proj-1',repo_path:'/repo/proj-1'},profile:{id:'pm-1'},gitFacts:{isGitRepo:true,root:'/repo/proj-1',branch:'main',dirtyCount:0,repoName:'proj-1'}});
  assert.match(block,/Project: proj-1/);
  assert.match(block,/Repository path: \/repo\/proj-1/);
  assert.match(block,/Branch: main/);
  assert.match(block,/Working tree: clean/);
  assert.match(block,/PM profile: pm-1/);
});
test('context block reports dirty working tree with a count',()=>{
  const block=buildAntigravityContextBlock({project:{id:'p'},gitFacts:{isGitRepo:true,branch:'main',dirtyCount:3}});
  assert.match(block,/Working tree: dirty \(3 changed path\(s\)\)/);
});
test('context block includes council role/phase/round only when extraCtx.role is present',()=>{
  const withRole=buildAntigravityContextBlock({project:{id:'p'},extraCtx:{role:'participant',phase:'participant_report',round:1}});
  assert.match(withRole,/Council role: participant, phase: participant_report, round: 1/);
  const withoutRole=buildAntigravityContextBlock({project:{id:'p'}});
  assert.equal(/Council role:/.test(withoutRole),false);
});
test('context block never includes secrets or arbitrary environment values (no ENV/process.env leakage)',()=>{
  process.env.DSH_TEST_SECRET_PROBE='sk-should-never-appear';
  const block=buildAntigravityContextBlock({project:{id:'p',repo_path:'/r'},gitFacts:{isGitRepo:true,branch:'main',dirtyCount:0}});
  delete process.env.DSH_TEST_SECRET_PROBE;
  assert.equal(block.includes('sk-should-never-appear'),false);
});

// ---- Part M: bounded context / deterministic truncation ----------------

test('context block is bounded and deterministically truncated with a safe marker, never a mid-JSON cut',()=>{
  const hugeRepoPath='/'+'x'.repeat(ANTIGRAVITY_CONTEXT_CHAR_BUDGET*2);
  const block=buildAntigravityContextBlock({project:{id:'p',repo_path:hugeRepoPath},gitFacts:{isGitRepo:true,branch:'main',dirtyCount:0}});
  assert.ok(block.length<=ANTIGRAVITY_CONTEXT_CHAR_BUDGET+120);
  assert.match(block,/\[TRUNCATED — Antigravity context block exceeded \d+-char budget\]$/);
});

// ---- Part E: explicit instruction -------------------------------------

test('assembled prompt tells the model supplied context is authoritative and tools are not required',()=>{
  const prompt=buildAntigravityPrompt({prompt:'task text',project:{id:'p',repo_path:'/r'},profile:{id:'pm'},gitFacts:{isGitRepo:true,branch:'main',dirtyCount:0}});
  assert.match(prompt,/Use ONLY the task and the DSH-supplied context above as your evidence/);
  assert.match(prompt,/tools are not required/);
  assert.match(prompt,/If the supplied context is insufficient .* say so explicitly/);
  assert.match(prompt,/Do not create a plan\.md artifact/);
  assert.ok(prompt.endsWith('task text'));
});

// ---- Part C: git facts (real git, throwaway repo — no network, no CLI) --

async function withTempGitRepo(fn){
  const dir=mkdtempSync(join(tmpdir(),'dsh-p9-r01-git-'));
  try{
    execFileSync('git',['init','-q'],{cwd:dir});
    execFileSync('git',['config','user.email','t@example.com'],{cwd:dir});
    execFileSync('git',['config','user.name','t'],{cwd:dir});
    return await fn(dir);
  }finally{
    // Windows: a just-closed git.exe file handle can still be releasing
    // when cleanup runs — retry a few times rather than fail the test on
    // an unrelated cleanup race (maxRetries covers this natively).
    try{rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});}catch{/* best-effort test cleanup only */}
  }
}

test('gatherGitFactsAsync reports isGitRepo:false for a non-repo directory',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'dsh-p9-r01-notgit-'));
  try{const facts=await gatherGitFactsAsync(dir);assert.equal(facts.isGitRepo,false);assert.equal(facts.branch,null);}
  finally{rmSync(dir,{recursive:true,force:true});}
});
test('gatherGitFactsAsync reports branch/clean tree for a real throwaway repo',async()=>{
  await withTempGitRepo(async(dir)=>{
    execFileSync('git',['checkout','-q','-b','feature-x'],{cwd:dir});
    writeFileSync(join(dir,'a.txt'),'hi');
    execFileSync('git',['add','-A'],{cwd:dir});
    execFileSync('git',['commit','-q','-m','seed'],{cwd:dir});
    const facts=await gatherGitFactsAsync(dir);
    assert.equal(facts.isGitRepo,true);
    assert.equal(facts.branch,'feature-x');
    assert.equal(facts.dirtyCount,0);
    assert.equal(facts.repoName,basename(realpathSync(dir)));
  });
});
test('gatherGitFactsAsync never throws on an unreadable/missing path',async()=>{
  const facts=await gatherGitFactsAsync('Z:/definitely/does/not/exist/at/all');
  assert.equal(facts.isGitRepo,false);
});
test('gatherAntigravityContextFacts wraps gatherGitFactsAsync and never throws for a missing project',async()=>{
  const {gitFacts}=await gatherAntigravityContextFacts({project:undefined});
  assert.equal(gitFacts.isGitRepo,false);
});

// ---- Part F: tool-denial classification (live-fixture-verbatim) --------

test('a permission-denied run_command classifies as ANTIGRAVITY_TOOL_DENIED, sanitized metadata only',()=>{
  const summary=summarizeAntigravityCliRun({stdout:resultLine({status:'ERROR',response:'',error:'permission check failed for command "git status": user denied permission to run command:\ngit status'})});
  try{extractAntigravityAssistantText(summary);assert.fail('expected throw');}
  catch(e){
    assert.equal(e.code,'ANTIGRAVITY_TOOL_DENIED');
    assert.equal(e.tool,'run_command');
    assert.equal(e.reason,'permission_denied');
    // Part F: the raw command line must never be copied into the typed
    // error's own fields.
    assert.equal(JSON.stringify(e).includes('git status'),false);
  }
});
test('a permission-denied read_file also classifies as ANTIGRAVITY_TOOL_DENIED with the real tool name',()=>{
  const summary=summarizeAntigravityCliRun({stdout:resultLine({status:'ERROR',response:'',error:'permission check failed for read_file "C:\\\\Users\\\\developer": user denied permission for read_file(C:\\Users\\developer)'})});
  try{extractAntigravityAssistantText(summary);assert.fail('expected throw');}
  catch(e){assert.equal(e.code,'ANTIGRAVITY_TOOL_DENIED');assert.equal(e.tool,'read_file');}
});
test('a generic ERROR with no permission-denial evidence stays ANTIGRAVITY_RUN_FAILED (generic code preserved)',()=>{
  const summary=summarizeAntigravityCliRun({stdout:resultLine({status:'ERROR',response:'',error:'internal error: something else entirely'})});
  assert.throws(()=>extractAntigravityAssistantText(summary),e=>e.code==='ANTIGRAVITY_RUN_FAILED');
});

// ---- Part G/H: no salvage from ERROR, strict parser boundary unchanged --

test('ERROR terminal status is never salvaged from an earlier step_update text_delta',()=>{
  const summary=summarizeAntigravityCliRun({stdout:[
    JSON.stringify({event:'step_update',step_update:{step_type:'agent_response',text_delta:'a plausible-looking partial answer'}}),
    resultLine({status:'ERROR',response:'',error:'permission check failed for command "git status": user denied permission to run command:\ngit status'}),
  ].join('\n')});
  assert.throws(()=>extractAntigravityAssistantText(summary),e=>e.code==='ANTIGRAVITY_TOOL_DENIED');
});
test('registry: a tool-denied Antigravity run fails the PM decision closed — never a synthesized success',async()=>{
  const registry=new ProductionPmBackendRegistry({probe:()=>true,antigravityBinary:'agy',antigravityRunner:async()=>summarizeAntigravityCliRun({stdout:resultLine({status:'ERROR',response:'',error:'permission check failed for command "git status": user denied permission to run command:\ngit status'})})});
  await assert.rejects(registry.resolve({id:'a',product:'antigravity',transport:'stdio',session_kind:'STATELESS'},{project:{id:'p',repo_path:process.cwd()}}).decide({turn:0,request:{id:'r'}}),e=>e.code==='ANTIGRAVITY_TOOL_DENIED');
});

// ---- Part I: no-tool / context-fed single-PM success (fake runner) -----

test('registry: a no-tool task succeeds via a fake runner that never receives a run_command-shaped prompt need',async()=>{
  let capturedPrompt;
  const registry=new ProductionPmBackendRegistry({probe:()=>true,antigravityBinary:'agy',antigravityRunner:async(args)=>{capturedPrompt=args.prompt;return summarizeAntigravityCliRun({stdout:resultLine({status:'SUCCESS',response:'{"type":"finish","output":"Repository: p, branch: main"}'})});}});
  const decision=await registry.resolve({id:'a',product:'antigravity',transport:'stdio',session_kind:'STATELESS'},{project:{id:'p',repo_path:process.cwd()}}).decide({turn:0,request:{id:'r',objective:'Report repository name and current branch.'}});
  assert.deepEqual(decision,{type:'finish',output:'Repository: p, branch: main'});
  assert.match(capturedPrompt,/DSH-SUPPLIED CONTEXT/);
  assert.match(capturedPrompt,/Report repository name and current branch/);
});

// ---- Part J: insufficient-context behavior is passed through unchanged -

test('an "insufficient context" finish decision from the model passes through unmodified — DSH never injects/hallucinates a fact on its behalf',async()=>{
  const registry=new ProductionPmBackendRegistry({probe:()=>true,antigravityBinary:'agy',antigravityRunner:async()=>summarizeAntigravityCliRun({stdout:resultLine({status:'SUCCESS',response:'{"type":"finish","output":"Insufficient context to determine this file'+"'"+'s contents — it was not supplied."}'})})});
  const decision=await registry.resolve({id:'a',product:'antigravity',transport:'stdio',session_kind:'STATELESS'},{project:{id:'p',repo_path:process.cwd()}}).decide({turn:0,request:{id:'r'}});
  assert.match(decision.output,/Insufficient context/);
});

// ---- Part K: council evidence reuse (no second context subsystem) ------

test('council participant prompt includes both the context block AND the chair-provided evidence — no separate context system',async()=>{
  let capturedPrompt;
  const registry=new ProductionPmBackendRegistry({probe:()=>true,antigravityBinary:'agy',antigravityRunner:async(args)=>{capturedPrompt=args.prompt;return summarizeAntigravityCliRun({stdout:resultLine({status:'SUCCESS',response:'{"type":"finish","output":"ok","data":{"type":"council_report","analysis":"x","recommendation":"y","risks":[],"uncertainties":[]}}'})});}});
  const profile={id:'a-participant',product:'antigravity',transport:'stdio',session_kind:'STATELESS'};
  await registry.resolve(profile,{project:{id:'p',repo_path:process.cwd()},extraCtx:{councilId:'c1',phase:'participant_report',round:1,role:'participant'}}).decide({turn:1,request:{id:'r',objective:'You are an INDEPENDENT council analyst.\nChair focus for you: investigate X.'}});
  assert.match(capturedPrompt,/DSH-SUPPLIED CONTEXT/);
  assert.match(capturedPrompt,/Council role: participant, phase: participant_report, round: 1/);
  assert.match(capturedPrompt,/INDEPENDENT council analyst/);
  assert.match(capturedPrompt,/Chair focus for you/);
});

// ---- Part L: observability -----------------------------------------

test('a successful run emits a CONTEXT observer event with bounded, non-secret metadata',async()=>{
  const events=[];
  const observer={start(){},parser(){},terminal(){},stdoutSummary(){},context(ctx,args){events.push(['context',args]);},toolDenied(ctx,args){events.push(['toolDenied',args]);}};
  const registry=new ProductionPmBackendRegistry({probe:()=>true,antigravityBinary:'agy',observer,antigravityRunner:async()=>summarizeAntigravityCliRun({stdout:resultLine({status:'SUCCESS',response:'{"type":"finish","output":"ok"}'})})});
  await registry.resolve({id:'a',product:'antigravity',transport:'stdio',session_kind:'STATELESS'},{project:{id:'p',repo_path:process.cwd()}}).decide({turn:0,request:{id:'r'}});
  const ctxEvent=events.find(([k])=>k==='context');
  assert.ok(ctxEvent);
  assert.equal(ctxEvent[1].projectFacts,true);
  assert.ok(Number.isFinite(ctxEvent[1].bytes)&&ctxEvent[1].bytes>0);
});
test('a tool-denied run emits a TOOL_DENIED observer event with sanitized tool/reason only',async()=>{
  const events=[];
  const observer={start(){},parser(){},terminal(){},stdoutSummary(){},context(){},toolDenied(ctx,args){events.push(args);}};
  const registry=new ProductionPmBackendRegistry({probe:()=>true,antigravityBinary:'agy',observer,antigravityRunner:async()=>summarizeAntigravityCliRun({stdout:resultLine({status:'ERROR',response:'',error:'permission check failed for command "git status": user denied permission to run command:\ngit status'})})});
  await assert.rejects(registry.resolve({id:'a',product:'antigravity',transport:'stdio',session_kind:'STATELESS'},{project:{id:'p',repo_path:process.cwd()}}).decide({turn:0,request:{id:'r'}}));
  assert.deepEqual(events,[{tool:'run_command',reason:'permission_denied'}]);
});

// ---- Part D/P6.5: no synchronous spawnSync git on this path ------------

test('context gathering is spawn()+Promise based (P6.5: async-injectable, never a synchronous blocking call)',async()=>{
  // gatherGitFactsAsync/gatherAntigravityContextFacts accept a spawnImpl
  // seam exactly like every other P6.5-era async probe (runBoundedProbe,
  // resolveXBinaryAsync) — a spawnSync-based implementation could not be
  // driven by an async fake spawn returning a Promise-friendly
  // EventEmitter this way, so successfully injecting one here is itself
  // proof this path never falls back to a synchronous child_process call.
  let calls=0;
  const fake=(binary,args,options)=>{calls+=1;const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};queueMicrotask(()=>{child.stdout.end(args[0]==='rev-parse'&&args[1]==='--is-inside-work-tree'?'true\n':'');queueMicrotask(()=>child.emit('close',0));});return child;};
  await gatherAntigravityContextFacts({project:{repo_path:'/whatever'},spawnImpl:fake});
  assert.ok(calls>=1);
});

// ---- Part N: model/reasoning semantics unchanged in this wave ----------

// P9-R0.3 note: this test's title originally asserted reasoning still
// flowed through to argv unchanged by the P9-R0.1 context-fed prompting
// change specifically. P9-R0.3 separately (and intentionally) stopped
// forwarding reasoning at all — see
// tests/antigravity-native-model-identity.test.mjs for that dedicated
// coverage. Updated here so this file's own assertions stay truthful.
test('model still flows through to argv exactly as configured — P9-R0.1\'s context-fed prompting only changes prompt content, not model selection',async()=>{
  const capture={};
  const registry=new ProductionPmBackendRegistry({probe:()=>true,antigravityBinary:'agy',antigravityRunner:async(args)=>{Object.assign(capture,args);return summarizeAntigravityCliRun({stdout:resultLine({status:'SUCCESS',response:'{"type":"finish","output":"ok"}'})});}});
  await registry.resolve({id:'live1-antigravity-pm',product:'antigravity',transport:'stdio',session_kind:'STATELESS',model:'gemini-3.5-flash-medium',reasoning:'medium'},{project:{id:'p',repo_path:process.cwd()}}).decide({turn:0,request:{id:'r'}});
  assert.equal(capture.model,'gemini-3.5-flash-medium');
});

// ---- Part Z regression: fifth-product inventory / capability shape -----

test('fifth-product inventory and capability shape remain exactly as P9-R0 shipped them',async()=>{
  const registry=new ProductionPmBackendRegistry({probe:()=>true,antigravityBinary:'agy'});
  assert.deepEqual(registry.list().map((v)=>v.product),['claude-code','opencode','codex','grok','antigravity','api']);
  const by=new Map((await registry.capabilities()).map((v)=>[v.product,v]));
  const value=by.get('antigravity');
  assert.equal(value.loginCommandSupported,false);
  assert.equal(value.logoutCommandSupported,false);
});
