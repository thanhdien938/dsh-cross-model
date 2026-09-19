import { acceptanceSourceRef, acceptanceCheckoutClean, acceptanceTestedTree } from './acceptance-source-snapshot.mjs';
import { ACCEPTANCE_CALL_BUDGET } from './acceptance-call-budget.mjs';
﻿// Research-only acceptance harness. No raw model or native output is persisted.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { AcceptanceEvidence, ContentFreePmRepository, assertExecutionMode, atomicJson, errorCode } from './acceptance-evidence.mjs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { PmProfileRegistry } from '../../../src/pm/pm-profile-registry.mjs';
import { loadApiProviderConfig } from '../../../src/pm/api-backend/api-provider-config.mjs';
import { ProductionPmBackendRegistry } from '../../../src/pm/production-pm-backend-registry.mjs';
import { createProductionPmDriverResolver } from '../../../src/runtime/p5-production-composition.mjs';
import { runAntigravityCliProcess, extractAntigravityAssistantText, resolveAntigravityExecutable } from '../../../src/session/antigravity-cli-session-bridge.mjs';
import { runApiBackendRequest } from '../../../src/pm/api-backend/api-backend-adapter.mjs';
import { runClaudeProcess } from '../../../src/session/claude-code-session-bridge.mjs';
import { normalizeCouncilSpec, councilMaxTurns } from '../../../src/pm/council/council-contracts.mjs';
import { admitCouncilWorkspaceRequirement } from '../../../src/pm/council/council-workspace-admission.mjs';
import { buildWorkspaceEvidencePacket, packetHashesByPath, renderWorkspaceEvidencePacketText } from '../../../src/pm/council/workspace-evidence-packet.mjs';
import { antigravityParticipantSchemaRequest } from '../../../src/pm/council/participant-json-schema.mjs';
import { CouncilChairDriver } from '../../../src/pm/council/council-chair-driver.mjs';
import { CouncilStepWorkflowRunner } from '../../../src/pm/council/council-step-workflow-runner.mjs';
import { DurablePmRuntime } from '../../../src/pm/durable-pm-runtime.mjs';
import { SqlitePersistenceStore } from '../../../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { createPmRequest } from '../../../src/pm/pm-contracts.mjs';
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// DECLARED PRODUCTION BASELINE for the `src` no-drift preflight below.
// Was 38919961146d105315f2fb47b2316c628177814c until 2026-09-09, when
// DSH-CHAIR-PLAN-JSON-INVALID landed the ONE authorized chair_plan
// output-contract fix (3d72151, production-pm-backend-registry.mjs). The
// check has always meant "no UNDECLARED production drift while this live
// acceptance runs"; it now compares against that reviewed fix commit
// instead of a baseline the fix deliberately supersedes.
// Gateway implementation baseline: source changes are explicitly declared.
export const BASE = 'e0a4ef104dc4f3925ee2eb15d9849ef1fe7c713e';
// PRIMARY_PM_CHAIR_BACKEND_QUALIFICATION (2026-09-09): the Chair is now
// selectable so the SAME council topology can be run against a different PM
// CHAIR BACKEND without editing the harness per run. Unset — every existing
// caller, test and prior acceptance — resolves to the exact same
// API/OpenRouter chair as before, byte for byte. This changes WHICH backend
// chairs the council; it changes no prompt, parser, retry policy or schema.
export const CHAIR_PROFILE = process.env.DSH_CANARY_CHAIR_PROFILE ?? 'live1-api-openai-gpt-5-6-luna-pro-high';
// Chair products this harness will drive. `api` is the historical auxiliary
// route; `claude-code` and `codex` are DSH's primary PM backends. A chair
// profile of any other product fails preflight rather than running.
const SUPPORTED_CHAIR_PRODUCTS = new Set(['api', 'claude-code', 'codex']);
export const ANTIGRAVITY_PROFILE = 'live1-antigravity-gemini-3-8-flash-high';
export const CONTROL_PROFILE = 'live1-api-z-ai-glm-5-3-flash-medium';
export const FIXTURE_RELATIVE = 'research/antigravity-full-council-e2e/workspace-fixture.md';
export const HARD_MAX_PROVIDER_INVOCATIONS = ACCEPTANCE_CALL_BUDGET;
export const DEBATE_ROUNDS = 1;
export const OWNER_TASK = [
  'Using only the Library Checkout System workspace fixture supplied below, recommend which ONE of its three checkout approaches (A paper register, B shared spreadsheet, C small internal web app) the three-person library staff should adopt first.',
  'State the principal tradeoff the fixture itself states, and justify the recommendation against that tradeoff. Keep the final recommendation under 200 words.',
].join('\n');
const sha = value => createHash('sha256').update(value).digest('hex');
const git = (...args) => execFileSync('git',args,{cwd:ROOT,windowsHide:true,encoding:'utf8'}).trim();
const safeReason = value => {
  if (typeof value !== 'string') return null;
  const parts = value.split(':');
  return /^[A-Z][A-Z0-9_]*$/.test(parts[0]) ? parts.slice(0,2).filter(p=>/^[A-Z][A-Z0-9_]*$/.test(p)).join(':') : 'UNKNOWN';
};
const terminalStatuses = ['SUCCESS','ERROR','CANCELED','INTERRUPTED','INVALID','WAITING','RUNNING'];

// Deterministic, content-free step sequence of a minimal one-round, two-participant
// READ council with debate enabled (derived from council-chair-driver.mjs's decide()
// ordering; participant order is owner-selected: Antigravity first).
export function expectedCallPlan({ antigravityProfile = ANTIGRAVITY_PROFILE, controlProfile = CONTROL_PROFILE, chairProfile = CHAIR_PROFILE, participants = [antigravityProfile, controlProfile], chairProduct = 'api' } = {}) {
  // A chair on a primary PM backend requests native structured output for
  // chair_plan (council-step-workflow-runner.mjs gates that lane on
  // product === 'claude-code'); the api chair never does. `chairProduct`
  // defaults to 'api', so every existing caller's plan is unchanged.
  const native = (profile, step) => (profile === antigravityProfile && ['participant_report','participant_critique','debate_response'].includes(step))
    || (profile === chairProfile && step === 'chair_plan' && chairProduct === 'claude-code');
  const plan = [];
  const add = (step, profile, ordinalAttempt = 0) => plan.push({ordinal: plan.length+1, profile_id: profile, product: profile===chairProfile?chairProduct:profile===antigravityProfile?'antigravity':'api', step_kind: step, attempt_ordinal: ordinalAttempt, native_schema_requested: native(profile, step)});
  add('chair_plan', chairProfile);
  for (const p of participants) add('participant_report', p);
  for (const p of participants) add('participant_critique', p);
  add('chair_synthesis', chairProfile);
  add('debate_brief', chairProfile);
  for (const p of participants) add('debate_response', p);
  add('debate_synthesis', chairProfile);
  return plan;
}

export async function prepare({profiles = null, providers = {}} = {}) {
  const runtimeDir = process.env.DSH_CANARY_RUNTIME_DIR ?? join(process.cwd(), '.runtime', 'live1');
  // Owner-provided API secrets live in the gitignored main-repo .env (never
  // committed); load them into process.env for this process only. Values are
  // never printed or persisted.
  const dotenvPath = process.env.DSH_CANARY_DOTENV ?? join(dirname(dirname(runtimeDir)), '.env');
  if (!profiles && !process.env.DSH_API_OPENROUTER_KEY && existsSync(dotenvPath)) {
    for (const line of readFileSync(dotenvPath, 'utf8').split(/\r?\n/)) {
      const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (m && process.env[m[1]] == null) process.env[m[1]] = m[2].trim();
    }
  }
  const profilesYaml = profiles ?? parse(readFileSync(join(runtimeDir,'pm-profiles.yaml'),'utf8')).pm_profiles;
  const profileRegistry = new PmProfileRegistry(profilesYaml);
  const apiProviders = profiles ? providers : await loadApiProviderConfig({path: join(runtimeDir,'api-providers.yaml'), env: process.env});
  const council = normalizeCouncilSpec({
    chair_profile_id: CHAIR_PROFILE,
    participant_profile_ids: [ANTIGRAVITY_PROFILE, CONTROL_PROFILE],
    rounds: 2,
    workspace_requirement: 'READ',
    workspace_evidence_paths: [FIXTURE_RELATIVE],
    debate: {enabled: true, max_rounds: DEBATE_ROUNDS},
  }, {knownProfileIds: new Set(profilesYaml.map(p => p.id))});
  const project = {id:'antigravity-full-council-e2e', repo_path: ROOT};
  const admission = await admitCouncilWorkspaceRequirement({council, project, resolveProfile: id => profileRegistry.get(id)});
  if (!admission.admitted) throw Object.assign(new Error('council workspace admission refused'), {code:'COUNCIL_WORKSPACE_ADMISSION_FAILED'});
  const packet = await buildWorkspaceEvidencePacket({project, evidencePaths: council.workspace_evidence_paths});
  const hashesByPath = packetHashesByPath(packet);
  const fixtureSha = hashesByPath[FIXTURE_RELATIVE];
  if (!fixtureSha || !packet.files?.[0]?.fully_visible) throw new Error('FIXTURE_PACKET_INVALID');
  const evidencePacketText = renderWorkspaceEvidencePacketText(packet);
  return {council, project, profileRegistry, apiProviders, evidencePacket:{text:evidencePacketText, hashesByPath},
    fixture:{relative_path:FIXTURE_RELATIVE, sha256:fixtureSha, bytes:packet.files?.[0]?.bytes ?? null, fully_visible:true, manifest_membership:true}};
}

export function preflight({profileRegistry, council, project, fixture}) {
  const chair = profileRegistry.get(CHAIR_PROFILE), agy = profileRegistry.get(ANTIGRAVITY_PROFILE), control = profileRegistry.get(CONTROL_PROFILE);
  const plan = expectedCallPlan({chairProduct: chair?.product});
  const schemaFor = stepKind => antigravityParticipantSchemaRequest({kind:'council_step',stepKind,round:1,profileId:ANTIGRAVITY_PROFILE,isImplementationParticipant:false,workspaceRequirement:council.workspace_requirement,workspaceEvidencePaths:council.workspace_evidence_paths}, agy);
  const bridge = readFileSync(join(ROOT,'src/session/antigravity-cli-session-bridge.mjs'),'utf8');
  const registry = readFileSync(join(ROOT,'src/pm/production-pm-backend-registry.mjs'),'utf8');
  let srcUnchanged = null;
  try { srcUnchanged = git('diff',acceptanceSourceRef(BASE),'--','src')===''; } catch { srcUnchanged = false; }
  const agyExecutable = resolveAntigravityExecutable();
  const checks = {
    validated_ancestry: (() => { try { git('merge-base','--is-ancestor',BASE,'HEAD'); return true; } catch { return false; } })(),
    clean_checkout: acceptanceCheckoutClean(git),
    src_unchanged_vs_base: srcUnchanged,
    // The chair must resolve to the EXACT selected profile id on a supported
    // chair product. An `api` chair additionally has to be the openrouter
    // route it has always been; a primary PM chair (claude-code / codex) is
    // driven through its own production CLI backend, never re-routed through
    // API/OpenRouter because the model name looks similar.
    chair_resolves: chair.id===CHAIR_PROFILE && SUPPORTED_CHAIR_PRODUCTS.has(chair.product) && (chair.product!=='api' || chair.provider==='openrouter'),
    control_resolves: control.id===CONTROL_PROFILE && control.product==='api' && control.provider==='openrouter',
    antigravity_resolves: agy.id===ANTIGRAVITY_PROFILE && agy.product==='antigravity',
    antigravity_non_implementation: council.implementation_participant_id==null && council.participant_profile_ids.includes(ANTIGRAVITY_PROFILE),
    read_only_council: council.workspace_requirement==='READ',
    one_debate_round: council.debate?.enabled===true && council.debate.max_rounds===DEBATE_ROUNDS,
    report_requires_workspace_read: council.workspace_requirement==='READ' && Array.isArray(council.workspace_evidence_paths) && council.workspace_evidence_paths.includes(FIXTURE_RELATIVE),
    fixture_manifest_membership: council.workspace_evidence_paths?.includes(FIXTURE_RELATIVE)===true,
    fixture_sha_frozen: fixture.sha256===sha(readFileSync(join(ROOT,FIXTURE_RELATIVE),'utf8')),
    agy_report_native_schema: schemaFor('participant_report')?.mode==='native_json_schema' && schemaFor('participant_report')?.provider==='antigravity',
    agy_critique_native_schema: schemaFor('participant_critique')?.mode==='native_json_schema',
    agy_debate_response_native_schema: schemaFor('debate_response')?.mode==='native_json_schema',
    authoritative_native_field: bridge.includes('const native=result.structured_output')&&registry.includes('extractAntigravityAssistantText(value,{structuredOutputSchema})'),
    // Renamed 2026-09-09 (DSH-CHAIR-PLAN-JSON-INVALID): a production change
    // WAS required, and is declared as this run's BASE. The invariant this
    // check actually enforces — and always enforced — is that `src` carries
    // nothing beyond that declared baseline when the live run starts.
    src_matches_declared_baseline: srcUnchanged,
    expected_plan_computed: plan.length===10 && plan.every(e=>Number.isInteger(e.ordinal)),
    hard_budget_enforceable: plan.length<=HARD_MAX_PROVIDER_INVOCATIONS,
    offline_tests_pass: existsSync(join(ROOT,'.test-results/full-council-offline-gates.json')),
    openrouter_key_present: typeof process.env.DSH_API_OPENROUTER_KEY==='string' && process.env.DSH_API_OPENROUTER_KEY.length>0,
    antigravity_cli_available: agyExecutable.available===true,
  };
  return {checks, pass:Object.values(checks).every(Boolean), tested_head:git('rev-parse','HEAD'), tested_tree:acceptanceTestedTree(git), plan, max_turns:councilMaxTurns(council)};
}

function antigravityFacts(summary,{structuredOutputSchema}){
  const r=summary?.result, response=typeof r?.response==='string'?r.response:null;
  let extracted=null;
  try { extracted=extractAntigravityAssistantText(summary,{structuredOutputSchema}); } catch {}
  return {terminal_status:terminalStatuses.includes(r?.status)?r.status:'UNKNOWN',
    terminal_response_present:response!==null&&!!response.trim(),terminal_response_bytes:response===null?null:Buffer.byteLength(response),
    structured_output_present:!!r?.structured_output&&typeof r.structured_output==='object'&&!Array.isArray(r.structured_output),
    assistant_output_present:extracted!==null,assistant_output_bytes:extracted===null?null:Buffer.byteLength(extracted),
    result_event_count:summary?.events?.filter(e=>e.event==='result').length??null,process_exit_code:summary.code??null};
}

// Content-free transport facts for one claude-code invocation. `jsonSchema`
// present means the production chair_plan native structured-output lane was
// used, and `structuredOutput` — not stdout — is the authoritative field the
// backend converts into assistant text.
function claudeFacts(value,{jsonSchema}){
  const structured = jsonSchema ? (value?.structuredOutput ?? null) : null;
  const text = jsonSchema
    ? (structured===null||structured===undefined ? null : JSON.stringify(structured))
    : (typeof value?.result==='string' ? value.result : typeof value?.stdout==='string' ? value.stdout : null);
  const present = typeof text==='string' && text.trim()!=='';
  return {terminal_status: present?'SUCCESS':'EMPTY', terminal_response_present: present,
    terminal_response_bytes: typeof text==='string'?Buffer.byteLength(text):null,
    assistant_output_present: present, assistant_output_bytes: typeof text==='string'?Buffer.byteLength(text):null,
    structured_output_present: !!structured && typeof structured==='object' && !Array.isArray(structured),
    process_exit_code: value?.code ?? null};
}

// Runs ONE real Council end-to-end through DurablePmRuntime + CouncilChairDriver +
// CouncilStepWorkflowRunner + a production driver resolver. A single global
// invocation ledger (antdigravity + api runners) enforces the hard call budget;
// no production retry/timeout policy is modified.
export async function runCouncil({council, project, profileRegistry, apiProviders, evidencePacket, fixture, providerRunners = {}, execution_mode, evidenceRoot = ROOT} = {}) {
  assertExecutionMode(execution_mode, providerRunners);
  if (execution_mode === 'SYNTHETIC' && (providerRunners.api === runApiBackendRequest || providerRunners.antigravity === runAntigravityCliProcess)) throw new Error('SYNTHETIC_REAL_RUNNER_REFUSED');
  if (execution_mode === 'LIVE') {
    const checks = preflight({profileRegistry,council,project,fixture});
    const gatePath = join(ROOT,'.test-results/full-council-offline-gates.json');
    const gates = existsSync(gatePath) ? JSON.parse(readFileSync(gatePath,'utf8')) : null;
    if (!checks.pass || !gates?.passed || gates.tested_head !== checks.tested_head || gates.tested_tree !== checks.tested_tree) throw new Error('LIVE_PREFLIGHT_OR_OFFLINE_GATES_REQUIRED');
    if (resolve(evidenceRoot) !== ROOT) throw new Error('LIVE_EVIDENCE_ROOT_REFUSED');
  }
  const evidence = new AcceptanceEvidence({root:evidenceRoot, mode:execution_mode, fixture, profiles:{chair:CHAIR_PROFILE,antigravity:ANTIGRAVITY_PROFILE,control:CONTROL_PROFILE}, repositoryHead:git('rev-parse','HEAD'), branch:git('branch','--show-current')});
  evidence.manifest.tested_source_tree=acceptanceTestedTree(git);
  evidence.claim();
  const removeFinalizers = execution_mode === 'LIVE' ? evidence.installFinalizers() : () => {};
  let store = null;
  try { return await executeCouncil(); }
  catch(error) { try { await store?.close(); evidence.abort('HARNESS_ERROR'); } catch {} throw error; }
  finally { removeFinalizers(); }
  async function executeCouncil() {
  const HARD_MAX = HARD_MAX_PROVIDER_INVOCATIONS;
  let invocations = 0;
  const evidencePacketText = evidencePacket.text, hashesByPath = evidencePacket.hashesByPath;
  const decideLedger = [];
  const stepOutcomes = [];
  let current = null;
  const reserve = () => { current.provider_record = evidence.reserve(current); return ++invocations; };
  // PARSER-0: the layeredDiagnostic event (Diagnostic Schema v1) is attached to
  // the CURRENT decide() ledger entry. Physical council execution is serialized,
  // so the "current" pointer is unambiguous.
  const parser0 = d => ({diagnostic_version:d?.diagnostic_version??1, execution_state:d?.execution_state??null, terminal_state:d?.terminal_state??null,
    structured_output_requested:d?.structured_output_requested??null, structured_output_present:d?.structured_output_present??null,
    assistant_output_present:d?.assistant_output_present??null, parser_attempted:d?.parser_attempted??null, parser_state:d?.parser_state??null,
    parse_error_code:safeReason(d?.parse_error_code), parse_subreason:safeReason(d?.parse_subreason),
    attempt_ordinal:d?.attempt_ordinal??null, primary_layer:d?.primary_layer??null});
  const observer = {canonicalization: (_ctx,d) => {
    if(current) {
      current.canonicalization = d;
      if(current.lastCanonical?.provider_record) {
        Object.assign(current.lastCanonical.provider_record,{canonicalization:d,parser_attempted:d.canonicalized_parser_state!=='NOT_ATTEMPTED',parser_state:d.canonicalized_parser_state,assistant_output_present:d.execution_state==='SUCCESS'}); evidence.persistLedger();
      }
    }
  }, canonicalizationUsage: (_ctx,d) => {
    if(current?.lastCanonical?.provider_record) { Object.assign(current.lastCanonical.provider_record,d); evidence.persistLedger(); }
  }, apiUsage: (_ctx,payload) => evidence.receipt(current?.provider_record,payload),start: ctx => { if(ctx.invocation_role==='canonicalizer') return; if(current) { current.backend_request_id=ctx.requestId; current.observer_identity_matches=ctx.acceptance_execution_id===evidence.manifest.acceptance_execution_id && ctx.council_run_id===evidence.manifest.council_run_id && ctx.action_id===current.action_id; } }, layeredDiagnostic: (_ctx, payload) => { if (current) { current.parser_0 = parser0(payload); evidence.diagnostic(current.provider_record, payload); } }};
  // PRIMARY_PM_CHAIR_BACKEND_QUALIFICATION: a claude-code chair must be
  // reserved, budgeted and receipted exactly like every other backend —
  // without this hook its invocations would bypass the ledger entirely and
  // the manifest would under-report the run. Mirrors antigravityRunner:
  // reserve an ordinal BEFORE the call, record transport truth either way,
  // and return the runner's own value untouched.
  const claudeRunner = async options => {
    if(execution_mode==='SYNTHETIC' && typeof providerRunners.claude!=='function') throw new Error('SYNTHETIC_CLAUDE_STUB_REQUIRED');
    const parent = current;
    if(options.invocationContext?.invocation_role === 'canonicalizer') {
      const c=options.invocationContext;
      current={action_id:parent.action_id,step_kind:parent.step_kind,profile_id:c.profileId,product:c.backendProduct,attempt_ordinal:1,retry_kind:'CANONICALIZER',invocation_role:'canonicalizer',source_profile:parent.profile_id,backend_request_id:parent.backend_request_id,observer_identity_matches:parent.observer_identity_matches};
      parent.lastCanonical=current; decideLedger.push(current);
    }
    try {
      const ordinal=reserve(); current.provider_invocation_ordinal=ordinal;
      let value; try { value=await (providerRunners.claude ?? runClaudeProcess)(options); evidence.transport(current.provider_record,true); } catch(error) { evidence.transport(current.provider_record,false); throw error; }
      Object.assign(current,claudeFacts(value,{jsonSchema:options.jsonSchema}),{provider_invocation_ordinal:ordinal});
      return value;
    } finally { current=parent; }
  };
  const antigravityRunner = async options => {
    const ordinal=reserve(); current.provider_invocation_ordinal=ordinal;
    let summary; try { summary=await (providerRunners.antigravity ?? runAntigravityCliProcess)(options); evidence.transport(current.provider_record,true); } catch(error) { evidence.transport(current.provider_record,false); throw error; }
    Object.assign(current, antigravityFacts(summary,{structuredOutputSchema:options.structuredOutputSchema}), {provider_invocation_ordinal:ordinal});
    return summary;
  };
  const apiRunner = async options => {
    const ordinal=reserve(); current.provider_invocation_ordinal=ordinal;
    let text; try { text=await (providerRunners.api ?? runApiBackendRequest)(options); evidence.transport(current.provider_record,true); } catch(error) { evidence.transport(current.provider_record,false); throw error; }
    Object.assign(current,{terminal_status:typeof text==='string'&&!!text.trim()?'SUCCESS':'EMPTY',terminal_response_present:typeof text==='string'&&!!text.trim(),terminal_response_bytes:typeof text==='string'?Buffer.byteLength(text):null,assistant_output_present:typeof text==='string'&&!!text.trim(),structured_output_present:false,provider_invocation_ordinal:ordinal});
    return text;
  };
  const backendRegistry = new ProductionPmBackendRegistry({profileRegistry,probe:()=>true, antigravityBinary: providerRunners.antigravityBinary ?? (resolveAntigravityExecutable().path ?? ''), antigravityRunner, apiRunner, claudeRunner, observer, apiProviders, apiEnv: process.env});
  const productionResolver = createProductionPmDriverResolver({backendRegistry, apiProviders});
  const resolveDriver = (profile, ctx = {}) => {
    const driver = productionResolver(profile, {project, extraCtx: ctx.extraCtx, executionOptions: ctx.executionOptions});
    return {name: driver.name, decide: async input => {
      const prior = decideLedger.some(e=>e.action_id===ctx.extraCtx?.action_id);
      const entry={action_id:ctx.extraCtx?.action_id,retry_kind:(ctx.extraCtx?.attempt??0)>0?'PARSE_RETRY':prior?(ctx.extraCtx?.phase==='chair_plan'?'PARTICIPANT_ID_REPAIR':'SEMANTIC_REPAIR'):'INITIAL_GENERATION',ordinal:decideLedger.length+1,profile_id:profile.id,product:profile.product,step_kind:ctx.extraCtx?.phase??null,attempt_ordinal:ctx.extraCtx?.attempt??0,native_schema_requested:!!(input?.structuredOutput),decision_type:null,public_error_code:null};
      decideLedger.push(entry); current=entry;
      try { const decision=await driver.decide(input); entry.decision_type=decision?.type??null; return decision; }
      catch(error){ entry.public_error_code=errorCode(error?.code); if(entry.provider_record) {entry.provider_record.public_error_code=entry.public_error_code; evidence.persistLedger();} throw error; }
    }};
  };
  const inner = new CouncilStepWorkflowRunner({project, resolveDriver, profileRegistry: {get: id => profileRegistry.get(id)},
    extraCtx: spec => ({acceptance_execution_id:evidence.manifest.acceptance_execution_id,council_run_id:evidence.manifest.council_run_id,action_id:spec.id,councilId:evidence.manifest.council_run_id, phase: spec.stepKind, round: spec.round, role: spec.stepKind.startsWith('chair')||['debate_brief','debate_synthesis'].includes(spec.stepKind)?'chair':'participant'})});
  const workflowRunner = { run: async spec => {
    const outcome = await inner.run(spec);
    const handoff = outcome.finalResult?.handoff ?? null;
    const evidence = Array.isArray(handoff?.evidence) ? handoff.evidence : null;
    stepOutcomes.push({
      step_id: spec.id, step_kind: spec.stepKind, profile_id: spec.profileId ?? null, round: spec.round ?? null,
      is_implementation_participant: spec.isImplementationParticipant === true, workspace_requirement: spec.workspaceRequirement ?? null, workspace_mode: spec.workspaceMode ?? null,
      ok: handoff?.ok === true, reason: handoff?.ok === true ? null : safeReason(handoff?.reason ?? null), original_failure_reason: safeReason(handoff?.original_failure?.reason ?? null),
      attempts: (handoff?.attempts ?? []).map(a => ({attempt:a.attempt, ok:a.ok===true, canonicalization:a.canonicalization??null, execution_state:a.execution_state??null, parser_attempted:a.parser_attempted??null, parser_state:a.parser_state??null, parse_error_code:safeReason(a.error_code), parse_subreason:safeReason(a.parse_subreason), assistant_output_present:a.assistant_output_present??null, structured_output_applied:a.structured_output_applied===true, output_bytes:a.output_bytes??null})),
      structured_output: handoff?.structured_output ? {requested:handoff.structured_output.requested===true} : null,
      semantic_repair_used: handoff?.semantic_repair_used === true, participant_id_repair_used: handoff?.participant_id_repair_used === true,
      evidence_entry_count: evidence?.length ?? null,
      evidence_path_match_count: evidence ? evidence.filter(e => e?.path === FIXTURE_RELATIVE).length : null,
      evidence_sha_match_count: evidence ? evidence.filter(e => typeof e?.sha256==='string' && fixture.sha256?.toLowerCase() === e.sha256.toLowerCase()).length : null,
      evidence_diagnostic_count: handoff?.evidence_diagnostics ? Object.values(handoff.evidence_diagnostics).reduce((n,v)=>n+(typeof v==='number'?v:0),0) : null,
    });
    return outcome;
  }, result: actionId => inner.result(actionId) };
  const peerRelay = {async exchange(){throw new Error('council never uses peer_exchange');}, createConversation(){throw new Error('unused');}, getConversation(){return null;}, result(){return null;}};
  const driver = new CouncilChairDriver({council, ownerTask: OWNER_TASK,
    loadEvidencePacket: async () => ({text: evidencePacketText, hashesByPath: hashesByPath})});
  store = new SqlitePersistenceStore();
  await store.open({path:evidence.manifest.database_path}); await store.migrate();
  evidence.databaseReady();
  const repository = new ContentFreePmRepository({store});
  const runtime = new DurablePmRuntime({driver, workflowRunner, peerRelay, repository, maxTurns: councilMaxTurns(council)});
  const request = createPmRequest({objective:OWNER_TASK,context:{ownerCommandId:evidence.manifest.acceptance_execution_id,acceptance_execution_id:evidence.manifest.acceptance_execution_id,execution_mode,council}});
  const pmRunId = evidence.manifest.council_run_id;
  repository.create(request, {id: pmRunId, driver: driver.name, startedAt: new Date().toISOString()});
  try {
    evidence.running();
    const result = await runtime.resume(pmRunId);
    // Classify retry kinds from the durable attempt ledgers.
    const parseRetries = stepOutcomes.flatMap(s => s.attempts.filter(a => a.attempt > 0).map(a => ({step: s.step_kind, profile_id: s.profile_id, attempt: a.attempt})));
    const semanticRepairs = stepOutcomes.filter(s => s.semantic_repair_used).map(s => ({step: s.step_kind, profile_id: s.profile_id}));
    const participantRepairs = stepOutcomes.filter(s => s.participant_id_repair_used).map(s => ({step: s.step_kind}));
    const by = (kind, profile) => stepOutcomes.find(s => s.step_kind===kind && s.profile_id===profile) ?? null;
    const aReport = by('participant_report', ANTIGRAVITY_PROFILE), aCritique = by('participant_critique', ANTIGRAVITY_PROFILE), aDebateResponse = by('debate_response', ANTIGRAVITY_PROFILE);
    const bReport = by('participant_report', CONTROL_PROFILE), bCritique = by('participant_critique', CONTROL_PROFILE), bDebateResponse = by('debate_response', CONTROL_PROFILE);
    const chairPlan = stepOutcomes.find(s => s.step_kind==='chair_plan') ?? null;
    const chairSynthesis = stepOutcomes.find(s => s.step_kind==='chair_synthesis') ?? null;
    const debateBrief = stepOutcomes.find(s => s.step_kind==='debate_brief') ?? null;
    const debateSynthesis = stepOutcomes.find(s => s.step_kind==='debate_synthesis') ?? null;
    const state = s => s ? (s.ok ? 'PASS' : 'FAIL') : 'NOT_REACHED';
    const nativeSchema = s => s?.structured_output?.requested===true;
    const agySteps = [aReport, aCritique, aDebateResponse];
    const agyAccepted = agySteps.every(Boolean) && agySteps.every(s => s.ok) && (aReport.evidence_entry_count??0) >= 1 && (aReport.evidence_path_match_count??0) >= 1 && (aReport.evidence_sha_match_count??0) >= 1;
    const controlSteps = [bReport, bCritique, bDebateResponse];
    const controlBlocked = !agyAccepted && controlSteps.some(Boolean) && controlSteps.some(s => s && !s.ok) && !agySteps.some(Boolean);
    const chairSteps = [chairPlan, chairSynthesis];
    const chairBlocked = !agyAccepted && chairSteps.some(s => s && !s.ok) && !agySteps.some(Boolean);
    const durableAccepted = result.status==='completed' && ['council','council_debate'].includes(result.data?.type);
    void durableAccepted;
    const budgetExceeded = invocations > HARD_MAX;
    const firstFailure = stepOutcomes.find(s => !s.ok);
    const failureOwner = firstFailure
      ? (firstFailure.profile_id===CHAIR_PROFILE ? 'CHAIR' : firstFailure.profile_id===ANTIGRAVITY_PROFILE ? 'ANTIGRAVITY_PARTICIPANT' : firstFailure.profile_id===CONTROL_PROFILE ? 'CONTROL_PARTICIPANT' : 'UNKNOWN')
      : null;
    const budgetErrorCode = decideLedger.some(e => e.public_error_code==='CANARY_LIVE_CALL_BUDGET_EXHAUSTED');
    const agyParseRetry = parseRetries.some(r => r.profile_id===ANTIGRAVITY_PROFILE);
    const agySemanticRepair = semanticRepairs.some(r => r.profile_id===ANTIGRAVITY_PROFILE);
    const reconciledCanonicalRecords=new Set();
    for (const step of stepOutcomes) {
      for (const attempt of step.attempts) {
        const d=attempt.canonicalization;
        if(d) {
          const record=evidence.records.find(r=>!reconciledCanonicalRecords.has(r) && r.invocation_role==='canonicalizer' && r.action_id===step.step_id && r.canonicalization?.raw_output_sha256===d.raw_output_sha256);
          if(record) { record.canonicalization=d; reconciledCanonicalRecords.add(record); }
        }
      }
    }
    evidence.persistLedger();
    const canonicalizerCalls = decideLedger.filter(e=>e.invocation_role==='canonicalizer' && e.provider_record);
    const strict = canonicalizerCalls.length===0 && result.status==='completed' && agyAccepted && parseRetries.length===0 && semanticRepairs.length===0 && participantRepairs.length===0 && budgetErrorCode===false;
    const report = {acceptance_execution_id:evidence.manifest.acceptance_execution_id,execution_mode,manifest_path:evidence.path,durable_result_status: result.status, durable_result_data_type: result.data?.type ?? null, degraded: result.data?.degraded ?? null,
      max_turns: councilMaxTurns(council), pm_run_id: pmRunId,
      canonicalizer_calls:canonicalizerCalls.length,
      pass_class:result.status!=='completed'?'FAIL':parseRetries.length||semanticRepairs.length||participantRepairs.length?'RECOVERED_PASS':canonicalizerCalls.length?'CANONICALIZED_PASS':'STRICT_FAST_PATH_PASS',
      canonicalization_records:canonicalizerCalls.map(e=>e.provider_record),
      live_provider_invocations: invocations, call_budget_exceeded: invocations > HARD_MAX || budgetErrorCode,
      provider_invocation_plan: decideLedger.filter(e=>e.provider_record).map(e => ({invocation_role:e.invocation_role??'pm',ordinal:e.provider_record.invocation_ordinal,acceptance_execution_id:evidence.manifest.acceptance_execution_id,backend_attempt_id:e.provider_record.backend_attempt_id,action_id:e.action_id, profile_id:e.profile_id, product:e.product, step_kind:e.step_kind, attempt_ordinal:e.attempt_ordinal, native_schema_requested:e.native_schema_requested, decision_type:e.decision_type, public_error_code:e.public_error_code, parser_0:e.parser_0??null})),
      step_outcomes: stepOutcomes,
      chair_plan: {state: state(chairPlan), attempts: chairPlan?.attempts?.length ?? 0},
      chair_synthesis: {state: state(chairSynthesis), attempts: chairSynthesis?.attempts?.length ?? 0},
      debate_brief: {state: state(debateBrief), attempts: debateBrief?.attempts?.length ?? 0},
      debate_synthesis: {state: state(debateSynthesis), attempts: debateSynthesis?.attempts?.length ?? 0},
      antigravity_report: {state: state(aReport), attempts: aReport?.attempts?.length ?? 0, native_schema: nativeSchema(aReport), evidence_state: aReport?.ok ? 'PASS' : aReport ? 'FAIL' : 'NOT_REACHED', evidence_entry_count: aReport?.evidence_entry_count ?? null, evidence_path_match_count: aReport?.evidence_path_match_count ?? null, evidence_sha_match_count: aReport?.evidence_sha_match_count ?? null, terminal_status: aReport?.attempts?.[0]?.execution_state ?? null},
      antigravity_critique: {state: state(aCritique), attempts: aCritique?.attempts?.length ?? 0, native_schema: nativeSchema(aCritique)},
      antigravity_debate_response: {state: state(aDebateResponse), attempts: aDebateResponse?.attempts?.length ?? 0, native_schema: nativeSchema(aDebateResponse)},
      control_report: {state: state(bReport), attempts: bReport?.attempts?.length ?? 0, native_schema: nativeSchema(bReport)},
      control_critique: {state: state(bCritique), attempts: bCritique?.attempts?.length ?? 0},
      control_debate_response: {state: state(bDebateResponse), attempts: bDebateResponse?.attempts?.length ?? 0},
      retry_observations: {initial_generation: decideLedger.filter(e=>e.attempt_ordinal===0).length, parse_retry: parseRetries, semantic_repair: semanticRepairs, participant_id_repair: participantRepairs},
      antigravity_parse_retry_used: agyParseRetry, antigravity_semantic_repair_used: agySemanticRepair, antigravity_native_fallback_used: false,
      antigravity_participant_accepted: agyAccepted,
      full_council_accepted: result.status==='completed' && !budgetErrorCode && [chairPlan, ...controlSteps, chairSynthesis, debateBrief, debateSynthesis].every(s => s?.ok===true) && agyAccepted,
      control_participant_blocked: controlBlocked, chair_blocked: chairBlocked,
      primary_failure_owner: budgetErrorCode ? 'COUNCIL_ORCHESTRATION' : failureOwner ?? 'NONE',
      failure_step: firstFailure?.step_kind ?? null, failure_profile: firstFailure?.profile_id ?? null, failure_public_error_code: firstFailure?.attempts?.at(-1)?.parse_error_code ?? firstFailure?.reason ?? null,
      strict_full_pass: strict, recovered_full_pass: result.status==='completed' && agyAccepted && !budgetErrorCode && !strict,
      deepest_stage: deepestStage(stepOutcomes),
    };
    const durable = repository.load(pmRunId);
    await store.close();
    atomicJson(join(evidence.directory,'acceptance-report.json'),report);
    evidence.finish(report,durable);
    return report;
  } finally { await store.close(); }
  }
}

function deepestStage(stepOutcomes){
  const order=['chair_plan','participant_report','participant_critique','chair_synthesis','debate_brief','debate_response','debate_synthesis'];
  let deepest='NOT_STARTED';
  for(const kind of order){ const steps=stepOutcomes.filter(s=>s.step_kind===kind); if(steps.length && steps.every(s=>s.ok)) deepest=kind.toUpperCase(); else break; }
  return deepest;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const context=await prepare();
  const checks=preflight(context);
  if(!checks.pass){console.log(JSON.stringify({state:'ANTIGRAVITY_FULL_COUNCIL_PREFLIGHT_FAILED',preflight:checks},null,2));process.exitCode=1;}
  else if(!process.argv.includes('--live')) console.log(JSON.stringify({preflight:checks,fixture:{relative_path:context.fixture.relative_path,sha256:context.fixture.sha256,bytes:context.fixture.bytes},owner_task_bytes:Buffer.byteLength(OWNER_TASK),owner_task_sha256:sha(OWNER_TASK)},null,2));
  else {
    const gatePath=join(ROOT,'.test-results/full-council-offline-gates.json');
    const gates=existsSync(gatePath)?JSON.parse(readFileSync(gatePath,'utf8')):null;
    if(!gates?.passed||gates.tested_head!==checks.tested_head||gates.tested_tree!==checks.tested_tree) throw new Error('OFFLINE_GATES_REQUIRED');
    const executable=resolveAntigravityExecutable();
    if(!executable.available) throw new Error('ANTIGRAVITY_FULL_COUNCIL_PREFLIGHT_FAILED');
    try {
      const result=await runCouncil({...context,execution_mode:'LIVE'});
      console.log(JSON.stringify({state:'DONE',manifest_path:result.manifest_path,acceptance_execution_id:result.acceptance_execution_id,live_provider_invocations:result.live_provider_invocations}));
    } catch { console.log('HARNESS_FAILED_NO_RETRY');process.exitCode=1; }
  }
}
