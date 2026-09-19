import test from 'node:test';import assert from 'node:assert/strict';
import {extractAntigravityAssistantText,summarizeAntigravityCliRun,ANTIGRAVITY_CLI_CAPABILITIES} from '../src/session/antigravity-cli-session-bridge.mjs';
import {reasoningCapabilityFor} from '../src/pm/pm-reasoning-capability.mjs';
import {ProductionPmBackendRegistry,listSupportedProducts} from '../src/pm/production-pm-backend-registry.mjs';

// P9-R0.2 — AUDIT ONLY wave: no production semantics changed. These tests
// encode the live-proven --model/--effort evidence from
// docs/p9/06_MODEL_REASONING_SEMANTICS.md (gathered via
// scripts/p9-antigravity-model-effort-probe.mjs against real agy 1.1.19)
// as regression-testable fixtures, and reconfirm every invariant this
// wave's audit depended on staying unchanged.
function resultLine(result){return JSON.stringify({event:'result',result});}

// ---- live-fixture-verbatim: model/effort conflict classification -------

test('a tier-suffix/--effort conflict (Gemini flash) classifies as ANTIGRAVITY_MODEL_INVALID, not a generic failure',()=>{
  const summary=summarizeAntigravityCliRun({stdout:resultLine({status:'ERROR',response:'',error:'invalid model selection (--model "gemini-3.5-flash-low" --effort "high"): --model gemini-3.5-flash-low conflicts with --effort=high'})});
  assert.throws(()=>extractAntigravityAssistantText(summary),e=>e.code==='ANTIGRAVITY_MODEL_INVALID');
});
test('a tier-suffix/--effort conflict (Gemini pro, no -medium tier at all) classifies the same way',()=>{
  const summary=summarizeAntigravityCliRun({stdout:resultLine({status:'ERROR',response:'',error:'invalid model selection (--model "gemini-3.1-pro-high" --effort "low"): --model gemini-3.1-pro-high conflicts with --effort=low'})});
  assert.throws(()=>extractAntigravityAssistantText(summary),e=>e.code==='ANTIGRAVITY_MODEL_INVALID');
});
test('a tier-suffix/--effort conflict (GPT-OSS, cross-family) classifies the same way',()=>{
  const summary=summarizeAntigravityCliRun({stdout:resultLine({status:'ERROR',response:'',error:'invalid model selection (--model "gpt-oss-120b-medium" --effort "low"): --model gpt-oss-120b-medium conflicts with --effort=low'})});
  assert.throws(()=>extractAntigravityAssistantText(summary),e=>e.code==='ANTIGRAVITY_MODEL_INVALID');
});
test('Claude rejecting --effort unconditionally also classifies as ANTIGRAVITY_MODEL_INVALID',()=>{
  const summary=summarizeAntigravityCliRun({stdout:resultLine({status:'ERROR',response:'',error:'invalid model selection (--model "claude-sonnet-4-6" --effort "low"): --effort is not supported for model "claude-sonnet-4-6"'})});
  assert.throws(()=>extractAntigravityAssistantText(summary),e=>e.code==='ANTIGRAVITY_MODEL_INVALID');
});
test('a matching tier-suffix + effort (the live1-antigravity-pm combo) succeeds — sanity fixture',()=>{
  const summary=summarizeAntigravityCliRun({stdout:resultLine({status:'SUCCESS',response:'MODEL_EFFORT_OK\n'})});
  assert.equal(extractAntigravityAssistantText(summary),'MODEL_EFFORT_OK');
});

// ---- Part N regressions: nothing about production semantics moved ------

test('reasoning capability unchanged: SUPPORTED low/medium/high via --effort',()=>{
  const cap=reasoningCapabilityFor('antigravity');
  assert.equal(cap.selection,'SUPPORTED');
  assert.deepEqual(cap.levels,['low','medium','high']);
});
test('capability shape unchanged: modelSelection true, login/logout still honestly false',()=>{
  assert.equal(ANTIGRAVITY_CLI_CAPABILITIES.modelSelection,true);
  assert.equal(ANTIGRAVITY_CLI_CAPABILITIES.loginCommandSupported,false);
  assert.equal(ANTIGRAVITY_CLI_CAPABILITIES.logoutCommandSupported,false);
});
test('five-backend inventory unchanged',()=>{
  assert.deepEqual(listSupportedProducts(),['claude-code','opencode','codex','grok','antigravity','api']);
});
// P9-R0.3 implemented the fix this file's audit (R0.2) recommended —
// profile.model still forwards exactly as configured (never a synthetic/
// rewritten id), and profile.reasoning is deliberately no longer
// forwarded to the CLI at all (see
// tests/antigravity-native-model-identity.test.mjs for the dedicated R0.3
// coverage; this assertion is kept here, updated, so this file's own
// history of "what does production actually send" stays accurate).
test('registry forwards profile.model exactly as configured (no synthetic/rewritten id) — reasoning is no longer forwarded at all (P9-R0.3)',async()=>{
  const capture={};
  const registry=new ProductionPmBackendRegistry({probe:()=>true,antigravityBinary:'agy',antigravityRunner:async(args)=>{Object.assign(capture,args);return summarizeAntigravityCliRun({stdout:resultLine({status:'SUCCESS',response:'{"type":"finish","output":"ok"}'})});}});
  await registry.resolve({id:'live1-antigravity-pm',product:'antigravity',transport:'stdio',session_kind:'STATELESS',model:'gemini-3.5-flash-medium',reasoning:'medium'},{project:{id:'p',repo_path:process.cwd()}}).decide({turn:0,request:{id:'r'}});
  assert.equal(capture.model,'gemini-3.5-flash-medium');
  assert.equal('reasoning' in capture,false);
});
