/**
 * P20.2 §6 pre-routing foundation checks:
 *   §6.1 conflicting supported transport stamps => FAIL CLOSED
 *   §6.2 task / invocation first-binding concurrency (real child processes)
 *
 * Authority: docs/P20/P20_2_SONNET_IMPLEMENTATION_MASTER_PROMPT.md §6.
 * Offline. Isolated temp roots.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  resolveTransportVersion,
  isArtifactV1Task,
  ArtifactTransportError,
  TRANSPORT_VERSION,
} from '../src/artifacts/artifact-transport.mjs';
import { withTempRoot, makeStore, runChild } from './fixtures/p20-report-helpers.mjs';

// ---- §6.1 -----------------------------------------------------------

test('§6.1: both transport stamps present, supported, but DIFFERENT => ARTIFACT_TRANSPORT_VERSION_CONFLICT', () => {
  for (const [top, nested] of [['legacy', 'artifact_v1'], ['artifact_v1', 'legacy']]) {
    assert.throws(
      () => resolveTransportVersion({ transport_version: top, context: { transport_version: nested } }),
      (e) => e instanceof ArtifactTransportError && e.code === 'ARTIFACT_TRANSPORT_VERSION_CONFLICT',
      `${top} vs ${nested}`,
    );
    assert.throws(() => isArtifactV1Task({ transport_version: top, context: { transport_version: nested } }), (e) => e.code === 'ARTIFACT_TRANSPORT_VERSION_CONFLICT');
  }
});

test('§6.1: both absent => legacy; one present => that one; both present & equal => that one', () => {
  assert.equal(resolveTransportVersion({}), TRANSPORT_VERSION.LEGACY);
  assert.equal(resolveTransportVersion({ context: {} }), TRANSPORT_VERSION.LEGACY);
  assert.equal(resolveTransportVersion({ transport_version: 'artifact_v1' }), TRANSPORT_VERSION.ARTIFACT_V1);
  assert.equal(resolveTransportVersion({ context: { transport_version: 'legacy' } }), TRANSPORT_VERSION.LEGACY);
  assert.equal(resolveTransportVersion({ transport_version: 'artifact_v1', context: { transport_version: 'artifact_v1' } }), TRANSPORT_VERSION.ARTIFACT_V1);
  assert.equal(resolveTransportVersion({ transport_version: 'legacy', context: { transport_version: 'legacy' } }), TRANSPORT_VERSION.LEGACY);
});

test('§6.1: a present-but-unsupported value still fails closed (not conflict, still refusal)', () => {
  assert.throws(() => resolveTransportVersion({ transport_version: 'artifact_v2', context: { transport_version: 'artifact_v2' } }), (e) => e.code === 'ARTIFACT_TRANSPORT_VERSION_UNSUPPORTED');
});

// ---- §6.2 ---------------------------------------------------------

const CREATED = '2026-09-10T08:32:15Z';

test('§6.2: N real processes, SAME full task_id, DIFFERENT slug/createdAt, concurrent first allocation => exactly ONE task folder', async () => {
  await withTempRoot(async (dir) => {
    const root = join(dir, 'store');
    const barrier = join(dir, 'go');
    const taskId = 'task-BINDRACE01';
    const variants = [
      { taskSlug: 'alpha title', createdAt: '2026-09-10T08:32:15Z' },
      { taskSlug: 'beta different', createdAt: '2027-01-01T00:00:00Z' },
      { taskSlug: 'gamma other', createdAt: '2025-05-05T05:05:05Z' },
      { taskSlug: 'delta more', createdAt: '2026-12-31T23:59:59Z' },
    ];
    const pending = variants.map((v) => runChild({ root, storeId: 's1', projectId: 'live1-local', op: 'bindtask', taskId, barrierFile: barrier, ...v }));
    await new Promise((r) => setTimeout(r, 300));
    writeFileSync(barrier, 'go');
    const results = await Promise.all(pending);

    for (const r of results) assert.equal(r.exitCode, 0, `child failed: ${r.out} ${r.err}`);
    const folders = new Set(results.map((r) => r.parsed.folder));
    assert.equal(folders.size, 1, `all children must resolve to ONE folder, got ${[...folders].join(' | ')}`);
    const onDisk = readdirSync(makeStore(dir).tasksRoot).filter((n) => !n.startsWith('.'));
    assert.deepEqual(onDisk, [...folders], 'exactly one task directory on disk');
    const manifest = JSON.parse(readFileSync(join(makeStore(dir).tasksRoot, onDisk[0], 'task-manifest.json'), 'utf8'));
    assert.equal(manifest.task_id, taskId);
  });
});

test('§6.2: N real processes, SAME full invocation_id, DIFFERENT stage/binding, concurrent => one binding wins, others fail closed', async () => {
  await withTempRoot(async (dir) => {
    const root = join(dir, 'store');
    const barrier = join(dir, 'go');
    const base = { root, storeId: 's1', projectId: 'live1-local', op: 'bindinv', taskId: 'task-INVRACE01', taskSlug: 'inv race', createdAt: CREATED, invocationId: 'inv-shared-race', profileId: 'p' };
    const pending = [
      runChild({ ...base, role: 'chair', stage: 'chair-plan', actorAlias: 'chair', barrierFile: barrier }),
      runChild({ ...base, role: 'chair', stage: 'chair-plan', actorAlias: 'chair', barrierFile: barrier }),
      runChild({ ...base, role: 'chair', stage: 'chair-council-synthesis', actorAlias: 'chair', barrierFile: barrier }),
      runChild({ ...base, role: 'member', stage: 'participant-report', actorAlias: 'm1', barrierFile: barrier }),
    ];
    await new Promise((r) => setTimeout(r, 300));
    writeFileSync(barrier, 'go');
    const results = await Promise.all(pending);

    const ok = results.filter((r) => r.exitCode === 0);
    const failed = results.filter((r) => r.exitCode !== 0);
    // The two identical chair-plan bindings both succeed (idempotent, same
    // binding); the mismatched-binding ones must fail closed.
    assert.ok(ok.length >= 1, 'at least one binding wins');
    assert.ok(failed.length >= 1, 'the mismatched bindings fail closed');
    for (const r of failed) {
      assert.ok(
        ['ARTIFACT_INVOCATION_ID_REBOUND', 'ARTIFACT_INVOCATION_BINDING_MISMATCH', 'ARTIFACT_INVOCATION_IDENTITY_COLLISION'].includes(r.parsed?.code),
        `mismatched binding must fail closed, got ${r.parsed?.code} ${r.out}`,
      );
    }
    // Exactly one invocation directory holds inv-shared-race.
    const winningRelpaths = new Set(ok.map((r) => `${r.parsed.relpath}/${r.parsed.key}`));
    assert.equal(winningRelpaths.size, 1, `one bound path only, got ${[...winningRelpaths].join(' | ')}`);
  });
});
