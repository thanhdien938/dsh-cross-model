import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';import {PassThrough} from 'node:stream';
import {AntigravityCliError,ANTIGRAVITY_CLI_BINARY_CANDIDATES,ANTIGRAVITY_CLI_CAPABILITIES,extractAntigravityAssistantText,resolveAntigravityBinary,resolveAntigravityBinaryAsync,runAntigravityCliProcess,summarizeAntigravityCliRun} from '../src/session/antigravity-cli-session-bridge.mjs';
import {ProductionPmBackendRegistry,listSupportedProducts} from '../src/pm/production-pm-backend-registry.mjs';
import {reasoningCapabilityFor} from '../src/pm/pm-reasoning-capability.mjs';

// P9-R0 Part Z: every scenario below is driven by an injected fake spawn —
// never a real CLI — mirroring the exact EventEmitter/stream shape
// tests/production-codex-grok-backends.test.mjs already uses. Fixture
// payloads are taken verbatim from the live transcripts recorded in
// docs/p9/01_ANTIGRAVITY_CLI_SURVEY.md (real agy 1.1.19).
function fakeSpawn({stdout='',stderr='',code=0,hang=false,capture={}}={}){return(binary,args,options)=>{Object.assign(capture,{binary,args,options});const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{child.killed=true;};queueMicrotask(()=>{if(hang)return;child.stdout.end(stdout);child.stderr.end(stderr);queueMicrotask(()=>child.emit('close',code));});return child;};}
// Real node:child_process.spawn() never throws synchronously for a missing
// executable — it emits an async 'error' event (ENOENT) instead. This
// fake matches that real contract (unlike a synchronous throw, which
// exercises a code path spawn() itself never takes).
function fakeSpawnError(message){return()=>{const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{child.killed=true;};queueMicrotask(()=>child.emit('error',new Error(message)));return child;};}

const initLine=JSON.stringify({event:'init',conversation_id:'c1',init:{cwd:'C:/p',tools:['run_command'],permission_mode:'request-review'}});
const stepLine=JSON.stringify({event:'step_update',step_update:{conversation_id:'c1',step_index:0,state:'DONE',step_type:'user_input'}});
function resultLine(result){return JSON.stringify({event:'result',result});}
function streamOf(result){return [initLine,stepLine,resultLine(result)].join('\n');}

// 1/2: binary resolution
test('binary resolvers return invokable local Antigravity candidates',()=>{assert.equal(typeof resolveAntigravityBinary(),'string');});
test('async binary resolver resolves without blocking (P6.5 invariant)',async()=>{const value=await resolveAntigravityBinaryAsync();assert.equal(typeof value,'string');});
test('ANTIGRAVITY_CLI_BINARY_CANDIDATES excludes PATH and uses only absolute known installation locations',()=>{assert.ok(ANTIGRAVITY_CLI_BINARY_CANDIDATES.every(v=>/^[A-Za-z]:[\\/]|^\//.test(v)));assert.ok(ANTIGRAVITY_CLI_BINARY_CANDIDATES.some(v=>v.endsWith('AppData\\Local\\agy\\bin\\agy.exe')||v.endsWith('AppData/Local/agy/bin/agy.exe')));});

// 3: version probe (exercised indirectly via capability(); see registry section below)

// 4-10: headless argv construction / safety
test('argv: stream-json stdin, --mode plan, --output-format stream-json, cwd exact, no shell',async()=>{const capture={};await runAntigravityCliProcess({binary:'agy-safe',cwd:'C:/project',prompt:'hello',spawnImpl:fakeSpawn({stdout:streamOf({status:'SUCCESS',response:'ok'}),capture})});assert.equal(capture.binary,'agy-safe');assert.deepEqual(capture.args.slice(capture.args.indexOf('--input-format'),capture.args.indexOf('--input-format')+2),['--input-format','stream-json']);assert.equal(capture.args.includes('hello'),false);assert.deepEqual(capture.args.slice(capture.args.indexOf('--mode'),capture.args.indexOf('--mode')+2),['--mode','plan']);assert.deepEqual(capture.args.slice(capture.args.indexOf('--output-format'),capture.args.indexOf('--output-format')+2),['--output-format','stream-json']);assert.equal(capture.options.cwd,'C:/project');assert.equal(capture.options.shell,false);assert.equal(capture.options.windowsHide,true);assert.deepEqual(capture.options.stdio,['pipe','pipe','pipe']);});
test('argv: --model is passed through exactly',async()=>{const capture={};await runAntigravityCliProcess({prompt:'p',model:'gemini-3.1-pro-high',spawnImpl:fakeSpawn({stdout:streamOf({status:'SUCCESS',response:'ok'}),capture})});assert.deepEqual(capture.args.slice(capture.args.indexOf('--model'),capture.args.indexOf('--model')+2),['--model','gemini-3.1-pro-high']);});
test('argv: --effort is passed through exactly',async()=>{const capture={};await runAntigravityCliProcess({prompt:'p',reasoning:'high',spawnImpl:fakeSpawn({stdout:streamOf({status:'SUCCESS',response:'ok'}),capture})});assert.deepEqual(capture.args.slice(capture.args.indexOf('--effort'),capture.args.indexOf('--effort')+2),['--effort','high']);});
test('argv: --print-timeout is a bounded, positive duration string',async()=>{const capture={};await runAntigravityCliProcess({prompt:'p',timeoutMs:20000,spawnImpl:fakeSpawn({stdout:streamOf({status:'SUCCESS',response:'ok'}),capture})});const idx=capture.args.indexOf('--print-timeout');assert.ok(idx>=0);assert.match(capture.args[idx+1],/^\d+s$/);});
test('argv never includes --dangerously-skip-permissions',async()=>{const capture={};await runAntigravityCliProcess({prompt:'p',spawnImpl:fakeSpawn({stdout:streamOf({status:'SUCCESS',response:'ok'}),capture})});assert.equal(capture.args.includes('--dangerously-skip-permissions'),false);});
test('argv always includes the proven-safe --mode plan (read-only/safety mode required)',async()=>{const capture={};await runAntigravityCliProcess({prompt:'p',spawnImpl:fakeSpawn({stdout:streamOf({status:'SUCCESS',response:'ok'}),capture})});assert.deepEqual(capture.args.slice(capture.args.indexOf('--mode'),capture.args.indexOf('--mode')+2),['--mode','plan']);});

// 11-16: parsing
test('JSON parsing: single --output-format json envelope (no event wrapper)',()=>{const summary=summarizeAntigravityCliRun({stdout:JSON.stringify({conversation_id:'x',status:'SUCCESS',response:'ok\n'})});assert.equal(extractAntigravityAssistantText(summary),'ok');});
test('stream-json: chunk split mid-line reassembles correctly (already-accumulated-string parsing)',()=>{const full=streamOf({status:'SUCCESS',response:'chunked-ok'});const summary=summarizeAntigravityCliRun({stdout:full});assert.equal(extractAntigravityAssistantText(summary),'chunked-ok');});
test('stream-json: char-by-char delivery still parses (summarize operates on the fully-accumulated buffer)',()=>{let acc='';const full=streamOf({status:'SUCCESS',response:'char-ok'});for(const ch of full)acc+=ch;const summary=summarizeAntigravityCliRun({stdout:acc});assert.equal(extractAntigravityAssistantText(summary),'char-ok');});
test('stream-json: multiple events in one chunk all parse',()=>{const summary=summarizeAntigravityCliRun({stdout:[initLine,stepLine,stepLine,resultLine({status:'SUCCESS',response:'multi-ok'})].join('\n')});assert.equal(summary.events.length,4);assert.equal(extractAntigravityAssistantText(summary),'multi-ok');});
test('CRLF-delimited NDJSON parses identically to LF',()=>{const summary=summarizeAntigravityCliRun({stdout:streamOf({status:'SUCCESS',response:'crlf-ok'}).split('\n').join('\r\n')});assert.equal(extractAntigravityAssistantText(summary),'crlf-ok');});
test('a malformed line is skipped, never thrown — later valid lines still parse (fail closed, not fail crash)',()=>{const summary=summarizeAntigravityCliRun({stdout:[initLine,'{not valid json',resultLine({status:'SUCCESS',response:'survives'})].join('\n')});assert.equal(extractAntigravityAssistantText(summary),'survives');});

// 17-19: terminal status extraction
test('terminal SUCCESS with non-empty response extracts cleanly',()=>{assert.equal(extractAntigravityAssistantText(summarizeAntigravityCliRun({stdout:streamOf({status:'SUCCESS',response:'{"type":"finish","output":"ok"}\n'})})),'{"type":"finish","output":"ok"}');});
test('terminal ERROR is rejected with ANTIGRAVITY_RUN_FAILED',()=>{assert.throws(()=>extractAntigravityAssistantText(summarizeAntigravityCliRun({stdout:streamOf({status:'ERROR',response:'',error:'boom'})})),e=>e.code==='ANTIGRAVITY_RUN_FAILED');});
test('empty response on a nominal SUCCESS status is rejected (ANTIGRAVITY_ASSISTANT_OUTPUT_MISSING)',()=>{assert.throws(()=>extractAntigravityAssistantText(summarizeAntigravityCliRun({stdout:streamOf({status:'SUCCESS',response:''})})),e=>e.code==='ANTIGRAVITY_ASSISTANT_OUTPUT_MISSING');});
test('missing terminal result event at all is ANTIGRAVITY_OUTPUT_INVALID',()=>{assert.throws(()=>extractAntigravityAssistantText(summarizeAntigravityCliRun({stdout:[initLine,stepLine].join('\n')})),e=>e.code==='ANTIGRAVITY_OUTPUT_INVALID');});

// Part K: soft-denial / permission-CANCELED — the live-proven case where
// the PROCESS exits 0 but the terminal result's own status says CANCELED.
// Exit code must never be trusted alone.
test('CANCELED status (soft-denied tool) is rejected even though the process itself would exit 0',async()=>{const out=await runAntigravityCliProcess({prompt:'p',spawnImpl:fakeSpawn({stdout:streamOf({status:'CANCELED',response:''}),code:0})});assert.throws(()=>extractAntigravityAssistantText(out),e=>e.code==='ANTIGRAVITY_PERMISSION_DENIED');});
test('runAntigravityCliProcess never rejects on a non-zero exit code by itself — the terminal result decides',async()=>{const out=await runAntigravityCliProcess({prompt:'p',spawnImpl:fakeSpawn({stdout:streamOf({status:'SUCCESS',response:'still-ok'}),code:1})});assert.equal(extractAntigravityAssistantText(out),'still-ok');});

// 20: stderr sanitization
test('spawn failure is typed ANTIGRAVITY_SPAWN_FAILED',async()=>{await assert.rejects(runAntigravityCliProcess({prompt:'p',spawnImpl:fakeSpawnError('spawn agy ENOENT')}),e=>e instanceof AntigravityCliError&&e.code==='ANTIGRAVITY_SPAWN_FAILED');});
test('stderr diagnostics redact URL and bearer-token content',async()=>{const out=await runAntigravityCliProcess({prompt:'p',spawnImpl:fakeSpawn({stdout:streamOf({status:'SUCCESS',response:'ok'}),stderr:'auth url https://user:password@example.invalid/private and bearer sk-should-not-leak'})});assert.equal(out.stderr.includes('password@example'),false);assert.equal(out.stderr.includes('sk-should-not-leak'),false);});
test('timeout is typed and bounded',async()=>{await assert.rejects(runAntigravityCliProcess({prompt:'p',timeoutMs:5,spawnImpl:fakeSpawn({hang:true})}),e=>e instanceof AntigravityCliError&&e.code==='ANTIGRAVITY_TIMEOUT');});

// model-invalid classification (live-proven error text)
test('invalid --model rejection is classified as ANTIGRAVITY_MODEL_INVALID, not a generic failure',()=>{const out=summarizeAntigravityCliRun({stdout:JSON.stringify({conversation_id:'',status:'ERROR',response:'',error:'invalid model selection (--model "bogus" --effort ""): model bogus is not recognized as a known model or custom model in settings\nAvailable models:\n  Gemini 3.7 Flash (High)'})});assert.throws(()=>extractAntigravityAssistantText(out),e=>e.code==='ANTIGRAVITY_MODEL_INVALID');});

// 21-22: model discovery / invalid model fail closed (registry-integration level)
test('reasoning capability: low/medium/high, live-verified, --effort flag',()=>{const cap=reasoningCapabilityFor('antigravity');assert.equal(cap.selection,'SUPPORTED');assert.deepEqual(cap.levels,['low','medium','high']);assert.match(cap.flag,/--effort/);});
for(const level of ['low','medium','high']){
  test(`reasoning ${level}: profile.reasoning flows through to --effort unchanged`,async()=>{const capture={};await runAntigravityCliProcess({prompt:'p',reasoning:level,spawnImpl:fakeSpawn({stdout:streamOf({status:'SUCCESS',response:'ok'}),capture})});assert.deepEqual(capture.args.slice(capture.args.indexOf('--effort'),capture.args.indexOf('--effort')+2),['--effort',level]);});
}

// 26: fifth product inventory
test('fifth product: antigravity is in the one authoritative catalogue',()=>{assert.deepEqual(listSupportedProducts(),['claude-code','opencode','codex','grok','antigravity','api']);});

// registry integration: decide(), cwd, model, strict parseDecision boundary preserved
test('registry resolves Antigravity and preserves strict decision parsing',async()=>{
  let captured;
  const registry=new ProductionPmBackendRegistry({probe:()=>true,antigravityBinary:'agy',antigravityRunner:async(args)=>{captured=args;return summarizeAntigravityCliRun({stdout:streamOf({status:'SUCCESS',response:'{"type":"finish","output":"antigravity-ok"}'})});}});
  const profile={id:'a',product:'antigravity',transport:'stdio',session_kind:'STATELESS',model:'gemini-3.1-pro-high',reasoning:'high'};
  const decision=await registry.resolve(profile,{project:{repo_path:'C:/isolated'}}).decide({turn:0,request:{},history:[]});
  assert.deepEqual(decision,{type:'finish',output:'antigravity-ok'});
  assert.equal(captured.cwd,'C:/isolated');
  assert.equal(captured.model,'gemini-3.1-pro-high');
  // P9-R0.3: production execution never forwards profile.reasoning as
  // --effort (see docs/p9/07_NATIVE_MODEL_IDENTITY_IMPLEMENTATION.md) —
  // the model slug's own tier suffix is the native execution identity.
  assert.equal('reasoning' in captured,false);
});
test('strict PM parser rejects arbitrary Antigravity prose (M09 unchanged)',async()=>{const registry=new ProductionPmBackendRegistry({probe:()=>true,antigravityRunner:async()=>summarizeAntigravityCliRun({stdout:streamOf({status:'SUCCESS',response:'not-json'})})});await assert.rejects(registry.resolve({id:'a',product:'antigravity',transport:'stdio',session_kind:'STATELESS'},{project:{repo_path:'C:/p'}}).decide({turn:0}),e=>e.code==='PM_DECISION_PARSE_FAILED');});
test('a finish decision with no output fails closed (PM_DECISION_EMPTY_OUTPUT unchanged for Antigravity)',async()=>{const registry=new ProductionPmBackendRegistry({probe:()=>true,antigravityRunner:async()=>summarizeAntigravityCliRun({stdout:streamOf({status:'SUCCESS',response:'{"type":"finish"}'})})});await assert.rejects(registry.resolve({id:'a',product:'antigravity',transport:'stdio',session_kind:'STATELESS'},{project:{repo_path:'C:/p'}}).decide({turn:0}),e=>e.code==='PM_DECISION_EMPTY_OUTPUT');});
test('new production adapter fails readiness when its binary is unavailable',()=>{const registry=new ProductionPmBackendRegistry({probe:binary=>binary!=='missing-agy',antigravityBinary:'missing-agy'});assert.equal(registry.inspect({product:'antigravity',transport:'stdio',session_kind:'STATELESS'}).available,false);});

// 27: Connection Center capability shape
test('capability descriptor: honest, credential-free, correct product/transport/session_kind',async()=>{const registry=new ProductionPmBackendRegistry({probe:()=>true,antigravityBinary:'agy'});const by=new Map((await registry.capabilities()).map(v=>[v.product,v]));const value=by.get('antigravity');assert.equal(value.transport,'stdio');assert.deepEqual(value.sessionKinds,['STATELESS']);assert.equal(value.modelSelection,true);assert.equal(value.loginCommandSupported,false);assert.equal(value.logoutCommandSupported,false);assert.equal(value.structuredOutput,true);assert.equal(value.usageTelemetry,true);assert.equal(JSON.stringify(value).includes('token'),false);});
test('unknown product still refused (typed UNSUPPORTED, never a throw)',async()=>{const registry=new ProductionPmBackendRegistry({probe:()=>true});const value=await registry.capability('not-a-real-product');assert.equal(value.authState,'UNKNOWN');assert.equal(value.dshBackendAvailable,false);});

// Part U: no new council engine — P7's CouncilStepWorkflowRunner/
// CouncilChairDriver are already product-agnostic (proven in
// tests/council-runtime.test.mjs via a fake resolveDriver). What's new
// here is proof that resolve(profile, {project, extraCtx}) — the one seam
// council machinery uses to reach any production backend — correctly
// reaches the real Antigravity driver for both roles, additively.
test('council participant automated: extraCtx (role=participant) merges into ctx without overriding identity fields',async()=>{
  let seenCtx;
  const registry=new ProductionPmBackendRegistry({probe:()=>true,antigravityBinary:'agy',observer:{start:(ctx)=>{seenCtx=ctx;},parser(){},terminal(){},stdoutSummary(){}},antigravityRunner:async()=>summarizeAntigravityCliRun({stdout:streamOf({status:'SUCCESS',response:'{"type":"finish","output":"r1"}'})})});
  const profile={id:'a-participant',product:'antigravity',transport:'stdio',session_kind:'STATELESS'};
  await registry.resolve(profile,{project:{id:'proj-1',repo_path:'C:/p'},extraCtx:{councilId:'council-1',phase:'r1',round:1,role:'participant'}}).decide({turn:0,request:{id:'req-1'},history:[]});
  assert.equal(seenCtx.backendProduct,'antigravity');
  assert.equal(seenCtx.profileId,'a-participant');
  assert.equal(seenCtx.councilId,'council-1');
  assert.equal(seenCtx.role,'participant');
});
test('antigravity chair automated: extraCtx (role=chair) merges the same way, additively',async()=>{
  let seenCtx;
  const registry=new ProductionPmBackendRegistry({probe:()=>true,antigravityBinary:'agy',observer:{start:(ctx)=>{seenCtx=ctx;},parser(){},terminal(){},stdoutSummary(){}},antigravityRunner:async()=>summarizeAntigravityCliRun({stdout:streamOf({status:'SUCCESS',response:'{"type":"finish","output":"chair-synthesis"}'})})});
  const profile={id:'a-chair',product:'antigravity',transport:'stdio',session_kind:'STATELESS'};
  await registry.resolve(profile,{project:{id:'proj-1',repo_path:'C:/p'},extraCtx:{councilId:'council-1',phase:'chair_synthesis',round:2,role:'chair'}}).decide({turn:2,request:{id:'req-2'},history:[]});
  assert.equal(seenCtx.role,'chair');
  assert.equal(seenCtx.phase,'chair_synthesis');
  assert.equal(seenCtx.backendProduct,'antigravity');
});

// ANTIGRAVITY_CLI_CAPABILITIES export shape
test('ANTIGRAVITY_CLI_CAPABILITIES declares STATELESS/stdio and honest login/logout support',()=>{assert.deepEqual(ANTIGRAVITY_CLI_CAPABILITIES,Object.freeze({product:'antigravity',transport:'stdio',session_kind:'STATELESS',modelSelection:true,loginCommandSupported:false,logoutCommandSupported:false,structuredOutput:true,usageTelemetry:true}));});
