import test from 'node:test';import assert from 'node:assert/strict';
import {deriveAntigravityReasoningFromModel,summarizeAntigravityCliRun,extractAntigravityAssistantText} from '../src/session/antigravity-cli-session-bridge.mjs';
import {reasoningCapabilityFor} from '../src/pm/pm-reasoning-capability.mjs';
import {ProductionPmBackendRegistry} from '../src/pm/production-pm-backend-registry.mjs';

// P9-R0.3 — implements the R0.2-audited, owner-approved decision:
// Antigravity's model slug is its native execution identity; --effort is
// never forwarded in production. See docs/p9/07 for the full record.
function resultLine(result){return JSON.stringify({event:'result',result});}

// ---- 1-6: tier extraction ------------------------------------------

test('1: Gemini flash-low extracts low',()=>{assert.equal(deriveAntigravityReasoningFromModel('gemini-3.5-flash-low'),'low');});
test('2: Gemini flash-medium extracts medium',()=>{assert.equal(deriveAntigravityReasoningFromModel('gemini-3.7-flash-medium'),'medium');});
test('3: Gemini pro-high extracts high',()=>{assert.equal(deriveAntigravityReasoningFromModel('gemini-3.1-pro-high'),'high');});
test('4: GPT-OSS 120b-medium extracts medium',()=>{assert.equal(deriveAntigravityReasoningFromModel('gpt-oss-120b-medium'),'medium');});
test('5: Claude Sonnet does not invent a tier',()=>{assert.equal(deriveAntigravityReasoningFromModel('claude-sonnet-4-6'),null);});
test('6: Claude Opus "(Thinking)" does not map to high — no tier invented',()=>{assert.equal(deriveAntigravityReasoningFromModel('claude-opus-4-6-thinking'),null);});
test('non-string/empty/unrecognized inputs never throw, always null',()=>{
  assert.equal(deriveAntigravityReasoningFromModel(null),null);
  assert.equal(deriveAntigravityReasoningFromModel(undefined),null);
  assert.equal(deriveAntigravityReasoningFromModel(''),null);
  assert.equal(deriveAntigravityReasoningFromModel('some-custom-model'),null);
});

// ---- 7-10: production argv ------------------------------------------

test('7/8: Gemini production argv has --model, no --effort',async()=>{
  const capture={};
  const registry=new ProductionPmBackendRegistry({probe:()=>true,antigravityBinary:'agy',antigravityRunner:async(args)=>{Object.assign(capture,args);return summarizeAntigravityCliRun({stdout:resultLine({status:'SUCCESS',response:'{"type":"finish","output":"ok"}'})});}});
  await registry.resolve({id:'live1-antigravity-pm',product:'antigravity',transport:'stdio',session_kind:'STATELESS',model:'gemini-3.5-flash-medium',reasoning:'medium'},{project:{id:'p',repo_path:process.cwd()}}).decide({turn:0,request:{id:'r'}});
  assert.equal(capture.model,'gemini-3.5-flash-medium');
  assert.equal('reasoning' in capture,false);
});
test('9: Claude production argv has no --effort either',async()=>{
  const capture={};
  const registry=new ProductionPmBackendRegistry({probe:()=>true,antigravityBinary:'agy',antigravityRunner:async(args)=>{Object.assign(capture,args);return summarizeAntigravityCliRun({stdout:resultLine({status:'SUCCESS',response:'{"type":"finish","output":"ok"}'})});}});
  await registry.resolve({id:'a-claude',product:'antigravity',transport:'stdio',session_kind:'STATELESS',model:'claude-sonnet-4-6',reasoning:null},{project:{id:'p',repo_path:process.cwd()}}).decide({turn:0,request:{id:'r'}});
  assert.equal(capture.model,'claude-sonnet-4-6');
  assert.equal('reasoning' in capture,false);
});
test('10: GPT-OSS production argv has no --effort either',async()=>{
  const capture={};
  const registry=new ProductionPmBackendRegistry({probe:()=>true,antigravityBinary:'agy',antigravityRunner:async(args)=>{Object.assign(capture,args);return summarizeAntigravityCliRun({stdout:resultLine({status:'SUCCESS',response:'{"type":"finish","output":"ok"}'})});}});
  await registry.resolve({id:'a-oss',product:'antigravity',transport:'stdio',session_kind:'STATELESS',model:'gpt-oss-120b-medium',reasoning:'medium'},{project:{id:'p',repo_path:process.cwd()}}).decide({turn:0,request:{id:'r'}});
  assert.equal(capture.model,'gpt-oss-120b-medium');
  assert.equal('reasoning' in capture,false);
});

// ---- observability: effortForwarded=false, never noisy --------------

test('CONTEXT observer event reports effortForwarded=false for production Antigravity runs',async()=>{
  const events=[];
  const observer={start(){},parser(){},terminal(){},stdoutSummary(){},context(ctx,args){events.push(args);},toolDenied(){}};
  const registry=new ProductionPmBackendRegistry({probe:()=>true,antigravityBinary:'agy',observer,antigravityRunner:async()=>summarizeAntigravityCliRun({stdout:resultLine({status:'SUCCESS',response:'{"type":"finish","output":"ok"}'})})});
  await registry.resolve({id:'a',product:'antigravity',transport:'stdio',session_kind:'STATELESS',model:'gemini-3.5-flash-medium',reasoning:'medium'},{project:{id:'p',repo_path:process.cwd()}}).decide({turn:0,request:{id:'r'}});
  assert.equal(events[0].effortForwarded,false);
});

// ---- reasoning capability still declares the true value set ---------

test('reasoning capability still reports SUPPORTED low/medium/high (informational/derived, not a forwarded flag)',()=>{
  const cap=reasoningCapabilityFor('antigravity');
  assert.equal(cap.selection,'SUPPORTED');
  assert.deepEqual(cap.levels,['low','medium','high']);
  assert.match(cap.flag,/derived/i);
});

// ---- P9-R0.1 context-fed + P9-R0.2 classification unaffected ---------

test('P9-R0.1 context-fed prompt assembly is unaffected by the argv change',async()=>{
  let capturedPrompt;
  const registry=new ProductionPmBackendRegistry({probe:()=>true,antigravityBinary:'agy',antigravityRunner:async(args)=>{capturedPrompt=args.prompt;return summarizeAntigravityCliRun({stdout:resultLine({status:'SUCCESS',response:'{"type":"finish","output":"ok"}'})});}});
  await registry.resolve({id:'a',product:'antigravity',transport:'stdio',session_kind:'STATELESS',model:'gemini-3.5-flash-medium'},{project:{id:'p',repo_path:process.cwd()}}).decide({turn:0,request:{id:'r',objective:'x'}});
  assert.match(capturedPrompt,/DSH-SUPPLIED CONTEXT/);
});
test('P9-R0.2 tool-denial classification (ANTIGRAVITY_TOOL_DENIED) is unaffected',()=>{
  const summary=summarizeAntigravityCliRun({stdout:resultLine({status:'ERROR',response:'',error:'permission check failed for command "git status": user denied permission to run command:\ngit status'})});
  assert.throws(()=>extractAntigravityAssistantText(summary),e=>e.code==='ANTIGRAVITY_TOOL_DENIED');
});

// ---- five-backend inventory / historical profile shape unaffected ----

test('five-backend inventory unchanged',async()=>{
  const registry=new ProductionPmBackendRegistry({probe:()=>true,antigravityBinary:'agy'});
  assert.deepEqual(registry.list().map((v)=>v.product),['claude-code','opencode','codex','grok','antigravity','api']);
});
