/**
 * P20.8 §8 — exact-tuple durable capability-evidence registry.
 *
 * Authority: docs/P20/P20_8_PRODUCTION_ARTIFACT_WIRING_CAPABILITY_PROBES_AND_E2E_MASTER_PROMPT.md §8, §12 (#13, #14, #15, #20).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CapabilityEvidenceRegistry, buildCapabilityTuple, capabilityTupleKey, buildRunCapabilityPolicy, CapabilityEvidenceError,
} from '../src/artifacts/capability-evidence-registry.mjs';
import { DEFAULT_BACKEND_REPORT_POLICY, CAPABILITY_STATE } from '../src/artifacts/backend-report-capability.mjs';

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-p20-8-evidence-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const BASE_TUPLE_ARGS = {
  profileId: 'live1-claude-sonnet-medium', product: 'claude-code', model: 'sonnet', reasoning: 'medium',
  executablePath: 'C:/fake/claude.exe', executableVersion: '2.1.261', os: 'win32',
  routeKind: 'report_delivery', routeValue: 'VERBATIM_MATERIALIZATION', sourceAccessMode: 'READ_ONLY',
};

test('#13/#14 — a PROVEN tuple does not broaden to a different profile or drifted field', () => {
  withTempDir((dir) => {
    const registry = new CapabilityEvidenceRegistry({ filePath: join(dir, 'evidence.json') });
    const tuple = buildCapabilityTuple(BASE_TUPLE_ARGS);
    registry.recordProven({ tuple, evidence: { note: 'test' } });
    assert.ok(registry.resolve(tuple), 'the exact proven tuple resolves');

    const differentProfile = buildCapabilityTuple({ ...BASE_TUPLE_ARGS, profileId: 'live1-claude-sonnet-OTHER' });
    assert.equal(registry.resolve(differentProfile), null, 'a different profile id must never inherit proof');

    const differentModel = buildCapabilityTuple({ ...BASE_TUPLE_ARGS, model: 'opus' });
    assert.equal(registry.resolve(differentModel), null, 'model drift must invalidate proof');

    const differentReasoning = buildCapabilityTuple({ ...BASE_TUPLE_ARGS, reasoning: 'high' });
    assert.equal(registry.resolve(differentReasoning), null, 'reasoning drift must invalidate proof');

    const differentExecutable = buildCapabilityTuple({ ...BASE_TUPLE_ARGS, executableVersion: '2.1.999' });
    assert.equal(registry.resolve(differentExecutable), null, 'executable version drift must invalidate proof');

    const differentRoute = buildCapabilityTuple({ ...BASE_TUPLE_ARGS, routeValue: 'DIRECT_WRITE' });
    assert.equal(registry.resolve(differentRoute), null, 'a different route (DIRECT_WRITE vs VERBATIM_MATERIALIZATION) must not share proof');
  });
});

test('#15 — a malformed/custom capability state still fails the literal-PROVEN admission guard', () => {
  withTempDir((dir) => {
    const registry = new CapabilityEvidenceRegistry({ filePath: join(dir, 'evidence.json') });
    const tuple = buildCapabilityTuple(BASE_TUPLE_ARGS);
    // Simulate a corrupted/tampered record with a custom truthy state —
    // resolve() must only ever honor the literal CAPABILITY_STATE.PROVEN.
    registry.recordProven({ tuple, evidence: {} });
    const doc = registry.read();
    const key = capabilityTupleKey(tuple);
    doc.records[key].state = 'PROBE_ALLOWED';
    // Directly write the tampered doc back (bypassing the class's own
    // atomic writer, to simulate an externally-corrupted file).
    writeFileSync(registry.filePath, JSON.stringify(doc, null, 2), 'utf8');
    assert.equal(registry.resolve(tuple), null, 'a non-literal-PROVEN state must never resolve as proven');
  });
});

test('#20 — a fresh registry instance (simulated restart) reloads exact durable evidence without re-probing', () => {
  withTempDir((dir) => {
    const filePath = join(dir, 'evidence.json');
    const first = new CapabilityEvidenceRegistry({ filePath });
    const tuple = buildCapabilityTuple(BASE_TUPLE_ARGS);
    first.recordProven({ tuple, evidence: { probeRun: 1 } });

    const second = new CapabilityEvidenceRegistry({ filePath }); // simulated process restart
    const record = second.resolve(tuple);
    assert.ok(record, 'evidence must survive a fresh registry instance over the same file');
    assert.equal(record.evidence.probeRun, 1);
  });
});

test('§8.1 — buildRunCapabilityPolicy never broadens: only the exact proven cell becomes PROVEN, never the whole product', () => {
  withTempDir((dir) => {
    const registry = new CapabilityEvidenceRegistry({ filePath: join(dir, 'evidence.json') });
    const tuple = buildCapabilityTuple(BASE_TUPLE_ARGS); // claude-code, VERBATIM_MATERIALIZATION
    registry.recordProven({ tuple, evidence: {} });

    const policy = buildRunCapabilityPolicy({
      registry,
      participants: [{ profileId: 'live1-claude-sonnet-medium', product: 'claude-code', model: 'sonnet', reasoning: 'medium', executablePath: 'C:/fake/claude.exe', executableVersion: '2.1.261', os: 'win32', deliveryMechanism: 'VERBATIM_MATERIALIZATION', sourceAccessMode: 'READ_ONLY' }],
    });
    assert.equal(policy.backends['claude-code'].report_delivery.VERBATIM_MATERIALIZATION, CAPABILITY_STATE.PROVEN);
    // DIRECT_WRITE was never probed — stays exactly as the base default (UNPROVEN).
    assert.equal(policy.backends['claude-code'].report_delivery.DIRECT_WRITE, DEFAULT_BACKEND_REPORT_POLICY.backends['claude-code'].report_delivery.DIRECT_WRITE);
    // No other product is touched at all.
    assert.deepEqual(policy.backends.opencode, DEFAULT_BACKEND_REPORT_POLICY.backends.opencode);
    assert.deepEqual(policy.backends.antigravity, DEFAULT_BACKEND_REPORT_POLICY.backends.antigravity);
  });
});

test('§8.1 — two participating profiles of the same product with conflicting proof states refuse to build an overlay (no silent broadening)', () => {
  withTempDir((dir) => {
    const registry = new CapabilityEvidenceRegistry({ filePath: join(dir, 'evidence.json') });
    const provenTuple = buildCapabilityTuple(BASE_TUPLE_ARGS);
    registry.recordProven({ tuple: provenTuple, evidence: {} });

    assert.throws(() => buildRunCapabilityPolicy({
      registry,
      participants: [
        { profileId: 'live1-claude-sonnet-medium', product: 'claude-code', model: 'sonnet', reasoning: 'medium', executablePath: 'C:/fake/claude.exe', executableVersion: '2.1.261', os: 'win32', deliveryMechanism: 'VERBATIM_MATERIALIZATION', sourceAccessMode: 'READ_ONLY' },
        { profileId: 'live1-claude-opus-OTHER', product: 'claude-code', model: 'opus', reasoning: 'high', executablePath: 'C:/fake/claude.exe', executableVersion: '2.1.261', os: 'win32', deliveryMechanism: 'VERBATIM_MATERIALIZATION', sourceAccessMode: 'READ_ONLY' },
      ],
    }), (e) => {
      assert.ok(e instanceof CapabilityEvidenceError);
      assert.equal(e.code, 'CAPABILITY_OVERLAY_CONFLICT');
      return true;
    });
  });
});
