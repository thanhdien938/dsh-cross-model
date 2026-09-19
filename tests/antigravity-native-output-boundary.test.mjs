import test from 'node:test';
import assert from 'node:assert/strict';
import { extractAntigravityAssistantText, summarizeAntigravityCliRun } from '../src/session/antigravity-cli-session-bridge.mjs';
import { ProductionPmBackendRegistry } from '../src/pm/production-pm-backend-registry.mjs';
import { CouncilStepWorkflowRunner } from '../src/pm/council/council-step-workflow-runner.mjs';
import { buildParticipantJsonSchema } from '../src/pm/council/participant-json-schema.mjs';
import { normalizePmDecision } from '../src/pm/pm-contracts.mjs';
const schema = buildParticipantJsonSchema('participant_critique');
const options = {structuredOutputSchema:schema};
const decision = {type:'finish',output:'synthetic native result',data:{type:'council_critique',criticisms:[],agreements:[],revised_recommendation:'synthetic revision',remaining_disagreements:[]}};
const raw = JSON.stringify(decision);
const other = JSON.stringify({...decision,output:'distinct presentation result',extra:true});
const envelope = (response, native=decision, status='SUCCESS') => ({result:{status,response,structured_output:native}});

// Presentation bytes are never normalized or selected. The native field is
// independent authority, even when response is invalid or has distinct objects.
for (const [name,response] of [
  ['one',raw],['identical',raw+'\n'+raw],['canonical',raw+'\n'+JSON.stringify(decision,null,2)],
  ['distinct',raw+'\n'+other],['valid-invalid',raw+' {}'],['invalid-valid','{} '+raw],
  ['three',[raw,other,raw].join('\n')],['prefix','prose '+raw],['suffix',raw+' prose'],
  ['fenced','```json\n'+raw+'\n```'],['truncated',raw+' {'],
  ['nested',JSON.stringify({...decision,extra:{nested:decision}})],
  ['duplicate-keys',raw.replace('"type":"finish"','"type":"finish","type":"await_owner"')],
  ['empty',''],['absent',undefined],
]) test(`native authority independent of presentation: ${name}`,()=> {
  assert.deepEqual(JSON.parse(extractAntigravityAssistantText(envelope(response),options)),decision);
});
for (const native of [null,undefined,'{}',[],42,true]) test(`missing/wrong native type ${typeof native}/${Array.isArray(native)} never falls back`,()=> {
  const summary = {result:{status:'SUCCESS',response:raw,structured_output:native}};
  assert.throws(()=>extractAntigravityAssistantText(summary,options),e=>e.code==='ANTIGRAVITY_STRUCTURED_OUTPUT_MISSING' && e.outputSource==='result.structured_output');
});
for (const status of ['ERROR','CANCELED','INTERRUPTED','INVALID','WAITING','RUNNING',undefined]) test(`native field never salvages terminal ${status}`,()=> {
  assert.throws(()=>extractAntigravityAssistantText({result:{status,response:raw,structured_output:decision}},options));
});
test('non-JSON-faithful injected native object fails closed',()=> {
  assert.throws(()=>extractAntigravityAssistantText(envelope(raw,{value:BigInt(1)}),options),e=>e.code==='ANTIGRAVITY_STRUCTURED_OUTPUT_INVALID');
});
test('ordinary free-form remains response-only even with a native field',()=> {
  assert.equal(extractAntigravityAssistantText(envelope(' '+other+' ')),other);
  assert.throws(()=>extractAntigravityAssistantText(envelope('')),e=>e.code==='ANTIGRAVITY_ASSISTANT_OUTPUT_MISSING');
});
test('select final terminal only, never recover prior structured field',()=> {
  const events=[{event:'result',result:{status:'SUCCESS',response:raw,structured_output:decision}},{event:'result',result:{status:'SUCCESS',response:raw}}];
  assert.throws(()=>extractAntigravityAssistantText(summarizeAntigravityCliRun({stdout:events.map(JSON.stringify).join('\n')}),options),e=>e.code==='ANTIGRAVITY_STRUCTURED_OUTPUT_MISSING');
});

async function runStep(native, response=raw+'\n'+other) {
  let calls=0; const diagnostics=[],provenance=[];
  const profile={id:'synthetic-native',product:'antigravity',transport:'stdio',session_kind:'STATELESS'};
  const project={id:'synthetic',repo_path:process.cwd()};
  const registry=new ProductionPmBackendRegistry({probe:()=>true,antigravityBinary:'synthetic-agy',observer:{layeredDiagnostic:(_ctx,d)=>diagnostics.push(d),context:(_ctx,d)=>provenance.push(d)},antigravityRunner:async args=> {
    calls++; assert.deepEqual(args.structuredOutputSchema,schema);
    return envelope(response,native);
  }});
  const runner=new CouncilStepWorkflowRunner({project,profileRegistry:{get:()=>profile},resolveDriver:(p,ctx)=>registry.resolve(p,ctx)});
  const outcome=await runner.run({id:'synthetic',kind:'council_step',stepKind:'participant_critique',round:1,profileId:profile.id,prompt:'Synthetic critique',isImplementationParticipant:false});
  return {handoff:outcome.finalResult.handoff,calls,diagnostics,provenance};
}
test('observed two-distinct-text-documents envelope passes real registry, parser, PM and critique validation via native field',async()=> {
  const r=await runStep(decision);
  assert.equal(r.calls,1); assert.equal(r.handoff.ok,true);
  assert.equal(r.diagnostics[0].parser_state,'PASS');
  assert.ok(r.provenance.some(d=>d.outputSource==='result.structured_output'));
  assert.deepEqual(normalizePmDecision(JSON.parse(extractAntigravityAssistantText(envelope(raw),options))),decision);
});
test('missing authoritative field fails extraction before parsing without retry',async()=> {
  const r=await runStep(null);
  assert.equal(r.calls,1); assert.equal(r.handoff.ok,false);
  assert.equal(r.diagnostics[0].parser_attempted,false);
  assert.equal(r.handoff.reason,'ANTIGRAVITY_STRUCTURED_OUTPUT_MISSING');
});
test('native object does not bypass critique validation or use valid presentation as repair',async()=> {
  const r=await runStep({...decision,data:{...decision.data,revised_recommendation:''}},raw);
  assert.equal(r.handoff.ok,false); assert.ok(r.diagnostics.every(d=>d.parser_state==='PASS'));
});
test('native object with empty finish output still fails production parser',async()=> {
  const r=await runStep({...decision,output:''});
  assert.equal(r.handoff.ok,false); assert.equal(r.diagnostics[0].parser_state,'FAIL');
});
