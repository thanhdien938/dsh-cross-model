import { acceptPmOutput, canonicalizationConfig, safeClaudeUsage } from './output-canonicalization/gateway.mjs';
import { buildPmDecisionJsonSchema } from './pm-decision-schema.mjs';
import {spawn as nodeSpawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {rawEvidenceCaptureConfig} from '../runtime/t5-raw-evidence-capture.mjs';
import {resolveClaudeExecutable,runClaudeProcess} from '../session/claude-code-session-bridge.mjs';
import {OPENCODE_DEFAULT_TIMEOUT_MS,extractOpenCodeAssistantText,resolveOpenCodeExecutable,runOpenCodeProcess} from '../session/opencode-cli-session-bridge.mjs';
import {CODEX_CLI_CAPABILITIES,CODEX_CLI_DEFAULT_TIMEOUT_MS,classifyCodexSandboxExecution,extractCodexAssistantText,probeCodexWindowsSandboxHelper,resolveCodexCliExecutable,runCodexCliProcess} from '../session/codex-cli-session-bridge.mjs';
import {GROK_CLI_CAPABILITIES,GROK_CLI_DEFAULT_TIMEOUT_MS,extractGrokAssistantText,runGrokCliProcess} from '../session/grok-cli-session-bridge.mjs';
import {resolveGrokExecutable} from '../session/grok-acp-client.mjs';
import {ANTIGRAVITY_CLI_CAPABILITIES,ANTIGRAVITY_DEFAULT_TIMEOUT_MS,buildAntigravityPrompt,extractAntigravityAssistantText,gatherAntigravityContextFacts,resolveAntigravityExecutable,runAntigravityCliProcess} from '../session/antigravity-cli-session-bridge.mjs';
import {awaitOwnedSpawnReaping,createBackendExecutionObserver,withReapedOwnedSpawnLifecycle,withSpawnObservation} from '../runtime/backend-execution-observer.mjs';
import {withBackendLiveness,BackendLivenessTracker} from '../runtime/backend-liveness-tracker.mjs';
import {probeConnectionFacts,unavailableConnectionFacts,probeInstalledAndVersion} from './pm-connection-probe.mjs';
import {reasoningCapabilityFor} from './pm-reasoning-capability.mjs';
import {discoverApiProviderModels} from './api-backend/api-model-discovery.mjs';
import {normalizePmDecision} from './pm-contracts.mjs';
import {EXECUTION_STAGE} from './pm-execution-timeout-policy.mjs';
// PARSER-0: truthful layered diagnostics — OBSERVABILITY ONLY (see
// parser-0-diagnostics.mjs). Strictly additive facts attached beside the
// existing public error codes; parseDecision()/extractSingleDecision()
// acceptance, retry, timeout, prompt and provider behavior are untouched.
import {executionFailureDiagnosticFromError,parserOutcomeDiagnostic} from './parser-0-diagnostics.mjs';
// P11-R0: sixth production PM backend — a generic, provider-neutral HTTP
// API backend (`api-backend/`). See docs/p11/02_P11_R0_API_BACKEND_ARCHITECTURE_SONNET5.md
// for the full architecture record; the registration block below is the
// ONLY place this file's normal CLI-oriented pattern is genuinely
// different (no binary, no spawn — an HTTP request instead), and it still
// plugs into the exact same createCliPmDriver()/decide() contract as
// every CLI backend above.
import {runApiBackendRequest} from './api-backend/api-backend-adapter.mjs';
import {buildProviderChildEnv} from '../session/provider-child-policy.mjs';
import {synchronousReadiness,probeApiProviderReadiness} from './api-backend/api-provider-readiness.mjs';

// R31-4: the one authoritative product catalogue for the production PM
// backend surface. `ProductionPmBackendRegistry.list()` already exposed
// this (mapped, unfrozen) to callers that construct a registry instance —
// constructing one pays a real `--version` probe-spawn cost per backend
// (see resolveClaudeBinary() etc. as constructor defaults), so
// `listSupportedProducts()` below exists purely so a caller that only
// needs the product *names* (e.g. Desktop's execution-log product
// validation and, indirectly, its React tabs) never has to pay that cost
// just to read a static, zero-I/O constant. Adding a fifth backend here
// is the only place that needs editing — never a second hardcoded
// catalogue in Desktop or React.
export const SUPPORTED=Object.freeze([
  Object.freeze({product:'claude-code',transport:'stdio',session_kind:'STATELESS'}),
  Object.freeze({product:'opencode',transport:'stdio',session_kind:'STATELESS'}),
  Object.freeze({product:'codex',transport:'stdio',session_kind:'STATELESS'}),
  Object.freeze({product:'grok',transport:'stdio',session_kind:'STATELESS'}),
  // P9-R0: fifth production PM backend — Google Antigravity CLI (`agy`).
  Object.freeze({product:'antigravity',transport:'stdio',session_kind:'STATELESS'}),
  // P11-R0: sixth production PM backend — generic HTTP API (provider
  // identity lives on the PM profile itself, `profile.provider`, never a
  // second top-level product per provider — spec "BACKEND CATALOGUE").
  Object.freeze({product:'api',transport:'http',session_kind:'STATELESS'}),
]);
export function listSupportedProducts(){return SUPPORTED.map(v=>v.product);}
// DSH-T5-DEBUG-EVIDENCE-AND-MULTI-DECISION (Part B): a SUCCESSFUL decide()
// call has never surfaced the raw pre-parse assistant text to its caller —
// only a FAILED one does, via error.diagnostics (parseDiagnostics()). Raw
// evidence capture needs BOTH ("Capture evidence for BOTH: successful
// participant generations and failed participant generations"), so this
// mirrors gateway.mjs's own canonicalizationDiagnostic() WeakMap pattern
// exactly: metadata attached to the returned decision object, invisible to
// normal enumeration/serialization, readable only via the exported accessor.
// `enabled` is read from rawEvidenceCaptureConfig() (OFF by default) at the
// exact point of use below — when disabled this WeakMap is never populated
// and rawOutputEvidence() always returns null, zero behavior/memory change.
const rawOutputEvidenceMap = new WeakMap();
export const rawOutputEvidence = (value) => value && typeof value === 'object' ? rawOutputEvidenceMap.get(value) ?? value.rawOutputEvidence ?? null : null;

export class ProductionPmBackendError extends Error{constructor(message,code='PM_BACKEND_UNAVAILABLE',extra={}){super(message);this.name='ProductionPmBackendError';this.code=code;Object.assign(this,extra);}}

// DSH-TIMEOUT-1 Part D (audit Finding T-3): the ONE place every non-Claude
// CLI backend's registration below computes the exact `timeoutMs` it
// forwards to its bridge. Production execution ALWAYS passes an explicit
// value now (never the conditional-LONG-only forwarding this replaces) —
// "workflow/orchestrator resolves timeout -> provider invocation receives
// explicit timeoutMs -> bridge enforces that exact resolved value" (this
// wave's own required architecture) — but that explicit value is floored
// at `bridgeDefaultMs` (each bridge's own named default export —
// CODEX_CLI_DEFAULT_TIMEOUT_MS / OPENCODE_DEFAULT_TIMEOUT_MS /
// GROK_CLI_DEFAULT_TIMEOUT_MS / ANTIGRAVITY_DEFAULT_TIMEOUT_MS) so a stage
// whose central policy value happens to be SHORTER than that bridge's own
// pre-existing default (e.g. a 120s council read-only stage against
// Antigravity's 300s default) can never silently regress a currently-
// working timeout — the audit's own Part A requirement ("preserve every
// currently valid default unless the audit specifically proves the path is
// using the wrong timeout class/stage": TIMEOUT-0 proved the INCONSISTENCY,
// never that any individual bridge default was itself too generous). A
// stage whose policy value is LONGER (LONG SINGLE, the new implementation-
// participant class) correctly raises the floor. `resolvedTimeoutMs` not a
// finite number (a caller that omitted `executionOptions` entirely — every
// existing direct/non-production `createCliPmDriver()` caller, e.g. a
// test double) falls through to `bridgeDefaultMs` unchanged, matching the
// exact "bridge-local defaults remain for callers that genuinely omit a
// timeout" carve-out this wave's brief requires.
function explicitBridgeTimeoutMs(resolvedTimeoutMs,bridgeDefaultMs){
  return Number.isFinite(resolvedTimeoutMs)?Math.max(resolvedTimeoutMs,bridgeDefaultMs):bridgeDefaultMs;
}

export class ProductionPmBackendRegistry{
  // P6-W3-R3 Part B: `observer` defaults to the real BackendExecutionObserver
  // (writes sanitized NDJSON lines to stdout for Desktop's read-only
  // execution-log tabs — see src/runtime/backend-execution-observer.mjs).
  // It is purely observational: nothing below branches on it, and every
  // call site is optional-chained so a missing/throwing observer changes
  // no PM decision, parser outcome, or backend behavior (B4).
  // P10-R0.2.4 Part W/X: `observer` is wrapped, once, with the
  // activity-aware liveness decorator (backend-liveness-tracker.mjs) —
  // every existing call/argument/timing through it is preserved
  // byte-for-byte (the decorator delegates to the underlying observer
  // FIRST, unconditionally); the decorator's own liveness bookkeeping only
  // ever activates for an execution whose `ctx.stage` is the new LONG
  // owner SINGLE class (Part S), so this is a no-op (one string compare)
  // for every pre-existing call site/test. `livenessTracker` defaults to a
  // fresh instance but is exposed (`this.livenessTracker`) so a caller —
  // Desktop/diagnostics/tests — can read `getState(taskId)` for the
  // CURRENT execution without a second parallel tracking mechanism.
  // P11-R0: `apiRunner` defaults to the real HTTP transport
  // (runApiBackendRequest); `apiProviders` defaults to `{}` — NO
  // configured providers — which is the exact state every existing
  // deployment with zero API config is in today (spec "NO KEY = NO
  // REGRESSION": DSH must start normally with zero API keys/providers
  // configured). `apiEnv`/`apiFetch` are DI seams for tests; production
  // callers get `process.env`/the real global `fetch`. None of these five
  // params is read by any CLI backend above — adding them changes nothing
  // for claude-code/opencode/codex/grok/antigravity.
  constructor({profileRegistry=null,canonicalization=canonicalizationConfig(),claudeRunner=runClaudeProcess,openCodeRunner=runOpenCodeProcess,codexRunner=runCodexCliProcess,grokRunner=runGrokCliProcess,antigravityRunner=runAntigravityCliProcess,apiRunner=runApiBackendRequest,claudeBinary,openCodeBinary,codexBinary,grokBinary,antigravityBinary,probe=probeBinary,observer=createBackendExecutionObserver(),livenessTracker=new BackendLivenessTracker(),connectionProbe=probeConnectionFacts,installedProbe=probeInstalledAndVersion,apiProviders={},apiEnv=process.env,apiFetch=defaultFetch}={}){this.backends=new Map();this.connectionProbe=connectionProbe;this.installedProbe=installedProbe;this.livenessTracker=livenessTracker;this.apiProviders=apiProviders;this.apiEnv=apiEnv;this.apiFetch=apiFetch;this.apiModelCapabilities=new Map();observer=withBackendLiveness(observer,{tracker:livenessTracker});
    const canonicalize = async ({prompt,profileId,ctx,signal,depth}) => {
      if (signal?.aborted) throw new ProductionPmBackendError('canonicalization canceled','PM_BACKEND_ABORTED');
      if (depth !== 1) throw new ProductionPmBackendError('canonicalization depth exceeded','PM_CANONICALIZER_DEPTH');
      let target;
      try { target = profileRegistry?.get(profileId); } catch {}
      if (!target || target.product !== 'claude-code' || !this.inspect(target).available) throw new ProductionPmBackendError('canonicalizer profile unavailable','PM_CANONICALIZER_UNAVAILABLE');
      const callCtx = {...ctx,backendProduct:target.product,profileId:target.id,model:target.model,invocation_role:'canonicalizer',source_profile:ctx.profileId,source_step:ctx.phase??ctx.stage,canonicalization_attempt_ordinal:1};
      const started = Date.now();
      observe(observer,'start',callCtx);
      try {
        const spawnImpl = withReapedOwnedSpawnLifecycle(withSpawnObservation(nodeSpawn,{...observer,stderrChunk:()=>{}},{...callCtx,executable:claudeBinary}),signal);
        const value = await raceWithWatchdog(claudeRunner({binary:claudeBinary,cwd:ctx.cwd,prompt,model:target.model,effort:target.reasoning,spawnImpl,permissionMode:'plan',ephemeral:true,timeoutMs:180000,invocationContext:callCtx}),{timeoutMs:HANG_SAFETY_CEILING_MS,signal,abortCleanup:()=>awaitOwnedSpawnReaping(signal)});
        if (value?.raw?.is_error === true) throw new ProductionPmBackendError('canonicalizer terminal failed','PM_CANONICALIZER_EXECUTION_FAILED');
        observe(observer,'canonicalizationUsage',callCtx,{token_usage:safeClaudeUsage(value)});
        observe(observer,'terminal',callCtx,{status:'COMPLETED',durationMs:Date.now()-started});
        return value;
      } catch {
        observe(observer,'terminal',callCtx,{status:'FAILED',durationMs:Date.now()-started,error:'PM_CANONICALIZER_EXECUTION_FAILED'});
        throw new ProductionPmBackendError('canonicalizer execution failed','PM_CANONICALIZER_EXECUTION_FAILED');
      }
    };

    const resolutions={
      'claude-code':claudeBinary===undefined?resolveClaudeExecutable():explicitExecutable('claude-code',claudeBinary),
      opencode:openCodeBinary===undefined?resolveOpenCodeExecutable():explicitExecutable('opencode',openCodeBinary),
      codex:codexBinary===undefined?resolveCodexCliExecutable():explicitExecutable('codex',codexBinary),
      grok:grokBinary===undefined?resolveGrokExecutable():explicitExecutable('grok',grokBinary),
      antigravity:antigravityBinary===undefined?resolveAntigravityExecutable():explicitExecutable('antigravity',antigravityBinary),
    };
    this.executableProvenances=new Map(Object.entries(resolutions));
    claudeBinary=resolutions['claude-code'].path??'';openCodeBinary=resolutions.opencode.path??'';codexBinary=resolutions.codex.path??'';grokBinary=resolutions.grok.path??'';antigravityBinary=resolutions.antigravity.path??'';
    // R41-5: per-product cache of the static/slow-changing capability
    // facts (cliInstalled/cliVersion/modelDiscovery/nativeDefaultModel).
    // Populated by every 'full' capability build, reused by 'auto' ones.
    // Lives for this registry instance's lifetime — main.ts constructs
    // exactly one `pmBackendRegistry` singleton, so this is effectively
    // "cached for the Desktop session", cleared only by an app restart.
    this.staticCache=new Map();
    // P10-R0.1.2 Part G/I: `structuredOutputSchema` (from createCliPmDriver's
    // `run(prompt,{ctx,structuredOutputSchema})` — see that function's own
    // docstring) is `null` for every existing caller, so this closure's
    // default behavior is BYTE-FOR-BYTE UNCHANGED unless a caller (today:
    // only council chair_plan via CouncilStepWorkflowRunner) explicitly
    // asks for it. When present, the SCHEMA-VALIDATED native
    // `structured_output` object -- never free-form assistant text --
    // becomes the "output" text handed to the SAME canonical
    // parseDecision() every other backend/call already uses
    // (JSON.stringify() here is Part I's preferred minimal-compatibility
    // strategy: one canonical DSH validation boundary, never a second
    // parser). runClaudeProcess() already throws the typed
    // CLAUDE_STRUCTURED_OUTPUT_MISSING before this line is reached if a
    // schema was requested but the CLI didn't satisfy it, so
    // `value.structuredOutput` is guaranteed present here whenever
    // `structuredOutputSchema` was truthy.
    this.#register({product:'claude-code',transport:'stdio',session_kind:'STATELESS',binary:claudeBinary,probe,capabilities:{modelSelection:true,loginCommandSupported:true,logoutCommandSupported:true,structuredOutput:true,usageTelemetry:false},create:({profile,project,extraCtx,executionOptions})=>createCliPmDriver({profile,project,observer,extraCtx,executionOptions,canonicalize,canonicalization,run:async(prompt,{ctx,structuredOutputSchema,timeoutMs,signal}={})=>{const spawnImpl=withReapedOwnedSpawnLifecycle(withSpawnObservation(nodeSpawn,observer,{...ctx,executable:claudeBinary}),signal);
      // P21.1: generic local CLI execution is trusted by default. This is
      // deliberately independent of the caller's old plan/execute hint so
      // every model registered under Claude inherits the same native mode.
      // The separate tool-less canonicalizer above remains plan/ephemeral.
      const value=await claudeRunner({binary:claudeBinary,cwd:project.repo_path,prompt:constrain('Claude',prompt),model:profile.model??undefined,effort:profile.reasoning??undefined,spawnImpl,jsonSchema:structuredOutputSchema??undefined,timeoutMs:timeoutMs??undefined,permissionMode:'bypassPermissions'});const text=structuredOutputSchema?JSON.stringify(value?.structuredOutput):(value?.result??value?.stdout);observe(observer,'stdoutSummary',ctx,{summary:`assistant result present=${typeof text==='string'&&text.trim()!==''} bytes=${typeof text==='string'?text.length:0}${structuredOutputSchema?' structured_output=true':''}`});return text;}})});this.#register({product:'opencode',transport:'stdio',session_kind:'STATELESS',binary:openCodeBinary,probe,capabilities:{modelSelection:true,loginCommandSupported:true,logoutCommandSupported:true,structuredOutput:true,usageTelemetry:false},create:({profile,project,extraCtx,executionOptions})=>createCliPmDriver({profile,project,observer,extraCtx,executionOptions,canonicalize,canonicalization,run:async(prompt,{ctx,timeoutMs,signal}={})=>{const extraArgs=[...(profile.model?['--model',profile.model]:[]),...(profile.reasoning?['--variant',profile.reasoning]:[]),'--auto'];const constrained=constrain('OpenCode',prompt);const spawnImpl=withReapedOwnedSpawnLifecycle(withSpawnObservation(nodeSpawn,observer,{...ctx,executable:openCodeBinary}),signal);
      // DSH-TIMEOUT-1 Part D (Finding T-3): `timeoutMs` is now ALWAYS
      // forwarded explicitly, floored at this bridge's own pre-existing
      // default — see explicitBridgeTimeoutMs()'s docstring above for the
      // full rationale (Part U's old LONG-only gate is retired; this
      // supersedes it).
      const value=await openCodeRunner({binary:openCodeBinary,cwd:project.repo_path,prompt:constrained,extraArgs,spawnImpl,timeoutMs:explicitBridgeTimeoutMs(timeoutMs,OPENCODE_DEFAULT_TIMEOUT_MS)});observe(observer,'stdoutSummary',ctx,{summary:`stream events=${Array.isArray(value?.events)?value.events.length:0}`});return extractOpenCodeAssistantText(value);}})});this.#register({...CODEX_CLI_CAPABILITIES,binary:codexBinary,probe,create:({profile,project,extraCtx,executionOptions})=>createCliPmDriver({profile,project,observer,extraCtx,executionOptions,canonicalize,canonicalization,run:async(prompt,{ctx,timeoutMs,signal}={})=>{const spawnImpl=withReapedOwnedSpawnLifecycle(withSpawnObservation(nodeSpawn,observer,{...ctx,executable:codexBinary}),signal);
      // DSH-TIMEOUT-1 Part D (Finding T-3): see the OpenCode registration's identical comment above.
      const value=await codexRunner({binary:codexBinary,cwd:project.repo_path,prompt:constrain('Codex',prompt),model:profile.model??undefined,reasoning:profile.reasoning??undefined,spawnImpl,timeoutMs:explicitBridgeTimeoutMs(timeoutMs,CODEX_CLI_DEFAULT_TIMEOUT_MS)});observe(observer,'stdoutSummary',ctx,{summary:`stream events=${Array.isArray(value?.events)?value.events.length:0}`});
      // P10-R0.2.2 Part F/G/H/Q: sandbox readiness/execution classification —
      // purely additive diagnostics, never a gate on the real decision below.
      // `readiness` is a cheap filesystem-only structural check (Part F: no
      // heavy periodic probing, no behavioral test here); `execution` reads
      // the SAME stdout events already captured above (Part H: exit 0 alone
      // never implies task success — this never short-circuits parseDecision
      // /normalizePmDecision, it only reports evidence alongside them).
      const readiness=probeCodexWindowsSandboxHelper(codexBinary);
      const execution=classifyCodexSandboxExecution(value);
      const sandboxState=execution.helperExecution==='FAILED'?'FAILED':readiness.sandboxReadiness;
      observe(observer,'sandbox',ctx,{state:sandboxState,failureCode:execution.sandboxFailureCode,helperResolution:readiness.helperResolution,helperExecution:execution.helperExecution});
      return extractCodexAssistantText(value);}})});this.#register({...GROK_CLI_CAPABILITIES,binary:grokBinary,probe,create:({profile,project,extraCtx,executionOptions})=>createCliPmDriver({profile,project,observer,extraCtx,executionOptions,canonicalize,canonicalization,run:async(prompt,{ctx,timeoutMs,signal}={})=>{const spawnImpl=withReapedOwnedSpawnLifecycle(withSpawnObservation(nodeSpawn,observer,{...ctx,executable:grokBinary}),signal);
      // DSH-TIMEOUT-1 Part D (Finding T-3): see the OpenCode registration's identical comment above.
      const value=await grokRunner({binary:grokBinary,cwd:project.repo_path,prompt:constrain('Grok',prompt),model:profile.model??undefined,reasoning:profile.reasoning??undefined,spawnImpl,timeoutMs:explicitBridgeTimeoutMs(timeoutMs,GROK_CLI_DEFAULT_TIMEOUT_MS)});observe(observer,'stdoutSummary',ctx,{summary:`output present=${typeof value?.output?.text==='string'&&value.output.text.trim()!==''}`});return extractGrokAssistantText(value);}})});
    // P9-R0: fifth production PM backend — Google Antigravity CLI (agy).
    this.#register({...ANTIGRAVITY_CLI_CAPABILITIES,binary:antigravityBinary,probe,create:({profile,project,extraCtx,executionOptions})=>createCliPmDriver({profile,project,observer,extraCtx,executionOptions,canonicalize,canonicalization,run:async(prompt,{ctx,timeoutMs,signal,structuredOutputSchema}={})=>{
      // P9-R0.1 Part B/C/L: gather the small, host-side, already-safe
      // context packet BEFORE spawning agy — async/bounded (P6.5), never
      // on Electron main (this closure only ever runs inside the runtime
      // child process — see p5-production-composition.mjs). Observed as
      // its own CONTEXT event so a context-fed run is distinguishable from
      // a bare one in Backend Execution without exposing the packet text.
      const{gitFacts}=await gatherAntigravityContextFacts({project,spawnImpl:nodeSpawn});
      const finalPrompt=constrain('Antigravity',buildAntigravityPrompt({prompt,project,profile,extraCtx,gitFacts}));
      // P9-R0.3 Part I: safe, non-noisy observability of the new argv
      // decision — effortForwarded is always false for production
      // Antigravity execution (see the antigravityRunner call below);
      // never falsely implies --effort is sent alongside the profile's
      // displayed model/reasoning.
      observe(observer,'context',ctx,{projectFacts:true,councilEvidence:Boolean(extraCtx&&extraCtx.role),bytes:finalPrompt.length,effortForwarded:false});
      const spawnImpl=withReapedOwnedSpawnLifecycle(withSpawnObservation(nodeSpawn,observer,{...ctx,executable:antigravityBinary}),signal);
      // P9-R0.3 Part B/C: production execution never forwards
      // profile.reasoning as --effort — live-proven (docs/p9/06) that for
      // every current model family, doing so is either fully redundant
      // (Gemini/GPT-OSS: the model slug's own tier suffix already IS the
      // reasoning tier, and omitting --effort behaves identically to
      // matching it) or an unconditional CLI rejection (Claude: --effort
      // is never supported, regardless of value). profile.reasoning
      // itself is NOT removed from the schema (P8 invariant) — it stays
      // the profile's stored, historically-meaningful metadata; it is
      // simply no longer sent to the CLI. runAntigravityCliProcess's own
      // `reasoning` parameter is untouched and still fully functional —
      // this is a production-call-site decision, not a bridge capability
      // removal (scripts/p9-antigravity-model-effort-probe.mjs and tests
      // still exercise --effort directly).
      // DSH-TIMEOUT-1 Part D (Finding T-3): see the OpenCode registration's identical comment above.
      const value=await antigravityRunner({binary:antigravityBinary,cwd:project.repo_path,prompt:finalPrompt,model:profile.model??undefined,...(structuredOutputSchema?{structuredOutputSchema}:{}),spawnImpl,timeoutMs:explicitBridgeTimeoutMs(timeoutMs,ANTIGRAVITY_DEFAULT_TIMEOUT_MS),mode:'accept-edits',dangerouslySkipPermissions:true});
      observe(observer,'stdoutSummary',ctx,{summary:`stream events=${Array.isArray(value?.events)?value.events.length:0} status=${value?.result?.status??'none'}`});
      try{
        const text=extractAntigravityAssistantText(value,{structuredOutputSchema});
        observe(observer,'context',ctx,{outputSource:structuredOutputSchema?'result.structured_output':'result.response'});
        return text;
      }
      catch(error){if(error?.code==='ANTIGRAVITY_TOOL_DENIED')observe(observer,'toolDenied',ctx,{tool:error.tool,reason:error.reason});throw error;}
    }})});
    // P11-R0: sixth production PM backend — generic HTTP API. `binary:null`
    // — there is no CLI to resolve/spawn; `probe:()=>true` — this
    // REGISTRATION is always structurally available (the `api` backend
    // CLASS always exists once P11 ships), independent of whether any
    // provider is actually configured/keyed. Per-provider readiness
    // (missing config, missing key, unreachable, ...) is a DISPATCH-TIME
    // concern handled inside `run()` below and surfaced as a typed
    // ApiBackendError (API_PROVIDER_CONFIG_INVALID / API_SECRET_MISSING /
    // ...) for the ONE task that used that provider — never a registration-
    // level gate that would make the whole `api` product unavailable
    // because ONE provider is misconfigured (spec
    // "FAILURE_OF_ONE_PROVIDER_MARKS_ALL_BACKENDS_FAILED" is a STOP
    // condition).
    this.#register({product:'api',transport:'http',session_kind:'STATELESS',binary:null,probe:()=>true,capabilities:{modelSelection:true,loginCommandSupported:false,logoutCommandSupported:false,structuredOutput:false,usageTelemetry:true},create:({profile,project,extraCtx,executionOptions})=>createCliPmDriver({profile,project,observer,extraCtx,executionOptions,canonicalize,canonicalization,run:async(prompt,{ctx,timeoutMs,signal}={})=>{
      const text=await apiRunner({providerId:profile.provider,model:profile.model??undefined,reasoning:profile.reasoning??undefined,modelReasoningSupport:this.apiModelCapabilities.get(`${profile.provider}:${profile.model}`)??'UNKNOWN',prompt,providers:apiProviders,env:apiEnv,fetchImpl:apiFetch,timeoutMs:timeoutMs??undefined,externalSignal:signal,observe:(method,payload)=>observe(observer,method,ctx,payload)});
      observe(observer,'stdoutSummary',ctx,{summary:`assistant result present=${typeof text==='string'&&text.trim()!==''} bytes=${typeof text==='string'?text.length:0} provider=${profile.provider??'unknown'}`});
      return text;
    }})});
  }
  #register(value){this.backends.set(key(value),Object.freeze(value));}
  list(){return SUPPORTED.map(v=>({...v}));}
  executableProvenance(product){return this.executableProvenances.get(product)??null;}
  inspect(profile){const backend=this.backends.get(key(profile));if(!backend)return Object.freeze({available:false,code:profile?.session_kind==='NATIVE_SESSION'?'PM_NATIVE_SESSION_UNAVAILABLE':'PM_BACKEND_UNSUPPORTED',product:profile?.product??null,transport:profile?.transport??null,session_kind:profile?.session_kind??null});let available=false;try{available=backend.probe(backend.binary,backend.product)===true;}catch{}const provenance=this.executableProvenances.get(profile.product);const unavailableCode=!available&&provenance?.code?provenance.code:'PM_BACKEND_UNAVAILABLE';return Object.freeze({available,code:available?null:unavailableCode,product:profile.product,transport:profile.transport,session_kind:profile.session_kind});}
  // P7 Part W: `extraCtx` is an optional plain object of observability
  // correlation fields (e.g. councilId/phase/round/role) merged into every
  // execution's ctx for this one resolve() call. Purely additive/optional —
  // every existing caller that omits it is unaffected (createCliPmDriver
  // defaults it to {}), and it never changes profile/backend resolution.
  // P10-R0.2.1 Part B: `executionOptions` (from pm-execution-timeout-
  // policy.mjs's resolveExecutionOptions()) is a SEPARATE, explicit
  // execution-policy seam — never folded into `extraCtx`, which stays
  // observability-only. `{timeoutMs,stage}`, optional; every existing
  // caller that omits it is unaffected (createCliPmDriver defaults it to
  // `{}`, and only the claude-code backend below reads `.timeoutMs` at
  // all — see Part E).
  resolve(profile,{project,extraCtx,executionOptions}={}){const availability=this.inspect(profile);if(!availability.available)throw new ProductionPmBackendError('configured PM backend is unavailable',availability.code,{product:availability.product,transport:availability.transport,session_kind:availability.session_kind});if(!project?.repo_path)throw new ProductionPmBackendError('PM project repository is unavailable','PM_PROJECT_UNAVAILABLE');return this.backends.get(key(profile)).create({profile,project,extraCtx,executionOptions});}
  // P6-W3-R4 Part A/E/F/G: `authReady:'UNKNOWN'` (a fixed value for every
  // backend, regardless of real auth state — see A1) is replaced by real,
  // per-backend authProbe/authState evidence from a safe non-mutating CLI
  // probe (src/pm/pm-connection-probe.mjs), plus model discovery and
  // reasoning-effort capability truth.
  //
  // P6-W3-R4.1 Part R41-3/R41-5: `capabilities({mode})` probes all four
  // backends (Refresh All / the self-scheduling auto tick); `capability
  // (product, {mode})` probes exactly one (per-card Refresh, and the
  // Login/Logout-triggered single-product refresh) — a per-card Refresh
  // never touches the other three backends' CLIs. `mode:'auto'` (the
  // periodic tick) reuses this instance's cached static facts
  // (cliInstalled/cliVersion/modelDiscovery/nativeDefaultModel) instead of
  // re-probing them, and skips each product's heavier secondary spawn
  // (see pm-connection-probe.mjs) — only the always-fresh auth fields are
  // re-probed on 'auto'. `mode:'full'` (the default) always re-probes
  // everything and refreshes the cache. Every spawn this reaches is
  // timeout-bounded (connectionProbe's own timeoutMs, plus probeVersion's
  // below) so one hung CLI can only ever degrade that one backend's card
  // to UNKNOWN, never hang the whole call or block another backend's
  // probe.
  // P6.5 Part A/B/C: async now (was sync/spawnSync-based) — Electron main
  // process forensics found every capabilities()/capability() call
  // blocking the whole main event loop for the full duration of every
  // probe it ran (docs/p6/26_P6_5_DESKTOP_RESPONSIVENESS.md). All I/O
  // below is spawn()+Promise based; awaiting these methods never stalls
  // the caller's event loop. capabilities() also now probes all four
  // backends in parallel (Promise.all) rather than sequentially, which is
  // both faster and a direct consequence of no longer needing to avoid
  // overlapping synchronous blocking calls.
  async capabilities({mode='full'}={}){const checkedAt=new Date().toISOString();return Promise.all([...this.backends.values()].map(value=>this.#buildCapability(value,mode,checkedAt)));}
  async capability(product,{mode='full'}={}){const checkedAt=new Date().toISOString();const value=[...this.backends.values()].find(v=>v.product===product);if(!value)return Object.freeze(unsupportedProductCapability(product,checkedAt));return this.#buildCapability(value,mode,checkedAt);}
  async #buildCapability(value,mode,checkedAt){
    // P11-R0: 'api' has no CLI to install/spawn — the generic installed-
    // probe/spawn-based pipeline below (borrowed wholesale from the CLI
    // backends) would misreport it as "CLI not installed" every time.
    // Provider/secret readiness is a SEPARATE, zero-network, synchronous
    // check (api-provider-readiness.mjs's synchronousReadiness) — no
    // periodic/automatic live HTTP probing here (spec "CONNECTION CENTER:
    // ... No periodic API polling" / "Do not perform paid generation just
    // to test health"); live per-provider reachability is exposed
    // separately via `probeApiProviderLive()` for an explicit, manual
    // refresh action (not wired to Desktop UI in R0 — see
    // docs/p11/02_P11_R0_API_BACKEND_ARCHITECTURE_SONNET5.md).
    if(value.product==='api')return Object.freeze(this.#buildApiCapability(checkedAt));
    const cached=this.staticCache.get(value.product)??{};
    const useCache=mode==='auto'&&cached.installed!==undefined;
    let installed,version;
    if(useCache){installed=cached.installed;version=cached.version;}
    else{const probed=await safeInstalledProbe(this.installedProbe,value.binary,value.product);installed=probed.installed;version=probed.version;}
    const reasoning=reasoningCapabilityFor(value.product);
    if(!installed){
      this.staticCache.set(value.product,{installed:false,version:null,modelDiscovery:null,nativeDefaultModel:null});
      return Object.freeze(shapeCapability(value,{installed:false,version:null,facts:unavailableConnectionFacts('CLI not installed'),reasoning,checkedAt}));
    }
    const facts=await safeConnectionProbe(this.connectionProbe,value.product,value.binary,mode);
    // R41-5: a 'auto' probe deliberately returns modelDiscovery.supported
    // false / nativeDefaultModel null for whatever it skipped — fall back
    // to the last 'full' probe's cached value rather than blanking the UI
    // every periodic tick.
    const modelDiscovery=facts.modelDiscovery?.supported?facts.modelDiscovery:(cached.modelDiscovery??facts.modelDiscovery);
    const nativeDefaultModel=facts.nativeDefaultModel??cached.nativeDefaultModel??null;
    this.staticCache.set(value.product,{installed:true,version,modelDiscovery,nativeDefaultModel});
    return Object.freeze(shapeCapability(value,{installed:true,version,facts:{...facts,modelDiscovery,nativeDefaultModel},reasoning,checkedAt}));
  }
  // P11-R0: 'api' capability shape — honest for an HTTP backend rather than
  // force-fit into the CLI-oriented `shapeCapability()`. `dshBackendAvailable`
  // is always `true` (the backend CLASS is always registered — see the
  // constructor's `#register` call above); it does NOT mean any provider is
  // ready to run, which is exactly why `providers` (per-provider, zero-
  // network CONFIGURED/KEY_PRESENT truth) is a separate, additive array a
  // caller must read to know per-provider readiness — never collapsed into
  // one global boolean (spec "Do not collapse provider-specific status into
  // one global red API state").
  #buildApiCapability(checkedAt){
    const providers=Object.values(this.apiProviders).map(entry=>synchronousReadiness(entry,this.apiEnv));
    return{product:'api',transport:'http',cliInstalled:null,cliVersion:null,dshBackendAvailable:true,sessionKinds:['STATELESS'],modelSelection:true,loginCommandSupported:false,logoutCommandSupported:false,structuredOutput:false,usageTelemetry:true,authProbe:'NOT_APPLICABLE',authState:providers.length?'SEE_PROVIDERS':'UNCONFIGURED',authDetail:providers.length?`${providers.length} provider(s) configured — see providers[]`:'no API providers configured',authCheckedAt:checkedAt,nativeDefaultModel:null,modelDiscovery:Object.freeze({supported:false,models:null,source:'explicit per-PM-profile model, not discovered'}),reasoning:Object.freeze({selection:'PROVIDER_DEPENDENT',levels:null,flag:null,source:'reasoning-effort support varies per API provider — see api-provider-capabilities.mjs'}),providers:Object.freeze(providers)};
  }
  // P11-R0: ONE live, explicit, manual-refresh-only probe for a single
  // configured provider (spec "manual refresh only. No periodic API
  // polling"). Never called automatically by capabilities()/capability()
  // above — a caller (a future Connection Center "Refresh" action) invokes
  // this directly. Returns the same shape synchronousReadiness() does, plus
  // a live-verified `status`; an unconfigured provider id degrades to
  // `null` rather than throwing (read-only diagnostic, never a hard error).
  async probeApiProviderLive(providerId){
    const entry=this.apiProviders?.[providerId];
    if(!entry)return null;
    return probeApiProviderReadiness(entry,{env:this.apiEnv,fetchImpl:this.apiFetch});
  }
  async discoverApiProviderModels(providerId){
    const entry=this.apiProviders?.[providerId];
    if(!entry)return Object.freeze({ok:false,code:'API_PROVIDER_CONFIG_INVALID',message:'API provider is not configured'});
    const result=await discoverApiProviderModels(entry,{env:this.apiEnv,fetchImpl:this.apiFetch});
    if(result.ok)for(const model of result.models)this.apiModelCapabilities.set(`${providerId}:${model.id}`,model.reasoningSupport);
    return result;
  }
}
function shapeCapability(value,{installed,version,facts,reasoning,checkedAt}){return {product:value.product,transport:value.transport,cliInstalled:installed,cliVersion:version,dshBackendAvailable:installed,sessionKinds:[value.session_kind],modelSelection:value.capabilities?.modelSelection??value.modelSelection??false,loginCommandSupported:value.capabilities?.loginCommandSupported??value.loginCommandSupported??false,logoutCommandSupported:value.capabilities?.logoutCommandSupported??value.logoutCommandSupported??false,structuredOutput:value.capabilities?.structuredOutput??value.structuredOutput??false,usageTelemetry:value.capabilities?.usageTelemetry??value.usageTelemetry??false,authProbe:facts.authProbe,authState:facts.authState,authDetail:facts.authDetail,authCheckedAt:checkedAt,nativeDefaultModel:facts.nativeDefaultModel,modelDiscovery:Object.freeze({...facts.modelDiscovery}),reasoning:Object.freeze({selection:reasoning.selection,levels:reasoning.levels,flag:reasoning.flag,source:reasoning.source,labels:reasoning.labels??null})};}
// R41-3: an unknown/unsupported product must fail closed — a typed,
// honest UNSUPPORTED/UNKNOWN shape, never a throw the IPC layer would have
// to translate, and never silently probing a renderer-supplied product
// string against some fallback backend.
function unsupportedProductCapability(product,checkedAt){return {product:product??null,transport:null,cliInstalled:false,cliVersion:null,dshBackendAvailable:false,sessionKinds:[],modelSelection:false,loginCommandSupported:false,logoutCommandSupported:false,structuredOutput:false,usageTelemetry:false,authProbe:'UNSUPPORTED',authState:'UNKNOWN',authDetail:'unsupported product',authCheckedAt:checkedAt,nativeDefaultModel:null,modelDiscovery:{supported:false,models:null,source:'unsupported product'},reasoning:{selection:'UNKNOWN',levels:null,flag:null,source:null}};}

// P12-R5B Part C/F/H — the generic terminalization backstop.
//
// Root cause (docs/p12/06B_P12_R5B_TERMINALIZATION_AND_RECONCILIATION_REMEDIATION_SONNET5.md):
// a real owner-live Council participant_report against Codex left this
// exact `run(...)` await pending indefinitely — BACKEND_LIVENESS_STATE
// observed the child process EXITED, but the bridge's own promise never
// settled (no TASK_COMPLETED, no TASK_FAILED, ever). Only Claude's bridge
// closure forwards `executionOptions.timeoutMs`; every other backend's own
// bridge-level default (Codex/OpenCode/Grok 180s, Antigravity 300s) is a
// SEPARATE, uncoordinated timer that is supposed to be a safety net but, in
// this live case, never fired (or its rejection never propagated) —
// whichever the exact mechanism, the orchestration layer had NO independent
// backstop of its own and waited forever.
//
// `input.signal` (already threaded down here by every real caller —
// DurablePmRuntime's own decide() loop, its SINGLE_WORKFLOW_STEP delegation,
// and CouncilStepWorkflowRunner's per-step decide() — see each caller's own
// `signal:` argument) was never read at all by this function before, so a
// genuine owner shutdown/cancel (SIGINT/SIGTERM/pipe SHUTDOWN, or a real
// REQUEST_CANCEL, all of which abort the SAME AbortController) had zero
// effect on an in-flight backend call — this is also the exact reason the
// runtime's own graceful stop hung ("Process exit timeout") and needed a
// force-stop.
//
// The fix is ONE generic guard at this ONE shared point every backend's
// driver is built from — never a per-bridge rewrite (Part C: "fix
// generically", Part E: "shared boundary, not profile/model-specific"):
// every `run(...)` call now races against (a) the owner-requested abort
// signal, settling IMMEDIATELY, and (b) a bounded watchdog timer. The
// watchdog bound is the LARGER of this stage's own orchestration-policy
// timeout and a fixed safety ceiling comfortably above every backend's own
// existing internal default — so it can NEVER fire before a healthy
// backend's own timeout would have (zero behavior change for anything that
// already completes normally); it only ever matters when a backend's own
// internal handling fails to settle at all, which is exactly this bug.
//
// R7.2 additionally binds that same signal to the exact child returned by
// each CLI bridge's spawn call (withReapedOwnedSpawnLifecycle above). R7.3
// makes this race await the exact invocation's bounded OS reaping before it
// settles abort, so Desktop never has to reclaim an orphan with Force Stop.
export const HANG_SAFETY_CEILING_MS = 600_000;
export function watchdogTimeoutMs(executionOptions) {
  const policyMs = Number.isFinite(executionOptions?.timeoutMs) ? executionOptions.timeoutMs : 0;
  return Math.max(policyMs, HANG_SAFETY_CEILING_MS);
}
export function raceWithWatchdog(promise, { timeoutMs, signal, abortCleanup } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let aborting = false;
    let timer = null;
    function cleanup() {
      if (timer) clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
    }
    function settle(fn, value) {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    }
    async function onAbort() {
      if (settled || aborting) return;
      aborting = true;
      try { await abortCleanup?.(); } catch { /* cleanup is bounded/best-effort */ }
      settle(reject, new ProductionPmBackendError('backend execution aborted (shutdown/cancellation requested)', 'PM_BACKEND_ABORTED'));
    }
    if (signal && typeof signal.addEventListener === 'function') {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    // DSH-TIMEOUT-1 Part E (audit Finding T-4): the watchdog firing is
    // exactly the pathological "a backend's own bridge-level timeout never
    // fired, or its rejection never propagated" case this function exists
    // for (see this function's own module-level docstring, P12-R5B) — and
    // TIMEOUT-0 proved it was the ONE case with NO cleanup at all, because
    // only the signal-abort branch above ever called `abortCleanup`. This
    // now awaits the exact same `abortCleanup` before settling, reusing
    // `onAbort()`'s own `aborting` in-flight guard so the underlying
    // `promise` racing this timer can never sneak a late resolve/reject
    // through while cleanup is still pending — never a silently-orphaned
    // owned process tree just because the watchdog, not the signal, was
    // the layer that noticed.
    async function onWatchdogFire() {
      if (settled || aborting) return;
      aborting = true;
      try { await abortCleanup?.(); } catch { /* cleanup is bounded/best-effort */ }
      settle(reject, new ProductionPmBackendError(`backend execution exceeded the orchestration watchdog (${timeoutMs}ms)`, 'PM_ORCHESTRATION_WATCHDOG_TIMEOUT', { timeoutMs }));
    }
    timer = setTimeout(() => { void onWatchdogFire(); }, timeoutMs);
    promise.then(
      (value) => { if (!aborting) settle(resolve, value); },
      (error) => { if (!aborting) settle(reject, error); },
    );
  });
}

// P6-W3-R3 Part B: `observer` is optional and purely observational — see
// BackendExecutionObserver's docstring. `run(prompt, {ctx})` receives the
// same identity `ctx` (backendProduct/profileId/projectId/cwd/model/
// requestId/runId) the START/PARSER/TERMINAL events below use, so every
// event for one decide() call correlates without re-deriving identity
// per call site.
// P10-R0.2.1 Part B: `executionOptions` (`{timeoutMs,stage}`, from
// pm-execution-timeout-policy.mjs's resolveExecutionOptions() via each
// orchestration call site) is a SEPARATE, explicit execution-policy input
// — never folded into `extraCtx` (observability-only, per its own
// docstring below). `undefined`/`{}` for every caller that omits it, so
// this is byte-for-byte backward compatible for any existing direct
// createCliPmDriver() caller (e.g. test doubles) that never supplies it.
export function createCliPmDriver({profile,project,run,observer,extraCtx,executionOptions,canonicalize,canonicalization}){if(typeof run!=='function')throw new TypeError('PM CLI runner is required');return Object.freeze({name:`production:${profile.product}:${profile.id}`,async decide(input){
  const requestId=input?.request?.id??null;
  // P7 Part W: extraCtx (councilId/phase/round/role, when this decide() call
  // is one council step) is spread last so it can only ADD correlation
  // fields — it can never override the identity fields derived from
  // profile/project/requestId above. `stage` (Part N) is set from
  // executionOptions BEFORE that spread so extraCtx's own `phase` field
  // (council steps) stays independent — `stage` is always the timeout
  // policy's own vocabulary (pm-execution-timeout-policy.mjs's
  // EXECUTION_STAGE, identical strings to council stepKind), never
  // re-derived from `phase`.
  const ctx={backendProduct:profile.product,profileId:profile.id,projectId:project.id??null,cwd:project.repo_path??null,model:profile.model??null,requestId,runId:requestId,stage:executionOptions?.stage??null,...(extraCtx&&typeof extraCtx==='object'?extraCtx:{})};
  const startedAt=Date.now();
  observe(observer,'start',ctx);
  // P10-R0.1.2 Part G/K: `input.structuredOutput` is an EXPLICIT, typed,
  // OPTIONAL sibling field on the decide() call contract — analogous to
  // the existing `capabilities` field, never a repurposing of `extraCtx`
  // (observability-only, per its own docstring above) and never folded
  // into `request.context` (which renderRequest() below inlines VERBATIM
  // into the rendered prompt text — a JSON Schema object does not belong
  // there). `null`/absent for every caller that doesn't ask for it
  // (today: everything except council chair_plan+claude-code — see
  // council-step-workflow-runner.mjs) — each `run()` closure decides for
  // itself whether it understands `structuredOutputSchema` at all; only
  // the claude-code registration below does anything with it.
  // PM24 remediation: a generic SINGLE-PM decision is a union of four
  // mutually-exclusive shapes (finish/workflow/peer_exchange/await_owner —
  // see pm-decision-schema.mjs), which buildPmDecisionJsonSchema() can only
  // express as a top-level `oneOf`. Live-reproduced against the owner's
  // installed CLI (2.1.261): Claude Code's `--json-schema` is implemented
  // as an Anthropic Messages API tool `input_schema`, and that API rejects
  // `oneOf`/`allOf`/`anyOf` at the schema's top level outright —
  // `API Error: 400 tools.N.custom.input_schema: input_schema does not
  // support oneOf, allOf, or anyOf at the top level` — exit 1 before any
  // real generation happens (this is CLAUDE_EXIT_FAILED, ~1.2KB stdout,
  // ~2-3s). There is no schema-only fix: a union of variants with
  // per-variant `required` fields cannot be flattened into one Anthropic
  // tool schema without oneOf/anyOf. So — unlike the council chair_plan
  // schema (a single flat object shape, still valid and still used below)
  // — a generic PM decision is never given a native schema; only an
  // explicitly supplied one (chair_plan) is honored, exactly as before
  // this schema module existed.
  const structuredOutputRequest=input?.structuredOutput??null;
  const structuredOutputSchema=structuredOutputRequest?.schema??null;
  let output;
  try{
    // P10-R0.2.1 Part E/H: `timeoutMs` rides alongside `structuredOutputSchema`
    // as another explicit, OPTIONAL sibling field every `run()` closure may
    // read — today only the claude-code registration above forwards it to
    // its bridge; every other backend's closure destructures `{ctx}` only
    // and silently ignores it (Part E: backend-neutral seam, not
    // backend-neutral enforcement — see this file's registration block).
    // P12-R5B Part C/F/H: every run() call is now raced against the
    // generic watchdog above — see its docstring. `input.signal` is the
    // SAME AbortSignal DurablePmRuntime/CouncilStepWorkflowRunner already
    // pass into every decide() call; it was simply never read here before.
    output=await raceWithWatchdog(
      run(renderRequest(input,profile,project),{ctx,requestId,turn:input?.turn,structuredOutputSchema,timeoutMs:executionOptions?.timeoutMs??null,signal:input?.signal}),
      { timeoutMs: watchdogTimeoutMs(executionOptions), signal: input?.signal, abortCleanup: () => awaitOwnedSpawnReaping(input?.signal) },
    );
  }catch(error){
    // P10-R0.2.1 Part K/N: a distinct BACKEND_TIMEOUT diagnostic event,
    // ahead of (never instead of) the existing generic 'terminal' FAILED
    // event below — detected structurally (any `*_TIMEOUT` typed code:
    // CLAUDE_TIMEOUT today, and the same convention every other bridge's
    // own timeout error already uses — codex-cli-session-bridge.mjs,
    // grok-cli-session-bridge.mjs, opencode-cli-session-bridge.mjs,
    // antigravity-cli-session-bridge.mjs), never a hardcoded
    // `product==='claude-code'` branch. Every field defaults to `null`/
    // `false` when the throwing bridge doesn't carry that depth (Part E:
    // only claude-code-session-bridge.mjs does today) — this never invents
    // evidence a bridge didn't actually report.
    if(typeof error?.code==='string'&&error.code.endsWith('_TIMEOUT')){
      observe(observer,'timeout',ctx,{
        timeoutMs:error.timeoutMs??executionOptions?.timeoutMs??null,elapsedMs:error.elapsedMs??null,
        processPid:error.processPid??null,stdoutBytes:error.stdoutBytes??null,stderrBytes:error.stderrBytes??null,
        assistantOutputPresent:error.assistantOutputPresent??null,terminationRequested:error.terminationRequestedByDsh===true,
      });
    }
    // PARSER-0 (Goal C/J): the real execution path proves parseDecision was
    // never reached here — so a provider/transport/terminal failure with no
    // assistant output is recorded as parser_attempted=false /
    // parser_state=NOT_ATTEMPTED (L1_EXECUTION), never as a model JSON parse
    // failure. Public error codes are unchanged; the diagnostic travels both
    // as a new observer event and (additively) on the thrown error so the
    // Council attempt ledger can copy the truth from the real boundary.
    const attemptOrdinal=Number.isInteger(ctx.attempt)?ctx.attempt:null;
    if(typeof error==='object'&&error!==null&&!error.layeredDiagnostic){
      error.layeredDiagnostic=executionFailureDiagnosticFromError(error,{structuredOutputRequested:Boolean(structuredOutputSchema),attemptOrdinal});
      observe(observer,'layeredDiagnostic',ctx,error.layeredDiagnostic);
    }
    observe(observer,'terminal',ctx,{status:'FAILED',durationMs:Date.now()-startedAt,error:error?.code??error?.message??'PROCESS_ERROR'});
    throw error;
  }
  const bytes=typeof output==='string'?output.length:0;
  // DSH-T5-DEBUG-EVIDENCE-AND-MULTI-DECISION (Part B): OFF by default
  // (rawEvidenceCaptureConfig() reads DSH_T5_RAW_EVIDENCE_CAPTURE, unset ->
  // disabled). When disabled, `rawEvidence` stays `null` and nothing below
  // that reads it ever runs — zero behavior change, zero extra bytes
  // computed or retained, exactly the pre-existing default.
  const rawEvidenceEnabled=rawEvidenceCaptureConfig().enabled;
  const rawEvidence=rawEvidenceEnabled&&typeof output==='string'?{
    bytes:Buffer.byteLength(output,'utf8'),
    sha256:createHash('sha256').update(output,'utf8').digest('hex'),
    // The COMPLETE visible text handed to parseDecision() — for a native-
    // schema backend (e.g. Antigravity) this IS `JSON.stringify(result.
    // structured_output)` verbatim (see extractAntigravityAssistantText()),
    // so this single field already captures "structured_output visible
    // content" for that path with no separate bridge plumbing needed.
    text:output,
    structured_output_requested:Boolean(structuredOutputSchema),
  }:null;
  try{
    const decision=await acceptPmOutput({output,parse:parseDecision,validateContract:normalizePmDecision,invoke:canonicalize,config:canonicalization,ctx,signal:input?.signal,depth:input?.canonicalizationDepth??0,
      contract:{step_kind:input?.request?.context?.stepKind??ctx.stage,schema:structuredOutputSchema??buildPmDecisionJsonSchema(input?.capabilities)},
      emit:diagnostic=>observe(observer,'canonicalization',ctx,diagnostic)});
    if(rawEvidence)rawOutputEvidenceMap.set(decision,rawEvidence);
    // PARSER-0 (Goal D): parseDecision() was really called and really
    // accepted — parser_attempted=true, parser_state=PASS. This is NOT a
    // full PM-contract/Council-semantic verdict: those run downstream, so
    // pm_contract_state/step_validation_state stay NOT_EVALUATED here.
    observe(observer,'layeredDiagnostic',ctx,parserOutcomeDiagnostic({state:'PASS',bytes,structuredOutputRequested:Boolean(structuredOutputSchema),structuredOutputPresent:structuredOutputSchema?true:null,attemptOrdinal:Number.isInteger(ctx.attempt)?ctx.attempt:null}));
    // P10-R0.2.2 Part I-M: bounded await_owner contract repair — SINGLE
    // owner tasks only (`ctx.stage===EXECUTION_STAGE.OWNER_SINGLE`). A
    // council step's own validator already rejects any non-finish
    // decision outright (council-step-workflow-runner.mjs's
    // `#validateDecideResult`), so an await_owner decision never reaches
    // council step validation in the first place — this branch never
    // fires during council execution, T1-regression-safe. Reuses the REAL
    // normalizePmDecision() (pm-contracts.mjs) as the ONE validity check
    // — never a second, parallel, possibly-drifting reimplementation of
    // the await_owner shape rules (Part I: "strict validator remains
    // authoritative" — normalizePmDecision itself is never modified).
    if(decision.type==='await_owner'&&ctx.stage===EXECUTION_STAGE.OWNER_SINGLE){
      const resolved=await resolveAwaitOwnerContract({decision,bytes,run,ctx,requestId,turn:input?.turn,structuredOutputSchema,timeoutMs:executionOptions?.timeoutMs??null,originalPrompt:renderRequest(input,profile,project)});
      observe(observer,'awaitOwnerContract',ctx,resolved.diagnostics);
      if(!resolved.ok)throw resolved.error;
      observe(observer,'parser',ctx,{outcome:'OK',bytes:resolved.bytes});
      observe(observer,'terminal',ctx,{status:'DECIDED',durationMs:Date.now()-startedAt});
      if(rawEvidence)rawOutputEvidenceMap.set(resolved.decision,rawEvidence);
      return resolved.decision;
    }
    observe(observer,'parser',ctx,{outcome:'OK',bytes});
    observe(observer,'terminal',ctx,{status:decision.type==='finish'?'COMPLETED':'DECIDED',durationMs:Date.now()-startedAt});
    return decision;
  }catch(error){
    // P7-R0.2 Part I: on a parse failure specifically (never on
    // PM_DECISION_EMPTY_OUTPUT, which is already a fully-diagnosed case),
    // emit sanitized STRUCTURAL diagnostics — never the raw assistant text
    // itself — so a future live parse failure is debuggable from Backend
    // Execution alone, without needing a manual repro. See
    // parseDiagnostics() below for exactly what is/isn't included.
    const diagnostics=error?.code==='PM_DECISION_PARSE_FAILED'?parseDiagnostics(output):null;
    // DSH-T5-DEBUG-EVIDENCE-AND-MULTI-DECISION (Part B): the SAME opt-in
    // bundle as the success path above, additive on the thrown error —
    // "Capture evidence for BOTH: successful ... and failed ... generations".
    if(rawEvidence)error.rawOutputEvidence=rawEvidence;
    // PARSER-0 (Goal C/D): parseDecision() was really called and really
    // rejected — parser_attempted=true, parser_state=FAIL, with the stable
    // public error code and sanitized subreason beside it. The diagnostic
    // also rides on the thrown error (additive) so downstream attempt
    // ledgers never have to re-derive parser truth from the error code.
    const layeredDiagnostic=parserOutcomeDiagnostic({state:'FAIL',bytes,errorCode:error?.code??null,parseSubreason:error?.parseSubreason??null,structuredOutputRequested:Boolean(structuredOutputSchema),structuredOutputPresent:structuredOutputSchema?false:null,attemptOrdinal:Number.isInteger(ctx.attempt)?ctx.attempt:null});
    error.layeredDiagnostic=layeredDiagnostic;
    observe(observer,'layeredDiagnostic',ctx,layeredDiagnostic);
    observe(observer,'parser',ctx,{outcome:error?.code??'PARSE_FAILED',bytes,...(diagnostics??{})});
    observe(observer,'terminal',ctx,{status:'FAILED',durationMs:Date.now()-startedAt,error:error?.code??error?.message??'DECISION_ERROR'});
    // P10-R0.1.1 Part A/B/H: the SAME already-computed sanitized structural
    // diagnostics also travel with the thrown error itself (never only to
    // the BackendExecutionObserver's separate stdout-sentinel channel) —
    // this is what actually closed the "why did PM_DECISION_PARSE_FAILED
    // happen" gap: a live owner failure (task-D5PT4CbNpjeUamnegQDN6kvM34w3NMdo)
    // showed the parser correctly rejecting Claude's output twice, but
    // nothing downstream of parseDecision() could see WHY beyond the bare
    // code, because these facts previously reached only the Desktop
    // execution-log ring buffer, never the task-scoped diagnostic bundle a
    // council step's caller (CouncilStepWorkflowRunner) actually persists.
    // Strictly additive to the Error object; parseDecision()'s accept/
    // reject boundary is byte-for-byte unchanged (Part C: no heuristic
    // salvage — this only reports facts already computed, never widens
    // what is accepted).
    if(diagnostics){error.diagnostics=diagnostics;error.parseSubreason=error.parseSubreason??classifyParseSubreason(diagnostics);}
    throw error;
  }
}});}
// B4: every observer call in this file goes through here, never bare
// optional-chained calls — `observer?.start?.(ctx)` only guards a missing
// observer/method, not one whose implementation itself throws. A custom
// (non-default) observer that throws must still never fail the real PM
// decision or backend spawn, so this is the single point that swallows
// that failure mode for both createCliPmDriver's decide() and every
// backend's `run` closure in the registry constructor below.
export function observe(observer,method,...args){try{observer?.[method]?.(...args);}catch{/* non-authoritative: never propagate */}}
// M09: the previous prompt said "Return exactly one JSON object matching
// the DSH PM decision contract" without ever stating what that contract's
// field names are. A live reproduction against project B
// (dsh-p6-test-b, empty scaffold repo, no CLAUDE.md) showed real Claude
// Code 2.1.235 responding to that under-specified prompt with a
// self-invented-but-plausible schema — {"type":"finish","summary":...,
// "result":{...},"evidence":[...]} — that carried real, non-empty
// assistant content but never used the required top-level "output" key,
// so parseDecision()'s M06 guard correctly, but unhelpfully, rejected it
// as PM_DECISION_EMPTY_OUTPUT. The same prompt against project A (this
// repo) happened to come back compliant, which is what made the failure
// look project-specific rather than prompt-specific. Three repeat live
// runs against project B with the exact field names spelled out below
// were compliant every time, so the fix is to make the contract
// unambiguous at the one place all four backends share it, not to add
// heuristic alternate-field extraction downstream (A6).
// P7-R0.2 M02: a real live chair_plan reproduction (2026-08-22, real
// `claude` 2.1.235, real dsh-p6-test-b) showed the PREVIOUS renderRequest()
// — `Request: ${JSON.stringify(input.request)}` — JSON-stringifying the
// *entire* request object embeds a council step's `objective` text (which
// itself contains an explicit "reply with exactly one JSON object... use
// this exact shape: {finish + council_plan example}" instruction, quote-
// and-brace-escaped, nested two JSON layers deep inside the outer prompt.
// One captured failure was Claude's own generated decision object ending
// in one extra stray `}` — structurally a complete, correct decision, off
// by exactly one trailing brace (classified: malformed JSON, not prose/
// fencing/wrong-schema — see docs/p7/05_P7_REAL_MODEL_CONTRACT_FINDINGS.md).
// This is consistent with the doubly-nested escaped example inducing a
// copy/mimicry slip. Fix (Part E layer 1 — prompt composition, not the
// parser): `objective` — the one field that can itself carry a nested
// "reply with JSON" instruction for a council step — is rendered as its
// own plain-text section instead of being JSON.stringify'd inside the
// request blob, and one explicit sentence tells the model the task text's
// own example JSON is not what it should echo. `id`/`context` stay
// JSON-encoded (small, non-instructional structured data — this is not a
// case of "remove JSON.stringify everywhere", only where nesting created
// the real ambiguity). The four decision shapes and the M09 sentence below
// are BYTE-FOR-BYTE UNCHANGED — this is the same universal PM contract for
// all four backends and both SINGLE/COUNCIL modes, not a new one.
// DSH-COUNCIL-PARTICIPANT-CONTRACT-HARDENING: three live Antigravity
// participant failures (MISSING_ANALYSIS -> NO_VALID_EVIDENCE_ENTRIES ->
// WRONG_DATA_TYPE:missing) proved prompt-only compliance unstable under
// ~248-252KB WORKSPACE_READ prompts, and source audit proved the exact-shape
// contract is NOT the terminal model-visible text — renderRequest() appends
// "Request context" and "History" after the task text, and the universal
// outer contract's `"data":{"...optional...":true}` line competes with the
// Council's stricter inner contract. This capsule is appended at the FINAL
// rendering boundary (after History — literally the last model-visible
// text) for Council/Debate PARTICIPANT semantic steps only, restating the
// ACTUAL validateStepData() contract from council-step-workflow-runner.mjs
// (never inventing fields). Scoped by the existing Council context the
// runner already threads (`request.context.council === true` + `stepKind`);
// ordinary SINGLE requests are byte-for-byte unchanged (capsule = '').
// Chair steps (chair_plan/chair_synthesis/debate_brief/debate_synthesis)
// are deliberately NOT covered here — their own prompts already carry their
// shapes and chair_plan already has the native structured-output lane.
// Antigravity native participant schemas use the explicit structuredOutputSchema
// seam; the terminal capsule stays as the final model-visible prompt text.
//
// DSH-CHAIR-PLAN-JSON-INVALID (2026-09-09): the "chair_plan already has the
// native structured-output lane" half of that rationale is now falsified by
// live evidence. That lane is gated on `profile.product === 'claude-code'`
// (council-step-workflow-runner.mjs #decideOnce); an `api`-product chair has
// NO native lane at all — `openrouter` declares `supports_json_schema:false`
// (api-provider-capabilities.mjs) and the openai-chat protocol adapter sends
// no `response_format` — so a chair_plan on that product is a free-form-JSON
// step whose exact shape is NOT the terminal model-visible text, exactly the
// condition this capsule mechanism was built to remove for participants.
// Three real chair_plan attempts on `live1-api-openai-gpt-5-6-luna-pro-high`
// (acc-live-2f7778fc attempts 0/1, plus one isolated diagnostic call) all
// returned `finish_reason:"stop"` with a single, fence-free, prose-free
// object that was short by EXACTLY ONE closing brace (scanner depth 1 at
// end-of-input, 0 balanced top-level objects) — the chair's own template
// closes three levels (`}}}`) while renderRequest()'s universal `finish`
// shape above closes two (`}}`), and the chair's contract is separated from
// the model's answer by "Request context"/"History". This capsule restates
// the chair_plan contract as the FINAL model-visible text and names the
// nesting depth explicitly. It NEVER invents a field: the shape below is
// exactly validateStepData()'s chair_plan contract
// (council-step-workflow-runner.mjs) and the same owner-selected id set
// council-prompts.mjs already renders. No parser, retry-policy, schema or
// capability change accompanies it.
function councilChairPlanCapsule(participantProfileIds){
  // Fail safe, never invent: without the owner-selected participant set
  // (which `CouncilStepWorkflowRunner` always threads into request.context)
  // DSH cannot state the exact key list, so the request stays byte-for-byte
  // unchanged rather than shipping a partial contract.
  const ids=Array.isArray(participantProfileIds)?participantProfileIds.filter(id=>typeof id==='string'&&id!==''):[];
  if(!ids.length)return'';
  const shape=`{"type":"finish","output":"council plan ready","data":{"type":"council_plan","participant_instructions":{${ids.map(id=>`"${id}":"<focus text for ${id}>"`).join(',')}},"critique_focus":"<focus text>","synthesis_focus":"<focus text>"}}`;
  return`FINAL COUNCIL CHAIR CONTRACT (this is the LAST instruction and overrides every earlier shape summary, including the generic "finish" shape at the top of this request): return exactly ONE DSH decision object and nothing else — no prose, no Markdown, no code fence before or after it. Exact shape: ${shape}. This object nests THREE levels — the outer decision object, then "data", then "participant_instructions" — and "participant_instructions" closes immediately before "critique_focus", so your response ENDS with exactly TWO consecutive closing braces (}}): the first closes "data", the second closes the outer decision object. Before answering, check that every "{" you opened has a matching "}" and that the whole response parses as strict JSON; a response short or long by even one brace is discarded unparsed and the step fails. "data.type" MUST be exactly "council_plan" — never omitted. "participant_instructions" MUST contain exactly these keys, copied character for character: ${ids.join(', ')} — no more, no fewer, no others. "critique_focus" and "synthesis_focus" must each be ONE non-empty JSON string. Every required field sits directly on "data" — never renamed, omitted, nested, stringified, or moved into "output".`;
}
function councilStepCapsule(stepKind,participantProfileIds){
  if(stepKind==='chair_plan')return councilChairPlanCapsule(participantProfileIds);
  return councilParticipantCapsule(stepKind);
}
function councilParticipantCapsule(stepKind){
  if(stepKind==='participant_report'){
    return 'FINAL COUNCIL PARTICIPANT CONTRACT (this is the LAST instruction and overrides any earlier shape summary): return exactly ONE DSH decision object and nothing else — no prose before or after it. Exact shape: {"type":"finish","output":"<non-empty string>","data":{"type":"council_report","analysis":"<ONE non-empty string>","recommendation":"<ONE non-empty string>","risks":[],"uncertainties":[],"evidence":[]}}. "data.type" MUST be exactly "council_report" — never omitted. "analysis" and "recommendation" must each be ONE non-empty JSON string. "risks" and "uncertainties" must each be a JSON array. "evidence" must be a JSON array of evidence objects exactly per the supplied packet rules (required only when this task requires repository evidence). Every required field sits directly on "data" — never renamed, omitted, nested, stringified, or moved into "output".';
  }
  if(stepKind==='participant_critique'){
    return 'FINAL COUNCIL PARTICIPANT CONTRACT (this is the LAST instruction and overrides any earlier shape summary): return exactly ONE DSH decision object and nothing else — no prose before or after it. Exact shape: {"type":"finish","output":"<non-empty string>","data":{"type":"council_critique","criticisms":[],"agreements":[],"revised_recommendation":"<ONE non-empty string>","remaining_disagreements":[]}}. "data.type" MUST be exactly "council_critique" — never omitted. "revised_recommendation" must be ONE non-empty JSON string. "criticisms", "agreements", and "remaining_disagreements" must each be a JSON array. Every required field sits directly on "data" — never renamed, omitted, nested, stringified, or moved into "output".';
  }
  if(stepKind==='debate_response'){
    return 'FINAL COUNCIL PARTICIPANT CONTRACT (this is the LAST instruction and overrides any earlier shape summary): return exactly ONE DSH decision object and nothing else — no prose before or after it. Exact shape: {"type":"finish","output":"<non-empty string>","data":{"type":"debate_response","response":"<ONE non-empty string>","evidence":[]}}. "data.type" MUST be exactly "debate_response" — never omitted. "response" must be ONE non-empty JSON string. "evidence" must be a JSON array of evidence objects exactly per the supplied packet rules (required only when this task requires repository evidence). Every required field sits directly on "data" — never renamed, omitted, nested, stringified, or moved into "output".';
  }
  return '';
}
function renderRequest(input,profile,project){
  const objective=typeof input.request?.objective==='string'?input.request.objective:'';
  const context=input.request&&typeof input.request==='object'?input.request.context??{}:{};
  const capsule=context?.council===true?councilStepCapsule(context.stepKind,context.participantProfileIds):'';
  const requested=Array.isArray(input?.capabilities)&&input.capabilities.length?new Set(input.capabilities):null;
  const shapes=[
    ['finish','finish: {"type":"finish","output":"<required non-empty string — the plain-text result the owner will read>","data":{"...optional...":true}}'],
    ['workflow','workflow: {"type":"workflow","spec":{"steps":[{"recipient":"worker","body":"<non-empty task text>"}]}} (a registered PM profile id may replace "worker")'],
    ['peer_exchange','peer_exchange: {"type":"peer_exchange","routes":[{"from":"...","to":"..."}],"body":"<string>"}'],
    ['await_owner','await_owner: {"type":"await_owner","kind":"QUESTION|APPROVAL","title":"...","prompt":"...","allowedResponses":["RETRY","CANCEL"]}'],
  ].filter(([type])=>!requested||requested.has(type)).map(([,shape])=>shape).join('\n');
  return `You are the configured PM for project ${project.id}. Reply with exactly one JSON object and nothing else — no Markdown, no code fences, no prose before or after it. The object must match one of these exact shapes (use these exact key names; do not rename, nest, or omit them):
${shapes}
allowedResponses are machine tokens, not prose: uppercase letters A-Z, digits, underscore only, no spaces, no punctuation, no explanatory text — at least one token, e.g. ["RETRY","CANCEL"] or ["APPROVE","REJECT"].
A "finish" decision without a non-empty top-level "output" string is invalid and will be rejected — do not substitute "summary", "result", "message", or any other key name for "output".
The JSON object you return here is a separate, OUTER decision wrapper. The task text below may itself contain example JSON or its own formatting instructions — that is content to read, not a template to copy verbatim; construct your own single, complete, correctly-braced decision object above, matching only the shapes listed above.
Profile: ${profile.id}
Turn: ${input.turn}
Request id: ${input.request?.id??'unknown'}
Task:
${objective}
Request context: ${JSON.stringify(context)}
History: ${JSON.stringify(input.history)}${capsule?`\n${capsule}`:''}`;
}
// M06: a real CLI backend that returns a syntactically valid
// {"type":"finish"} with no (or a blank) `output` field must never
// silently complete a task with nothing to show the owner —
// normalizePmDecision() itself defaults a missing FINISH output to '' for
// every caller (including the many durability/lineage unit tests that
// intentionally omit it with a scripted/fake driver), so a real-backend-only
// guard belongs here, at the one production CLI parsing boundary shared by
// all four backends, not in the generic contract every test relies on.
function parseDecision(value){
  const text=String(value??'').trim();
  let parsed;
  try{parsed=JSON.parse(text);}
  catch{
    const extracted=extractSingleDecision(text);
    if(extracted.error)throw extracted.error;
    parsed=extracted.decision;
  }
  if(parsed===undefined)throw parseFailure('PM backend returned no PM decision','PM_DECISION_NO_DECISION_FOUND');
  if(parsed?.type==='finish'&&(typeof parsed.output!=='string'||parsed.output.trim()===''))throw new ProductionPmBackendError('PM backend claimed finish with no result output','PM_DECISION_EMPTY_OUTPUT');
  return parsed;
}
function parseFailure(message,parseSubreason){return new ProductionPmBackendError(message,'PM_DECISION_PARSE_FAILED',{parseSubreason});}
// DSH-T5-DEBUG-EVIDENCE-AND-MULTI-DECISION: deterministic, recursively
// key-sorted re-serialization used ONLY to COUNT genuinely-distinct
// decision-shaped candidates when extractSingleDecision() below finds 2+ of
// them (never to accept/reject a shape — parseDecision/extractSingleDecision's
// own accept/reject boundary is byte-for-byte unchanged). Two candidates that
// differ only in key order or whitespace count as the SAME substantive
// decision; any difference in a value (verdict, recommendation, evidence,
// IDs, ...) counts as distinct.
function canonicalDecisionKey(value){
  const sort=(v)=>{
    if(Array.isArray(v))return v.map(sort);
    if(v&&typeof v==='object')return Object.keys(v).sort().reduce((acc,k)=>{acc[k]=sort(v[k]);return acc;},{});
    return v;
  };
  return JSON.stringify(sort(value));
}
function extractSingleDecision(text){
  const objects=[];let start=-1,depth=0,inString=false,escaped=false;
  for(let index=0;index<text.length;index+=1){
    const char=text[index];
    if(inString){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')inString=false;continue;}
    if(char==='"'){inString=true;continue;}
    if(char==='{'){if(depth===0)start=index;depth+=1;continue;}
    if(char==='}'){
      if(depth===0)return{error:parseFailure('PM backend returned malformed JSON','PM_DECISION_JSON_INVALID')};
      if(--depth===0){const candidate=text.slice(start,index+1);try{objects.push(JSON.parse(candidate));}catch{/* never salvage malformed JSON */}}
    }
  }
  if(depth!==0||inString)return{error:parseFailure('PM backend returned malformed JSON','PM_DECISION_JSON_INVALID')};
  const decisions=objects.filter((candidate)=>{
    if(candidate?.type==='finish')return typeof candidate.output==='string'&&candidate.output.trim()!=='';
    if(candidate?.type==='await_owner')return true;
    try{normalizePmDecision(candidate);return true;}catch{return false;}
  });
  if(decisions.length===0)return{error:parseFailure('PM backend returned no PM decision','PM_DECISION_NO_DECISION_FOUND')};
  if(decisions.length>1){
    const error=parseFailure('PM backend returned multiple competing decisions','PM_DECISION_AMBIGUOUS_DECISIONS');
    // Additive-only (Part C: never widens what parseDecision()/
    // extractSingleDecision() accepts) — carried on the thrown error so the
    // canonicalization gateway can deterministically tell "N raw candidates,
    // but really only 1 distinct decision repeated" from "N genuinely
    // distinct decisions" without re-scanning raw text or asking an LLM.
    error.sourceCandidateCount=decisions.length;
    error.sourceDistinctSubstantiveCount=new Set(decisions.map(canonicalDecisionKey)).size;
    return{error};
  }
  return{decision:decisions[0]};
}
// P7-R0.2 Part I: sanitized STRUCTURAL evidence only — never the raw
// assistant text, never credentials/tokens/auth URLs/environment values
// (this function never even looks at those; it only reports shape facts
// about the text itself: length, boundary characters, whether it's valid
// JSON, whether a fenced block exists, and coarse boundary classifications).
// Bounded, fixed-shape output — safe to attach to a BackendExecutionObserver
// event, which is a read-only diagnostic surface (Backend Execution stays
// read-only; this adds no capability).
function completeObjectEndIndex(text,startIndex){
  if(startIndex<0||text[startIndex]!=='{')return-1;
  let depth=0,inString=false,escaped=false;
  for(let index=startIndex;index<text.length;index+=1){
    const char=text[index];
    if(inString){
      if(escaped){escaped=false;continue;}
      if(char==='\\'){escaped=true;continue;}
      if(char==='"')inString=false;
      continue;
    }
    if(char==='"'){inString=true;continue;}
    if(char==='{'){depth+=1;continue;}
    if(char==='}'&&--depth===0)return index;
    if(depth<0)return-1;
  }
  return-1;
}
function parseDiagnostics(value){
  const raw=String(value??'');
  const text=raw.trim();
  const firstChar=text[0]??'';
  const lastChar=text[text.length-1]??'';
  let fullJson=false;
  try{JSON.parse(text);fullJson=true;}catch{}
  const jsonFence=/```(?:json)?\s*[\s\S]*?```/i.test(text);
  const fencePrefix=/^```(?:json)?\s*/i.test(text);
  const firstBraceIdx=text.indexOf('{');
  const objectEndIdx=completeObjectEndIndex(text,firstBraceIdx);
  const suffix=objectEndIdx>=0?text.slice(objectEndIdx+1).trim():'';
  const prefixClass=firstChar===''?'EMPTY':fencePrefix?'FENCE':firstChar==='{'?'NONE':firstBraceIdx>0?'LEADING_CONTENT':'UNKNOWN';
  const suffixClass=firstChar===''?'EMPTY':objectEndIdx<0?'UNKNOWN':suffix===''?'NONE':/^[}\],:]/.test(suffix)?'UNKNOWN':'TRAILING_CONTENT';
  const charClass=(char)=>char===''?'EMPTY':char==='{'?'OPEN_BRACE':char==='}'?'CLOSE_BRACE':/^[\[\](),:]$/.test(char)?'JSON_PUNCTUATION':/^[A-Za-z]$/.test(char)?'LETTER':/^[0-9]$/.test(char)?'DIGIT':'OTHER';
  const diagnostics={bytes:Buffer.byteLength(raw,'utf8'),outputByteLength:Buffer.byteLength(raw,'utf8'),firstChar,lastChar,firstCharClass:charClass(firstChar),lastCharClass:charClass(lastChar),fullJson,jsonFence,prefixClass,suffixClass};
  diagnostics.parseSubreason=classifyParseSubreason(diagnostics);
  return diagnostics;
}
// P10-R0.1.1 Part B: an internal/sanitized SUBREASON classification for
// PM_DECISION_PARSE_FAILED, derived ENTIRELY from parseDiagnostics()'s
// already-computed structural facts above — no new text scanning, no
// heuristic extraction, nothing that could widen what parseDecision()
// accepts (Part C). The canonical, externally-observed failure code stays
// exactly `PM_DECISION_PARSE_FAILED`; this is additional, strictly
// diagnostic detail carried alongside it (see the `error.parseSubreason`
// assignment above).
export function classifyParseSubreason({prefixClass,suffixClass,fullJson}={}){
  if(prefixClass==='EMPTY')return'PM_DECISION_EMPTY_TEXT';
  if(prefixClass==='LEADING_CONTENT')return'PM_DECISION_LEADING_CONTENT';
  if(prefixClass==='FENCE')return'PM_DECISION_FENCE_INVALID';
  if(suffixClass==='TRAILING_CONTENT')return'PM_DECISION_TRAILING_CONTENT';
  if(prefixClass==='NONE')return fullJson?'PM_DECISION_UNEXPECTED_SHAPE':'PM_DECISION_JSON_INVALID';
  return'PM_DECISION_UNEXPECTED_SHAPE';
}
// P10-R0.2.2 Part I/K/O: await_owner contract validation/repair — see
// createCliPmDriver()'s decide() call site above for when this runs
// (SINGLE owner tasks only, after parseDecision() already accepted the
// text as JSON with `type:'await_owner'`). Every function here is pure/
// side-effect-free except resolveAwaitOwnerContract's own `run()` call —
// no shared state, easy to unit test in isolation.
const AWAIT_OWNER_TOKEN_RE=/^[A-Z][A-Z0-9_]{0,63}$/;
// Part O: bounded, sanitized structural evidence only — never the raw
// owner-facing title/prompt text itself, only shape facts about it
// (matches parseDiagnostics()'s own philosophy above).
function awaitOwnerDiagnostics(decision,{normalizationResult,normalizationError=null,repairAttempted,repairResult}){
  const allowedResponses=Array.isArray(decision?.allowedResponses)?decision.allowedResponses:[];
  const tokensValid=allowedResponses.length>0&&allowedResponses.every(v=>typeof v==='string'&&AWAIT_OWNER_TOKEN_RE.test(v));
  return{decisionType:decision?.type??null,normalizationResult,normalizationError:normalizationError?String(normalizationError).slice(0,240):null,allowedResponseCount:allowedResponses.length,allowedResponseTokensValid:tokensValid,repairAttempted,repairResult};
}
// Part I: reuses the REAL normalizePmDecision() (pm-contracts.mjs) as the
// ONE validity check — never a second, parallel, possibly-drifting
// reimplementation of the await_owner shape rules. Never widens what
// normalizePmDecision() itself accepts; this only READS its verdict.
function validateAwaitOwnerContract(decision){
  try{normalizePmDecision(decision);return null;}
  catch(error){return error?.message??'await_owner contract invalid';}
}
// Part J/L: names the EXACT validator reason and EXACT required shape;
// never echoes large malformed output; the original task text travels
// verbatim, unmodified, at the end — owner task/project/profile/model/
// reasoning/authorization are all untouched by this repair.
function buildAwaitOwnerRepairPrompt({originalPrompt,invalidReason}){
  return `Your previous response parsed as JSON with "type":"await_owner", but DSH's strict await_owner contract validation rejected it: ${String(invalidReason).slice(0,240)}
Required shape (values below are examples only):
{"type":"await_owner","kind":"QUESTION","title":"<short title>","prompt":"<question for the owner>","allowedResponses":["RETRY","CANCEL"]}
Rules: kind must be exactly QUESTION or APPROVAL. title and prompt must be non-empty strings. allowedResponses must be a non-empty array of machine tokens only — uppercase A-Z, digits, underscore, no spaces, no punctuation, no explanatory text (e.g. ["RETRY","CANCEL"] or ["APPROVE","REJECT"]).
The original task is unchanged. Return exactly one corrected JSON decision object now — either a valid await_owner object matching the shape above, or, if you can complete the task without owner input after all, a valid decision of a different type per the original instructions below.
${originalPrompt}`;
}
// Part K/M: AT MOST one repair invocation — exactly two backend calls
// total for this class (the original call already made by the caller,
// plus this one), matching Part M's bound. Never retried further. Never
// throws itself — every failure path returns `{ok:false,error,...}` so
// the caller's existing try/catch (already scoped to parseDecision()
// failures) can throw it in one place without a second exception-shape to
// reason about.
async function resolveAwaitOwnerContract({decision,bytes,run,ctx,requestId,turn,structuredOutputSchema,timeoutMs,originalPrompt}){
  const initialError=validateAwaitOwnerContract(decision);
  if(!initialError){
    return{ok:true,decision,bytes,diagnostics:awaitOwnerDiagnostics(decision,{normalizationResult:'OK',repairAttempted:false,repairResult:null})};
  }
  const repairPrompt=buildAwaitOwnerRepairPrompt({originalPrompt,invalidReason:initialError});
  let repairedOutput;
  try{
    repairedOutput=await run(repairPrompt,{ctx,requestId,turn,structuredOutputSchema,timeoutMs});
  }catch(cause){
    return{ok:false,error:new ProductionPmBackendError('await_owner contract repair invocation failed','PM_DECISION_AWAIT_OWNER_REPAIR_FAILED',{cause}),diagnostics:awaitOwnerDiagnostics(decision,{normalizationResult:'FAILED',normalizationError:initialError,repairAttempted:true,repairResult:'FAILED'})};
  }
  const repairedBytes=typeof repairedOutput==='string'?repairedOutput.length:0;
  let repairedDecision;
  try{
    repairedDecision=parseDecision(repairedOutput);
  }catch(cause){
    return{ok:false,error:new ProductionPmBackendError('await_owner contract repair returned an unparseable decision','PM_DECISION_AWAIT_OWNER_REPAIR_FAILED',{cause}),diagnostics:awaitOwnerDiagnostics(decision,{normalizationResult:'FAILED',normalizationError:initialError,repairAttempted:true,repairResult:'FAILED'})};
  }
  if(repairedDecision.type==='await_owner'){
    const repairError=validateAwaitOwnerContract(repairedDecision);
    if(repairError){
      return{ok:false,error:new ProductionPmBackendError(`PM backend returned an invalid await_owner decision after repair: ${repairError}`,'PM_DECISION_AWAIT_OWNER_INVALID',{}),diagnostics:awaitOwnerDiagnostics(repairedDecision,{normalizationResult:'FAILED',normalizationError:repairError,repairAttempted:true,repairResult:'FAILED'})};
    }
  }
  return{ok:true,decision:repairedDecision,bytes:repairedBytes,diagnostics:awaitOwnerDiagnostics(repairedDecision,{normalizationResult:'OK',repairAttempted:true,repairResult:'OK'})};
}
function key(value){return `${value?.product}\u0000${value?.transport}\u0000${value?.session_kind}`;}
const VERSION_PROBE_TIMEOUT_MS=5000;
// P6.5: `probeBinary` remains synchronous (spawnSync) and is the sole
// remaining SAFE synchronous CLI probe in this file — see
// docs/p6/26_P6_5_DESKTOP_RESPONSIVENESS.md's blocking-call audit. It is
// used only as `inspect()`/`resolve()`'s default availability check
// (backend.probe(backend.binary), the DI seam the `probe` constructor
// option controls), which runs inside the separate runtime child process
// (scripts/p5-runtime.mjs), never on Electron's own main process — that
// process boundary is what makes it safe to leave synchronous rather than
// a forbidden change to PM/task execution semantics. The Electron-main-
// reachable path (capabilities()/capability(), used by Connection
// Center's IPC handlers) no longer calls this at all — see
// `installedProbe`/`probeInstalledAndVersion` (pm-connection-probe.mjs)
// above, which is fully async.
function probeBinary(binary,provider){if(typeof binary!=='string'||!binary)return false;try{return spawnSync(binary,['--version'],{encoding:'utf8',windowsHide:true,timeout:VERSION_PROBE_TIMEOUT_MS,shell:process.platform==='win32'&&/\.(cmd|bat)$/i.test(binary),env:buildProviderChildEnv({provider})}).status===0;}catch{return false;}}
function explicitExecutable(provider,path){return Object.freeze({available:typeof path==='string'&&path.length>0,provider,family:provider,path:typeof path==='string'?path:null,source:'CONFIGURED',version:null,code:typeof path==='string'&&path.length>0?null:'PROVIDER_EXECUTABLE_UNTRUSTED',internalInjection:true});}
// P11-R0: a lazily-bound reference to the runtime's global `fetch`
// (Node 18+) — read via a wrapper function, never captured as a bare value
// at module-load time, so a test environment that polyfills/monkeypatches
// `globalThis.fetch` after this module is imported is still honored. This
// is the registry's default `apiFetch` DI seam; real production code never
// needs to pass one explicitly, and every test passes its own fake.
function defaultFetch(...args){return globalThis.fetch(...args);}
// B4-style defense in depth: probeConnectionFacts already catches
// internally, but a caller-injected connectionProbe (e.g. a test double)
// could still throw — that must degrade capabilities() to ERROR facts for
// that one backend, never fail the whole call.
async function safeConnectionProbe(prober,product,binary,mode){try{return (await prober(product,binary,{mode}))??unavailableConnectionFacts('probe returned no result');}catch{return {authProbe:'SUPPORTED',authState:'ERROR',authDetail:'connection probe threw unexpectedly',nativeDefaultModel:null,modelDiscovery:{supported:false,models:null,source:'error'}};}}
// Defense in depth for the installed/version check, mirroring
// safeConnectionProbe above: a caller-injected installedProbe (e.g. a
// test double) that throws or rejects must degrade to "not installed"
// for that one backend, never fail the whole capabilities()/capability()
// call.
async function safeInstalledProbe(prober,binary,product){try{const result=await prober(binary,{product});return{installed:Boolean(result?.installed),version:result?.version??null};}catch{return{installed:false,version:null};}}
// P7-R0.2 M02: `constrain()` was applied to OpenCode/Codex/Grok but NOT
// Claude — a real chair_plan reproduction against Claude Code 2.1.235
// showed it, unprompted otherwise, occasionally emitting one syntactically
// complete, correct decision object immediately followed by exactly one
// extra stray "}" (docs/p7/05_P7_REAL_MODEL_CONTRACT_FINDINGS.md).
// "last character must be }" alone does not forbid that shape (the
// malformed sample's last character genuinely IS "}" too), so the wording
// now also states the stronger, still-true-for-every-backend invariant:
// the object must be syntactically complete AND nothing may follow it —
// not prose, not a fence, not a stray repeated delimiter. This is applied
// uniformly to all four backends (Part E: a backend-specific response
// constraint, not a parser change) — Claude now receives it too.
function constrain(product,prompt){return `${product} response constraint: output only the requested raw JSON object — one complete, syntactically valid JSON value, nothing else. The first character must be { and the last character must be }, with NOTHING following the final closing brace (no repeated or stray closing brace, no prose, no Markdown, no code fences, no tool calls). Before responding, mentally verify every opening { has exactly one matching closing } and that you stop immediately after the last one.\n${prompt}`;}
// P9-R0.1: the Antigravity-specific plan-mode-artifact mitigation and
// context-fed instruction now live in buildAntigravityPrompt()
// (src/session/antigravity-cli-session-bridge.mjs) — folded in there so
// the context packet (project/git facts) and the instruction text stay
// together in one place; this registry only supplies the shared,
// generic constrain() JSON-only wrapper on top, exactly as before.
