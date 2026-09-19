import test from 'node:test';
import assert from 'node:assert/strict';
import { prepare, preflight, runReport, PROFILE, RELATIVE } from './report-read-canary.mjs';
const profile={id:PROFILE,product:'antigravity',transport:'stdio',session_kind:'STATELESS',model:'synthetic'};
const ctx=await prepare();
const good={type:'finish',output:'PRIVATE_SYNTHETIC_OUTPUT',data:{type:'council_report',analysis:'PRIVATE_SYNTHETIC_ANALYSIS',recommendation:'PRIVATE_SYNTHETIC_RECOMMENDATION',risks:['risk'],uncertainties:['uncertainty'],evidence:[{path:RELATIVE,sha256:ctx.fixture.fixture_sha256,claim:'PRIVATE_SYNTHETIC_CLAIM',line_start:1,line_end:2}]}};
const envelope=native=>({code:0,events:[{event:'result'}],result:{status:'SUCCESS',response:'PRIVATE_SYNTHETIC_PRESENTATION',structured_output:native}});
test('all 20 source/schema/fixture preflight checks pass',()=>{assert.equal(preflight(profile,ctx.spec).pass,true);assert.equal(ctx.fixture.fixture_line_count,4);assert.equal(ctx.fixture.fixture_bytes,185);});
test('real report/evidence validation succeeds and returns content-free facts',async()=>{
  let calls=0;
  const result=await runReport({...ctx,profile,providerRunner:async()=>{calls++;return envelope(good);}});
  assert.equal(calls,1);assert.equal(result.full_canary_pass,true);assert.equal(result.deepest_successful_gate,'G10_END_TO_END_ACCEPTED');
  assert.equal(result.evidence_path_match_count,1);assert.equal(result.evidence_sha_match_count,1);
  assert.equal(result.evidence_diagnostics.entries_valid,1);assert.equal(result.line_range_present_count,1);
  assert.equal(/PRIVATE_SYNTHETIC/.test(JSON.stringify(result)),false);
});
test('empty finish fails parser without further provider invocation',async()=>{
  let calls=0;
  const result=await runReport({...ctx,profile,providerRunner:async()=>{calls++;return envelope({type:'finish',output:''});}});
  assert.equal(calls,1);assert.equal(result.full_canary_pass,false);assert.equal(result.parser_state,'FAIL');
  assert.equal(result.evidence_validation_state,'NOT_ATTEMPTED');
});
test('typed parse-retry trigger cannot spend a second provider invocation',async()=>{
  let calls=0;
  const result=await runReport({...ctx,profile,providerRunner:async()=>{
    calls++;throw Object.assign(new Error('synthetic parse-retry trigger'),{code:'PM_DECISION_PARSE_FAILED'});
  }});
  assert.equal(calls,1);assert.equal(result.live_provider_invocations,1);
  assert.equal(result.budget_guard_blocked_decide_calls,1);assert.equal(result.full_canary_pass,false);
});
test('semantic repair cannot cause a second provider call; original reason survives',async()=>{
  let calls=0;
  const result=await runReport({...ctx,profile,providerRunner:async()=>{calls++;return envelope({...good,data:{...good.data,analysis:''}});}});
  assert.equal(calls,1);assert.equal(result.budget_guard_blocked_decide_calls,1);
  assert.equal(result.step_validation_state,'FAIL');assert.equal(result.failure_gate,'G9_PARTICIPANT_REPORT_VALIDATION');
  assert.equal(result.original_validation_reason,'COUNCIL_PARTICIPANT_REPORT_INVALID:MISSING_ANALYSIS');
});
test('wrong hash fails existing evidence validator without correcting output or reinvoking',async()=>{
  let calls=0;
  const result=await runReport({...ctx,profile,providerRunner:async()=>{calls++;return envelope({...good,data:{...good.data,evidence:[{...good.data.evidence[0],sha256:'b'.repeat(64)}]}});}});
  assert.equal(calls,1);assert.equal(result.budget_guard_blocked_decide_calls,1);
  assert.equal(result.step_validation_state,'PASS');assert.equal(result.evidence_validation_state,'FAIL');assert.equal(result.evidence_sha_match_count,0);
  assert.equal(result.failure_gate,'G9E_WORKSPACE_EVIDENCE_VALIDATION');assert.equal(result.evidence_diagnostics.drop_reasons.EVIDENCE_HASH_MISMATCH,1);
  assert.equal(result.evidence_validation_reason,'NO_VALID_EVIDENCE_ENTRIES');
});
test('terminal ERROR stays unparsed despite structured output',async()=>{
  const result=await runReport({...ctx,profile,providerRunner:async()=>({...envelope(good),result:{...envelope(good).result,status:'ERROR'}})});
  assert.equal(result.parser_attempted,false);assert.equal(result.failure_gate,'G5_TERMINAL_SUCCESS');assert.equal(result.production_public_error_code,'ANTIGRAVITY_RUN_FAILED');
});
test('wrong path and invalid line types fail through actual validator',async()=>{
  for(const entry of [{...good.data.evidence[0],path:'unpermitted.md'},{...good.data.evidence[0],line_start:'1'}]) {
    const result=await runReport({...ctx,profile,providerRunner:async()=>envelope({...good,data:{...good.data,evidence:[entry]}})});
    assert.equal(result.live_provider_invocations,1);assert.equal(result.evidence_validation_state,'FAIL');assert.equal(result.full_canary_pass,false);
  }
});
