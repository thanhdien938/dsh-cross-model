import { acceptanceSourceRef, acceptanceCheckoutClean, acceptanceTestedTree } from './acceptance-source-snapshot.mjs';
// Research-only acceptance canary. No raw model or native output is persisted.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { PmProfileRegistry } from '../../../src/pm/pm-profile-registry.mjs';
import { ProductionPmBackendRegistry } from '../../../src/pm/production-pm-backend-registry.mjs';
import { CouncilStepWorkflowRunner } from '../../../src/pm/council/council-step-workflow-runner.mjs';
import { antigravityParticipantSchemaRequest } from '../../../src/pm/council/participant-json-schema.mjs';
import { buildWorkspaceEvidencePacket, renderWorkspaceEvidencePacketText, packetHashesByPath } from '../../../src/pm/council/workspace-evidence-packet.mjs';
import { validateEvidence } from '../../../src/pm/council/workspace-evidence-contract.mjs';
import { normalizePmDecision } from '../../../src/pm/pm-contracts.mjs';
import { runAntigravityCliProcess, extractAntigravityAssistantText, resolveAntigravityExecutable } from '../../../src/session/antigravity-cli-session-bridge.mjs';
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// DECLARED PRODUCTION BASELINE for this canary's `src` no-drift preflight.
// Was ffe2cbf7f891b820b23e18de3a02abce4c57c544 until 2026-09-09; advanced to
// the reviewed DSH-CHAIR-PLAN-JSON-INVALID chair_plan output-contract fix so
// the check keeps detecting UNDECLARED drift rather than reporting the one
// declared change. This canary's own historical result is unchanged and
// stays recorded in docs/acceptance.
// Gateway implementation baseline: source changes are explicitly declared.
export const BASE = 'e0a4ef104dc4f3925ee2eb15d9849ef1fe7c713e';
export const PROFILE = 'live1-antigravity-gemini-3-8-flash-high';
export const RELATIVE = 'CANARY_EVIDENCE.md';
const ARTIFACT = join(ROOT,'research/antigravity-native-schema-canary/participant-report-read-canary.json');
const FIXTURE = [
  'The synthetic Cedar library opens at 09:00 on weekdays.',
  'The library has twelve study desks.',
  'Reservations are recorded in a shared paper register.',
  'The register is reviewed every Friday.',
].join('\n')+'\n';
const sha = value => createHash('sha256').update(value).digest('hex');
const git = (...args) => execFileSync('git',args,{cwd:ROOT,windowsHide:true,encoding:'utf8'}).trim();
const safeReason = value => {
  if (typeof value !== 'string') return null;
  // Never preserve unexpected discriminator values or arbitrary error prose.
  const parts = value.split(':');
  return /^[A-Z][A-Z0-9_]*$/.test(parts[0]) ? parts.slice(0,2).filter(p=>/^[A-Z][A-Z0-9_]*$/.test(p)).join(':') : 'UNKNOWN';
};

export async function prepare() {
  const workspace = join(ROOT,'research/antigravity-native-schema-canary/report-read-workspace');
  mkdirSync(workspace,{recursive:true});
  writeFileSync(join(workspace,RELATIVE),FIXTURE,'utf8');
  if (readdirSync(workspace).length !== 1) throw new Error('FIXTURE_NOT_SINGLE_FILE');
  const project = {id:'antigravity-report-read-canary',repo_path:workspace};
  const packet = await buildWorkspaceEvidencePacket({project,evidencePaths:[RELATIVE],clock:()=> '2026-09-08T00:00:00.000Z'});
  const hashes = packetHashesByPath(packet);
  if (packet.files.length!==1 || !packet.files[0].fully_visible || hashes[RELATIVE]!==sha(FIXTURE)) throw new Error('FIXTURE_PACKET_INVALID');
  const spec = {id:'canary:participant_report:read',kind:'council_step',stepKind:'participant_report',round:1,profileId:PROFILE,
    isImplementationParticipant:false,workspaceRequirement:'READ',workspaceMode:'EVIDENCE_PACKET',
    workspaceEvidencePaths:[RELATIVE],workspaceEvidenceHashes:hashes,
    prompt:[
      'Read the complete synthetic fixture supplied in the DSH workspace evidence packet below. No tools or file mutations are required.',
      'Return a participant report summarizing its factual content, one recommendation, at least one risk, and at least one uncertainty.',
      'Include evidence[] referencing the supplied fixture with its exact relative path and SHA256 and a nonempty claim supported by the file. Optional integer line_start/line_end may be supplied.',
      'Use the required finish wrapper and council_report data contract. Treat the packet as the frozen workspace content to read.',
      renderWorkspaceEvidencePacketText(packet),
    ].join('\n\n')};
  return {project,spec,fixture:{fixture_relative_path:RELATIVE,fixture_sha256:hashes[RELATIVE],fixture_line_count:4,fixture_bytes:Buffer.byteLength(FIXTURE),fixture_fully_visible:true}};
}

export function preflight(profile,spec) {
  const request = antigravityParticipantSchemaRequest(spec,profile);
  const s = request?.schema, d = s?.properties?.data, e = d?.properties?.evidence, p = e?.items?.properties;
  const bridge = readFileSync(join(ROOT,'src/session/antigravity-cli-session-bridge.mjs'),'utf8');
  const registry = readFileSync(join(ROOT,'src/pm/production-pm-backend-registry.mjs'),'utf8');
  let ancestry = false, unchanged = false, terminalClosed = false;
  try { git('merge-base','--is-ancestor',BASE,'HEAD'); ancestry=true; unchanged=git('diff',acceptanceSourceRef(BASE),'--','src')===''; } catch {}
  try { extractAntigravityAssistantText({result:{status:'ERROR',response:'',structured_output:{type:'finish',output:'fixture'}}},{structuredOutputSchema:s}); } catch (error) { terminalClosed=error.code==='ANTIGRAVITY_RUN_FAILED'; }
  const checks = {
    head_descends_from_fixed_g7:ancestry, profile_antigravity:profile.product==='antigravity', step_participant_report:spec.stepKind==='participant_report',
    implementation_false:spec.isImplementationParticipant===false, workspace_read:spec.workspaceRequirement==='READ', schema_non_null:!!request,
    native_mode:request?.mode==='native_json_schema', outer_required:['type','output','data'].every(k=>s?.required?.includes(k)),
    report_required:['type','analysis','recommendation','risks','uncertainties','evidence'].every(k=>d?.required?.includes(k)),
    risks_items:d?.properties?.risks?.type==='array'&&d.properties.risks.items.type==='string',
    uncertainties_items:d?.properties?.uncertainties?.type==='array'&&d.properties.uncertainties.items.type==='string',
    evidence_nonempty:e?.type==='array'&&e.minItems>=1,
    evidence_item_required:['path','sha256','claim'].every(k=>e?.items?.required?.includes(k)),
    hash_64_hex:p?.sha256?.pattern==='^[0-9a-fA-F]{64}$',
    portable_path_claim:p?.path?.type==='string'&&p.path.minLength===1&&p.path.maxLength===400&&p.claim.type==='string'&&p.claim.minLength===1&&p.claim.maxLength===2000&&p.claim.pattern==='\\S',
    no_lookaround:!!s&&!/\(\?[=!<>]/.test(JSON.stringify(s)),
    authoritative_native_field:bridge.includes('const native=result.structured_output')&&registry.includes('extractAntigravityAssistantText(value,{structuredOutputSchema})'),
    terminal_error_closed:terminalClosed, production_parser_unchanged:unchanged,
    single_invocation_guard:registry.includes('ctx.stage===EXECUTION_STAGE.OWNER_SINGLE')&&spec.stepKind!=='owner_single',
  };
  return {checks,pass:Object.values(checks).every(Boolean),tested_head:git('rev-parse','HEAD'),schema_bytes:Buffer.byteLength(JSON.stringify(s)),schema_sha256:sha(JSON.stringify(s))};
}

// Both decide and actual runner have independent global guards. Retried driver
// resolutions share these counters; no production retry policy is modified.
export async function runReport({profile,project,spec,providerRunner=runAntigravityCliProcess,binary='synthetic-agy'}) {
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
        assistant_output_present:extracted!==null,assistant_output_bytes:extracted===null?null:Buffer.byteLength(extracted),
        result_event_count:summary?.events?.filter(e=>e.event==='result').length??null,
        process_exit_code:summary.code??null};
      return summary;
    }});
  const runner=new CouncilStepWorkflowRunner({project,profileRegistry:{get:id=>{if(id!==PROFILE)throw new Error('PROFILE_MISMATCH');return profile;}},
    extraCtx:()=>({phase:'participant_report',role:'participant',round:1}),
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
  const evidenceFailure=handoff.original_failure?.evidence_diagnostics??handoff.evidence_diagnostics;
  // A successful READ handoff proves that Council called validateEvidence.
  // On failure its evidence diagnostic proves that same gate was reached.
  const evidenceReached=handoff.ok===true||!!evidenceFailure;
  const ev=Array.isArray(decision?.data?.evidence)?decision.data.evidence:null;
  const observedEvidence=evidenceReached?validateEvidence(decision?.data?.evidence,{repoPath:project.repo_path,allowedPaths:new Set(spec.workspaceEvidencePaths),authoritativeHashes:spec.workspaceEvidenceHashes}):null;
  const semantics=decision?(evidenceReached?'PASS':'FAIL'):'NOT_ATTEMPTED';
  const evidenceState=observedEvidence?(observedEvidence.ok?'PASS':'FAIL'):'NOT_ATTEMPTED';
  const accepted=handoff.ok===true&&pm==='PASS'&&evidenceState==='PASS';
  const errorCode=safeReason(firstError?.code??(handoff.ok?null:reason));
  let deepest='G1_SCHEMA_CONSTRUCTION',failure='G2_SCHEMA_FORWARDING',layer='SCHEMA';
  if(forwarded){deepest='G2_SCHEMA_FORWARDING';failure='G3_PROVIDER_SCHEMA_ACCEPTANCE';layer='PROVIDER_ACCEPTANCE';}
  // SUCCESS plus schema-bearing generation is direct positive evidence.
  // Non-success results do not invent schema acceptance from generic errors.
  const schemaAccepted=nativeFacts?.terminal_status==='SUCCESS'&&forwarded;
  if(schemaAccepted){deepest='G5_TERMINAL_SUCCESS';failure='G6_NATIVE_OUTPUT_EXTRACTION';layer='NATIVE_EXTRACTION';}
  else if(nativeFacts){failure='G5_TERMINAL_SUCCESS';layer='TERMINAL';}
  if(nativeFacts?.assistant_output_present){deepest='G6_NATIVE_OUTPUT_EXTRACTION';failure='G7_PM_PARSE';layer='PARSER';}
  if(layered?.parser_state==='PASS'){deepest='G7_PM_PARSE';failure='G8_PM_CONTRACT';layer='PM_CONTRACT';}
  if(pm==='PASS'){deepest='G8_PM_CONTRACT';failure='G9_PARTICIPANT_REPORT_VALIDATION';layer='PARTICIPANT_REPORT_SEMANTICS';}
  if(semantics==='PASS'&&pm==='PASS'){deepest='G9_PARTICIPANT_REPORT_VALIDATION';failure='G9E_WORKSPACE_EVIDENCE_VALIDATION';layer='WORKSPACE_EVIDENCE';}
  if(accepted){deepest='G10_END_TO_END_ACCEPTED';failure='NONE';layer='NONE';}
  return {live_provider_invocations:providerCalls,budget_guard_blocked_decide_calls:blocked,
    structured_output_requested:true,structured_output_mode:'native_json_schema',authoritative_output_field:'result.structured_output',
    schema_forwarded:forwarded,provider_schema_accepted:schemaAccepted?'YES':'UNKNOWN',provider_generation_started:schemaAccepted?'YES':'UNKNOWN',
    diagnostic_version:1,attempt_ordinal:0,parser_0:layered,
    execution_state:layered?.execution_state??'UNKNOWN',terminal_state:nativeFacts?.terminal_status==='SUCCESS'?'SUCCESS':nativeFacts?'ERROR':'UNKNOWN',
    terminal_status:nativeFacts?.terminal_status??'UNKNOWN',terminal_response_present:nativeFacts?.terminal_response_present??null,terminal_response_bytes:nativeFacts?.terminal_response_bytes??null,
    structured_output_present:nativeFacts?.structured_output_present??null,assistant_output_present:nativeFacts?.assistant_output_present??false,assistant_output_bytes:nativeFacts?.assistant_output_bytes??null,
    parser_attempted:layered?.parser_attempted??false,parser_state:layered?.parser_state??'NOT_ATTEMPTED',parse_error_code:layered?.parse_error_code??null,parse_subreason:layered?.parse_subreason??null,
    pm_contract_state:pm,step_validation_state:semantics,evidence_validation_state:evidenceState,
    evidence_entry_count:ev?.length??null,evidence_path_match_count:ev?ev.filter(e=>spec.workspaceEvidencePaths.includes(e?.path)).length:null,
    evidence_sha_match_count:ev?ev.filter(e=>typeof e?.sha256==='string'&&spec.workspaceEvidenceHashes[e.path]?.toLowerCase()===e.sha256.toLowerCase()).length:null,
    evidence_claim_nonempty_count:ev?ev.filter(e=>typeof e?.claim==='string'&&!!e.claim.trim()).length:null,
    line_range_present_count:ev?ev.filter(e=>e?.line_start!=null||e?.line_end!=null).length:null,
    evidence_validation_reason:safeReason(observedEvidence?.reason),evidence_diagnostics:observedEvidence?.diagnostics??null,
    production_public_error_code:errorCode,original_validation_reason:reason,deepest_successful_gate:deepest,failure_gate:failure,failure_layer:layer,full_canary_pass:accepted};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const context=await prepare();
  const runtime=process.env.DSH_CANARY_RUNTIME_DIR??join(process.cwd(),'.runtime','live1');
  const profile=new PmProfileRegistry(parse(readFileSync(join(runtime,'pm-profiles.yaml'),'utf8')).pm_profiles).get(PROFILE);
  const checks=preflight(profile,context.spec);
  if(!checks.pass){console.log(JSON.stringify({state:'ANTIGRAVITY_NATIVE_SCHEMA_CANARY_2_PREFLIGHT_FAILED',preflight:checks}));process.exitCode=1;}
  else if(!process.argv.includes('--live')) console.log(JSON.stringify({preflight:checks,fixture:context.fixture},null,2));
  else {
    const gatePath=join(ROOT,'research/antigravity-native-schema-canary/report-read-offline-gates.json');
    const gates=existsSync(gatePath)?JSON.parse(readFileSync(gatePath,'utf8')):null;
    if(!gates?.passed||gates.tested_head!==checks.tested_head) throw new Error('OFFLINE_GATES_REQUIRED');
    const executable=resolveAntigravityExecutable();
    if(!executable.available) throw new Error('ANTIGRAVITY_NATIVE_SCHEMA_CANARY_2_PREFLIGHT_FAILED');
    // Reserve once; neither a crash nor failure permits another live run.
    writeFileSync(ARTIFACT,JSON.stringify({state:'RESERVED',live_provider_invocations:0})+'\n',{flag:'wx'});
    try {
      const result=await runReport({...context,profile,binary:executable.path});
      const record={profile:PROFILE,step:'participant_report',workspace_requirement:'READ',is_implementation_participant:false,tested_head:checks.tested_head,preflight:checks,fixture:context.fixture,...result};
      writeFileSync(ARTIFACT,JSON.stringify(record,null,2)+'\n');console.log(JSON.stringify(record,null,2));
    } catch { writeFileSync(ARTIFACT,JSON.stringify({state:'HARNESS_FAILED',invocation_count_unknown:true})+'\n');console.log('HARNESS_FAILED_NO_RETRY');process.exitCode=1; }
  }
}
