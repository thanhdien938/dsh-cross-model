import {spawn} from 'node:child_process';
import {resolveGrokBinary} from './grok-acp-client.mjs';
import {buildProviderChildEnv,reapOwnedChildProcess} from './provider-child-policy.mjs';

export class GrokCliError extends Error{constructor(message,extra={}){super(message);this.name='GrokCliError';this.code=extra.code??'GROK_CLI_ERROR';Object.assign(this,extra);}}
export const GROK_CLI_CAPABILITIES=Object.freeze({product:'grok',transport:'stdio',session_kind:'STATELESS',modelSelection:true,loginCommandSupported:true,logoutCommandSupported:true,structuredOutput:true,usageTelemetry:true});
export function summarizeGrokCliRun({stdout='',stderr='',code=null}={}){let output=null;try{output=JSON.parse(String(stdout).trim());}catch{}return{code,output,stdout,stderr};}
export function extractGrokAssistantText(summary){const text=summary?.output?.text;if(typeof text!=='string'||!text.trim())throw new GrokCliError('Grok final assistant output is missing',{code:'GROK_ASSISTANT_OUTPUT_MISSING'});return text.trim();}
// P6-W3-R4 Part F2: `reasoning` is DSH's typed profile.reasoning value,
// passed through as-is to Grok's documented --reasoning-effort flag. Grok's
// own --help does not enumerate accepted values (see
// pm-reasoning-capability.mjs), so DSH never invents/validates a level
// list here — the value is only ever what the owner explicitly typed.
// DSH-TIMEOUT-1 Part D (audit Finding T-3): see CODEX_CLI_DEFAULT_TIMEOUT_MS's
// identical docstring (codex-cli-session-bridge.mjs) — the ONE named source
// of truth for this bridge's own default, reused as both this function's
// default parameter and production-pm-backend-registry.mjs's forwarding
// floor.
export const GROK_CLI_DEFAULT_TIMEOUT_MS = 180000;
export function runGrokCliProcess({binary=resolveGrokBinary(),cwd=process.cwd(),prompt,model,reasoning,timeoutMs=GROK_CLI_DEFAULT_TIMEOUT_MS,spawnImpl=spawn}={}){required(prompt,'prompt');const args=['--cwd',cwd,'--single',prompt,'--output-format','json','--permission-mode','bypassPermissions','--sandbox','off','--no-plan','--no-subagents'];if(model)args.push('--model',required(model,'model'));if(reasoning)args.push('--reasoning-effort',required(reasoning,'reasoning'));return new Promise((resolve,reject)=>{const child=spawnImpl(binary,args,{cwd,stdio:['ignore','pipe','pipe'],windowsHide:true,shell:false,env:buildProviderChildEnv({provider:'grok'})});let stdout='',stderr='',settled=false;const timer=setTimeout(async()=>{if(settled)return;settled=true;await reapOwnedChildProcess(child);reject(new GrokCliError('Grok process timed out',{code:'GROK_TIMEOUT'}));},timeoutMs);child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',v=>stdout+=v);child.stderr.on('data',v=>stderr+=v);child.once('error',error=>{if(settled)return;settled=true;clearTimeout(timer);reject(new GrokCliError('Grok process spawn failed',{code:'GROK_SPAWN_FAILED',cause:error}));});child.once('close',code=>{if(settled)return;settled=true;clearTimeout(timer);const summary=summarizeGrokCliRun({stdout,stderr:safe(stderr),code});if(code!==0)return reject(new GrokCliError(`Grok process failed (${code}): ${safe(stderr)}`,{code:'GROK_RUN_FAILED',exitCode:code,summary}));resolve(summary);});});}
function required(value,label){if(typeof value!=='string'||!value.trim())throw new GrokCliError(`${label} must be a non-empty string`,{code:'INVALID_GROK_CLI_INPUT'});return value;}
function safe(value){return String(value??'').replace(/(?:postgres(?:ql)?|https?):\/\/\S+/gi,'[REDACTED_URL]').replace(/bearer\s+\S+/gi,'Bearer [REDACTED]').slice(0,2000);}
