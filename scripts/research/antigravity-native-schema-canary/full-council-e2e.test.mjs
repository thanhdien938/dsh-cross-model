import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { hashFile } from './acceptance-evidence.mjs';
import { runApiBackendRequest } from '../../../src/pm/api-backend/api-backend-adapter.mjs';
import { join, dirname, resolve } from 'node:path';
import { prepare, preflight, runCouncil, expectedCallPlan, FIXTURE_RELATIVE, HARD_MAX_PROVIDER_INVOCATIONS, ANTIGRAVITY_PROFILE, CONTROL_PROFILE, CHAIR_PROFILE } from './full-council-e2e.mjs';

// Synthetic, content-free harness tests. No real provider is invoked; the
// real production orchestration (DurablePmRuntime + CouncilChairDriver +
// CouncilStepWorkflowRunner + production driver resolver shape) runs unchanged.
const syntheticProfiles = [
  { id: ANTIGRAVITY_PROFILE, role_kind: 'PM', session_kind: 'STATELESS', product: 'antigravity', transport: 'stdio', model: 'synthetic-agy-model', reasoning: 'high', status: 'ACTIVE' },
  { id: CONTROL_PROFILE, role_kind: 'PM', session_kind: 'STATELESS', product: 'api', provider: 'openrouter', transport: 'http', model: 'synthetic-glm', reasoning: 'medium', status: 'ACTIVE' },
  { id: CHAIR_PROFILE, role_kind: 'PM', session_kind: 'STATELESS', product: 'api', provider: 'openrouter', transport: 'http', model: 'synthetic-chair-model', reasoning: 'high', status: 'ACTIVE' },
];
function profileRegistryFor(extra = []) {
  const ids = [...syntheticProfiles, ...extra.filter(p => !syntheticProfiles.some(q => q.id === p.id))];
  const map = new Map(ids.map(p => [p.id, p]));
  return { get: id => { const p = map.get(id); if (!p) throw Object.assign(new Error('not registered'), { code: 'PM_PROFILE_NOT_REGISTERED' }); return p; }, list: () => ids };
}
async function syntheticContext() {
  const ctx = await prepare({profiles:syntheticProfiles});
  return { ...ctx, execution_mode:'SYNTHETIC', profileRegistry: profileRegistryFor(ctx.profileRegistry.list()) };
}

function verifyEvidence(result, status, count) {
  const m=JSON.parse(readFileSync(result.manifest_path,'utf8'));
  const ledger=JSON.parse(readFileSync(join(dirname(result.manifest_path),'provider-invocations.json'),'utf8'));
  assert.equal(m.status,status);assert.equal(m.actual_provider_invocations,count);assert.equal(ledger.length,count);
  assert.equal(m.council_run_id,result.pm_run_id);assert.equal(m.acceptance_execution_id,result.acceptance_execution_id);
  assert.equal(m.database_sha256_final,hashFile(m.database_path));
  assert.equal(m.execution_mode,'SYNTHETIC');assert.ok(m.durable_outcome_present);
  assert.equal(m.action_id,result.step_outcomes[0].step_id);
  for(const r of ledger){
    assert.equal(r.acceptance_execution_id,m.acceptance_execution_id);assert.equal(r.council_run_id,m.council_run_id);
    assert.ok(result.step_outcomes.some(s=>s.step_id===r.action_id));assert.equal(r.observer_identity_matches,true);
    assert.ok(r.backend_request_id);assert.ok(r.backend_attempt_id);assert.equal(r.diagnostic_version,1);
    assert.ok(r.start_time);assert.ok(r.end_time);
  }
  const db=new Database(m.database_path,{readonly:true});
  const row=db.prepare('SELECT id,status FROM pm_runs').get();assert.equal(row.id,m.council_run_id);
  assert.equal(row.status,m.council_terminal_state);
  const turn=db.prepare('SELECT action_id,outcome FROM pm_turns ORDER BY turn_index LIMIT 1').get();
  assert.equal(turn.action_id,m.action_id);assert.ok(turn.outcome);
  const request=JSON.parse(db.prepare('SELECT context FROM pm_requests').get().context);
  assert.equal(request.acceptance_execution_id,m.acceptance_execution_id);assert.equal(request.execution_mode,'SYNTHETIC');db.close();
  for(const name of ['acceptance-manifest.json','provider-invocations.json','acceptance-report.json','council-evidence.sqlite']) {
    assert.doesNotMatch(readFileSync(join(dirname(result.manifest_path),name)).toString(),/SYNTHETIC_OUTPUT|SYNTHETIC_ANALYSIS|SYNTHETIC_PRESENTATION|LEAK_|Bearer/);
  }
  return m;
}

test('two isolated failed Councils preserve unique identities, pre-run evidence and real parse retries', async () => {
  const ctx=await syntheticContext();const manifests=[];
  mkdirSync('.test-results/failed-acceptance',{recursive:true});
  for(let run=0;run<2;run++) {
    const evidenceRoot=mkdtempSync(resolve('.test-results/failed-acceptance','case-'));
    let calls=0;
    const result=await runCouncil({...ctx,evidenceRoot,providerRunners:{antigravityBinary:'stub',
      antigravity:async()=>{assert.fail('participant must not run after Chair parse failure');},
      api:async({observe})=>{
        calls++;
        observe('apiUsage',{requestId:`synthetic-http-${calls}`,content:'LEAK_ASSISTANT_123',reasoning:'LEAK_REASONING_456',authorization:'Bearer LEAK_TOKEN_789'});
        const parent=join(evidenceRoot,'research/live-acceptance-runs');const children=readdirSync(parent);assert.equal(children.length,1);
        const m=JSON.parse(readFileSync(join(parent,children[0],'acceptance-manifest.json'),'utf8'));
        assert.equal(m.status,'RUNNING');assert.deepEqual(m.lifecycle.map(e=>e.status),['PREPARED','RUNNING']);
        assert.ok(m.database_created_at);assert.equal(m.workspace_fixture_sha256,ctx.fixture.sha256);
        const ledger=JSON.parse(readFileSync(join(parent,children[0],'provider-invocations.json'),'utf8'));assert.equal(ledger.length,calls);
        return '{"type":"finish","output":"LEAK_ASSISTANT_123 reasoning LEAK_REASONING_456 Authorization: Bearer LEAK_TOKEN_789",}';
      }}});
    assert.equal(calls,2);const m=verifyEvidence(result,'FAILED',2);manifests.push(m);
    const ledger=JSON.parse(readFileSync(join(dirname(result.manifest_path),'provider-invocations.json'),'utf8'));
    assert.deepEqual(ledger.map(r=>r.retry_kind),['INITIAL_GENERATION','PARSE_RETRY']);
    assert.deepEqual(ledger.map(r=>r.provider_request_id),['synthetic-http-1','synthetic-http-2']);
    assert.deepEqual(ledger.map(r=>r.parser_state),['FAIL','FAIL']);
    assert.ok(ledger.every(r=>r.parser_attempted && r.parse_subreason===result.step_outcomes[0].attempts[r.attempt_ordinal].parse_subreason));
    assert.equal(m.antigravity_reached,false);assert.equal(m.control_reached,false);
  }
  for(const key of ['acceptance_execution_id','council_run_id','action_id'])assert.notEqual(manifests[0][key],manifests[1][key]);
});

test('public entry refuses mode confusion and records setup abort without masking error', async () => {
  await assert.rejects(runCouncil({}),/EXECUTION_MODE_REQUIRED/);
  await assert.rejects(runCouncil({execution_mode:'SYNTHETIC'}),/SYNTHETIC_STUBS_REQUIRED/);
  await assert.rejects(runCouncil({execution_mode:'LIVE',providerRunners:{api:async()=>''}}),/LIVE_RUNNER_OVERRIDE_REFUSED/);
  await assert.rejects(runCouncil({execution_mode:'SYNTHETIC',providerRunners:{api:runApiBackendRequest,antigravity:async()=>{}}}),/SYNTHETIC_REAL_RUNNER_REFUSED/);
  const ctx=await syntheticContext();mkdirSync('.test-results/setup-abort',{recursive:true});
  const evidenceRoot=mkdtempSync(resolve('.test-results/setup-abort','case-'));
  await assert.rejects(runCouncil({...ctx,evidenceRoot,evidencePacket:null,providerRunners:{api:async()=>assert.fail('no call'),antigravity:async()=>assert.fail('no call')}}),TypeError);
  const parent=join(evidenceRoot,'research/live-acceptance-runs'),children=readdirSync(parent);
  assert.equal(children.length,1);const m=JSON.parse(readFileSync(join(parent,children[0],'acceptance-manifest.json'),'utf8'));
  assert.equal(m.status,'ABORTED');assert.equal(m.abort_reason,'HARNESS_ERROR');assert.equal(m.actual_provider_invocations,0);
});

test('static call plan is exactly the 10-invocation minimal council', () => {
  const plan = expectedCallPlan();
  assert.equal(plan.length, 10);
  assert.deepEqual(plan.map(p => p.step_kind), [
    'chair_plan', 'participant_report', 'participant_report', 'participant_critique', 'participant_critique',
    'chair_synthesis', 'debate_brief', 'debate_response', 'debate_response', 'debate_synthesis',
  ]);
  assert.deepEqual(plan.filter(p => p.native_schema_requested).map(p => `${p.step_kind}:${p.profile_id}`), [
    `participant_report:${ANTIGRAVITY_PROFILE}`, `participant_critique:${ANTIGRAVITY_PROFILE}`, `debate_response:${ANTIGRAVITY_PROFILE}`,
  ]);
  assert.ok(plan.length <= HARD_MAX_PROVIDER_INVOCATIONS);
});

test('synthetic full council passes end to end with exactly 10 provider invocations', async () => {
  const ctx = await syntheticContext();
  const fixtureSha = ctx.fixture.sha256;
  const agyData = props => {
    if (props?.type?.const === 'council_critique') return { type: 'council_critique', criticisms: ['SYNTHETIC_CRITICISM'], agreements: ['SYNTHETIC_AGREEMENT'], revised_recommendation: 'SYNTHETIC_REVISED', remaining_disagreements: [] };
    if (props?.type?.const === 'debate_response') return { type: 'debate_response', response: 'SYNTHETIC_DEBATE_RESPONSE_TEXT', evidence: [{ path: FIXTURE_RELATIVE, sha256: fixtureSha, claim: 'The fixture states one explicit tradeoff between automation and maintenance burden.' }] };
    return { type: 'council_report', analysis: 'SYNTHETIC_ANALYSIS', recommendation: 'SYNTHETIC_RECOMMENDATION', risks: ['SYNTHETIC_RISK'], uncertainties: ['SYNTHETIC_UNCERTAINTY'], evidence: [{ path: FIXTURE_RELATIVE, sha256: fixtureSha, claim: 'The fixture states one explicit tradeoff between automation and maintenance burden.', line_start: 1, line_end: 8 }] };
  };
  const syntheticApiDecision = prompt => {
    // The step's own JSON shape is always the LAST '"type":"..."' discriminator in
    // the rendered production prompt (embedded peer content can mention earlier ones).
    const markers = ['council_plan', 'debate_brief', 'debate_synthesis', 'council_critique', 'debate_response', 'council_synthesis', 'council_report'];
    const kind = markers.map(m => ({ m, i: prompt.lastIndexOf(`"type":"${m}"`) })).filter(x => x.i >= 0).sort((a, b) => b.i - a.i)[0]?.m;
    if (kind === 'council_plan') return '{"type":"finish","output":"SYNTHETIC_PLAN","data":{"type":"council_plan","participant_instructions":{"live1-antigravity-gemini-3-8-flash-high":"SYNTHETIC_INSTRUCTION_A","live1-api-z-ai-glm-5-3-flash-medium":"SYNTHETIC_INSTRUCTION_B"},"critique_focus":"SYNTHETIC_CRITIQUE_FOCUS","synthesis_focus":"SYNTHETIC_SYNTHESIS_FOCUS"}}';
    if (kind === 'council_synthesis') return '{"type":"finish","output":"SYNTHETIC_SYNTHESIS","data":{"type":"council_synthesis"}}';
    if (kind === 'debate_brief') return '{"type":"finish","output":"SYNTHETIC_BRIEF","data":{"type":"debate_brief","brief":"SYNTHETIC_BRIEF_TEXT"}}';
    if (kind === 'debate_synthesis') return '{"type":"finish","output":"SYNTHETIC_DEBATE_SYNTHESIS","data":{"type":"debate_synthesis","continue_debate":false,"reason":"SYNTHETIC_REASON","unresolved_questions":[]}}';
    if (kind === 'council_critique') return '{"type":"finish","output":"SYNTHETIC_CRITIQUE","data":{"type":"council_critique","criticisms":["SYNTHETIC_CRITICISM"],"agreements":["SYNTHETIC_AGREEMENT"],"revised_recommendation":"SYNTHETIC_REVISED","remaining_disagreements":[]}}';
    if (kind === 'debate_response') return '{"type":"finish","output":"SYNTHETIC_DEBATE","data":{"type":"debate_response","response":"SYNTHETIC_DEBATE_RESPONSE_TEXT","evidence":[{"path":"' + FIXTURE_RELATIVE + '","sha256":"' + fixtureSha + '","claim":"The fixture states one explicit tradeoff between automation and maintenance burden."}]}}';
    return `{"type":"finish","output":"SYNTHETIC_REPORT","data":{"type":"council_report","analysis":"SYNTHETIC_ANALYSIS","recommendation":"SYNTHETIC_RECOMMENDATION","risks":["SYNTHETIC_RISK"],"uncertainties":["SYNTHETIC_UNCERTAINTY"],"evidence":[{"path":"${FIXTURE_RELATIVE}","sha256":"${fixtureSha}","claim":"The fixture states one explicit tradeoff between automation and maintenance burden.","line_start":1,"line_end":8}]}}`;
  };
  const result = await runCouncil({ ...ctx, providerRunners: {
    antigravityBinary: 'synthetic-agy',
    antigravity: async options => {
      assert.ok(options.structuredOutputSchema, 'antigravity steps must carry a native schema');
      return { code: 0, events: [{ event: 'result' }], result: { status: 'SUCCESS', response: 'SYNTHETIC_PRESENTATION', reasoning:'LEAK_REASONING_456', authorization:'Bearer LEAK_TOKEN_789', structured_output: { type: 'finish', output: 'SYNTHETIC_OUTPUT', data: agyData(options.structuredOutputSchema?.properties?.data?.properties) } } };
    },
    api: async ({ prompt }) => syntheticApiDecision(prompt),
  } });
  assert.equal(result.live_provider_invocations, 10);
  assert.equal(result.call_budget_exceeded, false);
  assert.equal(result.durable_result_status, 'completed');
  assert.equal(result.durable_result_data_type, 'council_debate');
  assert.equal(result.chair_plan.state, 'PASS');
  assert.equal(result.antigravity_report.state, 'PASS');
  assert.equal(result.antigravity_report.native_schema, true);
  assert.equal(result.antigravity_report.evidence_state, 'PASS');
  assert.equal(result.antigravity_report.evidence_entry_count, 1);
  assert.equal(result.antigravity_report.evidence_path_match_count, 1);
  assert.equal(result.antigravity_report.evidence_sha_match_count, 1);
  assert.equal(result.antigravity_critique.state, 'PASS');
  assert.equal(result.antigravity_critique.native_schema, true);
  assert.equal(result.antigravity_debate_response.state, 'PASS');
  assert.equal(result.antigravity_debate_response.native_schema, true);
  assert.equal(result.control_report.state, 'PASS');
  assert.equal(result.control_critique.state, 'PASS');
  assert.equal(result.control_debate_response.state, 'PASS');
  assert.equal(result.chair_synthesis.state, 'PASS');
  assert.equal(result.debate_brief.state, 'PASS');
  assert.equal(result.debate_synthesis.state, 'PASS');
  assert.equal(result.antigravity_participant_accepted, true);
  assert.equal(result.full_council_accepted, true);
  assert.equal(result.strict_full_pass, true);
  verifyEvidence(result, 'SUCCESS', 10);
  assert.equal(result.deepest_stage, 'DEBATE_SYNTHESIS');
  assert.equal(result.primary_failure_owner, 'NONE');
  assert.equal(/SYNTHETIC_/.test(JSON.stringify(result)), false);
});

test('authorized semantic repair completes beyond the baseline budget', async () => {
  const ctx = await syntheticContext();
  const fixtureSha = ctx.fixture.sha256;
  const agyData = props => {
    if (props?.type?.const === 'council_critique') return { type: 'council_critique', criticisms: ['SYNTHETIC_CRITICISM'], agreements: ['SYNTHETIC_AGREEMENT'], revised_recommendation: 'SYNTHETIC_REVISED', remaining_disagreements: [] };
    if (props?.type?.const === 'debate_response') return { type: 'debate_response', response: 'SYNTHETIC_DEBATE_RESPONSE_TEXT', evidence: [{ path: FIXTURE_RELATIVE, sha256: fixtureSha, claim: 'The fixture states one explicit tradeoff between automation and maintenance burden.' }] };
    return { type: 'council_report', analysis: 'SYNTHETIC_ANALYSIS', recommendation: 'SYNTHETIC_RECOMMENDATION', risks: ['SYNTHETIC_RISK'], uncertainties: ['SYNTHETIC_UNCERTAINTY'], evidence: [{ path: FIXTURE_RELATIVE, sha256: fixtureSha, claim: 'The fixture states one explicit tradeoff between automation and maintenance burden.', line_start: 1, line_end: 8 }] };
  };
  const syntheticApiDecision = prompt => {
    const markers = ['council_plan', 'debate_brief', 'debate_synthesis', 'council_critique', 'debate_response', 'council_synthesis', 'council_report'];
    const kind = markers.map(m => ({ m, i: prompt.lastIndexOf(`"type":"${m}"`) })).filter(x => x.i >= 0).sort((a, b) => b.i - a.i)[0]?.m;
    if (kind === 'council_plan') return '{"type":"finish","output":"SYNTHETIC_PLAN","data":{"type":"council_plan","participant_instructions":{"live1-antigravity-gemini-3-8-flash-high":"SYNTHETIC_INSTRUCTION_A","live1-api-z-ai-glm-5-3-flash-medium":"SYNTHETIC_INSTRUCTION_B"},"critique_focus":"SYNTHETIC_CRITIQUE_FOCUS","synthesis_focus":"SYNTHETIC_SYNTHESIS_FOCUS"}}';
    if (kind === 'council_synthesis') return '{"type":"finish","output":"SYNTHETIC_SYNTHESIS","data":{"type":"council_synthesis"}}';
    if (kind === 'debate_brief') return '{"type":"finish","output":"SYNTHETIC_BRIEF","data":{"type":"debate_brief","brief":"SYNTHETIC_BRIEF_TEXT"}}';
    if (kind === 'debate_synthesis') return '{"type":"finish","output":"SYNTHETIC_DEBATE_SYNTHESIS","data":{"type":"debate_synthesis","continue_debate":false,"reason":"SYNTHETIC_REASON","unresolved_questions":[]}}';
    if (kind === 'council_critique') return '{"type":"finish","output":"SYNTHETIC_CRITIQUE","data":{"type":"council_critique","criticisms":["SYNTHETIC_CRITICISM"],"agreements":["SYNTHETIC_AGREEMENT"],"revised_recommendation":"SYNTHETIC_REVISED","remaining_disagreements":[]}}';
    if (kind === 'debate_response') return `{"type":"finish","output":"SYNTHETIC_DEBATE","data":{"type":"debate_response","response":"SYNTHETIC_DEBATE_RESPONSE_TEXT","evidence":[{"path":"${FIXTURE_RELATIVE}","sha256":"${fixtureSha}","claim":"The fixture states one explicit tradeoff between automation and maintenance burden."}]}}`;
    return `{"type":"finish","output":"SYNTHETIC_REPORT","data":{"type":"council_report","analysis":"SYNTHETIC_ANALYSIS","recommendation":"SYNTHETIC_RECOMMENDATION","risks":["SYNTHETIC_RISK"],"uncertainties":["SYNTHETIC_UNCERTAINTY"],"evidence":[{"path":"${FIXTURE_RELATIVE}","sha256":"${fixtureSha}","claim":"The fixture states one explicit tradeoff between automation and maintenance burden.","line_start":1,"line_end":8}]}}`;
  };
  let agyCalls = 0;
  const result = await runCouncil({ ...ctx, providerRunners: {
    antigravityBinary: 'synthetic-agy',
    // The Antigravity participant's FIRST generation (A report, attempt 0) is
    // invalid (empty evidence); the authorized semantic-repair re-prompt (attempt
    // ordinal 0 of the repair turn) succeeds. Every later Antigravity generation
    // is valid. The debate_synthesis chair step then requires the ELEVENTH
    // provider invocation, now covered by the bounded retry reserve.
    antigravity: async options => {
      agyCalls++;
      const data = agyData(options.structuredOutputSchema?.properties?.data?.properties);
      const invalidFirst = agyCalls === 1 && data.type === 'council_report';
      return { code: 0, events: [{ event: 'result' }], result: { status: 'SUCCESS', response: 'SYNTHETIC_PRESENTATION', reasoning:'LEAK_REASONING_456', authorization:'Bearer LEAK_TOKEN_789', structured_output: { type: 'finish', output: 'SYNTHETIC_OUTPUT', data: invalidFirst ? { ...data, evidence: [] } : data } } };
    },
    api: async ({ prompt }) => syntheticApiDecision(prompt),
  } });
  assert.equal(agyCalls, 4);
  assert.equal(result.live_provider_invocations, 11);
  assert.equal(result.call_budget_exceeded, false);
  verifyEvidence(result, 'SUCCESS', 11);
  const budgetLedger = JSON.parse(readFileSync(join(dirname(result.manifest_path),'provider-invocations.json'),'utf8'));
  assert.ok(budgetLedger.some(r=>r.retry_kind==='SEMANTIC_REPAIR'));
  assert.equal(result.full_council_accepted, true);
  assert.equal(result.primary_failure_owner, 'NONE');
  assert.equal(result.recovered_full_pass, true);
  assert.equal(/SYNTHETIC_/.test(JSON.stringify(result)), false);
});

test('synthetic canonicalized Chair reconciles all 11 invocations and durable semantics', async () => {
  const ctx = await syntheticContext();
  const fixtureSha = ctx.fixture.sha256;
  const agyData = props => {
    if (props?.type?.const === 'council_critique') return { type: 'council_critique', criticisms: ['SYNTHETIC_CRITICISM'], agreements: ['SYNTHETIC_AGREEMENT'], revised_recommendation: 'SYNTHETIC_REVISED', remaining_disagreements: [] };
    if (props?.type?.const === 'debate_response') return { type: 'debate_response', response: 'SYNTHETIC_DEBATE_RESPONSE_TEXT', evidence: [{ path: FIXTURE_RELATIVE, sha256: fixtureSha, claim: 'The fixture states one explicit tradeoff between automation and maintenance burden.' }] };
    return { type: 'council_report', analysis: 'SYNTHETIC_ANALYSIS', recommendation: 'SYNTHETIC_RECOMMENDATION', risks: ['SYNTHETIC_RISK'], uncertainties: ['SYNTHETIC_UNCERTAINTY'], evidence: [{ path: FIXTURE_RELATIVE, sha256: fixtureSha, claim: 'The fixture states one explicit tradeoff between automation and maintenance burden.', line_start: 1, line_end: 8 }] };
  };
  const syntheticApiDecision = prompt => {
    // The step's own JSON shape is always the LAST '"type":"..."' discriminator in
    // the rendered production prompt (embedded peer content can mention earlier ones).
    const markers = ['council_plan', 'debate_brief', 'debate_synthesis', 'council_critique', 'debate_response', 'council_synthesis', 'council_report'];
    const kind = markers.map(m => ({ m, i: prompt.lastIndexOf(`"type":"${m}"`) })).filter(x => x.i >= 0).sort((a, b) => b.i - a.i)[0]?.m;
    if (kind === 'council_plan') return '{"type":"finish","output":"SYNTHETIC_PLAN","data":{"type":"council_plan","participant_instructions":{"live1-antigravity-gemini-3-8-flash-high":"SYNTHETIC_INSTRUCTION_A","live1-api-z-ai-glm-5-3-flash-medium":"SYNTHETIC_INSTRUCTION_B"},"critique_focus":"SYNTHETIC_CRITIQUE_FOCUS","synthesis_focus":"SYNTHETIC_SYNTHESIS_FOCUS"}}';
    if (kind === 'council_synthesis') return '{"type":"finish","output":"SYNTHETIC_SYNTHESIS","data":{"type":"council_synthesis"}}';
    if (kind === 'debate_brief') return '{"type":"finish","output":"SYNTHETIC_BRIEF","data":{"type":"debate_brief","brief":"SYNTHETIC_BRIEF_TEXT"}}';
    if (kind === 'debate_synthesis') return '{"type":"finish","output":"SYNTHETIC_DEBATE_SYNTHESIS","data":{"type":"debate_synthesis","continue_debate":false,"reason":"SYNTHETIC_REASON","unresolved_questions":[]}}';
    if (kind === 'council_critique') return '{"type":"finish","output":"SYNTHETIC_CRITIQUE","data":{"type":"council_critique","criticisms":["SYNTHETIC_CRITICISM"],"agreements":["SYNTHETIC_AGREEMENT"],"revised_recommendation":"SYNTHETIC_REVISED","remaining_disagreements":[]}}';
    if (kind === 'debate_response') return '{"type":"finish","output":"SYNTHETIC_DEBATE","data":{"type":"debate_response","response":"SYNTHETIC_DEBATE_RESPONSE_TEXT","evidence":[{"path":"' + FIXTURE_RELATIVE + '","sha256":"' + fixtureSha + '","claim":"The fixture states one explicit tradeoff between automation and maintenance burden."}]}}';
    return `{"type":"finish","output":"SYNTHETIC_REPORT","data":{"type":"council_report","analysis":"SYNTHETIC_ANALYSIS","recommendation":"SYNTHETIC_RECOMMENDATION","risks":["SYNTHETIC_RISK"],"uncertainties":["SYNTHETIC_UNCERTAINTY"],"evidence":[{"path":"${FIXTURE_RELATIVE}","sha256":"${fixtureSha}","claim":"The fixture states one explicit tradeoff between automation and maintenance burden.","line_start":1,"line_end":8}]}}`;
  };
  let lastDecision;
  ctx.profileRegistry=profileRegistryFor([{id:'live1-claude-sonnet-low',product:'claude-code',transport:'stdio',session_kind:'STATELESS',model:'sonnet',reasoning:'low'}]);
  const result = await runCouncil({ ...ctx, providerRunners: {
    antigravityBinary: 'synthetic-agy',
    antigravity: async options => {
      assert.ok(options.structuredOutputSchema, 'antigravity steps must carry a native schema');
      return { code: 0, events: [{ event: 'result' }], result: { status: 'SUCCESS', response: 'SYNTHETIC_PRESENTATION', reasoning:'LEAK_REASONING_456', authorization:'Bearer LEAK_TOKEN_789', structured_output: { type: 'finish', output: 'SYNTHETIC_OUTPUT', data: agyData(options.structuredOutputSchema?.properties?.data?.properties) } } };
    },
    claude:async()=>({result:JSON.stringify({normalization_status:'NORMALIZED',canonical_decision:JSON.parse(lastDecision)}),raw:{usage:{input_tokens:5,output_tokens:7}}}),
    api: async ({ prompt }) => {lastDecision=syntheticApiDecision(prompt);return lastDecision.includes('SYNTHETIC_PLAN')?lastDecision.slice(0,-1):lastDecision;},
  } });
  assert.equal(result.live_provider_invocations, 11);
  assert.equal(result.call_budget_exceeded, false);
  assert.equal(result.durable_result_status, 'completed');
  assert.equal(result.durable_result_data_type, 'council_debate');
  assert.equal(result.chair_plan.state, 'PASS');
  assert.equal(result.antigravity_report.state, 'PASS');
  assert.equal(result.antigravity_report.native_schema, true);
  assert.equal(result.antigravity_report.evidence_state, 'PASS');
  assert.equal(result.antigravity_report.evidence_entry_count, 1);
  assert.equal(result.antigravity_report.evidence_path_match_count, 1);
  assert.equal(result.antigravity_report.evidence_sha_match_count, 1);
  assert.equal(result.antigravity_critique.state, 'PASS');
  assert.equal(result.antigravity_critique.native_schema, true);
  assert.equal(result.antigravity_debate_response.state, 'PASS');
  assert.equal(result.antigravity_debate_response.native_schema, true);
  assert.equal(result.control_report.state, 'PASS');
  assert.equal(result.control_critique.state, 'PASS');
  assert.equal(result.control_debate_response.state, 'PASS');
  assert.equal(result.chair_synthesis.state, 'PASS');
  assert.equal(result.debate_brief.state, 'PASS');
  assert.equal(result.debate_synthesis.state, 'PASS');
  assert.equal(result.antigravity_participant_accepted, true);
  assert.equal(result.full_council_accepted, true);
  assert.equal(result.strict_full_pass, false);assert.equal(result.pass_class,'CANONICALIZED_PASS');assert.equal(result.canonicalizer_calls,1);assert.equal(result.step_outcomes[0].attempts[0].canonicalization.semantic_state,'PASS');
  verifyEvidence(result, 'SUCCESS', 11);
  assert.equal(result.deepest_stage, 'DEBATE_SYNTHESIS');
  assert.equal(result.primary_failure_owner, 'NONE');
  assert.equal(/SYNTHETIC_/.test(JSON.stringify(result)), false);
});
