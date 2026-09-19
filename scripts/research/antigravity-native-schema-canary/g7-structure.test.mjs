import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectStructure, matchesSchema } from './g7-structure.mjs';
import { summarizeAntigravityCliRun, extractAntigravityAssistantText } from '../../../src/session/antigravity-cli-session-bridge.mjs';
import { buildParticipantJsonSchema } from '../../../src/pm/council/participant-json-schema.mjs';
import { createCliPmDriver } from '../../../src/pm/production-pm-backend-registry.mjs';
const schema = buildParticipantJsonSchema('participant_critique');
const decision = { type:'finish', output:'SYNTHETIC_SECRET_SENTINEL', data:{ type:'council_critique', criticisms:[], agreements:[], revised_recommendation:'SYNTHETIC_SECRET_SENTINEL', remaining_disagreements:[] } };
const raw = JSON.stringify(decision);
const inspect = response => { const result = { status:'SUCCESS',response }; return inspectStructure({events:[{event:'result',result}],result},schema); };
for (const [name,response,count,candidates,outside] of [
  ['one',raw,1,1,false], ['identical',raw+'\n'+raw,2,2,false],
  ['canonical',raw+'\n'+JSON.stringify(decision,null,2),2,2,false],
  ['distinct',raw+'\n'+JSON.stringify({...decision,output:'different'}),2,2,false],
  ['valid-invalid',raw+' {}',2,1,true], ['invalid-valid','{} '+raw,2,1,true],
  ['three',[raw,raw,raw].join('\n'),3,3,false], ['prefix','prose '+raw,1,1,true],
  ['suffix',raw+' prose',1,1,true], ['fence','```json\n'+raw+'\n```',1,1,true],
  ['truncated',raw+' {"type":',1,1,true],
  ['nested',JSON.stringify({...decision,extra:{type:'finish',output:'nested'}}),1,1,false],
  ['duplicate-keys',raw.replace('"type":"finish"','"type":"finish","type":"finish"'),1,1,false],
]) test(name, () => {
  const d = inspect(response);
  assert.equal(d.top_level_balanced_object_count,count);
  assert.equal(d.decision_candidate_count,candidates);
  assert.equal(d.non_whitespace_outside_candidates,outside);
  assert.equal(JSON.stringify(d).includes('SYNTHETIC_SECRET_SENTINEL'),false);
  if (name==='identical') assert.equal(d.candidates_byte_identical,true);
  if (name==='canonical') { assert.equal(d.candidates_byte_identical,false); assert.equal(d.candidates_canonical_json_identical,true); }
  if (name==='distinct') assert.equal(d.candidates_canonical_json_identical,false);
  if (name==='truncated') assert.equal(d.incomplete_object_or_string,true);
});
test('final event selected unchanged; earlier response and unknown field values never leak', () => {
  const summary = summarizeAntigravityCliRun({stdout:[{event:'step_update',message:{reasoning:'PRIVATE_REASONING'}},{event:'result',result:{status:'SUCCESS',response:raw}},{event:'result',result:{status:'SUCCESS',response:raw+'\n'+raw,structured_output:{secret:'PRIVATE_FIELD'}}}].map(JSON.stringify).join('\n')});
  const d = inspectStructure(summary,schema);
  assert.equal(d.result_event_count,2); assert.equal(d.selected_terminal_result_ordinal,2);
  assert.equal(d.decision_candidate_count,2); assert.equal(extractAntigravityAssistantText(summary),raw+'\n'+raw);
  assert.ok(d.structured_output_related_field_names.includes('structured_output'));
  assert.equal(/PRIVATE|SYNTHETIC_SECRET_SENTINEL/.test(JSON.stringify(d)),false);
});
test('schema validation checks required, const, array items and nonempty text', () => {
  assert.equal(matchesSchema(decision,schema),true);
  for (const d of [{...decision,output:' '},{...decision,data:{...decision.data,criticisms:[1]}},{...decision,type:'await_owner'},{type:'finish',output:'x'}]) assert.equal(matchesSchema(d,schema),false);
  assert.throws(()=>matchesSchema(decision,{oneOf:[]}),/UNSUPPORTED/);
});
test('research observation never widens production ambiguity acceptance', async () => {
  for (const response of [raw+'\n'+raw,raw+'\n'+JSON.stringify({...decision,output:'different'})]) {
    inspect(response);
    const driver = createCliPmDriver({profile:{id:'fixture',product:'antigravity'},project:{id:'fixture'},run:async()=>response});
    await assert.rejects(driver.decide({request:{id:'fixture',objective:'',context:{}},turn:1,history:[]}),e=>e.parseSubreason==='PM_DECISION_AMBIGUOUS_DECISIONS');
  }
});
test('terminal error remains rejected even with valid response', () => {
  const result = {status:'ERROR',response:raw};
  inspectStructure({events:[{event:'result',result}],result},schema);
  assert.throws(()=>extractAntigravityAssistantText({result}),e=>e.code==='ANTIGRAVITY_RUN_FAILED');
});
