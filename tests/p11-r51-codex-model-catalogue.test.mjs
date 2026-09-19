import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  deriveCodexModelLabel,
  normalizeLiveCodexModels,
  validateAndNormalizeCodexCatalogueJson,
  discoverCodexModelCatalogueLive,
  loadCodexCatalogue,
  catalogueToModelDiscoveryFields,
  CODEX_MODEL_CATALOGUE_JSON_PATH,
} from '../src/pm/codex-model-catalogue.mjs';
import { reasoningCapabilityFor, CODEX_EFFORT_LABELS } from '../src/pm/pm-reasoning-capability.mjs';

// Same fake-spawn shape tests/pm-connection-probe.test.mjs and
// tests/production-codex-grok-backends.test.mjs already use — an
// EventEmitter/PassThrough child matching node:child_process.spawn()'s
// real shape, never a real CLI.
function fakeSpawn({ stdout = '', code = 0, hang = false } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { child.killed = true; };
    queueMicrotask(() => {
      if (hang) return;
      child.stdout.end(stdout);
      child.stderr.end('');
      queueMicrotask(() => child.emit('close', code));
    });
    return child;
  };
}

// PART AA: prove the OLD one-model catalogue (pre-R5.1) would only ever
// render a single entry, then prove the new catalogue can expose several
// from configuration without any renderer/loader code change.
test('PART AA: label derivation reproduces the owner-observed 6-model screenshot from live display_name text, not a hardcoded list', () => {
  assert.equal(deriveCodexModelLabel('GPT-5.6-Sol', 'gpt-5.6-sol'), '5.6 Sol');
  assert.equal(deriveCodexModelLabel('GPT-5.6-Terra', 'gpt-5.6-terra'), '5.6 Terra');
  assert.equal(deriveCodexModelLabel('GPT-5.6-Luna', 'gpt-5.6-luna'), '5.6 Luna');
  assert.equal(deriveCodexModelLabel('GPT-5.5', 'gpt-5.5'), '5.5');
  assert.equal(deriveCodexModelLabel('GPT-5.4', 'gpt-5.4'), '5.4');
  assert.equal(deriveCodexModelLabel('GPT-5.4-Mini', 'gpt-5.4-mini'), '5.4 Mini');
  assert.equal(deriveCodexModelLabel(undefined, 'gpt-5.6-sol'), 'gpt-5.6-sol');
});

test('normalizeLiveCodexModels: filters to visibility "list" only, drops hidden internal models, keeps only known effort values', () => {
  const entries = normalizeLiveCodexModels([
    { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'ultra' }, { effort: 'not-a-real-level' }] },
    { slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide', supported_reasoning_levels: [{ effort: 'low' }] },
    { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide', supported_reasoning_levels: [{ effort: 'medium' }] },
    { slug: '', display_name: 'No slug', visibility: 'list', supported_reasoning_levels: [] },
    null,
  ]);
  assert.deepEqual(entries.map((e) => e.id), ['gpt-5.6-sol']);
  assert.equal(entries[0].label, '5.6 Sol');
  assert.deepEqual(entries[0].efforts.map((f) => f.value), ['low', 'ultra']);
  assert.equal(entries[0].efforts.find((f) => f.value === 'low').label, 'Light');
});

test('discoverCodexModelCatalogueLive: real `codex debug models` shape -> normalized entries', async () => {
  const stdout = JSON.stringify({
    client_version: '0.149.0',
    models: [
      { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }, { effort: 'max' }, { effort: 'ultra' }] },
    ],
  });
  const result = await discoverCodexModelCatalogueLive({ spawnImpl: fakeSpawn({ stdout }) });
  assert.ok(result);
  assert.equal(result.clientVersion, '0.149.0');
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].id, 'gpt-5.6-sol');
});

test('discoverCodexModelCatalogueLive: non-zero exit, malformed JSON, empty output, spawn throw, and timeout all degrade to null (never throw)', async () => {
  assert.equal(await discoverCodexModelCatalogueLive({ spawnImpl: fakeSpawn({ code: 1, stdout: 'ignored' }) }), null);
  assert.equal(await discoverCodexModelCatalogueLive({ spawnImpl: fakeSpawn({ stdout: 'not json' }) }), null);
  assert.equal(await discoverCodexModelCatalogueLive({ spawnImpl: fakeSpawn({ stdout: '' }) }), null);
  assert.equal(await discoverCodexModelCatalogueLive({ spawnImpl: () => { throw new Error('boom'); } }), null);
  assert.equal(await discoverCodexModelCatalogueLive({ spawnImpl: fakeSpawn({ hang: true }), timeoutMs: 20 }), null);
  // A live catalogue with zero owner-facing (visibility:"list") entries is
  // also treated as unavailable, not a false "live, zero models" result.
  assert.equal(await discoverCodexModelCatalogueLive({ spawnImpl: fakeSpawn({ stdout: JSON.stringify({ models: [{ slug: 'x', visibility: 'hide' }] }) }) }), null);
});

// PART Q: validation must reject/skip duplicate ids, empty ids, invalid
// effort values, unsupported schema version, and malformed entries — a bad
// optional entry must never take down the whole catalogue.
test('validateAndNormalizeCodexCatalogueJson: strict validation, fails safe per-entry', () => {
  const good = validateAndNormalizeCodexCatalogueJson({
    schema_version: 1,
    last_verified: '2026-08-27',
    models: [
      { id: 'a', label: 'A', enabled: true, efforts: ['low', 'medium'] },
      { id: 'b', label: 'B', efforts: ['xhigh'] },
    ],
  });
  assert.equal(good.errors.length, 0);
  assert.equal(good.entries.length, 2);
  assert.equal(good.entries[1].enabled, true); // enabled defaults true when omitted

  const badRoot = validateAndNormalizeCodexCatalogueJson({ schema_version: 2, models: [] });
  assert.equal(badRoot.entries.length, 0);
  assert.match(badRoot.errors[0], /unsupported schema_version/);

  const notObject = validateAndNormalizeCodexCatalogueJson([1, 2, 3]);
  assert.equal(notObject.entries.length, 0);
  assert.match(notObject.errors[0], /must be a JSON object/);

  const modelsNotArray = validateAndNormalizeCodexCatalogueJson({ schema_version: 1, models: 'nope' });
  assert.equal(modelsNotArray.entries.length, 0);
  assert.match(modelsNotArray.errors[0], /must be an array/);

  const mixed = validateAndNormalizeCodexCatalogueJson({
    schema_version: 1,
    models: [
      { id: 'dup', label: 'Dup1', efforts: ['low'] },
      { id: 'dup', label: 'Dup2', efforts: ['medium'] }, // duplicate id -> skipped
      { id: '', label: 'Empty id', efforts: ['low'] }, // empty id -> skipped
      { id: 'bad-effort', label: 'Bad Effort', efforts: ['low', 'not-a-real-level', 'low'] }, // unknown + duplicate effort -> both dropped, "low" kept once
      'not-an-object', // malformed -> skipped
      { id: 'good', label: 'Good', efforts: ['ultra'] },
    ],
  });
  assert.deepEqual(mixed.entries.map((e) => e.id), ['dup', 'bad-effort', 'good']);
  assert.deepEqual(mixed.entries.find((e) => e.id === 'bad-effort').efforts.map((f) => f.value), ['low']);
  assert.ok(mixed.errors.some((e) => /duplicate id "dup"/.test(e)));
  assert.ok(mixed.errors.some((e) => /empty\/missing id/.test(e)));
  assert.ok(mixed.errors.some((e) => /unknown effort value "not-a-real-level"/.test(e)));
  assert.ok(mixed.errors.some((e) => /not an object, skipped/.test(e)));
});

// PART AJ: the shipped JSON fallback file itself must be valid and carry
// no secret-shaped fields.
test('the real config/codex-model-catalogue.json is schema-valid and secret-free', async () => {
  const fs = await import('node:fs');
  const raw = fs.readFileSync(CODEX_MODEL_CATALOGUE_JSON_PATH, 'utf8');
  assert.equal(/token|secret|password|api[_-]?key|auth/i.test(raw), false);
  const parsed = JSON.parse(raw);
  const result = validateAndNormalizeCodexCatalogueJson(parsed);
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
  assert.ok(result.entries.length >= 6);
  for (const id of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini']) {
    assert.ok(result.entries.some((e) => e.id === id), `missing owner-observed model ${id}`);
  }
});

// PART D/M: the generic loader prefers live, falls back to JSON.
test('loadCodexCatalogue: LIVE when discovery succeeds', async () => {
  const stdout = JSON.stringify({ models: [{ slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }] }] });
  const catalogue = await loadCodexCatalogue({ spawnImpl: fakeSpawn({ stdout }) });
  assert.equal(catalogue.mode, 'LIVE');
  assert.match(catalogue.sourceLabel, /^Live Codex catalogue/);
});

test('loadCodexCatalogue: JSON_FALLBACK when live discovery is unavailable, reading the real shipped file', async () => {
  const catalogue = await loadCodexCatalogue({ spawnImpl: fakeSpawn({ code: 1 }) });
  assert.equal(catalogue.mode, 'JSON_FALLBACK');
  assert.match(catalogue.sourceLabel, /DSH-managed/);
  assert.match(catalogue.sourceLabel, /not live-discovered/);
  assert.ok(catalogue.entries.some((e) => e.id === 'gpt-5.6-sol'));
});

// PART AB: JSON change test — editing the fallback file (never source) is
// picked up on the very next call, no restart — bounded hot reload.
test('PART AB: JSON fallback hot-reloads from disk — a changed file is reflected on the next call with no cache/restart needed', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const fs = await import('node:fs');
  const tmpPath = path.join(os.tmpdir(), `codex-catalogue-hot-reload-${Date.now()}.json`);
  const v1 = { schema_version: 1, last_verified: '2026-08-27', models: [{ id: 'model-a', label: 'Model A', efforts: ['low'] }] };
  fs.writeFileSync(tmpPath, JSON.stringify(v1));
  try {
    const before = await loadCodexCatalogue({ spawnImpl: fakeSpawn({ code: 1 }), jsonPath: tmpPath });
    assert.deepEqual(before.entries.map((e) => e.id), ['model-a']);

    const v2 = { schema_version: 1, last_verified: '2026-08-27', models: [{ id: 'model-a', label: 'Model A', efforts: ['low'] }, { id: 'model-b', label: 'Model B', efforts: ['medium'] }] };
    fs.writeFileSync(tmpPath, JSON.stringify(v2));

    const after = await loadCodexCatalogue({ spawnImpl: fakeSpawn({ code: 1 }), jsonPath: tmpPath });
    assert.deepEqual(after.entries.map((e) => e.id), ['model-a', 'model-b']);
    // existing entry ("model-a") is untouched by the addition
    assert.deepEqual(before.entries[0], after.entries[0]);
  } finally {
    fs.unlinkSync(tmpPath);
  }
});

test('catalogueToModelDiscoveryFields: only enabled entries are exposed to the renderer (Part G/S)', () => {
  const fields = catalogueToModelDiscoveryFields({
    sourceLabel: 'test',
    entries: [
      { id: 'a', label: 'A', enabled: true, efforts: [{ value: 'low', label: 'Light' }] },
      { id: 'b', label: 'B', enabled: false, efforts: [] },
    ],
  });
  assert.deepEqual(fields.models, ['a']);
  assert.deepEqual(fields.modelLabels, { a: 'A' });
  assert.deepEqual(fields.modelEffortLevels, { a: ['low'] });
});

test('PART J: every catalogue-usable effort value has a codex-reasoning-capability label, and vice versa', () => {
  const cap = reasoningCapabilityFor('codex');
  assert.deepEqual(Object.keys(CODEX_EFFORT_LABELS).sort(), cap.levels.slice().sort());
});
