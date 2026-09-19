/**
 * P20.1R — PM review remediation tests (R2 invocation binding, R3 role/stage
 * matrix, R4 real concurrency + lost-update protection, R5 store-identity
 * race, R6 composite filename budget, plus §9 fail-closed additions).
 *
 * Offline. Isolated mkdtemp roots. Real independent OS processes for the
 * concurrency proofs (tests/fixtures/p20-store-child.mjs).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import {
  ARTIFACT_ROLE,
  ARTIFACT_STAGE,
  ROLE_STAGE_MATRIX,
  MAX_ACTOR_ALIAS_LENGTH,
  MAX_PATH_SEGMENT_LENGTH,
  assertActorAlias,
  assertRoleStage,
  buildActorAliasRegistry,
  deriveActorAlias,
  executiveLogFileName,
  expectedRoleForStage,
  reportFileName,
  stageDirSegments,
} from '../src/artifacts/artifact-paths.mjs';
import {
  DELIVERY_MECHANISM,
  buildArtifactMetadata,
  buildInvocationRecord,
  validateArtifactMetadata,
  validateInvocationRecord,
} from '../src/artifacts/artifact-schema.mjs';
import { createArtifactStore } from '../src/artifacts/artifact-store.mjs';

const CHILD = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'p20-store-child.mjs');

function withTempRoot(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-p20r-'));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  let result;
  try { result = fn(dir); } catch (e) { cleanup(); throw e; }
  if (result && typeof result.then === 'function') return result.finally(cleanup);
  cleanup();
  return result;
}

function runChild(cfg) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CHILD, JSON.stringify(cfg)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (exitCode) => {
      let parsed = null;
      try { parsed = JSON.parse(out.trim().split('\n').pop()); } catch { /* leave null */ }
      resolve({ exitCode, parsed, out, err });
    });
  });
}

const TASK = { taskId: 'task-LBGXGEhVZ5y1koA', taskSlug: 'hardening', createdAt: '2026-09-10T08:32:15Z' };

// =====================================================================
// R2 — invocation immutable binding
// =====================================================================

const INV_BASE = {
  invocationId: 'inv-participant-x',
  role: ARTIFACT_ROLE.MEMBER,
  stage: ARTIFACT_STAGE.PARTICIPANT_REPORT,
  profileId: 'live1-codex-luna-low',
  actorAlias: 'codex-luna-low',
};

for (const [label, override] of [
  ['different profileId', { profileId: 'live1-antigravity-x' }],
  ['different actorAlias', { actorAlias: 'antigravity-x' }],
  ['different role+stage', { role: ARTIFACT_ROLE.CHAIR, stage: ARTIFACT_STAGE.CHAIR_PLAN }],
]) {
  test(`R2.1: reopen with same invocation_id but ${label} fails closed (ARTIFACT_INVOCATION_BINDING_MISMATCH), never returns the old one`, () => {
    withTempRoot((dir) => {
      const task = createArtifactStore({ storeId: 's', projectId: 'live1-local', root: join(dir, 's') }).allocateTask(TASK);
      task.allocateInvocation(INV_BASE);
      assert.throws(
        () => task.allocateInvocation({ ...INV_BASE, ...override }),
        (e) => e.code === 'ARTIFACT_INVOCATION_BINDING_MISMATCH' || e.code === 'ARTIFACT_ROLE_STAGE_MISMATCH' || e.code === 'ARTIFACT_INVOCATION_ID_REBOUND',
        `${label}: expected a fail-closed rebinding error`,
      );
    });
  });
}

test('R2.1: reopen with the exact same binding is still idempotent', () => {
  withTempRoot((dir) => {
    const task = createArtifactStore({ storeId: 's', projectId: 'live1-local', root: join(dir, 's') }).allocateTask(TASK);
    const a = task.allocateInvocation(INV_BASE);
    const b = task.allocateInvocation({ ...INV_BASE });
    assert.equal(a.path, b.path);
    assert.equal(a.invocationId, b.invocationId);
  });
});

test('R2.1: a round change on an already-bound debate invocation fails closed', () => {
  withTempRoot((dir) => {
    const task = createArtifactStore({ storeId: 's', projectId: 'live1-local', root: join(dir, 's') }).allocateTask(TASK);
    const args = { invocationId: 'inv-debate-x', role: ARTIFACT_ROLE.MEMBER, stage: ARTIFACT_STAGE.DEBATE_MEMBER_RESPONSE, profileId: 'p', actorAlias: 'a', round: 1 };
    task.allocateInvocation(args);
    assert.throws(() => task.allocateInvocation({ ...args, round: 2 }), (e) => e.code === 'ARTIFACT_INVOCATION_ID_REBOUND' || e.code === 'ARTIFACT_INVOCATION_BINDING_MISMATCH');
  });
});

test('R2.2: the same full invocation_id cannot be bound in two different stage paths of one task', () => {
  withTempRoot((dir) => {
    const task = createArtifactStore({ storeId: 's', projectId: 'live1-local', root: join(dir, 's') }).allocateTask(TASK);
    task.allocateInvocation({ invocationId: 'inv-shared', role: ARTIFACT_ROLE.CHAIR, stage: ARTIFACT_STAGE.CHAIR_PLAN, profileId: 'p', actorAlias: 'chair' });
    assert.throws(
      () => task.allocateInvocation({ invocationId: 'inv-shared', role: ARTIFACT_ROLE.CHAIR, stage: ARTIFACT_STAGE.CHAIR_COUNCIL_SYNTHESIS, profileId: 'p', actorAlias: 'chair' }),
      (e) => e.code === 'ARTIFACT_INVOCATION_ID_REBOUND',
    );
    // Only the first invocation dir exists.
    assert.ok(existsSync(join(task.path, 'chair', 'plan', 'inv-shared', 'invocation.json')));
    assert.equal(existsSync(join(task.path, 'chair', 'council-synthesis', 'inv-shared')), false);
  });
});

test('R2 / §9: a corrupt persisted invocation.json fails closed on reopen (not "not found")', () => {
  withTempRoot((dir) => {
    const task = createArtifactStore({ storeId: 's', projectId: 'live1-local', root: join(dir, 's') }).allocateTask(TASK);
    const inv = task.allocateInvocation(INV_BASE);
    writeFileSync(inv.recordPath, '{ corrupt json');
    assert.throws(() => task.allocateInvocation(INV_BASE), (e) => e.code === 'ARTIFACT_INVOCATION_RECORD_CORRUPT' || e.code === 'ARTIFACT_INVOCATION_RECORD_INVALID');
  });
});

// =====================================================================
// R3 — role/stage matrix
// =====================================================================

test('R3: the matrix table covers exactly the 8 canonical stages with the frozen roles', () => {
  assert.deepEqual(Object.keys(ROLE_STAGE_MATRIX).sort(), Object.values(ARTIFACT_STAGE).sort());
  const expected = {
    single: 'single',
    'chair-plan': 'chair',
    'chair-council-synthesis': 'chair',
    'participant-report': 'member',
    'participant-critique': 'member',
    'debate-chair-brief': 'chair',
    'debate-chair-synthesis': 'chair',
    'debate-member-response': 'member',
  };
  for (const [stage, role] of Object.entries(expected)) {
    assert.equal(expectedRoleForStage(stage), role);
    assert.equal(ROLE_STAGE_MATRIX[stage].role, role);
  }
});

test('R3: path generation rejects every wrong-role / wrong-round combination', () => {
  // wrong role for stage
  for (const [role, stage] of [
    [ARTIFACT_ROLE.MEMBER, ARTIFACT_STAGE.CHAIR_PLAN],
    [ARTIFACT_ROLE.CHAIR, ARTIFACT_STAGE.PARTICIPANT_REPORT],
    [ARTIFACT_ROLE.SINGLE, ARTIFACT_STAGE.CHAIR_COUNCIL_SYNTHESIS],
    [ARTIFACT_ROLE.MEMBER, ARTIFACT_STAGE.DEBATE_CHAIR_BRIEF],
    [ARTIFACT_ROLE.CHAIR, ARTIFACT_STAGE.DEBATE_MEMBER_RESPONSE],
  ]) {
    assert.throws(() => stageDirSegments({ role, stage, actorAlias: 'a', round: ROLE_STAGE_MATRIX[stage].debate ? 1 : null }), (e) => e.code === 'ARTIFACT_ROLE_STAGE_MISMATCH', `${role}/${stage}`);
  }
  // debate stage with no round
  assert.throws(() => stageDirSegments({ role: ARTIFACT_ROLE.CHAIR, stage: ARTIFACT_STAGE.DEBATE_CHAIR_BRIEF }), (e) => e.code === 'ARTIFACT_STAGE_NEEDS_ROUND');
  // non-debate stage silently handed a round
  assert.throws(() => stageDirSegments({ role: ARTIFACT_ROLE.CHAIR, stage: ARTIFACT_STAGE.CHAIR_PLAN, round: 1 }), (e) => e.code === 'ARTIFACT_STAGE_UNEXPECTED_ROUND');
  assert.throws(() => stageDirSegments({ role: ARTIFACT_ROLE.MEMBER, stage: ARTIFACT_STAGE.PARTICIPANT_REPORT, actorAlias: 'a', round: 2 }), (e) => e.code === 'ARTIFACT_STAGE_UNEXPECTED_ROUND');
  // unknown stage
  assert.throws(() => stageDirSegments({ role: 'chair', stage: 'made-up' }), (e) => e.code === 'ARTIFACT_STAGE_UNKNOWN');
});

test('R3: InvocationRecord validation rejects an inconsistent role/stage/round even when the path is chair/plan', () => {
  const good = buildInvocationRecord({
    invocationId: 'i', invocationKey: 'i', storeId: 's', projectId: 'p', taskId: 'task-x',
    role: 'chair', stage: 'chair-plan', profileId: 'pid', actorAlias: 'chair',
    stageRelpath: 'tasks/x/chair/plan', createdAt: '2026-09-10T00:00:00Z',
  });
  assert.equal(validateInvocationRecord(good).ok, true);
  assert.equal(validateInvocationRecord({ ...good, role: 'member' }).ok, false); // R3: role must match stage
  assert.equal(validateInvocationRecord({ ...good, stage: 'not-a-stage' }).ok, false);
  assert.equal(validateInvocationRecord({ ...good, round: 2 }).ok, false); // non-debate carrying a round
});

test('R3: ArtifactMetadata validation enforces the same matrix', () => {
  const good = buildArtifactMetadata({
    storeId: 's', projectId: 'p', taskId: 'task-x', invocationId: 'i', executionId: 'e', attemptOrdinal: 0,
    role: 'member', stage: 'debate-member-response', round: 1, profileId: 'pid', actorAlias: 'a',
    deliveryMechanism: DELIVERY_MECHANISM.DIRECT_WRITE, reportRelpath: 'x/r.md', executiveLogRelpath: 'x/e.log',
  });
  assert.equal(validateArtifactMetadata(good).ok, true);
  assert.equal(validateArtifactMetadata({ ...good, role: 'chair' }).ok, false);
  assert.equal(validateArtifactMetadata({ ...good, round: null }).ok, false); // debate needs a round
  assert.equal(validateArtifactMetadata({ ...good, stage: 'participant-report', round: 1 }).ok, false); // non-debate + round
});

// =====================================================================
// R4 — real concurrency + lost parent-update protection
// =====================================================================

test('R4: real cross-process concurrency — every allocated attempt ordinal is unique, monotonic, and recorded in invocation.json', async () => {
  await withTempRoot(async (dir) => {
    const root = join(dir, 'store');
    const base = { root, storeId: 's', projectId: 'live1-local', op: 'attempts', taskId: TASK.taskId, taskSlug: TASK.taskSlug, createdAt: TASK.createdAt, invocationId: 'inv-concurrent', role: 'single', stage: 'single', actorAlias: 'a', count: 5 };
    // Seed the store/task/invocation once so children only race on attempts.
    const store = createArtifactStore({ storeId: 's', projectId: 'live1-local', root });
    const inv = store.allocateTask(TASK).allocateInvocation({ invocationId: 'inv-concurrent', role: ARTIFACT_ROLE.SINGLE, stage: ARTIFACT_STAGE.SINGLE, profileId: 'pid', actorAlias: 'a' });

    const barrier = join(dir, 'go');
    const N = 4;
    const pending = Array.from({ length: N }, () => runChild({ ...base, barrierFile: barrier }));
    // Let every child reach the barrier, then release them together.
    await new Promise((r) => setTimeout(r, 300));
    writeFileSync(barrier, 'go');
    const results = await Promise.all(pending);

    for (const r of results) assert.equal(r.exitCode, 0, `child failed: ${r.out} ${r.err}`);
    const allOrdinals = results.flatMap((r) => r.parsed.ordinals).sort((a, b) => a - b);
    assert.equal(allOrdinals.length, N * 5);
    assert.deepEqual(allOrdinals, Array.from({ length: N * 5 }, (_, i) => i), 'ordinals are 0..N*5-1, each exactly once');

    const onDisk = readdirSync(inv.path).filter((n) => n.startsWith('attempt-')).map((n) => Number(n.slice('attempt-'.length))).sort((a, b) => a - b);
    assert.deepEqual(onDisk, allOrdinals, 'attempt directories match allocated ordinals exactly');

    const rec = JSON.parse(readFileSync(inv.recordPath, 'utf8'));
    assert.deepEqual(rec.attempts.slice().sort((a, b) => a - b), allOrdinals, 'invocation.json.attempts == every allocated ordinal, no lost update');
    assert.equal(rec.latest_attempt_ordinal, allOrdinals[allOrdinals.length - 1]);
    assert.equal(rec.lifecycle, 'ASSIGNED');
    assert.equal(rec.authoritative_attempt, null);
    for (const ord of allOrdinals) {
      assert.ok(existsSync(join(inv.path, `attempt-${String(ord).padStart(2, '0')}`, 'artifact.json')), `artifact.json for attempt-${ord}`);
    }
  });
});

test('R4: two independently-opened InvocationWorkspace objects do not lose a parent attempts entry', () => {
  withTempRoot((dir) => {
    const root = join(dir, 'store');
    const mk = () => createArtifactStore({ storeId: 's', projectId: 'live1-local', root })
      .allocateTask(TASK)
      .allocateInvocation({ invocationId: 'inv-x', role: ARTIFACT_ROLE.SINGLE, stage: ARTIFACT_STAGE.SINGLE, profileId: 'pid', actorAlias: 'a' });
    const wsA = mk();
    const wsB = mk(); // separate object, its own cached #record (attempts: [])
    wsA.allocateAttempt({ deliveryMechanism: DELIVERY_MECHANISM.DIRECT_WRITE, startedAt: '2026-09-10T08:40:00Z' });
    wsB.allocateAttempt({ deliveryMechanism: DELIVERY_MECHANISM.DIRECT_WRITE, startedAt: '2026-09-10T08:41:00Z' });
    wsA.allocateAttempt({ deliveryMechanism: DELIVERY_MECHANISM.DIRECT_WRITE, startedAt: '2026-09-10T08:42:00Z' });
    const rec = JSON.parse(readFileSync(wsA.recordPath, 'utf8'));
    assert.deepEqual(rec.attempts, [0, 1, 2], 'parent list re-derived from disk, no lost update');
    assert.equal(rec.latest_attempt_ordinal, 2);
    assert.deepEqual(readdirSync(wsA.path).filter((n) => n.startsWith('attempt-')).sort(), ['attempt-00', 'attempt-01', 'attempt-02']);
  });
});

test('R4: a bounded lock-collision scenario still completes and never reuses a directory', () => {
  withTempRoot((dir) => {
    const inv = createArtifactStore({ storeId: 's', projectId: 'live1-local', root: join(dir, 'store') })
      .allocateTask(TASK)
      .allocateInvocation({ invocationId: 'inv-x', role: ARTIFACT_ROLE.SINGLE, stage: ARTIFACT_STAGE.SINGLE, profileId: 'pid', actorAlias: 'a' });
    // Simulate a peer that won attempt-00 AND left forensic bytes there.
    mkdirSync(join(inv.path, 'attempt-00'));
    writeFileSync(join(inv.path, 'attempt-00', 'peer.txt'), 'evidence');
    const a = inv.allocateAttempt({ deliveryMechanism: DELIVERY_MECHANISM.DIRECT_WRITE, startedAt: '2026-09-10T08:40:00Z' });
    assert.equal(a.ordinal, 1);
    assert.equal(readFileSync(join(inv.path, 'attempt-00', 'peer.txt'), 'utf8'), 'evidence', 'existing attempt bytes untouched');
    const rec = JSON.parse(readFileSync(inv.recordPath, 'utf8'));
    assert.deepEqual(rec.attempts, [0, 1]);
  });
});

// =====================================================================
// R5 — store identity first-creation race
// =====================================================================

test('R5: many independent processes racing to establish the SAME identity all succeed and agree', async () => {
  await withTempRoot(async (dir) => {
    const root = join(dir, 'store');
    const barrier = join(dir, 'go');
    const pending = Array.from({ length: 5 }, () => runChild({ root, storeId: 's', projectId: 'live1-local', op: 'ensure', barrierFile: barrier }));
    await new Promise((r) => setTimeout(r, 250));
    writeFileSync(barrier, 'go');
    const results = await Promise.all(pending);
    for (const r of results) {
      assert.equal(r.exitCode, 0, `child failed: ${r.out} ${r.err}`);
      assert.equal(r.parsed.ok, true);
    }
    const identity = JSON.parse(readFileSync(join(root, 'store.json'), 'utf8'));
    assert.equal(identity.store_id, 's');
    assert.equal(identity.project_id, 'live1-local');
  });
});

test('R5: processes racing with DIFFERENT identities at one root — the losers fail closed with ARTIFACT_STORE_MISMATCH', async () => {
  await withTempRoot(async (dir) => {
    const root = join(dir, 'store');
    const barrier = join(dir, 'go');
    const pending = [
      runChild({ root, storeId: 'store-A', projectId: 'live1-local', op: 'ensure', barrierFile: barrier }),
      runChild({ root, storeId: 'store-A', projectId: 'live1-local', op: 'ensure', barrierFile: barrier }),
      runChild({ root, storeId: 'store-B', projectId: 'live1-local', op: 'ensure', barrierFile: barrier }),
      runChild({ root, storeId: 'store-A', projectId: 'other-project', op: 'ensure', barrierFile: barrier }),
    ];
    await new Promise((r) => setTimeout(r, 250));
    writeFileSync(barrier, 'go');
    const results = await Promise.all(pending);

    const persisted = JSON.parse(readFileSync(join(root, 'store.json'), 'utf8'));
    const winnerKey = `${persisted.store_id}|${persisted.project_id}`;
    for (const [i, r] of results.entries()) {
      const key = [
        'store-A|live1-local', 'store-A|live1-local', 'store-B|live1-local', 'store-A|other-project',
      ][i];
      if (key === winnerKey) {
        assert.equal(r.exitCode, 0, `winner ${key} should succeed: ${r.out}`);
      } else {
        assert.equal(r.exitCode, 1, `loser ${key} must fail closed: ${r.out}`);
        assert.equal(r.parsed.code, 'ARTIFACT_STORE_MISMATCH', `loser ${key} code`);
      }
    }
  });
});

// =====================================================================
// R6 — composite filename budget
// =====================================================================

test('R6: MAX_ACTOR_ALIAS_LENGTH is derived from the longest report/log filename budget', () => {
  assert.ok(MAX_ACTOR_ALIAS_LENGTH > 0 && MAX_ACTOR_ALIAS_LENGTH < MAX_PATH_SEGMENT_LENGTH);
  const longestStage = Object.values(ARTIFACT_STAGE).reduce((a, b) => (a.length >= b.length ? a : b));
  const maxAlias = 'x'.repeat(MAX_ACTOR_ALIAS_LENGTH);
  // The alias at exactly the budget must produce legal report AND executive-log filenames.
  for (const fn of [reportFileName, executiveLogFileName]) {
    const name = fn({ startedAt: '2026-09-10T08:36:42Z', actorAlias: maxAlias, stage: longestStage });
    assert.ok(name.length <= MAX_PATH_SEGMENT_LENGTH, `${fn.name} length ${name.length}`);
  }
  // One char over the budget is refused up front, not silently truncated.
  assert.throws(() => assertActorAlias('x'.repeat(MAX_ACTOR_ALIAS_LENGTH + 1)), (e) => e.code === 'ARTIFACT_ACTOR_ALIAS_TOO_LONG');
  assert.throws(() => reportFileName({ startedAt: '2026-09-10T08:36:42Z', actorAlias: 'x'.repeat(MAX_ACTOR_ALIAS_LENGTH + 1), stage: longestStage }), (e) => e.code === 'ARTIFACT_ACTOR_ALIAS_TOO_LONG');
});

test('R6: a raw profile id whose derived alias exceeds the budget is deterministically shortened + suffixed', () => {
  const huge = `live1-${'segment-'.repeat(20)}tail`; // ~ 160 chars
  const a1 = deriveActorAlias(huge);
  const a2 = deriveActorAlias(huge);
  assert.equal(a1, a2, 'same result every run');
  assert.ok(a1.length <= MAX_ACTOR_ALIAS_LENGTH, `derived alias fits budget (${a1.length})`);
  assert.match(a1, /-[0-9a-f]{6}$/, 'identity-derived suffix, not a bare truncation');
  // Two distinct over-budget ids that share a long prefix stay distinct.
  const b = deriveActorAlias(`${huge}-other`);
  assert.notEqual(a1, b);
});

test('R6: a collision suffix still fits the filename budget', () => {
  // Two ids whose derived base is near the alias budget AND identical.
  const near = 'n'.repeat(MAX_ACTOR_ALIAS_LENGTH);
  const reg = buildActorAliasRegistry([`live1-${near}`, near]); // both derive to the same ~budget-length base
  for (const alias of reg.values()) {
    assert.doesNotThrow(() => assertActorAlias(alias), `registry alias within budget: ${alias.length}`);
  }
  assert.equal(new Set(reg.values()).size, 2, 'still unique');
});
