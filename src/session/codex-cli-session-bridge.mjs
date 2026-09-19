import {spawn} from 'node:child_process';
import {existsSync,readdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname,join} from 'node:path';
import {buildProviderChildEnv,providerExecutablePolicy,reapOwnedChildProcess,resolveProviderExecutable,resolveProviderExecutableSync} from './provider-child-policy.mjs';
import {createStreamSummaryAccumulator} from './stream-summary.mjs';

export class CodexCliError extends Error{constructor(message,extra={}){super(message);this.name='CodexCliError';this.code=extra.code??'CODEX_CLI_ERROR';Object.assign(this,extra);}}
// P10-R0.2.2 Part B/E: live-proven (docs/p10/08_CODEX_WINDOWS_SANDBOX_AND_
// AWAIT_OWNER_HARDENING_SONNET5.md) — on the owner's machine,
// `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe` (the previous sole
// fixed-path candidate) is an NTFS **hardlink** to the exact same file as
// `%CODEX_HOME%\packages\standalone\releases\<version>-<target-triple>\bin\
// codex.exe` (the standalone installer's own canonical, self-documented
// package-cache location — confirmed via `codex doctor`'s own "install"/
// "runtime" self-report). Both paths run the IDENTICAL binary and both
// pass a bare `--version` probe, but codex.exe's own internal derivation
// of its sibling `codex-resources\codex-windows-sandbox-setup.exe` helper
// path only resolves correctly when invoked via the real package-cache
// path — invoked via the `AppData\Local\Programs` hardlink, that
// derivation fails, and Codex's Windows sandbox setup fails with
// `orchestrator_helper_launch_failed: ... error=program not found` on
// EVERY `--sandbox read-only`/`workspace-write` invocation (live-
// reproduced twice, identical to the owner-live T3 failure signature).
// `codexStandaloneReleaseCandidates()` below discovers that canonical
// path dynamically (never a hardcoded version string, since the
// standalone installer version-bumps this directory on every self-
// update) and is tried BEFORE the two pre-existing candidates, so a
// working sandbox-capable binary is preferred whenever this install
// layout is present. Purely additive and fully safe on every OTHER
// install layout (non-Windows, npm-installed, WindowsApps-only, a future
// Codex build that fixes the hardlink derivation itself): any read
// failure (missing CODEX_HOME, no standalone releases, non-Windows)
// yields an empty array via the try/catch below, changing nothing — the
// two pre-existing candidates still work exactly as before this wave.
function codexStandaloneReleaseCandidates(){
  if(process.platform!=='win32')return[];
  try{
    const releasesDir=join(homedir(),'.codex','packages','standalone','releases');
    return readdirSync(releasesDir,{withFileTypes:true})
      .filter(entry=>entry.isDirectory())
      .map(entry=>entry.name)
      .sort().reverse() // best-effort newest-first; correctness never depends on exact order, only on trying every real release directory.
      .map(name=>join(releasesDir,name,'bin','codex.exe'));
  }catch{return[];}
}
export const CODEX_CLI_BINARY_CANDIDATES=Object.freeze([...codexStandaloneReleaseCandidates(),join(homedir(),'AppData','Local','Programs','OpenAI','Codex','bin','codex.exe'),join(homedir(),'AppData','Roaming','npm','codex.cmd'),join(homedir(),'.local','bin','codex')]);
export const CODEX_CLI_CAPABILITIES=Object.freeze({product:'codex',transport:'stdio',session_kind:'STATELESS',modelSelection:true,loginCommandSupported:true,logoutCommandSupported:true,structuredOutput:true,usageTelemetry:true});
// CODEX-ENV-ISO R2: the DSH Codex backend gets its own CODEX_HOME so the
// owner's VS Code ChatGPT extension and Codex Desktop alpha app-server
// processes — which continuously rewrite the shared `~/.codex` (proven
// live: models_cache.json rewritten to an incompatible alpha shape mid-
// session, ~450MB of unrelated alpha app state in the same directory) —
// can no longer clobber the models_cache.json/config state stable
// codex-cli 0.147.0 reads for DSH tasks. Configurable via DSH_CODEX_HOME
// (same DSH_<PROVIDER>_<THING> convention as DSH_CODEX_EXECUTABLE),
// defaulting to a fixed DSH-only directory; DSH_CODEX_HOME itself is never
// forwarded to a child (DSH_* keys are always denied by
// provider-child-policy.mjs's deny-by-default policy) — only the resulting
// CODEX_HOME value is injected, through the SAME allowlisted passthrough
// key (`PROVIDER_ENV_KEYS.codex`) that already exists for it. This never
// sets a global/machine CODEX_HOME and never touches VS Code/Codex
// Desktop's own environment — only DSH's own codex child spawns see it.
const DEFAULT_CODEX_DSH_HOME=join(homedir(),'.codex-dsh');
export function resolveCodexDshHome(sourceEnv=process.env){const configured=sourceEnv.DSH_CODEX_HOME;return typeof configured==='string'&&configured.trim()?configured:DEFAULT_CODEX_DSH_HOME;}
// Exported (not just used internally) so tests can assert the exact env
// object handed to buildProviderChildEnv without spawning a real process.
export function codexSourceEnv(sourceEnv=process.env){return{...sourceEnv,CODEX_HOME:resolveCodexDshHome(sourceEnv)};}
export function resolveCodexCliExecutable(){return resolveProviderExecutableSync(providerExecutablePolicy({provider:'codex',executableName:'codex',knownCandidates:CODEX_CLI_BINARY_CANDIDATES,sourceEnv:codexSourceEnv()}));}
export function resolveCodexCliBinary(){return resolveCodexCliExecutable().path??'';}
// P6.5 Part C/E: async, non-blocking counterpart — see binary-resolution-async.mjs's docstring.
export async function resolveCodexCliBinaryAsync(){return(await resolveProviderExecutable(providerExecutablePolicy({provider:'codex',executableName:'codex',knownCandidates:CODEX_CLI_BINARY_CANDIDATES,sourceEnv:codexSourceEnv()}))).path??'';}
export function summarizeCodexCliRun({stdout='',stderr='',code=null}={}){const events=[];for(const line of String(stdout).split(/\r?\n/)){if(!line.trim())continue;try{events.push(JSON.parse(line));}catch{}}return{code,events,stdout,stderr};}
export function extractCodexAssistantText(summary){const messages=[];for(const event of summary?.events??[])if(event?.type==='item.completed'&&event.item?.type==='agent_message'&&typeof event.item.text==='string'&&event.item.text.trim())messages.push(event.item.text.trim());if(!messages.length)throw new CodexCliError('Codex final assistant output is missing',{code:'CODEX_ASSISTANT_OUTPUT_MISSING'});return messages.at(-1);}
// P10-R0.2.2 Part F/Q: a narrow, non-mutating, filesystem-only structural
// readiness fact — never a behavioral sandbox test (that would mean
// spawning a real, quota-spending Codex call; Part F explicitly forbids
// "heavy sandbox probing periodically"). This checks the ONE thing that
// actually distinguishes a working candidate from a broken one on this
// install class (see CODEX_CLI_BINARY_CANDIDATES docstring above): does
// `<binary's...>\bin\codex.exe`'s sibling `..\codex-resources\codex-
// windows-sandbox-setup.exe` exist on disk. Zero process spawns, safe to
// call as often as any other cheap structural check (e.g. `existsSync`
// elsewhere in this codebase) — Connection Center's existing manual/
// explicit-refresh capability surface (pm-connection-probe.mjs) is the
// intended caller, never a periodic background timer.
export function probeCodexWindowsSandboxHelper(binary){
  if(process.platform!=='win32')return Object.freeze({sandboxReadiness:'UNKNOWN',helperResolution:'UNKNOWN',helperPath:null});
  if(typeof binary!=='string'||!binary)return Object.freeze({sandboxReadiness:'UNAVAILABLE',helperResolution:'UNKNOWN',helperPath:null});
  try{
    const binDir=dirname(binary); // .../bin
    const packageRoot=dirname(binDir); // the standalone package (or install) root
    const helperPath=join(packageRoot,'codex-resources','codex-windows-sandbox-setup.exe');
    const found=existsSync(helperPath);
    return Object.freeze({sandboxReadiness:found?'READY':'DEGRADED',helperResolution:found?'FOUND':'MISSING',helperPath:found?helperPath:null});
  }catch{
    return Object.freeze({sandboxReadiness:'UNKNOWN',helperResolution:'UNKNOWN',helperPath:null});
  }
}
// P10-R0.2.2 Part G/H: execution-TIME sandbox failure classification —
// reads ONLY the already-captured stdout JSONL events (never a second
// probe call, never new I/O). Live-proven signature (docs/p10/08_...md):
// a `command_execution` item that completes with `status:"failed"` and an
// `aggregated_output` containing Codex's own `orchestrator_helper_launch_
// failed`/"windows sandbox:" marker text. Deliberately never treats this
// as a transport failure on its own (Part H: exit 0 only proves process
// completion, never PM task success OR failure by itself) — it is purely
// classification evidence attached alongside whatever real decision
// parseDecision()/normalizePmDecision() eventually accept or reject from
// the assistant's own text (production-pm-backend-registry.mjs).
const SANDBOX_FAILURE_MARKER=/orchestrator_helper_launch_failed|windows sandbox:/i;
export function classifyCodexSandboxExecution(summary){
  const events=Array.isArray(summary?.events)?summary.events:[];
  let attempted=false;
  let failed=false;
  for(const event of events){
    if(event?.type!=='item.completed')continue;
    const item=event.item;
    if(item?.type!=='command_execution')continue;
    attempted=true;
    if(item.status==='failed'&&SANDBOX_FAILURE_MARKER.test(String(item.aggregated_output??'')))failed=true;
  }
  if(failed)return Object.freeze({helperExecution:'FAILED',sandboxFailureCode:'CODEX_SANDBOX_UNAVAILABLE'});
  if(!attempted)return Object.freeze({helperExecution:'NOT_ATTEMPTED',sandboxFailureCode:null});
  return Object.freeze({helperExecution:'OK',sandboxFailureCode:null});
}
// DSH-TIMEOUT-1 Part D (audit Finding T-3): the ONE named source of truth
// for this bridge's own default timeout — reused (never re-hardcoded) as
// this function's own default parameter value below AND as the floor
// production-pm-backend-registry.mjs's production call site now forwards
// against, so a direct/non-production caller that omits `timeoutMs`
// (a test, a script) keeps getting the exact same 180s it always did,
// while production execution always passes an explicit, policy-derived
// value that can raise this floor (e.g. the LONG/implementation classes)
// but never silently lower it below what already worked.
export const CODEX_CLI_DEFAULT_TIMEOUT_MS = 180_000;
// P6-W3-R4 Part F2: `reasoning` is DSH's typed profile.reasoning value,
// passed through as Codex's documented `-c model_reasoning_effort=<value>`
// config override — never invented, never applied unless the profile
// actually configured one (see pm-reasoning-capability.mjs).
export function runCodexCliProcess({binary=resolveCodexCliBinary(),cwd=process.cwd(),prompt,model,reasoning,timeoutMs=CODEX_CLI_DEFAULT_TIMEOUT_MS,spawnImpl=spawn}={}){required(prompt,'prompt');const args=['exec','--ephemeral','--dangerously-bypass-approvals-and-sandbox','--skip-git-repo-check','--json','--color','never'];if(model)args.push('--model',required(model,'model'));if(reasoning)args.push('-c',`model_reasoning_effort=${required(reasoning,'reasoning')}`);args.push('-');return run(binary,args,{cwd,prompt,timeoutMs,summarize:summarizeCodexCliRun,ErrorType:CodexCliError,prefix:'Codex',spawnImpl});}
function concrete(base){return process.platform==='win32'&&!/\.(exe|cmd|bat)$/i.test(base)?[base,`${base}.exe`,`${base}.cmd`,`${base}.bat`]:[base];}
function required(value,label){if(typeof value!=='string'||!value.trim())throw new CodexCliError(`${label} must be a non-empty string`,{code:'INVALID_CODEX_CLI_INPUT'});return value;}
function safe(value){return String(value??'').replace(/(?:postgres(?:ql)?|https?):\/\/\S+/gi,'[REDACTED_URL]').replace(/bearer\s+\S+/gi,'Bearer [REDACTED]').slice(0,2000);}
// DSH-TIMEOUT-1 Part E (Finding T-4): the timeout branch's `child.kill()`
// is replaced with `reapOwnedChildProcess(child)` — see provider-child-
// policy.mjs's docstring — reusing the SAME bounded owned-process-tree
// cleanup owner-cancel/shutdown already gets instead of an immediate-
// child-only kill; falls back to the exact prior `child.kill()` for any
// direct/test caller whose `spawnImpl` was never wrapped by the
// production registry.
function run(binary,args,{cwd,prompt,timeoutMs,summarize,ErrorType,prefix,spawnImpl}){return new Promise((resolve,reject)=>{const startedAt=Date.now();const streams=createStreamSummaryAccumulator();const child=spawnImpl(binary,args,{cwd,stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false,env:buildProviderChildEnv({provider:'codex',sourceEnv:codexSourceEnv()})});let stdout='',stderr='',settled=false;const timer=setTimeout(async()=>{if(settled)return;settled=true;await reapOwnedChildProcess(child);reject(new ErrorType(`${prefix} process timed out`,{code:`${prefix.toUpperCase()}_TIMEOUT`,timeoutMs,elapsedMs:Date.now()-startedAt,processPid:child?.pid??null,assistantOutputPresent:streams.snapshot().stdout_total_bytes>0,terminationRequestedByDsh:true,streamSummary:streams.snapshot()}));},timeoutMs);child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdin?.on?.('error',error=>{if(settled)return;settled=true;clearTimeout(timer);reject(new ErrorType(`failed to send prompt to ${prefix}: ${error.message}`,{code:`${prefix.toUpperCase()}_STDIN_FAILED`,cause:error,streamSummary:streams.snapshot()}));});child.stdout.on('data',v=>{stdout+=v;streams.stdout(v);});child.stderr.on('data',v=>{stderr+=v;streams.stderr(v);});child.once('error',error=>{if(settled)return;settled=true;clearTimeout(timer);reject(new ErrorType(`${prefix} process spawn failed`,{code:`${prefix.toUpperCase()}_SPAWN_FAILED`,cause:error,streamSummary:streams.snapshot()}));});child.once('close',code=>{if(settled)return;settled=true;clearTimeout(timer);const summary=summarize({stdout,stderr:safe(stderr),code});if(code!==0)return reject(new ErrorType(`${prefix} process failed (${code}): ${safe(stderr)}`,{code:`${prefix.toUpperCase()}_RUN_FAILED`,exitCode:code,summary,streamSummary:streams.snapshot()}));resolve(summary);});child.stdin?.end?.(prompt);});}
