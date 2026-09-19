import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';import {PassThrough} from 'node:stream';
import {CodexCliError,extractCodexAssistantText,resolveCodexCliBinary,runCodexCliProcess,summarizeCodexCliRun} from '../src/session/codex-cli-session-bridge.mjs';
import {GrokCliError,extractGrokAssistantText,runGrokCliProcess,summarizeGrokCliRun} from '../src/session/grok-cli-session-bridge.mjs';
import {resolveGrokBinary} from '../src/session/grok-acp-client.mjs';import {ProductionPmBackendRegistry} from '../src/pm/production-pm-backend-registry.mjs';

function fakeSpawn({stdout='',stderr='',code=0,hang=false,capture={}}={}){return(binary,args,options)=>{Object.assign(capture,{binary,args,options});const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{child.killed=true;};queueMicrotask(()=>{if(hang)return;child.stdout.end(stdout);child.stderr.end(stderr);queueMicrotask(()=>child.emit('close',code));});return child;};}
const codexJson=text=>[JSON.stringify({type:'thread.started',thread_id:'t'}),JSON.stringify({type:'item.completed',item:{type:'command_execution',aggregated_output:'misleading'}}),JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}),JSON.stringify({type:'turn.completed',usage:{input_tokens:1}})].join('\n');

test('binary resolvers return invokable local Codex and Grok candidates',()=>{assert.equal(typeof resolveCodexCliBinary(),'string');assert.equal(typeof resolveGrokBinary(),'string');});
test('Codex summarizer extracts only final completed assistant messages',()=>{const summary=summarizeCodexCliRun({stdout:codexJson('{"type":"finish"}')});assert.equal(extractCodexAssistantText(summary),'{"type":"finish"}');assert.throws(()=>extractCodexAssistantText(summarizeCodexCliRun({stdout:JSON.stringify({type:'item.completed',item:{type:'command_execution',text:'fake'}})})),e=>e.code==='CODEX_ASSISTANT_OUTPUT_MISSING');});
test('Grok summarizer trusts only top-level final text',()=>{const summary=summarizeGrokCliRun({stdout:JSON.stringify({text:'{"type":"finish"}',thought:'misleading'})});assert.equal(extractGrokAssistantText(summary),'{"type":"finish"}');assert.throws(()=>extractGrokAssistantText(summarizeGrokCliRun({stdout:JSON.stringify({thought:'fake'})})),e=>e.code==='GROK_ASSISTANT_OUTPUT_MISSING');});
test('Codex process success is shell-free, cwd-isolated, and passes model',async()=>{const capture={};const out=await runCodexCliProcess({binary:'codex-safe',cwd:'C:/project',prompt:'p',model:'m-safe',spawnImpl:fakeSpawn({stdout:codexJson('ok'),capture})});assert.equal(extractCodexAssistantText(out),'ok');assert.equal(capture.options.shell,false);assert.equal(capture.options.cwd,'C:/project');assert.deepEqual(capture.args.slice(capture.args.indexOf('--model'),capture.args.indexOf('--model')+2),['--model','m-safe']);});
// P11-R5/R5.1 Part T/AD: canonical PM-profile `reasoning` must actually
// translate to Codex's documented `-c model_reasoning_effort=<value>`
// config-key argument — profile reasoning is identity; this proves it is
// really APPLIED, not merely stored. Covers every level pm-reasoning-
// capability.mjs's codex entry allows, live-verified via `codex debug
// models` (src/pm/codex-model-catalogue.mjs): low/medium/high/xhigh/max/
// ultra — "minimal" was never proven live and has been removed.
for(const level of ['low','medium','high','xhigh','max','ultra']){
  test(`Codex reasoning "${level}" translates to -c model_reasoning_effort=${level}`,async()=>{const capture={};await runCodexCliProcess({binary:'codex-safe',cwd:'C:/project',prompt:'p',model:'gpt-5.6-sol',reasoning:level,spawnImpl:fakeSpawn({stdout:codexJson('ok'),capture})});const i=capture.args.indexOf('-c');assert.notEqual(i,-1);assert.equal(capture.args[i+1],`model_reasoning_effort=${level}`);});
}
test('Codex omits -c model_reasoning_effort entirely when no reasoning is set (default/inherited)',async()=>{const capture={};await runCodexCliProcess({binary:'codex-safe',cwd:'C:/project',prompt:'p',model:'gpt-5.6-sol',spawnImpl:fakeSpawn({stdout:codexJson('ok'),capture})});assert.equal(capture.args.includes('-c'),false);});
test('Grok process success is shell-free, cwd-isolated, and passes model',async()=>{const capture={};const out=await runGrokCliProcess({binary:'grok-safe',cwd:'C:/project',prompt:'p',model:'grok-m',spawnImpl:fakeSpawn({stdout:JSON.stringify({text:'ok'}),capture})});assert.equal(extractGrokAssistantText(out),'ok');assert.equal(capture.options.shell,false);assert.equal(capture.options.cwd,'C:/project');assert.ok(capture.args.includes('--single'));assert.deepEqual(capture.args.slice(capture.args.indexOf('--model'),capture.args.indexOf('--model')+2),['--model','grok-m']);});
for(const [name,run,ErrorType] of [['Codex',runCodexCliProcess,CodexCliError],['Grok',runGrokCliProcess,GrokCliError]]){
 test(`${name} process failure is typed and redacts URL diagnostics`,async()=>{await assert.rejects(run({prompt:'p',spawnImpl:fakeSpawn({stderr:'https://user:password@example.invalid/private',code:7})}),e=>e instanceof ErrorType&&!e.message.includes('password@example'));});
 test(`${name} timeout is typed and bounded`,async()=>{await assert.rejects(run({prompt:'p',timeoutMs:5,spawnImpl:fakeSpawn({hang:true})}),e=>e instanceof ErrorType&&e.code.endsWith('_TIMEOUT'));});
}
test('registry resolves Codex and preserves strict decision parsing',async()=>{let input;const registry=new ProductionPmBackendRegistry({probe:()=>true,codexBinary:'codex',grokBinary:'grok',codexRunner:async value=>(input=value,summarizeCodexCliRun({stdout:codexJson('{"type":"finish","output":"codex-ok"}')}))});const profile={id:'c',product:'codex',transport:'stdio',session_kind:'STATELESS',model:'x'};const decision=await registry.resolve(profile,{project:{repo_path:'C:/isolated'}}).decide({turn:0,request:{},history:[]});assert.deepEqual(decision,{type:'finish',output:'codex-ok'});assert.equal(input.cwd,'C:/isolated');assert.equal(input.model,'x');});
test('registry resolves Grok and preserves strict decision parsing',async()=>{let input;const registry=new ProductionPmBackendRegistry({probe:()=>true,codexBinary:'codex',grokBinary:'grok',grokRunner:async value=>(input=value,summarizeGrokCliRun({stdout:JSON.stringify({text:'{"type":"finish","output":"grok-ok"}'})}))});const profile={id:'g',product:'grok',transport:'stdio',session_kind:'STATELESS'};assert.deepEqual(await registry.resolve(profile,{project:{repo_path:'C:/isolated'}}).decide({turn:0,request:{},history:[]}),{type:'finish',output:'grok-ok'});assert.equal(input.cwd,'C:/isolated');});
test('new production adapters fail readiness when binaries are unavailable',()=>{const registry=new ProductionPmBackendRegistry({probe:binary=>!['missing-codex','missing-grok'].includes(binary),codexBinary:'missing-codex',grokBinary:'missing-grok'});for(const product of ['codex','grok'])assert.equal(registry.inspect({product,transport:'stdio',session_kind:'STATELESS'}).available,false);});
test('strict PM parser rejects arbitrary backend prose',async()=>{const registry=new ProductionPmBackendRegistry({probe:()=>true,codexRunner:async()=>summarizeCodexCliRun({stdout:codexJson('not-json')})});await assert.rejects(registry.resolve({id:'c',product:'codex',transport:'stdio',session_kind:'STATELESS'},{project:{repo_path:'C:/p'}}).decide({turn:0}),e=>e.code==='PM_DECISION_PARSE_FAILED');});
// M06 regression: a real CLI backend that returns a syntactically valid
// {"type":"finish"} with a missing/blank `output` must fail closed
// (PM_DECISION_EMPTY_OUTPUT -> the durable PM run becomes 'failed' with a
// clear error) rather than silently completing with nothing to show the
// owner. Proven for both a bare-omitted output and a whitespace-only one,
// and that a genuine non-empty output still parses normally.
test('a finish decision with no output fails closed instead of silently completing blank',async()=>{
  const registry=new ProductionPmBackendRegistry({probe:()=>true,codexRunner:async()=>summarizeCodexCliRun({stdout:codexJson('{"type":"finish"}')})});
  await assert.rejects(registry.resolve({id:'c',product:'codex',transport:'stdio',session_kind:'STATELESS'},{project:{repo_path:'C:/p'}}).decide({turn:0}),e=>e.code==='PM_DECISION_EMPTY_OUTPUT');
});
test('a finish decision with a whitespace-only output also fails closed',async()=>{
  const registry=new ProductionPmBackendRegistry({probe:()=>true,codexRunner:async()=>summarizeCodexCliRun({stdout:codexJson('{"type":"finish","output":"   "}')})});
  await assert.rejects(registry.resolve({id:'c',product:'codex',transport:'stdio',session_kind:'STATELESS'},{project:{repo_path:'C:/p'}}).decide({turn:0}),e=>e.code==='PM_DECISION_EMPTY_OUTPUT');
});
test('a finish decision with real output still parses normally (regression)',async()=>{
  const registry=new ProductionPmBackendRegistry({probe:()=>true,codexRunner:async()=>summarizeCodexCliRun({stdout:codexJson('{"type":"finish","output":"repo: dsh-p6-test-b, branch: main"}')})});
  const decision=await registry.resolve({id:'c',product:'codex',transport:'stdio',session_kind:'STATELESS'},{project:{repo_path:'C:/p'}}).decide({turn:0});
  assert.deepEqual(decision,{type:'finish',output:'repo: dsh-p6-test-b, branch: main'});
});
test('a non-finish decision (e.g. await_owner) is unaffected by the empty-output guard',async()=>{
  const registry=new ProductionPmBackendRegistry({probe:()=>true,codexRunner:async()=>summarizeCodexCliRun({stdout:codexJson('{"type":"await_owner","kind":"question","title":"t","prompt":"p","allowedResponses":["YES"]}')})});
  const decision=await registry.resolve({id:'c',product:'codex',transport:'stdio',session_kind:'STATELESS'},{project:{repo_path:'C:/p'}}).decide({turn:0});
  assert.equal(decision.type,'await_owner');
});
test('capability descriptors are backend truth without credentials',async()=>{const registry=new ProductionPmBackendRegistry({probe:()=>true,codexBinary:'codex',grokBinary:'grok'}),by=new Map((await registry.capabilities()).map(v=>[v.product,v]));assert.deepEqual(registry.list().map(v=>v.product),['claude-code','opencode','codex','grok','antigravity','api']);for(const product of ['codex','grok']){const value=by.get(product);assert.equal(value.transport,'stdio');assert.equal(value.cliInstalled,true);assert.equal(value.dshBackendAvailable,true);assert.deepEqual(value.sessionKinds,['STATELESS']);assert.equal(value.modelSelection,true);assert.equal(value.loginCommandSupported,true);assert.equal(value.logoutCommandSupported,true);assert.equal(JSON.stringify(value).includes('token'),false);}});
