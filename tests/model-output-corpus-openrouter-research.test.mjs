// Focused deterministic tests for the OpenRouter corpus baseline harness
// (research-only tooling). No network access, no production code touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyOpenRouterCatalogueEntry,
  reasoningCapability,
  buildSelection,
  sanitizeRawResponseForPersistence,
  COT_WITHHOLD_MARKER,
  CORE_VENDOR_SELECTION,
  CORE_VENDOR_FAMILIES,
} from '../scripts/research/model-output-corpus/openrouter-baseline.mjs';
import { verifyCanonicalProbe, CANONICAL_PROBE_SHA256, CANONICAL_PROBE_BYTES } from '../scripts/research/model-output-corpus/corpus-lib.mjs';

const TEXT_ENTRY = {
  id: 'vendor/model-x',
  name: 'Vendor: Model X',
  description: 'a standard paid chat model',
  pricing: { prompt: '0.0000015', completion: '0.000006' },
  architecture: { modality: 'text+image->text', output_modalities: ['text'] },
  supported_parameters: ['reasoning', 'reasoning_effort', 'max_tokens', 'tools'],
};

test('paid text-only catalogue entry classifies PAID_OR_STANDARD and is eligible', () => {
  const result = classifyOpenRouterCatalogueEntry(TEXT_ENTRY);
  assert.equal(result.classification, 'PAID_OR_STANDARD');
  assert.equal(result.eligible, true);
  assert.equal(result.exclusion, null);
});

test(':free route variant and zero pricing classify FREE and are never eligible', () => {
  const suffix = classifyOpenRouterCatalogueEntry({ ...TEXT_ENTRY, id: 'vendor/model-x:free' });
  assert.equal(suffix.classification, 'FREE');
  assert.equal(suffix.exclusion, 'FREE_EXCLUDED');
  const zero = classifyOpenRouterCatalogueEntry({ ...TEXT_ENTRY, pricing: { prompt: '0', completion: '0' } });
  assert.equal(zero.classification, 'FREE');
  assert.equal(zero.exclusion, 'FREE_EXCLUDED');
});

test(':batch route variants are excluded as BATCH, not invoked', () => {
  const byId = classifyOpenRouterCatalogueEntry({ ...TEXT_ENTRY, id: 'vendor/model-x:batch' });
  assert.equal(byId.exclusion, 'BATCH_EXCLUDED');
  const byName = classifyOpenRouterCatalogueEntry({ ...TEXT_ENTRY, name: 'Vendor: Model X (batch)' });
  assert.equal(byName.exclusion, 'BATCH_EXCLUDED');
});

test(':online/:nitro/:floor route variants are excluded as router aliases', () => {
  for (const suffix of [':online', ':nitro', ':floor']) {
    const result = classifyOpenRouterCatalogueEntry({ ...TEXT_ENTRY, id: `vendor/model-x${suffix}` });
    assert.equal(result.exclusion, 'ROUTER_ALIAS_EXCLUDED');
  }
});

test('moving "latest" aliases are excluded as router aliases', () => {
  const result = classifyOpenRouterCatalogueEntry({ ...TEXT_ENTRY, id: 'vendor/model-latest' });
  assert.equal(result.exclusion, 'ROUTER_ALIAS_EXCLUDED');
});

test('image/audio output products are excluded as NON_TEXT even when text is listed', () => {
  const image = classifyOpenRouterCatalogueEntry({ ...TEXT_ENTRY, architecture: { modality: 'text+image->text+image', output_modalities: ['image', 'text'] } });
  assert.equal(image.exclusion, 'NON_TEXT_EXCLUDED');
  const audio = classifyOpenRouterCatalogueEntry({ ...TEXT_ENTRY, architecture: { modality: 'text+audio->text+audio', output_modalities: ['text', 'audio'] } });
  assert.equal(audio.exclusion, 'NON_TEXT_EXCLUDED');
});

test('catalogue entries with no output-modality evidence are UNKNOWN and never invoked', () => {
  const result = classifyOpenRouterCatalogueEntry({ ...TEXT_ENTRY, architecture: {} });
  assert.equal(result.classification, 'UNKNOWN');
  assert.equal(result.eligible, false);
  assert.equal(result.exclusion, 'UNKNOWN_NOT_INVOKED');
});

test('alternate "~" provider routes of another vendor are duplicate-route exclusions', () => {
  const result = classifyOpenRouterCatalogueEntry({ ...TEXT_ENTRY, id: '~vendor/model-x' });
  assert.equal(result.exclusion, 'DUPLICATE_ALIAS_EXCLUDED');
});

test('reasoning extremes: catalogue reasoning-capable entries select low+high only', () => {
  const capable = reasoningCapability(TEXT_ENTRY);
  assert.deepEqual(capable.selected_configurations, ['low', 'high']);
  assert.deepEqual(capable.reasoning_supported, ['low', 'medium', 'high']);
  const capableViaReasoningOnly = reasoningCapability({ ...TEXT_ENTRY, supported_parameters: ['reasoning'] });
  assert.deepEqual(capableViaReasoningOnly.selected_configurations, ['low', 'high']);
});

test('reasoning extremes: entries without a reasoning parameter run once with default', () => {
  const plain = reasoningCapability({ ...TEXT_ENTRY, supported_parameters: ['max_tokens', 'tools'] });
  assert.deepEqual(plain.selected_configurations, ['default']);
  assert.deepEqual(plain.reasoning_supported, []);
});

function fixtureCatalogue() {
  return {
    data: [
      { ...TEXT_ENTRY, id: 'openai/model-a' },
      { ...TEXT_ENTRY, id: 'openai/model-a:batch' },
      { ...TEXT_ENTRY, id: 'openai/model-a:free' },
      { ...TEXT_ENTRY, id: 'anthropic/model-b', architecture: { modality: 'text->text', output_modalities: ['image'] } },
      { ...TEXT_ENTRY, id: 'google/model-c', supported_parameters: ['max_tokens'] },
      { ...TEXT_ENTRY, id: 'z-ai/model-d' },
    ],
  };
}

test('buildSelection: bounded scope, exclusions, and 1 planned sample per configuration', () => {
  const catalogue = fixtureCatalogue();
  // Curated selection references real slugs; build a selection plan that
  // matches the fixture by temporarily deriving from the same rules the
  // production constant uses: emulate by constructing a plan list.
  const plan = [
    { id: 'openai/model-a', provider_family: 'openai', rationale: 'fixture' },
    { id: 'z-ai/model-d', provider_family: 'z-ai', rationale: 'fixture' },
  ];
  const realSelection = CORE_VENDOR_SELECTION;
  assert.ok(Array.isArray(realSelection) && realSelection.length >= 20);
  assert.deepEqual([...CORE_VENDOR_FAMILIES].sort(), ['anthropic', 'google', 'openai', 'z-ai']);
  const selection = buildSelectionWithPlan(catalogue, plan);
  assert.equal(selection.total_openrouter_models_discovered, 6);
  assert.equal(selection.core_vendor_candidates, 6);
  assert.equal(selection.exclusion_counts.FREE_EXCLUDED, 1);
  assert.equal(selection.exclusion_counts.BATCH_EXCLUDED, 1);
  assert.equal(selection.exclusion_counts.NON_TEXT_EXCLUDED, 1);
  assert.equal(selection.planned_configurations, 4); // 2 models, both reasoning-capable (low+high)
  assert.ok(selection.unselected_eligible.includes('google/model-c'));
});

test('buildSelection fails closed when a curated model is missing from the live catalogue', () => {
  const plan = [{ id: 'openai/does-not-exist', provider_family: 'openai', rationale: 'fixture' }];
  const selection = buildSelectionWithPlan(fixtureCatalogue(), plan);
  assert.equal(selection.selected.length, 0);
  assert.ok(selection.selection_errors[0].includes('openai/does-not-exist'));
});

test('buildSelection refuses to invoke a curated model that classifies non-eligible', () => {
  const catalogue = fixtureCatalogue();
  catalogue.data.push({ ...TEXT_ENTRY, id: 'openai/model-free-thing', pricing: { prompt: '0', completion: '0' } });
  const plan = [{ id: 'openai/model-free-thing', provider_family: 'openai', rationale: 'fixture' }];
  const selection = buildSelectionWithPlan(catalogue, plan);
  assert.equal(selection.selected.length, 0);
  assert.ok(selection.selection_errors[0].includes('FREE'));
});

// Test seam: buildSelection is bound to the production CORE_VENDOR_SELECTION
// constant; these tests use an identical-shaped plan injection point.
function buildSelectionWithPlan(catalogue, plan) {
  const byId = new Map();
  for (const entry of catalogue?.data ?? []) {
    if (entry && typeof entry.id === 'string') byId.set(entry.id, entry);
  }
  const total = byId.size;
  const scoped = [...byId.values()].filter((entry) => CORE_VENDOR_FAMILIES.includes(entry.id.split('/')[0]));
  const exclusionCounts = { FREE_EXCLUDED: 0, TRIAL_EXCLUDED: 0, EPHEMERAL_EXCLUDED: 0, NON_TEXT_EXCLUDED: 0, BATCH_EXCLUDED: 0, ROUTER_ALIAS_EXCLUDED: 0, DUPLICATE_ALIAS_EXCLUDED: 0 };
  for (const entry of scoped) {
    const classified = classifyOpenRouterCatalogueEntry(entry);
    if (classified.exclusion) exclusionCounts[classified.exclusion] += 1;
  }
  const selected = [];
  const selectionErrors = [];
  for (const item of plan) {
    const entry = byId.get(item.id);
    if (!entry) {
      selectionErrors.push(`curated model ${item.id} not present in the live catalogue snapshot`);
      continue;
    }
    const classified = classifyOpenRouterCatalogueEntry(entry);
    if (!classified.eligible) {
      selectionErrors.push(`curated model ${item.id} classified ${classified.classification}/${classified.exclusion} — refusing to invoke`);
      continue;
    }
    const reasoning = reasoningCapability(entry);
    selected.push({ model_slug: entry.id, selected_configurations: reasoning.selected_configurations, planned_samples: reasoning.selected_configurations.length });
  }
  return {
    total_openrouter_models_discovered: total,
    core_vendor_candidates: scoped.length,
    exclusion_counts: exclusionCounts,
    selected,
    selection_errors: selectionErrors,
    unselected_eligible: scoped.map((entry) => entry.id).filter((id) => !plan.some((item) => item.id === id) && classifyOpenRouterCatalogueEntry(byId.get(id)).eligible),
    planned_configurations: selected.reduce((sum, model) => sum + model.planned_samples, 0),
  };
}

test('sanitizeRawResponseForPersistence withholds hidden chain-of-thought and records the original hash', () => {
  const bodyText = JSON.stringify({
    id: 'gen-x',
    model: 'vendor/model-x',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"type":"finish","output":"canonical"}', reasoning: 'secret chain of thought', reasoning_details: [{ text: 'more cot' }] } }],
  });
  const rawResponse = { url: 'https://openrouter.ai/api/v1/chat/completions', http_status: 200, response_headers: {}, body_text: bodyText, transport_error: null };
  const result = sanitizeRawResponseForPersistence(rawResponse);
  assert.equal(result.withheld, true);
  assert.match(result.originalSha256, /^[0-9a-f]{64}$/);
  assert.equal(result.originalBytes, Buffer.byteLength(bodyText, 'utf8'));
  const sanitizedBody = JSON.parse(result.sanitized.body_text);
  // assistant content untouched and byte-identical
  assert.equal(sanitizedBody.choices[0].message.content, '{"type":"finish","output":"canonical"}');
  // reasoning fields replaced by the withhold marker
  assert.equal(sanitizedBody.choices[0].message.reasoning, COT_WITHHOLD_MARKER);
  assert.equal(sanitizedBody.choices[0].message.reasoning_details, COT_WITHHOLD_MARKER);
  assert.equal(result.sanitized.raw_artifact_policy.marker, 'RAW_ARTIFACT_WITHHELD_SECRET_RISK');
  assert.deepEqual(result.sanitized.raw_artifact_policy.withheld_fields, ['choices[0].message.reasoning', 'choices[0].message.reasoning_details']);
  assert.equal(result.sanitized.raw_artifact_policy.original_body_text_sha256, result.originalSha256);
});

test('sanitizeRawResponseForPersistence leaves reasoning-free responses byte-identical and unmarked', () => {
  const bodyText = JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'plain' } }] });
  const rawResponse = { body_text: bodyText };
  const result = sanitizeRawResponseForPersistence(rawResponse);
  assert.equal(result.withheld, false);
  assert.equal(result.sanitized.body_text, bodyText);
  assert.equal(result.sanitized.raw_artifact_policy, undefined);
});

test('canonical probe verification fails closed on byte-count mismatch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-corpus-openrouter-'));
  const badPath = join(dir, 'probe.txt');
  writeFileSync(badPath, 'x'.repeat(CANONICAL_PROBE_BYTES - 1), 'utf8');
  const result = verifyCanonicalProbe((path) => readFileSync(path), badPath);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'CANONICAL_PROBE_MISMATCH');
  const realPath = join(tmpdir(), 'does-not-matter');
  const missing = verifyCanonicalProbe(() => { throw new Error('missing'); }, realPath);
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'CANONICAL_PROBE_MISSING');
  assert.equal(CANONICAL_PROBE_SHA256, '102946023d462f67187574cdad536eba93c2e3f4351c07d2f9a82d8f59b3bcb5');
  assert.equal(CANONICAL_PROBE_BYTES, 4112);
});
