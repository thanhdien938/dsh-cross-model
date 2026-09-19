/**
 * P20.2 test M — legacy `decide()` (the control plane) is unchanged by the
 * new report content plane, and the report modules do not leak into the
 * legacy PM backend registry.
 *
 * Authority: docs/P20/P20_2_SONNET_IMPLEMENTATION_MASTER_PROMPT.md §5, §26, §35 #14.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createCliPmDriver } from '../src/pm/production-pm-backend-registry.mjs';

const profile = { id: 'synthetic', product: 'api' };
const project = { id: 'synthetic', repo_path: process.cwd() };

test('M: legacy decide() still runs the structured parser path and returns a parsed decision', async () => {
  const driver = createCliPmDriver({ profile, project, run: async () => '{"type":"finish","output":"done"}' });
  const decision = await driver.decide({ request: { id: 'r' } });
  assert.equal(decision.type, 'finish');
});

test('M: legacy decide() still rejects invalid PM output (parser contract intact)', async () => {
  const driver = createCliPmDriver({ profile, project, run: async () => 'this is not JSON at all' });
  await assert.rejects(driver.decide({ request: { id: 'r' } }));
});

test('M: the report content plane does not leak into the legacy PM backend registry', () => {
  const src = readFileSync(new URL('../src/pm/production-pm-backend-registry.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /report-invocation|report-backend-result|report-prompt|single-report-operation|artifact-delivery|backend-report-capability|report-executive-log|api-report-transport/,
    'production-pm-backend-registry.mjs must not import any P20.2 report module');
});

test('M: legacy decide() with a scripted canonicalizer still reaches canonicalization on an eligible parse failure', async () => {
  let canonicalizeCalls = 0;
  const driver = createCliPmDriver({
    profile,
    project,
    run: async () => '{"type":"finish","output":"truncated', // malformed -> eligible for canonicalization
    canonicalize: async () => { canonicalizeCalls += 1; return JSON.stringify({ normalization_status: 'UNSAFE', reason_code: 'OTHER_UNSAFE' }); },
  });
  await assert.rejects(driver.decide({ request: { id: 'r' } }));
  assert.equal(canonicalizeCalls, 1, 'legacy path still invokes the canonicalizer on an eligible parse failure');
});
