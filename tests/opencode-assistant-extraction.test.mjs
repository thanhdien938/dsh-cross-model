import test from 'node:test';
import assert from 'node:assert/strict';
import {extractOpenCodeAssistantText,OpenCodeSessionError} from '../src/session/opencode-cli-session-bridge.mjs';
import {ProductionPmBackendRegistry} from '../src/pm/production-pm-backend-registry.mjs';

const start={type:'step_start',part:{type:'step-start'},sessionID:'session'};
const finish={type:'step_finish',part:{type:'step-finish'},sessionID:'session'};

test('OpenCode extraction selects assistant text when final event is bookkeeping',()=>{const summary={events:[start,{type:'text',part:{type:'text',text:'{"type":"finish","output":"ok"}'}},finish]};assert.equal(extractOpenCodeAssistantText(summary),'{"type":"finish","output":"ok"}');});
test('OpenCode extraction reconstructs ordered multi-part assistant text',()=>{const summary={events:[start,{type:'text',part:{type:'text',text:'{"type":"finish",'}},{type:'tool',part:{type:'tool',text:'ignored'}},{type:'text',part:{type:'text',text:'"output":"ok"}'}},finish]};assert.equal(extractOpenCodeAssistantText(summary),'{"type":"finish","output":"ok"}');});
test('OpenCode extraction removes observed zero-width transport markers only at text boundaries',()=>{const summary={events:[start,{type:'text',part:{type:'text',text:'\u200b{"type":"finish","output":"ok"}\ufeff'}},finish]};assert.equal(extractOpenCodeAssistantText(summary),'{"type":"finish","output":"ok"}');});
test('OpenCode extraction ignores unrelated text-shaped metadata and fails typed when assistant text is absent',()=>{assert.throws(()=>extractOpenCodeAssistantText({events:[start,{type:'metadata',part:{type:'text',text:'not assistant'}},finish]}),error=>error instanceof OpenCodeSessionError&&error.code==='OPENCODE_ASSISTANT_OUTPUT_MISSING');});
test('production OpenCode registry uses explicit extraction, strict provider invocation, and parses finish contract',async()=>{let invoked;const registry=new ProductionPmBackendRegistry({probe:()=>true,openCodeBinary:'opencode',openCodeRunner:async input=>(invoked=input,{events:[start,{type:'text',part:{type:'text',text:'{"type":"finish","output":"real shape"}'}},finish]})});const driver=registry.resolve({id:'pm',product:'opencode',transport:'stdio',session_kind:'STATELESS'},{project:{id:'p',repo_path:'C:/repo'}});assert.deepEqual(await driver.decide({turn:0,request:{objective:'x'},history:[]}),{type:'finish',output:'real shape'});assert.match(invoked.prompt,/first character must be \{/);assert.doesNotMatch(invoked.prompt,/Claude/);});
