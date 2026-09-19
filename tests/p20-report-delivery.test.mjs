/**
 * P20.2 §15/§16 — VERBATIM_MATERIALIZATION + DIRECT_WRITE contract.
 * Tests G, H, I, J, K, N, O, P, U + containment.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { deliverVerbatimMaterialization, deliverDirectWrite, ArtifactDeliveryError } from '../src/artifacts/artifact-delivery.mjs';
import { ARTIFACT_ROLE, ARTIFACT_STAGE } from '../src/artifacts/artifact-paths.mjs';
import { DELIVERY_MECHANISM } from '../src/artifacts/artifact-schema.mjs';
import { withTempRoot, makeStore } from './fixtures/p20-report-helpers.mjs';

function freshAttempt(dir, delivery = DELIVERY_MECHANISM.VERBATIM_MATERIALIZATION) {
  const inv = makeStore(dir)
    .allocateTask({ taskId: 'task-DELIV01', taskSlug: 'delivery', createdAt: '2026-09-10T08:00:00Z' })
    .allocateInvocation({ invocationId: 'inv-d1', role: ARTIFACT_ROLE.SINGLE, stage: ARTIFACT_STAGE.SINGLE, profileId: 'p', actorAlias: 'a' });
  return inv.allocateAttempt({ deliveryMechanism: delivery, startedAt: '2026-09-10T08:00:00Z' });
}

const BYTE_MATRIX = {
  'LF only': 'line one\nline two\n',
  'CRLF': 'line one\r\nline two\r\n',
  'leading newline': '\n\nstarts with blank lines\n',
  'trailing newline': 'ends with newline\n',
  'no trailing newline': 'no trailing newline',
  'leading + trailing spaces': '   padded on both sides   ',
  'Unicode': 'café — naïve — 日本語 — Ω',
  'emoji': 'launch 🚀🛰️ done 👍',
  'zero-width': 'a​b‌‍c⁠d﻿',
  'multiple JSON blocks': '```json\n{"a":1}\n```\ntext\n```json\n{"b":2}\n```\n',
  'raw JSON objects': '{"decision":"x"}\n{"decision":"y"}\n',
};

for (const [label, content] of Object.entries(BYTE_MATRIX)) {
  test(`N/G/H/I/J/K: VERBATIM_MATERIALIZATION writes ${label} byte-for-byte`, () => {
    withTempRoot((dir) => {
      const attempt = freshAttempt(dir);
      const out = deliverVerbatimMaterialization({ attempt, acceptedVisibleText: content });
      const onDisk = readFileSync(out.reportPath);
      assert.equal(Buffer.compare(onDisk, Buffer.from(content, 'utf8')), 0, `${label}: bytes differ`);
      assert.equal(out.bytes, Buffer.byteLength(content, 'utf8'));
      assert.equal(out.mechanism, 'VERBATIM_MATERIALIZATION');
    });
  });
}

test('O: a pre-existing report file in the attempt is NEVER overwritten', () => {
  withTempRoot((dir) => {
    const attempt = freshAttempt(dir);
    writeFileSync(attempt.reportPath, 'PRIOR CONTENT — must survive');
    assert.throws(() => deliverVerbatimMaterialization({ attempt, acceptedVisibleText: 'new' }), (e) => e.code === 'ARTIFACT_DELIVERY_REPORT_EXISTS');
    assert.equal(readFileSync(attempt.reportPath, 'utf8'), 'PRIOR CONTENT — must survive');
  });
});

test('P: a materialization I/O failure propagates as a typed error', () => {
  withTempRoot((dir) => {
    const attempt = freshAttempt(dir);
    // Make the attempt report path un-writable by turning its parent into a file.
    // (attempt.path exists; replace the report basename's directory expectation
    //  by pre-creating a directory AT the report path so the exclusive write fails.)
    mkdirSync(attempt.reportPath);
    assert.throws(
      () => deliverVerbatimMaterialization({ attempt, acceptedVisibleText: 'x' }),
      (e) => e instanceof ArtifactDeliveryError && (e.code === 'ARTIFACT_MATERIALIZATION_IO_FAILED' || e.code === 'ARTIFACT_DELIVERY_REPORT_EXISTS'),
    );
  });
});

test('containment: a report path outside the attempt directory is refused', () => {
  withTempRoot((dir) => {
    const attempt = freshAttempt(dir);
    const bad = { path: attempt.path, reportPath: join(dir, 'escape.md') };
    assert.throws(() => deliverVerbatimMaterialization({ attempt: bad, acceptedVisibleText: 'x' }), (e) => e.code === 'ARTIFACT_DELIVERY_PATH_OUTSIDE_ATTEMPT');
  });
});

test('non-string content is refused (no accidental JSON.stringify of an object)', () => {
  withTempRoot((dir) => {
    const attempt = freshAttempt(dir);
    assert.throws(() => deliverVerbatimMaterialization({ attempt, acceptedVisibleText: { a: 1 } }), (e) => e.code === 'ARTIFACT_DELIVERY_NO_CONTENT');
  });
});

// ---- DIRECT_WRITE (offline fake writer contract) --------------------

test('U: DIRECT_WRITE may return an empty acknowledgement when the assigned report file exists', () => {
  withTempRoot((dir) => {
    const attempt = freshAttempt(dir, 'DIRECT_WRITE');
    const out = deliverDirectWrite({
      attempt,
      writer: (assignedPath) => { writeFileSync(assignedPath, '# The official report\nbody\n'); return { ackText: '' }; },
      allowEmptyAck: true,
    });
    assert.equal(out.mechanism, 'DIRECT_WRITE');
    assert.equal(out.ackText, '');
    assert.ok(out.bytes > 0);
    assert.equal(readFileSync(out.reportPath, 'utf8'), '# The official report\nbody\n');
  });
});

test('DIRECT_WRITE fails closed if the writer does not create the assigned report', () => {
  withTempRoot((dir) => {
    const attempt = freshAttempt(dir, 'DIRECT_WRITE');
    assert.throws(() => deliverDirectWrite({ attempt, writer: () => ({ ackText: 'done' }) }), (e) => e.code === 'ARTIFACT_DIRECT_WRITE_REPORT_MISSING');
  });
});

test('DIRECT_WRITE fails closed on a pre-existing report and on a missing writer', () => {
  withTempRoot((dir) => {
    const attempt = freshAttempt(dir, 'DIRECT_WRITE');
    assert.throws(() => deliverDirectWrite({ attempt, writer: null }), (e) => e.code === 'ARTIFACT_DELIVERY_NO_WRITER');
    writeFileSync(attempt.reportPath, 'prior');
    assert.throws(() => deliverDirectWrite({ attempt, writer: () => {} }), (e) => e.code === 'ARTIFACT_DELIVERY_REPORT_EXISTS');
  });
});
