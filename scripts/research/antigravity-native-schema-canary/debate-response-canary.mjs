import { acceptanceSourceRef, acceptanceCheckoutClean, acceptanceTestedTree } from './acceptance-source-snapshot.mjs';
// Research-only acceptance canary. No raw model or native output is persisted.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { PmProfileRegistry } from '../../../src/pm/pm-profile-registry.mjs';
import { ProductionPmBackendRegistry } from '../../../src/pm/production-pm-backend-registry.mjs';
import { CouncilStepWorkflowRunner } from '../../../src/pm/council/council-step-workflow-runner.mjs';
import { antigravityParticipantSchemaRequest } from '../../../src/pm/council/participant-json-schema.mjs';
import { normalizePmDecision } from '../../../src/pm/pm-contracts.mjs';
import { runAntigravityCliProcess, extractAntigravityAssistantText, resolveAntigravityExecutable } from '../../../src/session/antigravity-cli-session-bridge.mjs';
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// DECLARED PRODUCTION BASELINE for this canary's `src` no-drift preflight.
// Was 1f42d80cbc86bd9118cfc12cbcf40847d4682a0a until 2026-09-09; advanced to
// the reviewed DSH-CHAIR-PLAN-JSON-INVALID chair_plan output-contract fix so
// the check keeps detecting UNDECLARED drift rather than reporting the one
// declared change. This canary's own historical result is unchanged and
// stays recorded in docs/acceptance.
// Gateway implementation baseline: source changes are explicitly declared.
export const BASE = 'e0a4ef104dc4f3925ee2eb15d9849ef1fe7c713e';
export const PROFILE = 'live1-antigravity-gemini-3-8-flash-high';
const ARTIFACT = join(ROOT,'research/antigravity-native-schema-canary/debate-response-canary.json');
const OWNER_TASK = 'A synthetic council debated whether a four-person software team should adopt trunk-based development. Participant B argued that short-lived feature branches are safer for this team because its release tooling is minimal and untested.';
const BRIEF = 'Round 2 debate brief: reconcile Participant B\'s short-lived-branch position with Participant A\'s trunk-based-development-with-feature-flags position for this same four-person team.';
const PEER_STATEMENT = 'Participant B\'s Round 1 position (the only other position you are responding to): "Short-lived feature branches are safer for a four-person team with minimal release tooling because a broken trunk would block all four developers at once."';
const SHAPE_LINE = '{"type":"finish","output":"<one-line summary of your Round 2 response>","data":{"type":"debate_response","response":"<your full response>"}}';
const PROMPT = [
  'You are an INDEPENDENT council participant responding in DEBATE ROUND 2. You have NOT seen any other participant\'s Round 2 response beyond the peer statement below.',
  'This is a read-only, tool-free reasoning turn: no files, no shell commands, no workspace writes, no network access, no tool calls.',
  section('Owner task (synthetic)', OWNER_TASK),
  section('Debate brief', BRIEF),
  section('Peer position', PEER_STATEMENT),
  `Respond to Participant B\'s position in two to four sentences: state clearly whether you agree or disagree and give one concrete reason grounded only in the scenario above.`,
  '\nReply with exactly one JSON object and nothing else — no Markdown, no code fences, no prose before or after it. Use this exact shape (use these exact key names):',
  SHAPE_LINE,
].join('\n');
const sha = value => createHash('sha256').update(value).digest('hex');
const git = (...args) => execFileSync('git',args,{cwd:ROOT,windowsHide:true,encoding:'utf8'}).trim();
const safeReason = value => {
  if (typeof value !== 'string') return null;
  // Never preserve unexpected discriminator values or arbitrary error prose.
  const parts = value.split(':');
  return /^[A-Z][A-Z0-9_]*$/.test(parts[0]) ? parts.slice(0,2).filter(p=>/^[A-Z][A-Z0-9_]*$/.test(p)).join(':') : 'UNKNOWN';
};
function section(title, body){ return `### ${title}\n${body}`; }

export function prepare() {
  const spec = {id:'canary:debate_response',kind:'council_step',stepKind:'debate_response',round:2,profileId:PROFILE,
    isImplementationParticipant:false,workspaceRequirement:'NONE',
    prompt:PROMPT};
  return {spec,scenario:{owner_task_sha256:sha(OWNER_TASK),brief_sha256:sha(BRIEF),peer_statement_sha256:sha(PEER_STATEMENT),
    prompt_bytes:Buffer.byteLength(PROMPT),prompt_sha256:sha(PROMPT),prompt_sections:5,workspace_requirement:'NONE',
    requires_files:false,requires_commands:false,requires_network:false,requires_tools:false}};
}

export function preflight(profile,spec) {
  const request = antigravityParticipantSchemaRequest(spec,profile);
  const s = request?.schema, d = s?.properties?.data, r = d?.properties?.response;
  const bridge = readFileSync(join(ROOT,'src/session/antigravity-cli-session-bridge.mjs'),'utf8');
  const registry = readFileSync(join(ROOT,'src/pm/production-pm-backend-registry.mjs'),'utf8');
  let ancestry = false, unchanged = false, terminalClosed = false;
  try { git('merge-base','--is-ancestor',BASE,'HEAD'); ancestry=true; unchanged=git('diff',acceptanceSourceRef(BASE),'--','src')===''; } catch {}
  try { extractAntigravityAssistantText({result:{status:'ERROR',response:'',structured_output:{type:'finish',output:'fixture'}}},{structuredOutputSchema:s}); } catch (error) { terminalClosed=error.code==='ANTIGRAVITY_RUN_FAILED'; }
  const checks = {
    head_descends_from_canary2_base:ancestry, profile_antigravity:profile.product==='antigravity', profile_id_exact:profile.id===PROFILE,
    step_debate_response:spec.stepKind==='debate_response', implementation_false:spec.isImplementationParticipant===false,
    workspace_none:spec.workspaceRequirement==='NONE', schema_non_null:!!request,
    native_mode:request?.mode==='native_json_schema', provider_antigravity:request?.provider==='antigravity', schema_kind:request?.kind==='debate_response',
    outer_required:['type','output','data'].every(k=>s?.required?.includes(k)), outer_type_finish:s?.properties?.type?.const==='finish',
    data_required:['type','response'].every(k=>d?.required?.includes(k)), data_type_const:d?.properties?.type?.const==='debate_response',
    response_nonempty_string:r?.type==='string'&&r?.minLength===1&&r?.pattern==='\\S', no_evidence_property:!('evidence' in (d?.properties??{})),
    bridge_forwards_native_schema:registry.includes('...(structuredOutputSchema?{structuredOutputSchema}:{})'),
    authoritative_native_field:bridge.includes('const native=result.structured_output')&&registry.includes('extractAntigravityAssistantText(value,{structuredOutputSchema})'),
    terminal_error_closed:terminalClosed, production_src_unchanged:unchanged,
    single_invocation_guard:registry.includes('ctx.stage===EXECUTION_STAGE.OWNER_SINGLE')&&spec.stepKind!=='owner_single',
  };
  return {checks,pass:Object.values(checks).every(Boolean),tested_head:git('rev-parse','HEAD'),schema_bytes:Buffer.byteLength(JSON.stringify(s)),schema_sha256:sha(JSON.stringify(s))};
}

// Both decide and actual runner have independent global guards. Retried driver
// resolutions share these counters; no production retry policy is modified.
export async function runDebate({profile,spec,providerRunner=runAntigravityCliProcess,binary='synthetic-agy'}) {
  let decideCalls=0, providerCalls=0, blocked=0, decision=null, firstError=null, layered=null, nativeFacts=null;
  let forwarded=false, pm='NOT_ATTEMPTED';
  const registry = new ProductionPmBackendRegistry({probe:()=>true,antigravityBinary:binary,observer:{layeredDiagnostic:(_ctx,d)=>{layered ??= d;}},
    antigravityRunner:async options=> {
      if (providerCalls>=1) throw Object.assign(new Error('LOCAL_BUDGET_EXHAUSTED'),{code:'CANARY_SINGLE_INVOCATION_BUDGET_EXHAUSTED'});
      providerCalls++;
      forwarded=JSON.stringify(options.structuredOutputSchema)===JSON.stringify(antigravityParticipantSchemaRequest(spec,profile).schema);
      const summary=await providerRunner(options);
      const r=summary?.result, response=typeof r?.response==='string'?r.response:null;
      let extracted=null;
      try { extracted=extractAntigravityAssistantText(summary,{structuredOutputSchema:options.structuredOutputSchema}); } catch {}
      nativeFacts={terminal_status:['SUCCESS','ERROR','CANCELED','INTERRUPTED','INVALID','WAITING','RUNNING'].includes(r?.status)?r.status:'UNKNOWN',
        terminal_response_present:response!==null&&!!response.trim(),terminal_response_bytes:response===null?null:Buffer.byteLength(response),
        structured_output_present:!!r?.structured_output&&typeof r.structured_output==='object'&&!Array.isArray(r.structured_output),
        structured_output_has_data_type:r?.structured_output?.data?.type==='debate_response',
        assistant_output_present:extracted!==null,assistant_output_bytes:extracted===null?null:Buffer.byteLength(extracted),
        result_event_count:summary?.events?.filter(e=>e.event==='result').length??null,
        process_exit_code:summary.code??null};
      return summary;
    }});
  const runner=new CouncilStepWorkflowRunner({project:{id:'antigravity-debate-response-canary',repo_path:ROOT},profileRegistry:{get:id=>{if(id!==PROFILE)throw new Error('PROFILE_MISMATCH');return profile;}},
    extraCtx:()=>({phase:'debate_response',role:'participant',round:2}),
    resolveDriver:(p,ctx)=> {
      const driver=registry.resolve(p,ctx);
      return {name:driver.name,decide:async input=> {
        if(decideCalls>=1){blocked++;throw Object.assign(new Error('LOCAL_BUDGET_EXHAUSTED'),{code:'CANARY_SINGLE_INVOCATION_BUDGET_EXHAUSTED'});}
        decideCalls++;
        try {
          decision=await driver.decide(input);
          // Observe the actual PM contract before Council's own validation;
          // return the original decision, never a rewritten/normalized value.
          try {normalizePmDecision(decision);pm='PASS';} catch {pm='FAIL';}
          return decision;
        } catch(error){firstError=error;throw error;}
      }};
    }});
  const outcome=await runner.run(spec);
  const handoff=outcome.finalResult.handoff;
  const reason=safeReason(handoff.original_failure?.reason??handoff.reason??firstError?.code);
  const responsePresent=typeof decision?.data?.response==='string'&&!!decision.data.response.trim();
  const semantics=decision?(handoff.ok===true&&responsePresent?'PASS':'FAIL'):'NOT_ATTEMPTED';
  const accepted=handoff.ok===true&&pm==='PASS'&&semantics==='PASS';
  const errorCode=safeReason(firstError?.code??(handoff.ok?null:reason));
  let deepest='G1_SCHEMA_CONSTRUCTION',failure='G2_SCHEMA_FORWARDING',layer='SCHEMA';
  if(forwarded){deepest='G2_SCHEMA_FORWARDING';failure='G3_PROVIDER_SCHEMA_ACCEPTANCE';layer='PROVIDER_ACCEPTANCE';}
  // SUCCESS plus schema-bearing generation is direct positive evidence.
  // Non-success results do not invent schema acceptance from generic errors.
  const schemaAccepted=nativeFacts?.terminal_status==='SUCCESS'&&forwarded;
  if(schemaAccepted){deepest='G5_TERMINAL_SUCCESS';failure='G6_AUTHORITATIVE_NATIVE_EXTRACTION';layer='NATIVE_EXTRACTION';}
  else if(nativeFacts){failure='G5_TERMINAL_SUCCESS';layer='TERMINAL';}
  if(nativeFacts?.assistant_output_present){deepest='G6_AUTHORITATIVE_NATIVE_EXTRACTION';failure='G7_PM_PARSE';layer='PARSER';}
  if(layered?.parser_state==='PASS'){deepest='G7_PM_PARSE';failure='G8_PM_CONTRACT';layer='PM_CONTRACT';}
  if(pm==='PASS'){deepest='G8_PM_CONTRACT';failure='G9_DEBATE_RESPONSE_VALIDATION';layer='DEBATE_RESPONSE_SEMANTICS';}
  if(semantics==='PASS'&&pm==='PASS'){deepest='G9_DEBATE_RESPONSE_VALIDATION';failure='G10_END_TO_END_ACCEPTED';layer='ACCEPTANCE';}
  if(accepted){deepest='G10_END_TO_END_ACCEPTED';failure='NONE';layer='NONE';}
  return {live_provider_invocations:providerCalls,budget_guard_blocked_decide_calls:blocked,
    structured_output_requested:true,structured_output_mode:'native_json_schema',authoritative_output_field:'result.structured_output',
    schema_forwarded:forwarded,provider_schema_accepted:schemaAccepted?'YES':'UNKNOWN',provider_generation_started:schemaAccepted?'YES':'UNKNOWN',
    diagnostic_version:1,attempt_ordinal:0,parser_0:layered,
    execution_state:layered?.execution_state??'UNKNOWN',terminal_state:nativeFacts?.terminal_status==='SUCCESS'?'SUCCESS':nativeFacts?'ERROR':'UNKNOWN',
    terminal_status:nativeFacts?.terminal_status??'UNKNOWN',terminal_response_present:nativeFacts?.terminal_response_present??null,terminal_response_bytes:nativeFacts?.terminal_response_bytes??null,
    structured_output_present:nativeFacts?.structured_output_present??null,structured_output_data_type_match:nativeFacts?.structured_output_has_data_type??null,
    assistant_output_present:nativeFacts?.assistant_output_present??false,assistant_output_bytes:nativeFacts?.assistant_output_bytes??null,
    parser_attempted:layered?.parser_attempted??false,parser_state:layered?.parser_state??'NOT_ATTEMPTED',parse_error_code:layered?.parse_error_code??null,parse_subreason:layered?.parse_subreason??null,
    pm_contract_state:pm,step_validation_state:semantics,debate_response_response_present:responsePresent,
    production_public_error_code:errorCode,original_validation_reason:reason,deepest_successful_gate:deepest,failure_gate:failure,failure_layer:layer,full_canary_pass:accepted};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const context=prepare();
  const runtime=process.env.DSH_CANARY_RUNTIME_DIR??join(process.cwd(),'.runtime','live1');
  const profile=new PmProfileRegistry(parse(readFileSync(join(runtime,'pm-profiles.yaml'),'utf8')).pm_profiles).get(PROFILE);
  const checks=preflight(profile,context.spec);
  if(!checks.pass){console.log(JSON.stringify({state:'ANTIGRAVITY_CANARY_3_PREFLIGHT_FAILED',preflight:checks}));process.exitCode=1;}
  else if(!process.argv.includes('--live')) console.log(JSON.stringify({preflight:checks,scenario:context.scenario},null,2));
  else {
    const gatePath=join(ROOT,'research/antigravity-native-schema-canary/debate-response-offline-gates.json');
    const gates=existsSync(gatePath)?JSON.parse(readFileSync(gatePath,'utf8')):null;
    if(!gates?.passed||gates.tested_head!==checks.tested_head) throw new Error('OFFLINE_GATES_REQUIRED');
    const executable=resolveAntigravityExecutable();
    if(!executable.available) throw new Error('ANTIGRAVITY_CANARY_3_PREFLIGHT_FAILED');
    // Reserve once; neither a crash nor failure permits another live run.
    writeFileSync(ARTIFACT,JSON.stringify({state:'RESERVED',live_provider_invocations:0})+'\n',{flag:'wx'});
    try {
      const result=await runDebate({...context,profile,binary:executable.path});
      const record={profile:PROFILE,step:'debate_response',workspace_requirement:'NONE',is_implementation_participant:false,tested_head:checks.tested_head,preflight:checks,scenario:context.scenario,...result};
      writeFileSync(ARTIFACT,JSON.stringify(record,null,2)+'\n');console.log(JSON.stringify(record,null,2));
    } catch { writeFileSync(ARTIFACT,JSON.stringify({state:'HARNESS_FAILED',invocation_count_unknown:true})+'\n');console.log('HARNESS_FAILED_NO_RETRY');process.exitCode=1; }
  }
}
