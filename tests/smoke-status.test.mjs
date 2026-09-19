import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySmoke,
  classifyContextRow,
  classifyTransferRoute,
  exitCodeFor,
  SMOKE_STATUS,
  SMOKE_REASON,
  SMOKE_EXIT_CODE,
} from '../scripts/lib/smoke-status.mjs';

test('generic classification: 3/3 -> PASS', () => {
  assert.equal(classifySmoke({ proved: 3, required: 3 }), SMOKE_STATUS.PASS);
});

test('generic classification: 2/3 -> PARTIAL', () => {
  assert.equal(classifySmoke({ proved: 2, required: 3 }), SMOKE_STATUS.PARTIAL);
});

test('generic classification: 1/3 -> PARTIAL', () => {
  assert.equal(classifySmoke({ proved: 1, required: 3 }), SMOKE_STATUS.PARTIAL);
});

test('generic classification: 0/3 -> FAIL', () => {
  assert.equal(classifySmoke({ proved: 0, required: 3 }), SMOKE_STATUS.FAIL);
});

test('generic classification: harness fatal failure -> FAIL', () => {
  assert.equal(classifySmoke({ proved: 3, required: 3, harnessFailed: true }), SMOKE_STATUS.FAIL);
});

test('generic classification: zero required target is not PASS', () => {
  assert.equal(classifySmoke({ proved: 0, required: 0 }), SMOKE_STATUS.FAIL);
  assert.equal(classifySmoke({ proved: 0, required: -1 }), SMOKE_STATUS.FAIL);
});

test('gate3r1 semantics: all declared backends echo sentinel -> PASS', () => {
  const rows = Array.from({ length: 3 }, () => ({
    status: 'completed',
    outputEmpty: false,
    sentinelObserved: true,
  }));
  const proved = rows.filter((r) => classifyContextRow(r) === SMOKE_REASON.PROVED).length;
  assert.equal(classifySmoke({ proved, required: rows.length }), SMOKE_STATUS.PASS);
});

test('gate3r1 semantics: one backend empty output -> PARTIAL', () => {
  const rows = [
    { status: 'completed', outputEmpty: false, sentinelObserved: true },
    { status: 'completed', outputEmpty: false, sentinelObserved: true },
    { status: 'completed', outputEmpty: true, sentinelObserved: false },
  ];
  const proved = rows.filter((r) => classifyContextRow(r) === SMOKE_REASON.PROVED).length;
  assert.equal(classifySmoke({ proved, required: rows.length }), SMOKE_STATUS.PARTIAL);
  assert.equal(proved, 2);
});

test('gate3r1 semantics: one backend errors -> PARTIAL if others prove', () => {
  const rows = [
    { status: 'completed', outputEmpty: false, sentinelObserved: true },
    { status: 'failed', outputEmpty: true, sentinelObserved: false, agentFailed: true },
    { status: 'completed', outputEmpty: false, sentinelObserved: true },
  ];
  const proved = rows.filter((r) => classifyContextRow(r) === SMOKE_REASON.PROVED).length;
  assert.equal(classifySmoke({ proved, required: rows.length }), SMOKE_STATUS.PARTIAL);
});

test('gate3r1 semantics: all backends fail/unproved -> FAIL', () => {
  const rows = [
    { status: 'failed', outputEmpty: true, sentinelObserved: false, agentFailed: true },
    { status: 'completed', outputEmpty: true, sentinelObserved: false },
    { status: 'completed', outputEmpty: false, sentinelObserved: false },
  ];
  const proved = rows.filter((r) => classifyContextRow(r) === SMOKE_REASON.PROVED).length;
  assert.equal(classifySmoke({ proved, required: rows.length }), SMOKE_STATUS.FAIL);
});

test('gate3r1 reason classification: completed empty output vs echo failure differ', () => {
  assert.equal(classifyContextRow({ status: 'completed', outputEmpty: true, sentinelObserved: false }), SMOKE_REASON.EMPTY_OUTPUT);
  assert.equal(classifyContextRow({ status: 'completed', outputEmpty: false, sentinelObserved: false }), SMOKE_REASON.TRANSFER_NOT_OBSERVED);
  assert.equal(classifyContextRow({ status: 'failed', outputEmpty: true, sentinelObserved: false, agentFailed: true }), SMOKE_REASON.AGENT_FAILED);
});

test('gate4 semantics: 2/2 routes proved -> PASS', () => {
  const routes = [
    { sourceStatus: 'completed', sourceOutputEmpty: false, tokenObserved: true, targetStatus: 'completed', transferObserved: true },
    { sourceStatus: 'completed', sourceOutputEmpty: false, tokenObserved: true, targetStatus: 'completed', transferObserved: true },
  ];
  const proved = routes.filter((r) => classifyTransferRoute(r) === SMOKE_REASON.PROVED).length;
  assert.equal(classifySmoke({ proved, required: routes.length }), SMOKE_STATUS.PASS);
});

test('gate4 semantics: 1/2 routes proved -> PARTIAL', () => {
  const routes = [
    { sourceStatus: 'completed', sourceOutputEmpty: false, tokenObserved: true, targetStatus: 'completed', transferObserved: true },
    { sourceStatus: 'completed', sourceOutputEmpty: false, tokenObserved: true, targetStatus: 'completed', transferObserved: false },
  ];
  const proved = routes.filter((r) => classifyTransferRoute(r) === SMOKE_REASON.PROVED).length;
  assert.equal(classifySmoke({ proved, required: routes.length }), SMOKE_STATUS.PARTIAL);
});

test('gate4 semantics: 0/2 routes proved -> FAIL', () => {
  const routes = [
    { sourceStatus: 'completed', sourceOutputEmpty: true, tokenObserved: false, targetStatus: 'completed', transferObserved: false },
    { sourceStatus: 'failed', sourceOutputEmpty: true, tokenObserved: false, targetStatus: null, transferObserved: false },
  ];
  const proved = routes.filter((r) => classifyTransferRoute(r) === SMOKE_REASON.PROVED).length;
  assert.equal(classifySmoke({ proved, required: routes.length }), SMOKE_STATUS.FAIL);
});

test('gate4 reason: source empty output != handoff-build failure != target failure', () => {
  const sourceEmpty = classifyTransferRoute({ sourceStatus: 'completed', sourceOutputEmpty: true, tokenObserved: false, targetStatus: 'completed', transferObserved: false });
  const handoffFail = classifyTransferRoute({ sourceStatus: 'completed', sourceOutputEmpty: false, tokenObserved: true, targetStatus: 'completed', transferObserved: false, handoffBuildFailed: true });
  const targetFailed = classifyTransferRoute({ sourceStatus: 'completed', sourceOutputEmpty: false, tokenObserved: true, targetStatus: 'failed', transferObserved: false });
  assert.equal(sourceEmpty, SMOKE_REASON.EMPTY_SOURCE_OUTPUT);
  assert.equal(handoffFail, SMOKE_REASON.HANDOFF_BUILD_FAILED);
  assert.equal(targetFailed, SMOKE_REASON.TARGET_AGENT_FAILED);
  assert.notEqual(sourceEmpty, handoffFail);
  assert.notEqual(sourceEmpty, targetFailed);
  assert.notEqual(handoffFail, targetFailed);
});

test('gate4 reason: source agent failed -> SOURCE_AGENT_FAILED', () => {
  assert.equal(
    classifyTransferRoute({ sourceStatus: 'failed', sourceOutputEmpty: true, tokenObserved: false, targetStatus: null, transferObserved: false }),
    SMOKE_REASON.SOURCE_AGENT_FAILED,
  );
});

test('gate4 reason: target completed without transfer -> TRANSFER_NOT_OBSERVED', () => {
  assert.equal(
    classifyTransferRoute({ sourceStatus: 'completed', sourceOutputEmpty: false, tokenObserved: true, targetStatus: 'completed', transferObserved: false }),
    SMOKE_REASON.TRANSFER_NOT_OBSERVED,
  );
});

test('exit codes: PASS 0, PARTIAL 2, FAIL 1', () => {
  assert.equal(exitCodeFor(SMOKE_STATUS.PASS), SMOKE_EXIT_CODE.PASS);
  assert.equal(exitCodeFor(SMOKE_STATUS.PARTIAL), SMOKE_EXIT_CODE.PARTIAL);
  assert.equal(exitCodeFor(SMOKE_STATUS.FAIL), SMOKE_EXIT_CODE.FAIL);
});