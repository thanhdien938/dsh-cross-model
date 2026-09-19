import test from 'node:test';
import assert from 'node:assert/strict';
import { createCliPmDriver, ProductionPmBackendRegistry } from '../src/pm/production-pm-backend-registry.mjs';
import { canonicalizationDiagnostic, decodeCanonicalizer, canonicalizationConfig, safeClaudeUsage, PRIMARY_CANONICALIZER, UNSAFE_REASONS } from '../src/pm/output-canonicalization/gateway.mjs';
import { CouncilStepWorkflowRunner } from '../src/pm/council/council-step-workflow-runner.mjs';
import { ACCEPTANCE_CALL_BUDGET, MAX_ORIGINAL_GENERATIONS } from '../scripts/research/antigravity-native-schema-canary/acceptance-call-budget.mjs';
const project={id:'test',repo_path:process.cwd()};
const profile={id:'source',product:'codex',transport:'stdio',session_kind:'STATELESS'};
const input={request:{id:'r',objective:'test'},history:[],turn:0,capabilities:['finish']};
const good={type:'finish',output:'SYNTHETIC_PRIVATE_CONTENT'};
const normalized = decision => JSON.stringify({normalization_status:'NORMALIZED',canonical_decision:decision});
function setup(output,response=normalized(good),options={}) {
  let calls=0;const diagnostics=[];
  const driver=createCliPmDriver({profile,project,run:async()=>{if(output instanceof Error)throw output;return output;},canonicalize:async args=>{calls++;assert.equal(args.depth,1);if(response instanceof Error)throw response;return response;},observer:{canonicalization:(_ctx,d)=>diagnostics.push(d)},...options});
  return {decide:extra=>driver.decide({...input,...extra}),calls:()=>calls,diagnostics};
}
for(const output of [JSON.stringify(good),'```json\n'+JSON.stringify(good)+'\n```','Here is the decision: '+JSON.stringify(good)]) test('fast path zero calls '+output.slice(0,15),async()=>{
  const t=setup(output);assert.deepEqual(await t.decide(),good);assert.equal(t.calls(),0);
});
for(const output of [JSON.stringify(good).slice(0,-1),'{type:"finish",output:"SYNTHETIC_PRIVATE_CONTENT"}']) test('representation fallback '+output.slice(0,15),async()=>{
  const t=setup(output);const d=await t.decide();assert.deepEqual(d,good);assert.equal(t.calls(),1);assert.equal(canonicalizationDiagnostic(d).pm_contract_state,'PASS');
  assert.doesNotMatch(JSON.stringify(t.diagnostics),/SYNTHETIC_PRIVATE_CONTENT/);
});
for(const reason of UNSAFE_REASONS) test('UNSAFE '+reason,async()=>{
  const t=setup('{"type":"finish",',JSON.stringify({normalization_status:'UNSAFE',reason_code:reason}));await assert.rejects(t.decide(),{code:'PM_DECISION_PARSE_FAILED'});assert.equal(t.calls(),1);assert.equal(t.diagnostics.at(-1).result,'UNSAFE');
});
for(const response of ['{','```json\n{}\n```','{}','[]','{"normalization_status":"UNKNOWN","canonical_decision":{}}','{"normalization_status":"UNSAFE","reason_code":"GUESS"}','{"normalization_status":"NORMALIZED","canonical_decision":{},"extra":1}',normalized({type:'bogus'}),normalized({type:'finish'}),new Error('SECRET')]) test('invalid canonicalizer fails closed '+String(response).slice(0,38),async()=>{
  const t=setup('{',response);await assert.rejects(t.decide(),{code:'PM_DECISION_PARSE_FAILED'});assert.equal(t.calls(),1);assert.equal(t.diagnostics.at(-1).result,'FAILED');assert.doesNotMatch(JSON.stringify(t.diagnostics),/SECRET/);
});
// DSH-T5-DEBUG-EVIDENCE-AND-MULTI-DECISION: the two-competing-decisions
// input previously lived in this "ineligible" list (PM_DECISION_AMBIGUOUS_
// DECISIONS was excluded from eligibility). It is now ELIGIBLE by design —
// see tests/pm-multi-decision-canonicalization.test.mjs for its coverage —
// so it is removed from here rather than left asserting the old behavior.
for(const output of ['',null,Object.assign(new Error('transport'),{code:'API_TIMEOUT'})]) test('ineligible '+String(output).slice(0,18),async()=>{const t=setup(output);await assert.rejects(t.decide());assert.equal(t.calls(),0);});
test('kill switch and explicit recursion guard',async()=>{
  for(const options of [{canonicalization:{enabled:false,profileId:PRIMARY_CANONICALIZER}},{}]) {const t=setup('{',normalized(good),options);await assert.rejects(t.decide({canonicalizationDepth:1}));assert.equal(t.calls(),0);}
  assert.equal(canonicalizationConfig({}).enabled,true);assert.equal(canonicalizationConfig({DSH_PM_CANONICALIZATION_ENABLED:'off'}).enabled,false);
});
test('registry resolves selected profile and uses single low-level ephemeral invocation',async()=>{
  const events=[];let calls=0;
  const registry=new ProductionPmBackendRegistry({probe:()=>true,codexBinary:'fake',claudeBinary:'fake',profileRegistry:{get:id=>({id,product:'claude-code',transport:'stdio',session_kind:'STATELESS',model:'sonnet',reasoning:'low'})},codexRunner:async()=>({events:[{type:'item.completed',item:{type:'agent_message',text:'{'}}]}),claudeRunner:async options=>{calls++;assert.equal(options.ephemeral,true);assert.equal(options.model,'sonnet');assert.equal(options.effort,'low');assert.equal(options.invocationContext.invocation_role,'canonicalizer');return {result:normalized(good),raw:{usage:{input_tokens:2,output_tokens:4,cache_read_input_tokens:3,secret:'bad'}}};},observer:{start:c=>events.push(c),canonicalizationUsage:(_c,d)=>events.push(d)}});
  assert.deepEqual(await registry.resolve(profile,{project}).decide(input),good);assert.equal(calls,1);assert.equal(events.filter(e=>e.invocation_role==='canonicalizer').length,1);assert.deepEqual(events.at(-1).token_usage,{input_tokens:2,output_tokens:4,cache_read_input_tokens:3});
});
test('unavailable configured profile fails safely without provider call',async()=>{
  let calls=0;const registry=new ProductionPmBackendRegistry({probe:()=>true,claudeBinary:'fake',claudeRunner:async()=>{calls++;return {result:'{'};}});
  const p={...profile,product:'claude-code'};await assert.rejects(registry.resolve(p,{project}).decide(input),{code:'PM_DECISION_PARSE_FAILED'});assert.equal(calls,1);
});
test('usage retains native semantics; bounded budget includes all format calls',()=>{assert.equal(MAX_ORIGINAL_GENERATIONS,34);assert.equal(ACCEPTANCE_CALL_BUDGET,68);assert.deepEqual(safeClaudeUsage({raw:{usage:{input_tokens:1,output_tokens:-1,total_tokens:5,reasoning:'private'}}}),{input_tokens:1,total_tokens:5});});
const data={type:'council_report',analysis:'analysis',recommendation:'recommendation',risks:[],uncertainties:[],evidence:[]};
async function councilCase({stepKind='participant_report',decision={...good,data},unsafe=false,semanticBad=false}={}) {
  let generations=0,canonicalizations=0;
  const runner=new CouncilStepWorkflowRunner({project,resolveDriver:()=>createCliPmDriver({profile,project,run:async()=>{generations++;return generations===1?'{':JSON.stringify(decision);},canonicalize:async()=>{canonicalizations++;return unsafe?JSON.stringify({normalization_status:'UNSAFE',reason_code:'SEMANTIC_CONTENT_MISSING'}):normalized(semanticBad?{...good,data:{type:'council_report'}}:decision);}})});
  const result=await runner.run({id:'step',kind:'council_step',stepKind,profileId:profile.id,prompt:'test',round:1});
  return {result,generations,canonicalizations};
}
test('Council report canonicalization suppresses parse retry and records semantic PASS',async()=>{const t=await councilCase();assert.equal(t.result.finalResult.handoff.ok,true);assert.equal(t.generations,1);assert.equal(t.canonicalizations,1);assert.equal(t.result.finalResult.handoff.attempts[0].canonicalization.semantic_state,'PASS');});
test('canonicalizer UNSAFE leaves existing parse retry intact',async()=>{const t=await councilCase({unsafe:true});assert.equal(t.result.finalResult.handoff.ok,true);assert.equal(t.generations,2);assert.equal(t.canonicalizations,1);});
test('canonicalized semantic failure rejected by existing Council validation',async()=>{const t=await councilCase({semanticBad:true});assert.equal(t.result.finalResult.handoff.ok,true);assert.equal(t.generations,2);assert.equal(t.result.finalResult.handoff.semantic_repair_used,true);assert.equal(t.result.finalResult.handoff.attempts[0].canonicalization.semantic_state,'FAIL');});
test('Debate response shares production gateway',async()=>{const t=await councilCase({stepKind:'debate_response',decision:{...good,data:{type:'debate_response',response:'answer',evidence:[]}}});assert.equal(t.result.finalResult.handoff.ok,true);assert.equal(t.generations,1);});

test('kill switch alone bypasses fallback',async()=>{const t=setup('{',normalized(good),{canonicalization:{enabled:false,profileId:PRIMARY_CANONICALIZER}});await assert.rejects(t.decide());assert.equal(t.calls(),0);});
test('parsed semantic defects never enter the gateway',async()=>{const t=setup(JSON.stringify({...good,data:{type:'council_report'}}));await t.decide();assert.equal(t.calls(),0);});

test('contract rejection is classified at contract layer and preserves original parser error',async()=>{
  const t=setup('{',normalized({type:'bogus'}));
  await assert.rejects(t.decide(),{code:'PM_DECISION_PARSE_FAILED',parseSubreason:'PM_DECISION_JSON_INVALID'});
  const d=t.diagnostics.at(-1);
  assert.equal(t.calls(),1);
  assert.equal(d.execution_state,'SUCCESS');
  assert.equal(d.wrapper_contract_state,'PASS');
  assert.equal(d.canonicalized_parser_state,'PASS');
  assert.equal(d.pm_contract_state,'FAIL');
  assert.equal(d.state,'CANONICALIZED_CONTRACT_FAIL');
  assert.equal(d.semantic_state,'NOT_EVALUATED');
});
for(const [response,state] of [[new Error('backend'),'CANONICALIZATION_EXECUTION_FAILED'],['{','CANONICALIZATION_WRAPPER_FAILED'],[JSON.stringify({normalization_status:'UNSAFE',reason_code:'OTHER_UNSAFE'}),'CANONICALIZATION_UNSAFE'],[normalized({type:'finish'}),'CANONICALIZED_PARSE_FAIL']]) test('diagnostic layer remains '+state,async()=>{
  const t=setup('{',response);await assert.rejects(t.decide(),{code:'PM_DECISION_PARSE_FAILED'});assert.equal(t.diagnostics.at(-1).state,state);assert.equal(t.calls(),1);
});
