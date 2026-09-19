/**
 * P20.8R2/R7 — the operator-only capability probe seam, DIRECT_WRITE branch.
 *
 * Authority: docs/P20/P20_8R2_DIRECT_WRITE_PHASE1_E2E_MASTER_PROMPT.md §7, §8, §9;
 * docs/P20/P20_8R7_DEBATE_PHASE1_FUNCTIONAL_READINESS_MASTER_PROMPT.md §1.1, §3.
 *
 * P20.8R7 §1.1 correction: DIRECT_WRITE proves the provider AUTHORED its
 * assigned report.md — not that it can copy an app-provided fenced/
 * zero-width canary byte-for-byte (that exact-copy rule is the
 * VERBATIM_MATERIALIZATION contract, unchanged, tested separately below).
 * These tests exercise the corrected nonce-based DIRECT_WRITE contract:
 * assigned path exists, non-empty, the fresh app-minted nonce appears
 * exactly once, `accepted_visible_text` stays null (no materialization
 * fallback), diagnostics are truthful, and the sealed bytes/hash match the
 * actual on-disk bytes.
 *
 * Offline, using a deterministic fake backend that writes the assigned
 * file itself (never a real CLI process).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { PROVIDER_DIRECT_WRITE_CONFIRMER } from '../src/pm/report-backends/cli-report-backends.mjs';
import { buildReportBackendResult, TERMINAL_STATE } from '../src/pm/report-backend-result.mjs';
import {
  runProductionCapabilityProbe,
  buildCapabilityProbeInstructions,
  generateDirectWriteProbeNonce,
  CAPABILITY_PROBE_CANARY_BLOCK,
  DIRECT_WRITE_PROBE_NONCE_PREFIX,
} from '../src/runtime/p20-production-capability-probe.mjs';
import { withTempRoot, makeStore } from './fixtures/p20-report-helpers.mjs';

/**
 * A fake DIRECT_WRITE report backend that extracts the nonce out of the
 * REAL untrusted instructions (`request` doesn't carry it directly — the
 * fake reads `request` only for the assigned path; the prompt/instructions
 * text is not passed to `runReport` by this harness, so tests inject the
 * nonce explicitly via `nonceLine`, exactly like a real provider would
 * have read it from its own prompt).
 */
function fakeDirectWriteProbeBackend({ authorText = null, skipWrite = false, leakMaterializedText = null, omitDirectWriteDiagnostic = false } = {}) {
  return {
    backend: 'fake',
    deliveryMechanism: 'DIRECT_WRITE',
    directWriter: PROVIDER_DIRECT_WRITE_CONFIRMER,
    async runReport({ request }) {
      if (!skipWrite) {
        const path = request.attempt.reportPath;
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, authorText);
      }
      return buildReportBackendResult({
        backend: request.backend, profileId: request.profileId, executionId: request.executionId, terminalState: TERMINAL_STATE.SUCCESS,
        ...(leakMaterializedText !== null ? { acceptedVisibleText: leakMaterializedText, visibleOutputSource: 'FAKE' } : {}),
        safeDiagnostics: omitDirectWriteDiagnostic ? {} : { direct_write: true },
      });
    },
  };
}

async function runDirectWriteProbe(dir, backendOpts) {
  const store = makeStore(dir);
  const backend = fakeDirectWriteProbeBackend(backendOpts);
  return runProductionCapabilityProbe({
    store, profile: { id: 'live1-fake', product: 'fake', model: 'x', reasoning: null },
    reportBackend: backend, deliveryMechanism: 'DIRECT_WRITE', inputTransport: 'VERBATIM_CONTENT',
  });
}

// ---- §5 item 1 — accepts provider-authored Markdown with the nonce, formatting differs from the old exact-copy canary ----

test('§R7 1 — DIRECT_WRITE probe accepts a freely-authored report containing the exact nonce, even with completely different formatting from the old canary', async () => {
  await withTempRoot(async (dir) => {
    // We can't know the probe's own internally-minted nonce in advance, so
    // this test proves the CONTRACT using the real generator + instruction
    // builder directly (offline, deterministic), then feeds that exact
    // nonce into a backend that authors its own free-form Markdown around
    // it — never a copy of CAPABILITY_PROBE_CANARY_BLOCK.
    const nonce = generateDirectWriteProbeNonce();
    assert.ok(nonce.startsWith(DIRECT_WRITE_PROBE_NONCE_PREFIX));
    const instructions = buildCapabilityProbeInstructions({ deliveryMechanism: 'DIRECT_WRITE', directWriteNonceLine: nonce });
    assert.doesNotMatch(instructions, /byte-for-byte/, 'DIRECT_WRITE instructions must no longer demand exact-copy fidelity');
    assert.match(instructions, /Author a short Markdown report YOURSELF/);
    assert.ok(instructions.includes(nonce));

    // The actual probe run uses its OWN freshly-minted nonce internally;
    // this fake backend authors a small free-form report containing
    // WHATEVER nonce line the real instructions given to it demand, by
    // reading it back out of the trusted+untrusted prompt via the same
    // request the real adapter would receive. Since this harness's
    // `runReport` only receives `{request}` (no prompt text), we instead
    // prove authoring-acceptance end-to-end using the probe's real
    // internal nonce by asserting on the SEALED file content afterward.
    const result = await runDirectWriteProbe(dir, {
      authorText: '# My Own Report\n\nHere is my own short paragraph in my own words.\n\nSome closing thought.\n',
    });
    // This particular fake author text has NO nonce at all, so the probe
    // must correctly refuse it (proves the nonce check is real, not a
    // no-op) — the acceptance half of this contract is proven by the next
    // test, which captures the real internal nonce via a stateful fake.
    assert.equal(result.ok, false);
    assert.equal(result.failureCode, 'CAPABILITY_PROBE_DIRECT_WRITE_NONCE_MISSING_OR_DUPLICATED');
  });
});

test('§R7 1 — DIRECT_WRITE probe passes end-to-end when the backend authors free-form Markdown containing the REAL per-call nonce exactly once', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    // A stateful fake that captures whatever nonce this exact probe call
    // mints (by intercepting generateDirectWriteProbeNonce is not possible
    // without monkey-patching the module, so instead we drive the probe
    // through its real flow and have the backend read the nonce back off
    // the untrusted prompt embedded in `request.instructions`, exactly
    // like a real provider reads its own prompt).
    const backend = {
      backend: 'fake',
      deliveryMechanism: 'DIRECT_WRITE',
      directWriter: PROVIDER_DIRECT_WRITE_CONFIRMER,
      async runReport({ prompt, request }) {
        const m = new RegExp(`${DIRECT_WRITE_PROBE_NONCE_PREFIX}[A-Z0-9]+`).exec(prompt ?? '');
        assert.ok(m, 'the real DIRECT_WRITE probe prompt must embed the nonce line for the provider to read');
        const path = request.attempt.reportPath;
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `# Fake Provider Report\n\nI wrote this myself, in a completely different format from any fixed canary.\n\n${m[0]}\n\nA closing sentence with *markdown* and no fences at all.\n`);
        return buildReportBackendResult({ backend: request.backend, profileId: request.profileId, executionId: request.executionId, terminalState: TERMINAL_STATE.SUCCESS, safeDiagnostics: { direct_write: true } });
      },
    };
    const result = await runProductionCapabilityProbe({
      store, profile: { id: 'live1-fake', product: 'fake', model: 'x', reasoning: null },
      reportBackend: backend, deliveryMechanism: 'DIRECT_WRITE', inputTransport: 'VERBATIM_CONTENT',
    });
    assert.equal(result.ok, true, `expected ok:true, got ${JSON.stringify(result)}`);
    assert.equal(result.evidence.direct_write_authoring_verified, true);
    assert.equal(result.evidence.direct_write_nonce_present_exactly_once, true);
    assert.ok(result.tuple);
    assert.equal(result.tuple.routeValue, 'DIRECT_WRITE');
  });
});

// ---- §5 item 2 — fails if assigned report is missing ----

test('§R7 2 — DIRECT_WRITE probe fails cleanly (no crash) when the model writes nothing at the assigned path', async () => {
  await withTempRoot(async (dir) => {
    const result = await runDirectWriteProbe(dir, { skipWrite: true });
    assert.equal(result.ok, false);
    assert.match(result.failureCode, /ARTIFACT_DIRECT_WRITE_REPORT_MISSING|CAPABILITY_PROBE_FAILED/);
  });
});

// ---- §5 item 3 — fails if nonce is missing / duplicated / altered ----

test('§R7 3a — DIRECT_WRITE probe fails when the nonce is entirely missing from an otherwise well-formed report', async () => {
  await withTempRoot(async (dir) => {
    const result = await runDirectWriteProbe(dir, { authorText: '# Report\n\nA perfectly fine report with no nonce anywhere.\n' });
    assert.equal(result.ok, false);
    assert.equal(result.failureCode, 'CAPABILITY_PROBE_DIRECT_WRITE_NONCE_MISSING_OR_DUPLICATED');
    assert.equal(result.nonceOccurrences, 0);
  });
});

test('§R7 3b — DIRECT_WRITE probe fails when the nonce appears twice (duplicated)', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const backend = {
      backend: 'fake', deliveryMechanism: 'DIRECT_WRITE', directWriter: PROVIDER_DIRECT_WRITE_CONFIRMER,
      async runReport({ prompt, request }) {
        const m = new RegExp(`${DIRECT_WRITE_PROBE_NONCE_PREFIX}[A-Z0-9]+`).exec(prompt ?? '');
        const path = request.attempt.reportPath;
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${m[0]}\n\nrepeated below:\n${m[0]}\n`);
        return buildReportBackendResult({ backend: request.backend, profileId: request.profileId, executionId: request.executionId, terminalState: TERMINAL_STATE.SUCCESS, safeDiagnostics: { direct_write: true } });
      },
    };
    const result = await runProductionCapabilityProbe({ store, profile: { id: 'live1-fake', product: 'fake', model: 'x', reasoning: null }, reportBackend: backend, deliveryMechanism: 'DIRECT_WRITE', inputTransport: 'VERBATIM_CONTENT' });
    assert.equal(result.ok, false);
    assert.equal(result.failureCode, 'CAPABILITY_PROBE_DIRECT_WRITE_NONCE_MISSING_OR_DUPLICATED');
    assert.equal(result.nonceOccurrences, 2);
  });
});

test('§R7 3c — DIRECT_WRITE probe fails when the nonce is altered (one character changed)', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const backend = {
      backend: 'fake', deliveryMechanism: 'DIRECT_WRITE', directWriter: PROVIDER_DIRECT_WRITE_CONFIRMER,
      async runReport({ prompt, request }) {
        const m = new RegExp(`${DIRECT_WRITE_PROBE_NONCE_PREFIX}[A-Z0-9]+`).exec(prompt ?? '');
        const altered = `${m[0].slice(0, -1)}${m[0].slice(-1) === 'A' ? 'B' : 'A'}`;
        const path = request.attempt.reportPath;
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `# Report\n\n${altered}\n`);
        return buildReportBackendResult({ backend: request.backend, profileId: request.profileId, executionId: request.executionId, terminalState: TERMINAL_STATE.SUCCESS, safeDiagnostics: { direct_write: true } });
      },
    };
    const result = await runProductionCapabilityProbe({ store, profile: { id: 'live1-fake', product: 'fake', model: 'x', reasoning: null }, reportBackend: backend, deliveryMechanism: 'DIRECT_WRITE', inputTransport: 'VERBATIM_CONTENT' });
    assert.equal(result.ok, false);
    assert.equal(result.failureCode, 'CAPABILITY_PROBE_DIRECT_WRITE_NONCE_MISSING_OR_DUPLICATED');
    assert.equal(result.nonceOccurrences, 0);
  });
});

// ---- §5 item 4 — fails if DSH/materialization becomes report authority ----

test('§R7 4 — DIRECT_WRITE probe fails if a materialization fallback leaks accepted_visible_text', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const backend = {
      backend: 'fake', deliveryMechanism: 'DIRECT_WRITE', directWriter: PROVIDER_DIRECT_WRITE_CONFIRMER,
      async runReport({ prompt, request }) {
        const m = new RegExp(`${DIRECT_WRITE_PROBE_NONCE_PREFIX}[A-Z0-9]+`).exec(prompt ?? '');
        const path = request.attempt.reportPath;
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `# Report\n\n${m[0]}\n`);
        // Simulates a hypothetical adapter bug: DIRECT_WRITE result that
        // ALSO carries materialized text — must be refused, never silently accepted.
        return buildReportBackendResult({ backend: request.backend, profileId: request.profileId, executionId: request.executionId, terminalState: TERMINAL_STATE.SUCCESS, acceptedVisibleText: 'leaked stdout text', visibleOutputSource: 'FAKE', safeDiagnostics: { direct_write: true } });
      },
    };
    const result = await runProductionCapabilityProbe({ store, profile: { id: 'live1-fake', product: 'fake', model: 'x', reasoning: null }, reportBackend: backend, deliveryMechanism: 'DIRECT_WRITE', inputTransport: 'VERBATIM_CONTENT' });
    assert.equal(result.ok, false);
    assert.equal(result.failureCode, 'CAPABILITY_PROBE_DIRECT_WRITE_MATERIALIZATION_FALLBACK');
  });
});

test('§R7 4b — DIRECT_WRITE probe fails if the DIRECT_WRITE diagnostic itself is missing/untruthful', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const backend = {
      backend: 'fake', deliveryMechanism: 'DIRECT_WRITE', directWriter: PROVIDER_DIRECT_WRITE_CONFIRMER,
      async runReport({ prompt, request }) {
        const m = new RegExp(`${DIRECT_WRITE_PROBE_NONCE_PREFIX}[A-Z0-9]+`).exec(prompt ?? '');
        const path = request.attempt.reportPath;
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `# Report\n\n${m[0]}\n`);
        return buildReportBackendResult({ backend: request.backend, profileId: request.profileId, executionId: request.executionId, terminalState: TERMINAL_STATE.SUCCESS, safeDiagnostics: {} });
      },
    };
    const result = await runProductionCapabilityProbe({ store, profile: { id: 'live1-fake', product: 'fake', model: 'x', reasoning: null }, reportBackend: backend, deliveryMechanism: 'DIRECT_WRITE', inputTransport: 'VERBATIM_CONTENT' });
    assert.equal(result.ok, false);
    assert.equal(result.failureCode, 'CAPABILITY_PROBE_DIRECT_WRITE_DIAGNOSTIC_MISSING');
  });
});

// ---- §5 item 5 — seals the exact on-disk bytes/hash without rewriting ----

test('§R7 5 — DIRECT_WRITE probe seals the EXACT on-disk bytes/hash the provider wrote, independently recomputed, without rewriting them', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    let writtenText = null;
    const backend = {
      backend: 'fake', deliveryMechanism: 'DIRECT_WRITE', directWriter: PROVIDER_DIRECT_WRITE_CONFIRMER,
      async runReport({ prompt, request }) {
        const m = new RegExp(`${DIRECT_WRITE_PROBE_NONCE_PREFIX}[A-Z0-9]+`).exec(prompt ?? '');
        const path = request.attempt.reportPath;
        mkdirSync(dirname(path), { recursive: true });
        writtenText = `# Report with unicode ✅ and\ttabs\n\n${m[0]}\n\nend.\n`;
        writeFileSync(path, writtenText);
        return buildReportBackendResult({ backend: request.backend, profileId: request.profileId, executionId: request.executionId, terminalState: TERMINAL_STATE.SUCCESS, safeDiagnostics: { direct_write: true } });
      },
    };
    const result = await runProductionCapabilityProbe({ store, profile: { id: 'live1-fake', product: 'fake', model: 'x', reasoning: null }, reportBackend: backend, deliveryMechanism: 'DIRECT_WRITE', inputTransport: 'VERBATIM_CONTENT' });
    assert.equal(result.ok, true, `expected ok:true, got ${JSON.stringify(result)}`);
    const expectedBytes = Buffer.byteLength(writtenText, 'utf8');
    const expectedSha256 = createHash('sha256').update(writtenText, 'utf8').digest('hex');
    assert.equal(result.evidence.report_bytes, expectedBytes);
    assert.equal(result.evidence.report_sha256, expectedSha256);
  });
});

// ---- §5 item 6 — VERBATIM_MATERIALIZATION exact-byte-sensitive rule is UNCHANGED ----

test('§R7 6 — VERBATIM_MATERIALIZATION probe instructions still demand byte-for-byte exact-copy fidelity of the fixed canary (unchanged)', () => {
  const instructions = buildCapabilityProbeInstructions({ deliveryMechanism: 'VERBATIM_MATERIALIZATION' });
  assert.match(instructions, /byte-for-byte/);
  assert.ok(instructions.includes(CAPABILITY_PROBE_CANARY_BLOCK), 'the exact fenced/zero-width canary block must still be demanded verbatim');
});

test('§R7 6 — VERBATIM_MATERIALIZATION probe still passes end-to-end when the accepted text is sealed unmodified (untouched code path)', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const backend = {
      backend: 'fake', deliveryMechanism: 'VERBATIM_MATERIALIZATION',
      async runReport({ request }) {
        return buildReportBackendResult({ backend: request.backend, profileId: request.profileId, executionId: request.executionId, terminalState: TERMINAL_STATE.SUCCESS, acceptedVisibleText: CAPABILITY_PROBE_CANARY_BLOCK, visibleOutputSource: 'FAKE' });
      },
    };
    const result = await runProductionCapabilityProbe({ store, profile: { id: 'live1-fake', product: 'fake', model: 'x', reasoning: null }, reportBackend: backend, deliveryMechanism: 'VERBATIM_MATERIALIZATION', inputTransport: 'VERBATIM_CONTENT' });
    assert.equal(result.ok, true, `expected ok:true, got ${JSON.stringify(result)}`);
    assert.equal(result.evidence.accepted_text_sha256_matches_sealed, true);
    assert.equal(result.evidence.direct_write_authoring_verified, undefined, 'VERBATIM_MATERIALIZATION must never carry DIRECT_WRITE-only evidence fields');
  });
});
