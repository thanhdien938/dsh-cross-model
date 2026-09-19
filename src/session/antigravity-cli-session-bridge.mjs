import {spawn} from 'node:child_process';
import {homedir,tmpdir} from 'node:os';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {serializeDurable} from '../persistence/repositories/json-durable.mjs';
import {join} from 'node:path';
import {buildProviderChildEnv,providerExecutablePolicy,reapOwnedChildProcess,resolveProviderExecutable,resolveProviderExecutableSync} from './provider-child-policy.mjs';
import {gatherGitFactsAsync} from '../pm/git-facts-async.mjs';
import {truncateForBudget} from '../pm/council/council-contracts.mjs';

// P9-R0: Google Antigravity CLI (`agy`) — DSH's fifth production PM
// backend. Antigravity is the CLI/HARNESS product; the model identity is
// whatever slug `agy models` reports (Gemini/Claude/GPT-OSS families all
// observed live — see docs/p9/01_ANTIGRAVITY_CLI_SURVEY.md). Never
// hard-code this backend as "Gemini".
//
// Live research trail (2026-08-23, installed agy 1.1.19, official install
// via https://antigravity.google/cli/install.ps1 — see docs/p9/01 for the
// full transcript this file is built from):
//   - `agy` (bare) is a full-screen interactive TUI that hangs
//     indefinitely over piped/closed stdin with zero output — proven live
//     (8s bounded probe, exit 124, no stdout/stderr at all). It cannot be
//     safely represented by DSH's existing piped-stdio LoginTerminalSession
//     (designed for "print a URL/code, wait for Enter" flows only). `agy
//     --help` also documents no dedicated `login`/`logout` subcommand.
//     loginCommandSupported/logoutCommandSupported are therefore honestly
//     false below — never claimed for UI symmetry (Part D).
//   - `agy -p <prompt> --mode plan --output-format json|stream-json` was
//     run repeatedly, including one adversarial "create a file" prompt
//     against a throwaway git repo: HEAD and working tree were unchanged
//     (git status before/after identical) even though the model's chosen
//     `run_command` tool call was actually attempted — the init event's
//     own `permission_mode` is "request-review", and a headless run with
//     no TTY to review against auto-denies the tool instead of executing
//     it. This is `--mode plan`'s real, proven behavior, not merely a
//     prompted convention (Part F).
//   - That auto-denial is the "soft-denied tool" case official docs warn
//     about (Part K): the PROCESS still exits 0, but the terminal `result`
//     event's own `status` is `"CANCELED"` with an empty `response` —
//     proof that exit code alone is never suffient evidence of success.
//     `extractAntigravityAssistantText` below gates on `status`/`response`
//     inside the terminal event, never on process exit code.
//   - An unrecognized `--model` value fails closed live: exit 1,
//     `status:"ERROR"`, a `available models` list in `error`, no silent
//     fallback to any default model.
//   - `--effort low|medium|high` all ran successfully live against real
//     models.
export class AntigravityCliError extends Error{constructor(message,extra={}){super(message);this.name='AntigravityCliError';this.code=extra.code??'ANTIGRAVITY_CLI_ERROR';Object.assign(this,extra);}}

// P9-R0 Part A: 'agy' first (relies on the official installer having added
// %LOCALAPPDATA%\agy\bin to the user PATH), then the exact Windows install
// location the official installer reported live on this machine
// (`C:\Users\<user>\AppData\Local\agy\bin\agy.exe`) as an explicit
// fallback — mirrors Codex's homedir-based candidate (codex-cli-session-
// bridge.mjs). Never the Antigravity IDE's own `antigravity`/`antigravity.cmd`
// launcher (a different product — see docs/p9/01, "IDE vs CLI").
export const ANTIGRAVITY_CLI_BINARY_CANDIDATES=Object.freeze([join(homedir(),'AppData','Local','agy','bin','agy.exe'),join(homedir(),'.local','bin','agy')]);
// P9-R0 Part D/W: login/logout are honestly false (see the file docstring
// above) — never claimed for UI symmetry. usageTelemetry:true is proven
// live (every terminal result carries input/output/thinking/cache_read/
// total token counts).
export const ANTIGRAVITY_CLI_CAPABILITIES=Object.freeze({product:'antigravity',transport:'stdio',session_kind:'STATELESS',modelSelection:true,loginCommandSupported:false,logoutCommandSupported:false,structuredOutput:true,usageTelemetry:true});

function concrete(base){return process.platform==='win32'&&!/\.(exe|cmd|bat)$/i.test(base)?[base,`${base}.exe`,`${base}.cmd`,`${base}.bat`]:[base];}
export function resolveAntigravityExecutable(){return resolveProviderExecutableSync(providerExecutablePolicy({provider:'antigravity',executableName:'agy',knownCandidates:ANTIGRAVITY_CLI_BINARY_CANDIDATES}));}
export function resolveAntigravityBinary(){return resolveAntigravityExecutable().path??'';}
// P6.5 Part C/E: async, non-blocking counterpart — see binary-resolution-async.mjs's docstring. Electron main must never gain a blocking spawnSync CLI probe (P6.5 responsiveness invariant).
export async function resolveAntigravityBinaryAsync(){return(await resolveProviderExecutable(providerExecutablePolicy({provider:'antigravity',executableName:'agy',knownCandidates:ANTIGRAVITY_CLI_BINARY_CANDIDATES}))).path??'';}

// P9-R0 Part J: parses NDJSON stream-json output (one JSON object per
// line: {"event":"init",...} / {"event":"step_update",...} /
// {"event":"result","result":{...}}), CRLF-safe (split on /\r?\n/) and
// chunk-boundary-safe by construction (stdout is fully accumulated by the
// caller before this ever runs — see runAntigravityCliProcess below — so
// no line can straddle two separate calls to this function). A malformed
// line is skipped, never thrown (fail closed at the extraction step
// instead, where "no usable result" becomes a typed error). Also accepts
// the plain `--output-format json` shape (one bare envelope with no
// "event" wrapper) for robustness, though production calls always request
// stream-json (G1 — the observability-preferred transport; see docs/p9/02).
export function summarizeAntigravityCliRun({stdout='',stderr='',code=null}={}){
  const events=[];
  for(const line of String(stdout).split(/\r?\n/)){
    const trimmed=line.trim();
    if(!trimmed)continue;
    let parsed;
    try{parsed=JSON.parse(trimmed);}catch{continue;}
    events.push(parsed);
  }
  let result=null;
  for(let i=events.length-1;i>=0;i-=1){
    const e=events[i];
    if(e&&typeof e==='object'&&e.event==='result'&&e.result&&typeof e.result==='object'){result=e.result;break;}
  }
  if(!result){
    const plain=events.find(e=>e&&typeof e==='object'&&typeof e.status==='string'&&!('event' in e));
    if(plain)result=plain;
  }
  return{code,events,result,stdout,stderr};
}

// P9-R0 Part K: the selected terminal result event is the ONLY
// source of truth — process exit code is never consulted here (proven
// live: a soft-denied tool run exits 0 with status "CANCELED"). Known
// terminal statuses observed/documented: SUCCESS, ERROR, CANCELED,
// INTERRUPTED, INVALID, WAITING, RUNNING — only SUCCESS is eligible.
// Free-form requires nonempty response; native schema requires structured_output.
export function extractAntigravityAssistantText(summary,{structuredOutputSchema=null}={}){
  const result=summary?.result;
  if(!result||typeof result!=='object')throw new AntigravityCliError('Antigravity terminal result event is missing',{code:'ANTIGRAVITY_OUTPUT_INVALID'});
  const status=result.status;
  const errorText=typeof result.error==='string'?result.error:'';
  // PARSER-0 Goal E: safe terminal-response facts, attached additively to
  // every typed failure so TERMINAL_ERROR_EMPTY and
  // TERMINAL_ERROR_WITH_RESPONSE_PRESENT stay distinguishable WITHOUT
  // changing this bridge's fail-closed terminal gate: only terminal SUCCESS
  // is eligible downstream; a response inside a
  // terminal ERROR is never parsed, never salvaged, and never exposed —
  // only its presence and byte count are recorded here.
  const terminalResponsePresent=typeof result.response==='string'&&!!result.response.trim();
  const terminalResponseBytes=typeof result.response==='string'?Buffer.byteLength(result.response,'utf8'):null;
  const terminalFacts={terminalResponsePresent,terminalResponseBytes};
  if(status==='CANCELED')throw new AntigravityCliError('Antigravity run was canceled — a tool permission request could not be granted in headless mode (soft-denial)',{code:'ANTIGRAVITY_PERMISSION_DENIED',...terminalFacts});
  if(status==='ERROR'){
    if(/not recognized as a known model|invalid model selection/i.test(errorText))throw new AntigravityCliError('Antigravity rejected an unrecognized --model value',{code:'ANTIGRAVITY_MODEL_INVALID',detail:errorText.slice(0,500),...terminalFacts});
    if(/not authenticated|please (sign|log) in|authentication required|run ['"`]?agy['"`]? to (sign|log) in/i.test(errorText))throw new AntigravityCliError('Antigravity reports authentication is required',{code:'ANTIGRAVITY_AUTH_REQUIRED',detail:errorText.slice(0,500),...terminalFacts});
    // P9-R0.1 Part F: live-proven distinct failure class — a tool the model
    // chose to call needed interactive permission review that headless mode
    // structurally cannot grant ("permission check failed for command
    // \"git status\": user denied permission to run command:\ngit status",
    // and the same shape for read_file). Classified BEFORE the generic
    // fallback so this specific, actionable, non-security-relevant failure
    // is never lumped into an opaque ANTIGRAVITY_RUN_FAILED. Sanitized
    // metadata only (tool name + a fixed reason code) — the raw error text,
    // which can embed the exact attempted command line or file path, is
    // deliberately NOT copied into `detail` here (Part F: "never persist
    // full dangerous command lines if they may contain secrets").
    const denialMatch=errorText.match(/permission check failed for (\S+)/i);
    if(denialMatch){
      const rawTool=denialMatch[1].replace(/["':]+$/,'');
      const tool=rawTool.toLowerCase()==='command'?'run_command':rawTool;
      throw new AntigravityCliError(`Antigravity denied a tool permission request (${tool})`,{code:'ANTIGRAVITY_TOOL_DENIED',tool,reason:'permission_denied',...terminalFacts});
    }
    throw new AntigravityCliError('Antigravity run failed',{code:'ANTIGRAVITY_RUN_FAILED',detail:errorText.slice(0,500),...terminalFacts});
  }
  if(status!=='SUCCESS')throw new AntigravityCliError(`Antigravity run ended in a non-success terminal state: ${status??'unknown'}`,{code:'ANTIGRAVITY_RUN_FAILED',status:status??null,...terminalFacts});
  // Native schema mode has an authoritative parsed field, including in
  // stream-json: https://antigravity.google/docs/cli/headless/
  // response is presentation text and can contain multiple representations.
  // Select only the documented field; retain downstream PM/step validation.
  if(structuredOutputSchema!=null){
    const native=result.structured_output;
    const nativeFacts={...terminalFacts,outputSource:'result.structured_output'};
    if(!native||typeof native!=='object'||Array.isArray(native))throw new AntigravityCliError('Antigravity native structured output object is missing',{code:'ANTIGRAVITY_STRUCTURED_OUTPUT_MISSING',...nativeFacts});
    try{return serializeDurable(native,'Antigravity structured output');}
    catch{throw new AntigravityCliError('Antigravity native structured output is not JSON-faithful',{code:'ANTIGRAVITY_STRUCTURED_OUTPUT_INVALID',...nativeFacts});}
  }
  const text=result.response;
  if(typeof text!=='string'||!text.trim())throw new AntigravityCliError('Antigravity final assistant output is missing',{code:'ANTIGRAVITY_ASSISTANT_OUTPUT_MISSING',...terminalFacts});
  return text.trim();
}

// P9-R0.3 Part B/C/D: live-proven (docs/p9/06_MODEL_REASONING_SEMANTICS.md)
// — a tier-suffixed Antigravity model slug's own trailing -low/-medium/
// -high IS the reasoning tier; the CLI itself rejects any --effort value
// that disagrees with it, and behaves identically whether --effort is
// omitted or matches. This is the ONE place that pattern is recognized —
// both production argv generation (never forward --effort — see
// runAntigravityCliProcess's caller in production-pm-backend-registry.mjs)
// and the trusted profile-creation guard (pmProfileConfigService.ts, via
// dynamic import) derive from this same function, so the two can never
// drift apart. Returns null for a slug with no recognized tier suffix
// (every current Claude slug) — never invents a tier (Part H: no
// "(Thinking)" => "high" inference, no guessing).
const TIER_SUFFIX_PATTERN=/-(low|medium|high)$/i;
export function deriveAntigravityReasoningFromModel(model){
  if(typeof model!=='string')return null;
  const match=model.match(TIER_SUFFIX_PATTERN);
  return match?match[1].toLowerCase():null;
}

// P9-R0.1 Part B/C: bounded, deterministic context DSH can supply without
// any repository shell exploration — project identity + read-only git
// facts (branch/dirty/remote), gathered via the async, bounded
// gatherGitFactsAsync (Part D: never spawnSync on this path — it runs once
// per PM turn, not an infrequent Add-Folder-style action). Never includes
// file content, secrets, or environment variables (Part B).
export const ANTIGRAVITY_CONTEXT_CHAR_BUDGET=2000;
export async function gatherAntigravityContextFacts({project,spawnImpl,timeoutMs}={}){
  const gitFacts=await gatherGitFactsAsync(project?.repo_path,{spawnImpl,timeoutMs});
  return{gitFacts};
}

// P9-R0.1 Part B/E: the bounded, deterministic context block prepended to
// every Antigravity prompt (single-PM AND council — both funnel through
// the same registry `run` closure, so this needs no council-specific
// branch). Pure/sync — no I/O. `extraCtx` (councilId/phase/round/role) is
// the SAME correlation object createCliPmDriver already threads into
// observability ctx (P7 Part W) — reused here, never a second council-
// context mechanism (Part K). Deterministically truncated via the existing
// council truncateForBudget() convention (Part M) — a safe marker, never a
// silent mid-JSON cut.
export function buildAntigravityContextBlock({project,profile,extraCtx,gitFacts}={}){
  const lines=[
    'DSH-SUPPLIED CONTEXT (authoritative — do not verify independently):',
    `Project: ${project?.id??'unknown'}${gitFacts?.repoName?` (${gitFacts.repoName})`:''}`,
    `Repository path: ${project?.repo_path??'unknown'}`,
    `Branch: ${gitFacts?.isGitRepo?(gitFacts.branch??'unknown (detached HEAD)'):'unknown'}`,
    `Working tree: ${gitFacts?.isGitRepo?(gitFacts.dirtyCount===0?'clean':gitFacts.dirtyCount>0?`dirty (${gitFacts.dirtyCount} changed path(s))`:'unknown'):'unknown'}`,
  ];
  if(profile?.id)lines.push(`PM profile: ${profile.id}`);
  if(extraCtx&&typeof extraCtx==='object'&&extraCtx.role)lines.push(`Council role: ${extraCtx.role}${extraCtx.phase?`, phase: ${extraCtx.phase}`:''}${extraCtx.round!=null?`, round: ${extraCtx.round}`:''}`);
  return truncateForBudget(lines.join('\n'),ANTIGRAVITY_CONTEXT_CHAR_BUDGET,'Antigravity context block');
}

// P9-R0.1 Part E: explicit instruction that supplied context is
// authoritative and tools are not required for a normal PM turn —
// mitigates two DIFFERENT live-proven failure modes: (1) plan mode's own
// "write a plan.md artifact instead of answering directly" detour (P9-R0
// quirk #4), and (2) headless plan mode denying essentially all
// run_command calls, even harmless read-only ones like `git status` (the
// P9-R0.1 owner-reported failure — see docs/p9/05). Security still comes
// from --mode plan alone (Part E: this text is never relied on as the
// security boundary) — it exists only to avoid AVOIDABLE tool-denial
// failures, never to grant or imply a permission DSH does not enforce
// structurally.
const ANTIGRAVITY_INSTRUCTION=[
  'Antigravity execution note: this is a single read-only reasoning turn inside DSH.',
  'Use ONLY the task and the DSH-supplied context above as your evidence — treat it as authoritative and do not attempt to verify it independently.',
  'Do not inspect the repository or environment using shell/file/browser tools unless this request explicitly authorizes tools. For this execution, tools are not required, and shell commands (including harmless read-only ones) will likely be denied by policy.',
  'Do not create a plan.md artifact, propose file edits, or ask for approval to proceed — there is nothing to execute here.',
  'If the supplied context is insufficient to answer precisely, say so explicitly in your decision rather than attempting workspace exploration or guessing.',
  'Answer directly in your response text with only the JSON object described below.',
].join(' ');

// P9-R0.1 Part B/E: assembles the final Antigravity-specific prompt —
// context block + instruction + the original task prompt. The shared,
// generic constrain() JSON-only wrapper
// (production-pm-backend-registry.mjs) is still applied OUTSIDE this, as
// the outermost layer, exactly as before P9-R0.1 — this function only ever
// ADDS content ahead of the original prompt; it never touches the decision
// contract or parseDecision()/M09.
export function buildAntigravityPrompt({prompt,project,profile,extraCtx,gitFacts}={}){
  const contextBlock=buildAntigravityContextBlock({project,profile,extraCtx,gitFacts});
  return `${contextBlock}\n\n${ANTIGRAVITY_INSTRUCTION}\n${prompt}`;
}

// P9-R0 Part F/I: hard-coded, non-negotiable safety composition —
// `--dangerously-skip-permissions` never, `shell:false` always, cwd is
// exactly `project.repo_path` (passed in by the caller), stdio is a
// bounded explicit ['pipe','pipe','pipe']. `--mode` defaults to `'plan'`
// (byte-for-byte the pre-P20.8R2 behavior for every existing caller — the
// decision plane, production-pm-backend-registry.mjs, never passes `mode`
// and so never reaches anything but `plan`); P20.8R2 §3.3 adds `mode` as
// an explicit opt-in parameter ONLY for the new report-plane DIRECT_WRITE
// adapter (cli-report-backends.mjs), which passes `'accept-edits'` — never
// `--dangerously-skip-permissions`, still never reachable from task prose.
// `--print-timeout`
// is the CLI's own bounded wait (seconds); the Node-level `timer` below is
// a defensive backstop (timeoutMs + grace) in case the CLI's own timeout
// mechanism ever fails to fire — it should essentially never be the one
// that trips in practice.
const TIMEOUT_GRACE_MS=15000;
// DSH-TIMEOUT-1 Part D (audit Finding T-3): see CODEX_CLI_DEFAULT_TIMEOUT_MS's
// identical docstring (codex-cli-session-bridge.mjs) — the ONE named source
// of truth for this bridge's own default, reused as both this function's
// default parameter and production-pm-backend-registry.mjs's forwarding
// floor. `TIMEOUT_GRACE_MS` above stays a separate, unrelated concept (the
// Node-level backstop's margin over the CLI's own `--print-timeout`) — not
// part of this floor.
export const ANTIGRAVITY_DEFAULT_TIMEOUT_MS=300000;
// P20.8R2 §3.3 — `mode` is a NEW, explicit, opt-in parameter. Every
// existing caller (decision-plane production-pm-backend-registry.mjs,
// every pre-R2 test) omits it and gets the EXACT prior hard-coded
// '--mode plan' behavior, byte-for-byte — this is still the only mode the
// decision plane ever reaches. Only the NEW report-plane DIRECT_WRITE
// adapter (cli-report-backends.mjs) passes 'accept-edits' explicitly, for
// this one narrow report-content call site.
const KNOWN_ANTIGRAVITY_MODES=Object.freeze(['plan','accept-edits']);
// P20.8R2 §3.3 diagnostic finding — a live probe with `--mode accept-edits`
// alone reached SUCCESS but never wrote the assigned file: this headless
// stream-json/print-mode session has no TTY to answer any interactive tool-
// permission prompt, so an edit tool call silently never completes without
// `--dangerously-skip-permissions`. Explicit, opt-in, `false` by default —
// every existing caller (decision plane, every pre-R2 test) is unaffected;
// only the report-plane DIRECT_WRITE adapter passes `true`, and even then
// only for this one non-interactive report-content call, never combined
// with any repository/source-write authority (§9 source safety is
// unrelated — the assigned report path is outside the source tree).
export async function runAntigravityCliProcess({binary=resolveAntigravityBinary(),cwd=process.cwd(),prompt,model,reasoning,structuredOutputSchema,timeoutMs=ANTIGRAVITY_DEFAULT_TIMEOUT_MS,spawnImpl=spawn,mode='plan',dangerouslySkipPermissions=false}={}){
  required(prompt,'prompt');
  if(!KNOWN_ANTIGRAVITY_MODES.includes(mode)){
    throw new AntigravityCliError(`unknown Antigravity mode: ${mode}`,{code:'ANTIGRAVITY_MODE_UNKNOWN',mode,knownModes:KNOWN_ANTIGRAVITY_MODES});
  }
  // agy 1.1.27's documented stream-input mode accepts one NDJSON `user`
  // event per turn. Unlike `-p <prompt>`, this keeps arbitrarily large task
  // evidence out of Windows' bounded command line without truncating it.
  const args=['--input-format','stream-json','--mode',mode,'--output-format','stream-json'];
  if(dangerouslySkipPermissions===true)args.push('--dangerously-skip-permissions');
  if(model)args.push('--model',required(model,'model'));
  if(reasoning)args.push('--effort',required(reasoning,'reasoning'));
  args.push('--print-timeout',`${Math.max(1,Math.round(timeoutMs/1000))}s`);
  let schemaDir;
  try {
    if(structuredOutputSchema != null){
      let schemaJson;
      try {
        schemaJson=serializeDurable(structuredOutputSchema,'Antigravity schema');
        if(!structuredOutputSchema || typeof structuredOutputSchema!=='object' || Array.isArray(structuredOutputSchema) || Buffer.byteLength(schemaJson,'utf8')>16384)throw new Error('invalid schema size or shape');
      } catch { throw new AntigravityCliError('invalid or oversized native schema',{code:'ANTIGRAVITY_SCHEMA_INVALID'}); }
      schemaDir=await mkdtemp(join(tmpdir(),'dsh-agy-schema-'));
      const schemaPath=join(schemaDir,'schema.json');
      await writeFile(schemaPath,schemaJson,{encoding:'utf8',mode:0o600});
      args.push('--json-schema',schemaPath);
    }
    return await new Promise((resolve,reject)=>{
      const child=spawnImpl(binary,args,{cwd,stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false,env:buildProviderChildEnv({provider:'antigravity'})});
      let stdout='',stderr='',settled=false;
      // DSH-TIMEOUT-1 Part E (Finding T-4): `child.kill()` replaced with
      // `reapOwnedChildProcess(child)` — see provider-child-policy.mjs's
      // docstring — reusing the SAME bounded owned-process-tree cleanup
      // owner-cancel/shutdown already gets.
      const timer=setTimeout(async()=>{if(settled)return;settled=true;await reapOwnedChildProcess(child);reject(new AntigravityCliError('Antigravity process timed out',{code:'ANTIGRAVITY_TIMEOUT'}));},timeoutMs+TIMEOUT_GRACE_MS);
      child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
      child.stdin?.on?.('error',error=>{if(settled)return;settled=true;clearTimeout(timer);reject(new AntigravityCliError(`failed to send prompt to Antigravity: ${error.message}`,{code:'ANTIGRAVITY_STDIN_FAILED',cause:error}));});
      child.stdout.on('data',v=>stdout+=v);
      child.stderr.on('data',v=>stderr+=v);
      child.once('error',error=>{if(settled)return;settled=true;clearTimeout(timer);reject(new AntigravityCliError('Antigravity process spawn failed',{code:'ANTIGRAVITY_SPAWN_FAILED',cause:error}));});
      // Without a native schema, preserve P9-R0 nonzero-exit behavior.
      // Resolve with the parsed summary so the
      // terminal result event's own status (SUCCESS/ERROR/CANCELED/...) is
      // always what decides success, via extractAntigravityAssistantText.
      child.once('close',code=>{if(settled)return;settled=true;clearTimeout(timer);
        if(structuredOutputSchema != null && code!==0){reject(new AntigravityCliError('Antigravity native schema invocation failed',{code:'ANTIGRAVITY_SCHEMA_INVOCATION_FAILED'}));return;}
        resolve(summarizeAntigravityCliRun({stdout,stderr:safe(stderr),code}));});
      child.stdin?.end?.(`${JSON.stringify({event:'user',message:{content:prompt}})}\n`);
    });
  } finally { if(schemaDir)await rm(schemaDir,{recursive:true,force:true}); }
}

function required(value,label){if(typeof value!=='string'||!value.trim())throw new AntigravityCliError(`${label} must be a non-empty string`,{code:'INVALID_ANTIGRAVITY_CLI_INPUT'});return value;}
// P9-R0 Part X: sanitized before it ever reaches an observer/error object —
// browser auth URLs and bearer/API-key-shaped tokens never enter logs.
function safe(value){return String(value??'').replace(/(?:postgres(?:ql)?|https?):\/\/\S+/gi,'[REDACTED_URL]').replace(/bearer\s+\S+/gi,'Bearer [REDACTED]').slice(0,2000);}
