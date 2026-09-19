import test from 'node:test';
import assert from 'node:assert/strict';
import { prepare, preflight, runDebate, PROFILE } from './debate-response-canary.mjs';
const profile={id:PROFILE,product:'antigravity',transport:'stdio',session_kind:'STATELESS',model:'synthetic'};
const ctx=prepare();
const good={type:'finish',output:'PRIVATE_SYNTHETIC_OUTPUT',data:{type:'debate_response',response:'PRIVATE_SYNTHETIC_RESPONSE'}};
const envelope=native=>({code:0,events:[{event:'result'}],result:{status:'SUCCESS',response:'PRIVATE_SYNTHETIC_PRESENTATION',structured_output:native}});
test('all 21 source/schema/scenario preflight checks pass',()=>{assert.equal(preflight(profile,ctx.spec).pass,true);assert.equal(ctx.scenario.prompt_sections,5);assert.equal(ctx.scenario.workspace_requirement,'NONE');});
test('real debate_response validation succeeds and returns content-free facts',async()=>{
  let calls=0;
  const result=await runDebate({...ctx,profile,providerRunner:async()=>{calls++;return envelope(good);}});
  assert.equal(calls,1);assert.equal(result.full_canary_pass,true);assert.equal(result.deepest_successful_gate,'G10_END_TO_END_ACCEPTED');
  assert.equal(result.failure_gate,'NONE');assert.equal(result.schema_forwarded,true);
  assert.equal(result.pm_contract_state,'PASS');assert.equal(result.step_validation_state,'PASS');
  assert.equal(result.structured_output_data_type_match,true);
  assert.equal(/PRIVATE_SYNTHETIC/.test(JSON.stringify(result)),false);
});
test('empty finish fails parser without further provider invocation',async()=>{
  let calls=0;
  const result=await runDebate({...ctx,profile,providerRunner:async()=>{calls++;return envelope({type:'finish',output:''});}});
  assert.equal(calls,1);assert.equal(result.full_canary_pass,false);assert.equal(result.parser_state,'FAIL');
  assert.equal(result.step_validation_state,'NOT_ATTEMPTED');
});
test('typed parse-retry trigger cannot spend a second provider invocation',async()=>{
  let calls=0;
  const result=await runDebate({...ctx,profile,providerRunner:async()=>{
    calls++;throw Object.assign(new Error('synthetic parse-retry trigger'),{code:'PM_DECISION_PARSE_FAILED'});
  }});
  assert.equal(calls,1);assert.equal(result.live_provider_invocations,1);
  assert.equal(result.budget_guard_blocked_decide_calls,1);assert.equal(result.full_canary_pass,false);
});
test('semantic repair cannot cause a second provider call; original reason survives',async()=>{
  let calls=0;
  const result=await runDebate({...ctx,profile,providerRunner:async()=>{calls++;return envelope({...good,data:{...good.data,response:''}});}});
  assert.equal(calls,1);assert.equal(result.budget_guard_blocked_decide_calls,1);
  assert.equal(result.step_validation_state,'FAIL');assert.equal(result.failure_gate,'G9_DEBATE_RESPONSE_VALIDATION');
  assert.equal(result.original_validation_reason,'COUNCIL_DEBATE_RESPONSE_INVALID:MISSING_RESPONSE');
});
test('wrong data type fails through actual validator without reinvoking',async()=>{
  let calls=0;
  const result=await runDebate({...ctx,profile,providerRunner:async()=>{calls++;return envelope({...good,data:{...good.data,type:'council_report'}});}});
  assert.equal(calls,1);assert.equal(result.step_validation_state,'FAIL');assert.equal(result.full_canary_pass,false);
  assert.equal(result.original_validation_reason,'COUNCIL_DEBATE_RESPONSE_INVALID:WRONG_DATA_TYPE');
});
test('terminal ERROR stays unparsed despite structured output',async()=>{
  const result=await runDebate({...ctx,profile,providerRunner:async()=>({...envelope(good),result:{...envelope(good).result,status:'ERROR'}})});
  assert.equal(result.parser_attempted,false);assert.equal(result.failure_gate,'G5_TERMINAL_SUCCESS');assert.equal(result.production_public_error_code,'ANTIGRAVITY_RUN_FAILED');
});
test('missing structured output with schema fails native extraction',async()=>{
  let calls=0;
  const result=await runDebate({...ctx,profile,providerRunner:async()=>{calls++;return {code:0,events:[{event:'result'}],result:{status:'SUCCESS',response:'PRIVATE_SYNTHETIC_PRESENTATION'}};}});
  assert.equal(calls,1);assert.equal(result.full_canary_pass,false);
  assert.equal(result.parser_attempted,false);assert.equal(result.failure_gate,'G6_AUTHORITATIVE_NATIVE_EXTRACTION');
});
