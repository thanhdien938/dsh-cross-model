import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const worker = new URL('./fixtures/p2-gate9-worker.mjs', import.meta.url);
const root = mkdtempSync(join(tmpdir(), 'dsh-p2g9-'));
const rows = []; let killed = 0;
const timeoutMs = 15_000;

function events(path) { try { return readFileSync(path, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse); } catch { return []; } }
function count(path, kind) { return events(path).filter((x) => x.kind === kind).length; }
function spawn(mode, scenario, db, ledger) {
  const child = fork(worker, [scenario, mode, db, ledger], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }); child._diagnostic = ''; child.stderr.on('data', (chunk) => { child._diagnostic += chunk; }); return child;
}
function waitMessage(child, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${type} timeout; stderr=${child.stderr.read() ?? ''}`)), timeoutMs);
    child.on('message', (message) => { if (message?.type === type) { clearTimeout(timer); resolve(message); } });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => { if (type !== 'EXIT' && code !== null) { clearTimeout(timer); reject(new Error(`worker exited before ${type}: code=${code} signal=${signal}; stderr=${child._diagnostic}`)); } });
  });
}
function waitExit(child) { return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))); }
async function crashAndRecover(scenario) {
  const dir = join(root, scenario); mkdirSync(dir); const db = join(dir, 'project.db'); const ledger = join(dir, 'external.jsonl');
  const first = spawn('setup', scenario, db, ledger); const marker = await waitMessage(first, 'CRASH_POINT'); assert.equal(marker.scenario, scenario); const exiting = waitExit(first); assert.equal(first.kill('SIGKILL'), true); const death = await exiting; assert.notEqual(death.signal ?? death.code, null); killed += 1;
  const second = spawn('recover', scenario, db, ledger); const exitedPromise = waitExit(second); const result = await waitMessage(second, 'RESULT'); const exited = await exitedPromise; assert.equal(exited.code, 0); return { data: result.data, ledger };
}
function pass(name, detail) { rows.push(name); console.log(`PASS ${String(rows.length).padStart(2)}. ${name}: ${detail}`); }

try {
  const A = await crashAndRecover('A'); assert.equal(A.data.classification, 'SAFE_TO_DISPATCH'); assert.equal(A.data.phase, 'TERMINAL_COMMITTED'); assert.equal(A.data.run.status, 'completed'); assert.equal(A.data.results, 1); assert.equal(count(A.ledger, 'adapter'), 1); pass('A INTENT_COMMITTED safely dispatches persisted identity once', 'SAFE_TO_DISPATCH / external=1');
  const B = await crashAndRecover('B'); assert.equal(B.data.classification, 'AMBIGUOUS_EXTERNAL_ACCEPTANCE'); assert.equal(count(B.ledger, 'adapter'), 1); pass('B DISPATCH_STARTED blocks automatic replay', 'AMBIGUOUS_EXTERNAL_ACCEPTANCE / unchanged=1');
  const C = await crashAndRecover('C'); assert.equal(C.data.classification, 'INTERRUPTED_EXTERNAL_RUN'); assert.equal(count(C.ledger, 'adapter'), 1); assert.equal(count(C.ledger, 'native_resume'), 0); pass('C REMOTE_STARTED without recovery stays interrupted', 'zero replay/resume');
  const D = await crashAndRecover('D'); assert.equal(D.data.classification, 'NATIVE_RECONCILE_REQUIRED'); assert.equal(D.data.reconciliation, 'RECONCILED'); assert.equal(D.data.calls, 1); assert.equal(count(D.ledger, 'native_resume'), 1); assert.equal(count(D.ledger, 'adapter'), 1); assert.equal(D.data.phase, 'TERMINAL_COMMITTED'); pass('D exact native evidence reconciles once', 'native resume=1 / fresh dispatch=0');
  const E = await crashAndRecover('E'); assert.equal(E.data.reconciliation, 'OPERATOR_ACTION_REQUIRED'); assert.equal(E.data.calls, 0); assert.equal(count(E.ledger, 'native_resume'), 1); pass('E RESUME_STARTED never resumes twice', 'OPERATOR_ACTION_REQUIRED / total resume=1');
  const F = await crashAndRecover('F'); assert.equal(F.data.classification, 'AMBIGUOUS_RESULT_COMMIT'); assert.equal(count(F.ledger, 'adapter'), 1); assert.equal(count(F.ledger, 'external_result'), 1); pass('F observed external result blocks blind replay', 'AMBIGUOUS_RESULT_COMMIT');
  const G = await crashAndRecover('G'); assert.equal(G.data.classification, 'CLEAN'); assert.equal(G.data.resultCount, 1); assert.equal(count(G.ledger, 'adapter'), 1); pass('G TERMINAL_COMMITTED reopens cleanly', 'CLEAN / result=1 / calls=1');
  const H = await crashAndRecover('H'); assert.equal(H.data.status, 'completed'); assert.deepEqual(H.data.decideTurns, [1]); assert.deepEqual(H.data.workflowCalls, []); assert.equal(H.data.actionId, 'workflow-H'); assert.equal(count(H.ledger, 'workflow_action'), 1); pass('H committed PM decision reconstructs exact action', 'same-turn decide=0 / action rerun=0');
  const I = await crashAndRecover('I'); assert.equal(I.data.committedStepStatus, 'completed'); assert.equal(I.data.safeStepStatus, 'completed'); assert.equal(I.data.ambiguousStepStatus, 'running'); assert.equal(I.data.peerCommittedStatus, 'completed'); assert.equal(I.data.peerSafeStatus, 'completed'); assert.equal(I.data.peerAmbiguousStatus, 'running'); assert.equal(I.data.wfSafeClass, 'SAFE_TO_DISPATCH'); assert.equal(I.data.peerSafeClass, 'SAFE_TO_DISPATCH'); assert.equal(I.data.wfAmbiguousClass, 'AMBIGUOUS_EXTERNAL_ACCEPTANCE'); assert.equal(I.data.peerAmbiguousClass, 'AMBIGUOUS_EXTERNAL_ACCEPTANCE'); for (const kind of ['workflow_committed','workflow_safe_continue','workflow_active','peer_committed','peer_safe_continue','peer_active']) assert.equal(count(I.ledger, kind), 1); pass('I workflow and peer survive restart truthfully', 'Gate3 safe once / ambiguous blocked');
  const J = await crashAndRecover('J'); assert.equal(J.data.codex.status, 'UNKNOWN'); assert.equal(J.data.grok.status, 'UNAVAILABLE'); assert.equal(J.data.revisionsUnchanged, true); assert.deepEqual(J.data.sequences, [1, 2]); assert.equal(J.data.oldRowsUnchanged, true); assert.equal(J.data.sealed, true); assert.equal(J.data.sealedRejected, true); pass('J health and audit rematerialize without invented success', 'revision stable / MAX+1 / sealed');
  assert.equal(killed, 10); console.log(`P2-GATE9: PASS (${rows.length}/${rows.length} checks; ${killed} real child kills)`);
} finally { rmSync(root, { recursive: true, force: true }); }
