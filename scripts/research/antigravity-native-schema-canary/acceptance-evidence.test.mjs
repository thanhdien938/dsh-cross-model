import { BASELINE_CALLS, MAX_ALLOWED_RETRY_RESERVE, ACCEPTANCE_CALL_BUDGET } from './acceptance-call-budget.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { AcceptanceEvidence, atomicJson, assertExecutionMode, finalizeAbandonedManifest, hashFile } from './acceptance-evidence.mjs';

const root = resolve('.test-results/evidence-unit'); mkdirSync(root, { recursive: true });
const create = (mode = 'SYNTHETIC') => new AcceptanceEvidence({root:mkdtempSync(join(root,'case-')),mode,
  fixture:{relative_path:'fixture.md',sha256:'a'.repeat(64)},profiles:{chair:'chair',antigravity:'agy',control:'control'},repositoryHead:'b'.repeat(40),branch:'test'});
const read = e => JSON.parse(readFileSync(e.path,'utf8'));
const entry = {action_id:'wf-example',profile_id:'chair',product:'api',step_kind:'chair_plan',attempt_ordinal:0,retry_kind:'INITIAL_GENERATION',native_schema_requested:false};

test('fresh execution/run/action identities, explicit modes and atomic PREPARED manifest', () => {
  const a=create(),b=create(),live=create('LIVE');
  for(const k of ['acceptance_execution_id','council_run_id','action_id']) {
    assert.notEqual(a.manifest[k],b.manifest[k]); assert.notEqual(a.manifest[k],live.manifest[k]);
    assert.equal(read(a)[k],a.manifest[k]);
  }
  assert.equal(read(a).status,'PREPARED'); assert.equal(read(live).execution_mode,'LIVE');
  assert.equal(read(a).execution_mode,'SYNTHETIC');
  assert.equal(read(a).workspace_fixture_sha256,'a'.repeat(64));
  assert.ok(read(a).database_path.startsWith(a.directory));
  a.claim(); assert.throws(()=>a.claim(),/ALREADY_CLAIMED/);
});
test('mode guards refuse missing mode, incomplete synthetic stubs, and live overrides', () => {
  assert.throws(()=>assertExecutionMode(undefined,{}));
  assert.throws(()=>assertExecutionMode('SYNTHETIC',{}));
  assert.throws(()=>assertExecutionMode('SYNTHETIC',{api:async()=>''}));
  assert.throws(()=>assertExecutionMode('LIVE',{api:async()=>''}));
  assert.doesNotThrow(()=>assertExecutionMode('SYNTHETIC',{api:async()=>'',antigravity:async()=>{}}));
});
test('interrupted replacement preserves full previous JSON and cleans staged file', () => {
  const e=create(),before=readFileSync(e.path,'utf8');
  assert.throws(()=>atomicJson(e.path,{status:'BROKEN'},()=>{throw new Error('simulated interruption');}));
  assert.equal(readFileSync(e.path,'utf8'),before);
  assert.equal(readdirSync(e.directory).some(p=>p.endsWith('.tmp')),false);
});
test('RUNNING, exact backend ledger, parser retry and parser-only accounting', () => {
  const e=create(); assert.throws(()=>e.reserve(entry),/NOT_RUNNING/); e.claim(); e.running();
  const first=e.reserve(entry);
  e.transport(first,true);
  e.diagnostic(first,{execution_state:'SUCCESS',terminal_state:'SUCCESS',parser_attempted:true,parser_state:'FAIL',parse_error_code:'PM_DECISION_PARSE_FAILED',parse_subreason:'PM_DECISION_JSON_INVALID'});
  assert.equal(e.records.length,1);
  e.diagnostic(first,{parser_state:'FAIL'}); assert.equal(e.records.length,1);
  const second=e.reserve({...entry,attempt_ordinal:1,retry_kind:'PARSE_RETRY'});
  assert.equal(second.invocation_ordinal,2); assert.equal(second.retry_kind,'PARSE_RETRY');
  assert.equal(JSON.parse(readFileSync(e.ledgerPath,'utf8')).length,2);
  assert.deepEqual(read(e).lifecycle.map(x=>x.status),['PREPARED','RUNNING']);
});
test('first over-budget reservation refused before callback and never counted as invocation', () => {
  const e=create();e.running();let calls=0;
  for(let i=0;i<ACCEPTANCE_CALL_BUDGET;i++){e.reserve(entry);calls++;}
  assert.throws(()=>{e.reserve(entry);calls++;},/budget exhausted/);
  assert.equal(calls,ACCEPTANCE_CALL_BUDGET);assert.equal(e.records.length,ACCEPTANCE_CALL_BUDGET);
  e.finish({durable_result_status:'failed'},{status:'failed',turns:[{outcome:{status:'failed'}}]});
  assert.equal(read(e).status,'ABORTED');assert.equal(read(e).abort_reason,'CALL_BUDGET_EXCEEDED');
});
test('terminal success comes from durable outcome and final DB hash after close', () => {
  const e=create();writeFileSync(e.manifest.database_path,'safe db bytes');e.databaseReady();e.running();
  e.finish({durable_result_status:'completed',strict_full_pass:true,chair_plan:{state:'PASS'},primary_failure_owner:'NONE'}, {status:'completed',turns:[{outcome:{status:'completed'}}]});
  const m=read(e);assert.equal(m.status,'SUCCESS');assert.equal(m.database_sha256_final,hashFile(m.database_path));
  assert.equal(m.database_sha256_initial,null);assert.ok(m.database_created_at);assert.ok(m.database_size_bytes>0);
  assert.equal(m.durable_outcome_present,true);assert.ok(m.manifest_completed_at);
});
test('FAILED and shell exit zero cannot force SUCCESS', () => {
  const e=create();e.running();e.finish({durable_result_status:'failed',shell_exit:0,strict_full_pass:true},{status:'failed',turns:[{outcome:{}}]});
  assert.equal(read(e).status,'FAILED');assert.equal(read(e).strict_full_pass,false);
  const empty=create();empty.running();empty.finish({durable_result_status:'completed',shell_exit:0},{status:'completed',turns:[]});
  assert.equal(read(empty).status,'ABORTED');assert.equal(read(empty).durable_outcome_present,false);
});
test('disagreement or incomplete durable state is ABORTED, never overwrites DB', () => {
  const e=create();e.running();const durable={status:'running',turns:[]};
  e.finish({durable_result_status:'completed',shell_exit:0},durable);
  assert.equal(durable.status,'running');assert.equal(read(e).status,'ABORTED');
  assert.equal(read(e).abort_reason,'TERMINALIZATION_INCOMPLETE');assert.equal(read(e).durable_manifest_disagreement,true);
});
test('ABORTED finalization and explicit orphan finalization preserve state meaning', () => {
  const e=create();e.running();e.abort('HARNESS_ERROR');assert.equal(read(e).status,'ABORTED');assert.equal(read(e).abort_reason,'HARNESS_ERROR');
  const orphan=create();orphan.running();finalizeAbandonedManifest(orphan.path);
  assert.equal(read(orphan).status,'ABORTED');assert.throws(()=>finalizeAbandonedManifest(orphan.path));
});
test('fake assistant/reasoning/authorization values cannot enter diagnostic files', () => {
  const e=create();e.running();const r=e.reserve(entry);
  const fake={content:'LEAK_ASSISTANT_123',reasoning:'LEAK_REASONING_456',authorization:'Bearer LEAK_TOKEN_789',structured_output:{secret:'LEAK_STRUCTURED_012'}};
  e.diagnostic(r,{...fake,execution_state:'SUCCESS',parser_state:'FAIL',parse_subreason:'PM_DECISION_JSON_INVALID'});
  e.finish({...fake,durable_result_status:'failed',failure_public_error_code:fake.authorization,primary_failure_owner:fake.content},{status:'failed',turns:[{outcome:{}}]});
  for(const p of [e.path,e.ledgerPath])assert.doesNotMatch(readFileSync(p,'utf8'),/LEAK_|Bearer/);
});
test('process exit before terminalization writes explanatory ABORTED without providers', () => {
  const e=create();const moduleUrl=new URL('./acceptance-evidence.mjs',import.meta.url).href;
  // Child creates its own synthetic manifest; exit finalizer runs synchronously.
  const code=`import {AcceptanceEvidence} from ${JSON.stringify(moduleUrl)}; const e=new AcceptanceEvidence(${JSON.stringify({root:e.directory,mode:'SYNTHETIC',fixture:{relative_path:'f',sha256:'a'.repeat(64)},profiles:{chair:'c',antigravity:'a',control:'b'},repositoryHead:'b'.repeat(40),branch:'test'})}); e.installFinalizers();e.running();console.log(e.path);`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',windowsHide:true});
  assert.equal(child.status,0);const m=JSON.parse(readFileSync(child.stdout.trim(),'utf8'));
  assert.equal(m.status,'ABORTED');assert.equal(m.abort_reason,'TERMINALIZATION_INCOMPLETE');
});

test('budget covers bounded production retry and repair policy',()=>{
 assert.equal(BASELINE_CALLS,10);assert.equal(MAX_ALLOWED_RETRY_RESERVE,24);assert.equal(ACCEPTANCE_CALL_BUDGET,68);
 const policy=readFileSync(new URL('../../../src/pm/council/council-step-workflow-runner.mjs',import.meta.url),'utf8');
 assert.match(policy,/const MAX_PARSE_ATTEMPTS = 2;/);assert.match(policy,/const MAX_CHAIR_PLAN_ATTEMPTS = 2;/);
 assert.match(policy,/new Set\(\['participant_report', 'participant_critique', 'debate_response'\]\)/);
});
