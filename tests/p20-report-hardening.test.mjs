/**
 * P20.2R — PM review remediation:
 *   R1 end-to-end report invocation binding (request <-> persisted P20.1
 *      metadata <-> backend result)
 *   R2 empty ACK != empty official REPORT file
 *   R3 ReportBackendResult schema_version + structural invariants
 *   §7 known failure-path lifecycle stays fail-closed (P20.3 handoff, not fixed here)
 *
 * Authority: docs/P20/P20_2R_SONNET_REMEDIATION_MASTER_PROMPT.md. Offline.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ARTIFACT_ROLE, ARTIFACT_STAGE } from '../src/artifacts/artifact-paths.mjs';
import { DELIVERY_MECHANISM } from '../src/artifacts/artifact-schema.mjs';
import { deliverDirectWrite, ArtifactDeliveryError } from '../src/artifacts/artifact-delivery.mjs';
import {
  ReportInvoker,
  assertReportInvocationBinding,
  assertReportBackendResultBinding,
} from '../src/pm/report-invocation.mjs';
import {
  buildReportBackendResult,
  validateReportBackendResult,
  TERMINAL_STATE,
  VISIBLE_OUTPUT_SOURCE,
} from '../src/pm/report-backend-result.mjs';
import { withTempRoot, makeStore, fakeReportBackend } from './fixtures/p20-report-helpers.mjs';

const CREATED = '2026-09-10T09:00:00Z';
const EXEC = 'exec-r-1';

function seed(dir, over = {}) {
  const store = makeStore(dir);
  const task = store.allocateTask({ taskId: 'task-R1BIND', taskSlug: 'p20.2r', createdAt: CREATED, mode: 'single' });
  const invocation = task.allocateInvocation({
    invocationId: 'inv-r-1', role: ARTIFACT_ROLE.SINGLE, stage: ARTIFACT_STAGE.SINGLE,
    profileId: 'live1-fake', actorAlias: 'fake', ...over.invocation,
  });
  const attempt = invocation.allocateAttempt({ deliveryMechanism: over.delivery ?? DELIVERY_MECHANISM.VERBATIM_MATERIALIZATION, startedAt: CREATED, executionId: EXEC });
  return { store, task, invocation, attempt };
}

function goodRequest({ store, task, invocation, attempt }, over = {}) {
  return {
    store, task, invocation, attempt,
    taskId: 'task-R1BIND',
    stage: ARTIFACT_STAGE.SINGLE,
    role: ARTIFACT_ROLE.SINGLE,
    round: null,
    profileId: 'live1-fake',
    backend: 'fake',
    actorAlias: 'fake',
    executionId: EXEC,
    deliveryMechanism: DELIVERY_MECHANISM.VERBATIM_MATERIALIZATION,
    inputTransport: null,
    capabilityPolicy: undefined,
    instructions: 'analyse',
    evidence: [],
    sourceWritePolicy: 'READ_ONLY',
    ...over,
  };
}

function assertNothingDelivered({ invocation, attempt }) {
  const rec = JSON.parse(readFileSync(invocation.recordPath, 'utf8'));
  assert.notEqual(rec.lifecycle, 'DELIVERED');
  assert.notEqual(rec.lifecycle, 'SEALED');
  assert.equal(rec.authoritative_attempt, null);
  assert.equal(readdirSync(attempt.path).some((n) => n.endsWith('report.md')), false, 'no report.md written');
  assert.equal(readdirSync(attempt.path).some((n) => n.endsWith('executive.log')), false, 'no executive.log written');
}

// ================= R1 — request <-> backend result binding =================

for (const [label, override] of [
  ['wrong result.backend', { backend: 'WRONG' }],
  ['wrong result.profile_id', { profileId: 'live1-attacker' }],
  ['wrong result.execution_id', { executionId: 'exec-OTHER' }],
]) {
  test(`R1: ${label} on the ReportBackendResult => REPORT_BACKEND_RESULT_BINDING_MISMATCH, nothing written`, async () => {
    await withTempRoot(async (dir) => {
      const ws = seed(dir);
      const backend = fakeReportBackend({ text: '# ok\n', overrideBinding: override });
      await assert.rejects(
        new ReportInvoker().invokeReport({ request: goodRequest(ws), reportBackend: backend }),
        (e) => e.code === 'REPORT_BACKEND_RESULT_BINDING_MISMATCH',
      );
      assertNothingDelivered(ws);
    });
  });
}

for (const [label, over] of [
  ['wrong request.taskId', { taskId: 'task-OTHER' }],
  ['wrong request.executionId vs AttemptWorkspace.executionId', { executionId: 'exec-WRONG' }],
  ['wrong request.profileId vs invocation binding', { profileId: 'live1-other' }],
  ['wrong request.role vs invocation binding', { role: 'chair' }],
  ['wrong request.stage vs invocation binding', { stage: 'chair-plan' }],
  ['wrong request.actorAlias vs invocation binding', { actorAlias: 'someone-else' }],
  ['wrong request.round vs invocation binding', { round: 2 }],
]) {
  test(`R1: ${label} => REPORT_INVOCATION_BINDING_MISMATCH before RUNNING, nothing written`, async () => {
    await withTempRoot(async (dir) => {
      const ws = seed(dir);
      await assert.rejects(
        new ReportInvoker().invokeReport({ request: goodRequest(ws, over), reportBackend: fakeReportBackend({ text: '# ok\n' }) }),
        (e) => e.code === 'REPORT_INVOCATION_BINDING_MISMATCH',
      );
      const rec = JSON.parse(readFileSync(ws.invocation.recordPath, 'utf8'));
      assert.equal(rec.lifecycle, 'ASSIGNED', 'request-binding check runs before markRunning()');
      assertNothingDelivered(ws);
    });
  });
}

test('R1: a consistent request + matching result still delivers (no false positive)', async () => {
  await withTempRoot(async (dir) => {
    const ws = seed(dir);
    const out = await new ReportInvoker().invokeReport({ request: goodRequest(ws), reportBackend: fakeReportBackend({ text: '# real report\n' }) });
    assert.equal(readFileSync(out.delivery.reportPath, 'utf8'), '# real report\n');
    assert.equal(JSON.parse(readFileSync(ws.invocation.recordPath, 'utf8')).lifecycle, 'DELIVERED');
  });
});

test('R1: the helpers are exported and usable directly', () => {
  assert.equal(typeof assertReportInvocationBinding, 'function');
  assert.equal(typeof assertReportBackendResultBinding, 'function');
  assert.throws(
    () => assertReportBackendResultBinding({ backend: 'a', profileId: 'p', executionId: 'e' }, buildReportBackendResult({ backend: 'b', profileId: 'p', executionId: 'e', terminalState: TERMINAL_STATE.SUCCESS, acceptedVisibleText: 'x', visibleOutputSource: VISIBLE_OUTPUT_SOURCE.FAKE })),
    (e) => e.code === 'REPORT_BACKEND_RESULT_BINDING_MISMATCH',
  );
});

// ================= R2 — empty ACK != empty REPORT =================

test('R2: DIRECT_WRITE zero-byte report + empty ack => ARTIFACT_DIRECT_WRITE_REPORT_EMPTY (deliverDirectWrite unit)', () => {
  withTempRoot((dir) => {
    const { attempt } = seed(dir, { delivery: DELIVERY_MECHANISM.DIRECT_WRITE });
    assert.throws(
      () => deliverDirectWrite({ attempt, writer: (p) => { writeFileSync(p, ''); return { ackText: '' }; }, allowEmptyAck: true }),
      (e) => e instanceof ArtifactDeliveryError && e.code === 'ARTIFACT_DIRECT_WRITE_REPORT_EMPTY',
    );
  });
});

test('R2: DIRECT_WRITE non-empty report + empty ack still PASSES', () => {
  withTempRoot((dir) => {
    const { attempt } = seed(dir, { delivery: DELIVERY_MECHANISM.DIRECT_WRITE });
    const out = deliverDirectWrite({ attempt, writer: (p) => { writeFileSync(p, '# real body\n'); return { ackText: '' }; }, allowEmptyAck: true });
    assert.equal(out.ackText, '');
    assert.ok(out.bytes > 0);
    assert.equal(readFileSync(out.reportPath, 'utf8'), '# real body\n');
  });
});

test('R2: through invokeReport — a zero-byte direct report is NOT a delivery, lifecycle not DELIVERED', async () => {
  await withTempRoot(async (dir) => {
    const ws = seed(dir, { delivery: DELIVERY_MECHANISM.DIRECT_WRITE });
    const req = goodRequest(ws, {
      deliveryMechanism: DELIVERY_MECHANISM.DIRECT_WRITE,
      directWriter: (p) => { writeFileSync(p, ''); return { ackText: '' }; },
    });
    await assert.rejects(
      new ReportInvoker().invokeReport({ request: req, reportBackend: fakeReportBackend({ text: 'ack only' }) }),
      (e) => e.code === 'ARTIFACT_DIRECT_WRITE_REPORT_EMPTY',
    );
    const rec = JSON.parse(readFileSync(ws.invocation.recordPath, 'utf8'));
    assert.notEqual(rec.lifecycle, 'DELIVERED');
    assert.equal(rec.authoritative_attempt, null);
  });
});

test('R2: ackText empty with allowEmptyAck=false is refused separately from the report-empty rule', () => {
  withTempRoot((dir) => {
    const { attempt } = seed(dir, { delivery: DELIVERY_MECHANISM.DIRECT_WRITE });
    assert.throws(
      () => deliverDirectWrite({ attempt, writer: (p) => { writeFileSync(p, '# body\n'); return { ackText: '' }; }, allowEmptyAck: false }),
      (e) => e.code === 'ARTIFACT_DIRECT_WRITE_EMPTY_ACK',
    );
  });
});

// ================= R3 — ReportBackendResult version / invariants =================

const validBase = () => buildReportBackendResult({
  backend: 'fake', profileId: 'p', executionId: 'e',
  terminalState: TERMINAL_STATE.SUCCESS, acceptedVisibleText: 'body',
  visibleOutputSource: VISIBLE_OUTPUT_SOURCE.FAKE,
});

test('R3: schema_version must be exactly 1', () => {
  assert.equal(validateReportBackendResult(validBase()).ok, true);
  for (const bad of [0, 2, '1', null, undefined]) {
    assert.equal(validateReportBackendResult({ ...validBase(), schema_version: bad }).ok, false, `schema_version=${JSON.stringify(bad)}`);
  }
});

test('R3: contradictory structural combinations fail closed', () => {
  const b = validBase();
  // text null but byte count is a number
  assert.equal(validateReportBackendResult({ ...b, accepted_visible_text: null, accepted_visible_bytes: 5 }).ok, false);
  // text present but no valid source
  assert.equal(validateReportBackendResult({ ...b, visible_output_source: null }).ok, false);
  assert.equal(validateReportBackendResult({ ...b, visible_output_source: 'MADE_UP' }).ok, false);
  // terminal_state vs flags
  assert.equal(validateReportBackendResult({ ...b, terminal_state: TERMINAL_STATE.TIMEOUT, timed_out: false }).ok, false);
  assert.equal(validateReportBackendResult({ ...b, terminal_state: TERMINAL_STATE.CANCELLED, cancelled: false }).ok, false);
  assert.equal(validateReportBackendResult({ ...b, terminal_state: TERMINAL_STATE.SUCCESS, timed_out: true }).ok, false);
  assert.equal(validateReportBackendResult({ ...b, terminal_state: TERMINAL_STATE.SUCCESS, cancelled: true }).ok, false);
  assert.equal(validateReportBackendResult({ ...b, timed_out: 'yes' }).ok, false);
});

test('R3: a non-success state MAY still carry forensic visible text (not rejected)', () => {
  const r = buildReportBackendResult({
    backend: 'fake', profileId: 'p', executionId: 'e',
    terminalState: TERMINAL_STATE.TRUNCATED_OR_INCOMPLETE,
    acceptedVisibleText: 'partial forensic body',
    visibleOutputSource: VISIBLE_OUTPUT_SOURCE.API_CHAT_CONTENT,
  });
  assert.equal(validateReportBackendResult(r).ok, true);
});

test('R3: buildReportBackendResult keeps TIMEOUT/CANCELLED self-consistent', () => {
  const t = buildReportBackendResult({ backend: 'f', profileId: 'p', executionId: 'e', terminalState: TERMINAL_STATE.TIMEOUT });
  assert.equal(t.timed_out, true);
  assert.equal(validateReportBackendResult(t).ok, true);
  const c = buildReportBackendResult({ backend: 'f', profileId: 'p', executionId: 'e', terminalState: TERMINAL_STATE.CANCELLED });
  assert.equal(c.cancelled, true);
  assert.equal(validateReportBackendResult(c).ok, true);
});

// ================= §7 — known failure-path lifecycle stays fail-closed =================

test('§7 handoff: a provider exception leaves the invocation fail-closed (RUNNING, unsealed) — P20.3 owns reconciliation', async () => {
  await withTempRoot(async (dir) => {
    const ws = seed(dir);
    const throwingBackend = { async runReport() { throw new Error('provider blew up mid-run'); } };
    await assert.rejects(new ReportInvoker().invokeReport({ request: goodRequest(ws), reportBackend: throwingBackend }), /provider blew up/);
    const rec = JSON.parse(readFileSync(ws.invocation.recordPath, 'utf8'));
    // markRunning() already ran; nothing else advanced.
    assert.equal(rec.lifecycle, 'RUNNING');
    assert.equal(rec.authoritative_attempt, null);
    assert.notEqual(rec.lifecycle, 'DELIVERED');
    assert.notEqual(rec.lifecycle, 'SEALED');
    const manifest = JSON.parse(readFileSync(ws.task.manifestPath, 'utf8'));
    assert.equal(manifest.final_ref, null);
    assertNothingDelivered(ws);
  });
});
