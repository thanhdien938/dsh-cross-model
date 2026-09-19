/**
 * P20.1A — deterministic identity / path / naming helpers.
 * Authority: docs/architecture/P20_DSH_ARTIFACT_STORAGE_CONVENTION_V1.md
 * §5/§8/§9/§10, docs/planning/P20_IMPLEMENTATION_PLAN_POST_SURVEY_PM_FREEZE.md §12.
 *
 * Offline, pure — no filesystem, no clock.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ARTIFACT_ROLE,
  ARTIFACT_STAGE,
  ArtifactPathError,
  assertProjectIdSegment,
  assertSafeSegment,
  attemptDirName,
  parseAttemptDirName,
  buildActorAliasRegistry,
  actorAliasFor,
  debateRoundDirName,
  deriveActorAlias,
  executiveLogFileName,
  invocationKey,
  isSafeSegment,
  PREFERRED_ACTOR_ALIASES,
  reportFileName,
  sha256Hex,
  shortTaskId,
  stageDirSegments,
  taskFolderName,
  taskSlug,
  toStoreRelativePosix,
  utcCompactTimestamp,
} from '../src/artifacts/artifact-paths.mjs';

// ---- UTC compact timestamp -------------------------------------------

test('utcCompactTimestamp is UTC YYYYMMDD_HHMMSS and matches the freeze example', () => {
  assert.equal(utcCompactTimestamp('2026-09-10T08:32:15.123Z'), '20260910_083215');
});

test('utcCompactTimestamp normalises a non-UTC offset to UTC', () => {
  // 2026-09-10T08:32:15+07:00 === 2026-09-10T01:32:15Z (freeze §5 example)
  assert.equal(utcCompactTimestamp('2026-09-10T08:32:15+07:00'), '20260910_013215');
});

test('utcCompactTimestamp refuses an invalid input rather than falling back to wall-clock time', () => {
  assert.throws(() => utcCompactTimestamp('not-a-date'), ArtifactPathError);
  assert.throws(() => utcCompactTimestamp(undefined), ArtifactPathError);
  assert.throws(() => utcCompactTimestamp(''), ArtifactPathError);
});

// ---- task slug ------------------------------------------------------

test('taskSlug is a deterministic hyphen-joined lowercase transform of the first meaningful line', () => {
  assert.equal(taskSlug('  \n\n  T5 Cross-Backend Council!!\nsecond line'), 't5-cross-backend-council');
  assert.equal(taskSlug(''), 'task');
  assert.equal(taskSlug('!!!'), 'task');
  assert.equal(taskSlug('x'), 'x');
});

test('taskSlug is idempotent and bounds length at a hyphen boundary', () => {
  const long = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu';
  const slug = taskSlug(long, 24);
  assert.ok(slug.length <= 24);
  assert.equal(slug, taskSlug(long, 24));
  assert.doesNotThrow(() => assertSafeSegment(slug));
});

test('taskSlug handles Unicode input by folding to ASCII-safe segments', () => {
  const slug = taskSlug('Café — Ünïcödé Tïtlé 日本語');
  assert.doesNotThrow(() => assertSafeSegment(slug));
  assert.match(slug, /^[a-z0-9-]+$/);
  assert.equal(slug, taskSlug('Café — Ünïcödé Tïtlé 日本語'));
});

// ---- short task id ------------------------------------------------

test('shortTaskId reproduces the freeze §5 example shape task-XXXXXXXX', () => {
  assert.equal(shortTaskId('task-LBGXGEhVZ5y1koA-yL7X_WiqdhO2EGmT'), 'task-LBGXGEhV');
});

test('shortTaskId is deterministic and rejects a non-canonical id', () => {
  assert.equal(shortTaskId('task-abc123def'), shortTaskId('task-abc123def'));
  assert.throws(() => shortTaskId('../../etc/passwd'), ArtifactPathError);
  assert.throws(() => shortTaskId('task with spaces'), ArtifactPathError);
});

// ---- task folder name -----------------------------------------------

test('taskFolderName is the frozen <ts>__<slug>__<short-id> order (slug before short id)', () => {
  const name = taskFolderName({
    taskId: 'task-LBGXGEhVZ5y1koA-yL7X_WiqdhO2EGmT',
    createdAt: '2026-09-10T08:32:15Z',
    taskSlug: 'T5 Cross Backend Council',
  });
  assert.equal(name, '20260910_083215__t5-cross-backend-council__task-LBGXGEhV');
  assert.doesNotThrow(() => assertSafeSegment(name));
});

test('taskFolderName is fully deterministic for the same identity inputs', () => {
  const args = { taskId: 'task-xyz', createdAt: '2026-01-01T00:00:00.000Z', taskSlug: 'Fixed Title' };
  assert.equal(taskFolderName(args), taskFolderName(args));
});

// ---- path segment safety (freeze §10) ------------------------------

test('assertSafeSegment refuses every adversarial path shape from the freeze', () => {
  const cases = {
    '/': 'ARTIFACT_PATH_SEGMENT_UNSAFE',
    '\\': 'ARTIFACT_PATH_SEGMENT_UNSAFE',
    'a/b': 'ARTIFACT_PATH_SEGMENT_UNSAFE',
    'a\\b': 'ARTIFACT_PATH_SEGMENT_UNSAFE',
    '..': 'ARTIFACT_PATH_SEGMENT_DOT',
    '.': 'ARTIFACT_PATH_SEGMENT_DOT',
    '...': 'ARTIFACT_PATH_SEGMENT_DOT',
    '/etc/passwd': 'ARTIFACT_PATH_SEGMENT_UNSAFE',
    'C:foo': 'ARTIFACT_PATH_SEGMENT_UNSAFE',
    'C:\\x': 'ARTIFACT_PATH_SEGMENT_UNSAFE',
    'a:b': 'ARTIFACT_PATH_SEGMENT_UNSAFE',
    'nul': 'ARTIFACT_PATH_SEGMENT_RESERVED',
    'NUL': 'ARTIFACT_PATH_SEGMENT_RESERVED',
    'CON': 'ARTIFACT_PATH_SEGMENT_RESERVED',
    'com1': 'ARTIFACT_PATH_SEGMENT_RESERVED',
    'LPT9': 'ARTIFACT_PATH_SEGMENT_RESERVED',
    'nul.txt': 'ARTIFACT_PATH_SEGMENT_RESERVED',
    'trailing.': 'ARTIFACT_PATH_SEGMENT_TRAILING',
    'trailing ': 'ARTIFACT_PATH_SEGMENT_UNSAFE',
    'x y': 'ARTIFACT_PATH_SEGMENT_UNSAFE',
    'tab\tx': 'ARTIFACT_PATH_SEGMENT_UNSAFE',
    'nullbyte\u0000': 'ARTIFACT_PATH_SEGMENT_UNSAFE',
    'ctrl\u0001': 'ARTIFACT_PATH_SEGMENT_UNSAFE',
    '': 'ARTIFACT_PATH_SEGMENT_EMPTY',
  };
  for (const [bad, code] of Object.entries(cases)) {
    assert.throws(() => assertSafeSegment(bad), (e) => e instanceof ArtifactPathError && e.code === code, `expected ${code} for ${JSON.stringify(bad)}`);
    assert.equal(isSafeSegment(bad), false);
  }
});

test('assertSafeSegment rejects an unbounded component length but accepts a long-but-bounded one', () => {
  assert.throws(() => assertSafeSegment('a'.repeat(121)), (e) => e.code === 'ARTIFACT_PATH_SEGMENT_TOO_LONG');
  assert.doesNotThrow(() => assertSafeSegment('a'.repeat(120)));
});

test('assertSafeSegment accepts the legitimate generated segment shapes', () => {
  for (const good of ['20260910_083215', 't5-cross-backend-council', 'task-LBGXGEhV', 'attempt-00', 'inv-abc123', 'chair', 'participant-report', 'round-01']) {
    assert.equal(assertSafeSegment(good), good);
  }
});

test('assertProjectIdSegment fails closed on a config-legal id that carries ":"', () => {
  assert.equal(assertProjectIdSegment('live1-local'), 'live1-local');
  assert.equal(assertProjectIdSegment('live1'), 'live1');
  assert.throws(() => assertProjectIdSegment('live1:local'), (e) => e.code === 'ARTIFACT_PROJECT_ID_UNSAFE');
  assert.throws(() => assertProjectIdSegment('../evil'), ArtifactPathError);
});

// ---- invocation key ----------------------------------------------

test('invocationKey passes a filesystem-safe id straight through and hashes an unsafe one', () => {
  assert.equal(invocationKey('inv-LBGXGEhVZ5y1koA-yL7X_WiqdhO2EGmT'), 'inv-LBGXGEhVZ5y1koA-yL7X_WiqdhO2EGmT');
  const hashed = invocationKey('inv/../escape');
  assert.match(hashed, /^inv-[0-9a-f]{16}$/);
  assert.doesNotThrow(() => assertSafeSegment(hashed));
  assert.equal(invocationKey('inv/../escape'), hashed); // deterministic
});

// ---- attempt dir names -----------------------------------------------

test('attemptDirName is zero-padded monotonic and round-trips', () => {
  assert.equal(attemptDirName(0), 'attempt-00');
  assert.equal(attemptDirName(1), 'attempt-01');
  assert.equal(attemptDirName(42), 'attempt-42');
  assert.equal(attemptDirName(100), 'attempt-100');
  assert.equal(parseAttemptDirName('attempt-00'), 0);
  assert.equal(parseAttemptDirName('attempt-07'), 7);
  assert.equal(parseAttemptDirName('attempt-100'), 100);
  assert.equal(parseAttemptDirName('not-an-attempt'), null);
  assert.equal(parseAttemptDirName('invocation.json'), null);
  assert.throws(() => attemptDirName(-1), ArtifactPathError);
  assert.throws(() => attemptDirName(1.5), ArtifactPathError);
});

// ---- report / executive log filenames (freeze §8) -----------------

test('report and executive log filenames share the invocation-start UTC prefix', () => {
  const args = { startedAt: '2026-09-10T01:36:42Z', actorAlias: 'antigravity-gemini-3-8-flash-high', stage: 'participant-report' };
  assert.equal(reportFileName(args), '20260910_013642__antigravity-gemini-3-8-flash-high__participant-report__report.md');
  assert.equal(executiveLogFileName(args), '20260910_013642__antigravity-gemini-3-8-flash-high__participant-report__executive.log');
});

test('report filename rejects an unsafe alias or stage rather than building a bad path', () => {
  assert.throws(() => reportFileName({ startedAt: '2026-09-10T01:36:42Z', actorAlias: '../x', stage: 'participant-report' }), ArtifactPathError);
  assert.throws(() => reportFileName({ startedAt: '2026-09-10T01:36:42Z', actorAlias: 'a', stage: 'weird/stage' }), ArtifactPathError);
});

// ---- stage hierarchy (freeze §6) ---------------------------------

test('stageDirSegments maps every canonical stage to the frozen hierarchy', () => {
  assert.deepEqual(stageDirSegments({ role: ARTIFACT_ROLE.SINGLE, stage: ARTIFACT_STAGE.SINGLE, actorAlias: 'claude-sonnet-low' }), ['single', 'claude-sonnet-low']);
  assert.deepEqual(stageDirSegments({ role: ARTIFACT_ROLE.CHAIR, stage: ARTIFACT_STAGE.CHAIR_PLAN }), ['chair', 'plan']);
  assert.deepEqual(stageDirSegments({ role: ARTIFACT_ROLE.CHAIR, stage: ARTIFACT_STAGE.CHAIR_COUNCIL_SYNTHESIS }), ['chair', 'council-synthesis']);
  assert.deepEqual(stageDirSegments({ role: ARTIFACT_ROLE.MEMBER, stage: ARTIFACT_STAGE.PARTICIPANT_REPORT, actorAlias: 'codex-luna-low' }), ['members', 'codex-luna-low', 'participant-report']);
  assert.deepEqual(stageDirSegments({ role: ARTIFACT_ROLE.MEMBER, stage: ARTIFACT_STAGE.PARTICIPANT_CRITIQUE, actorAlias: 'codex-luna-low' }), ['members', 'codex-luna-low', 'participant-critique']);
  assert.deepEqual(stageDirSegments({ role: ARTIFACT_ROLE.CHAIR, stage: ARTIFACT_STAGE.DEBATE_CHAIR_BRIEF, round: 1 }), ['debate', 'round-01', 'chair', 'brief']);
  assert.deepEqual(stageDirSegments({ role: ARTIFACT_ROLE.CHAIR, stage: ARTIFACT_STAGE.DEBATE_CHAIR_SYNTHESIS, round: 2 }), ['debate', 'round-02', 'chair', 'synthesis']);
  assert.deepEqual(stageDirSegments({ role: ARTIFACT_ROLE.MEMBER, stage: ARTIFACT_STAGE.DEBATE_MEMBER_RESPONSE, round: 2, actorAlias: 'a' }), ['debate', 'round-02', 'members', 'a', 'response']);
});

test('stageDirSegments enforces the alias/round preconditions and rejects unknown stages', () => {
  assert.throws(() => stageDirSegments({ role: 'member', stage: ARTIFACT_STAGE.PARTICIPANT_REPORT }), (e) => e.code === 'ARTIFACT_STAGE_NEEDS_ALIAS');
  assert.throws(() => stageDirSegments({ role: 'chair', stage: ARTIFACT_STAGE.DEBATE_CHAIR_BRIEF }), (e) => e.code === 'ARTIFACT_STAGE_NEEDS_ROUND');
  assert.throws(() => stageDirSegments({ role: 'chair', stage: 'made-up' }), (e) => e.code === 'ARTIFACT_STAGE_UNKNOWN');
  assert.throws(() => stageDirSegments({ role: 'chair', stage: ARTIFACT_STAGE.DEBATE_CHAIR_BRIEF, round: 0 }), (e) => e.code === 'ARTIFACT_ROUND_INVALID');
  assert.throws(() => debateRoundDirName(100), (e) => e.code === 'ARTIFACT_ROUND_INVALID');
});

test('toStoreRelativePosix always joins with "/" and validates every segment', () => {
  assert.equal(toStoreRelativePosix(['tasks', '20260910_083215__x__task-y', 'chair', 'plan']), 'tasks/20260910_083215__x__task-y/chair/plan');
  assert.throws(() => toStoreRelativePosix(['ok', '../bad']), ArtifactPathError);
});

// ---- actor alias (freeze §9 / §16) ------------------------------

test('deriveActorAlias is a deterministic, filesystem-safe, lowercase transform', () => {
  assert.equal(deriveActorAlias('live1-antigravity-gemini-3-8-flash-high'), 'antigravity-gemini-3-8-flash-high');
  assert.equal(deriveActorAlias('live1-opencode-opencode-go-glm-5-3-flash'), 'opencode-go-glm-5-3-flash');
  assert.equal(deriveActorAlias('LIVE1-Claude-Sonnet-LOW'), 'claude-sonnet-low');
  assert.equal(deriveActorAlias('x'), deriveActorAlias('x'));
  assert.doesNotThrow(() => assertSafeSegment(deriveActorAlias('weird///name!!!')));
  assert.throws(() => deriveActorAlias(''), ArtifactPathError);
});

test('buildActorAliasRegistry is stable and independent of enumeration order', () => {
  const ids = ['live1-antigravity-gemini-3-8-flash-high', 'live1-codex-gpt-5-6-luna-low', 'live1-claude-sonnet-low'];
  const a = buildActorAliasRegistry(ids);
  const b = buildActorAliasRegistry([...ids].reverse());
  assert.deepEqual([...a.entries()].sort(), [...b.entries()].sort());
  assert.equal(actorAliasFor(a, 'live1-claude-sonnet-low'), 'claude-sonnet-low');
});

test('buildActorAliasRegistry honours explicit config overrides (freeze §9 preferred examples)', () => {
  const ids = Object.keys(PREFERRED_ACTOR_ALIASES);
  const reg = buildActorAliasRegistry(ids, { overrides: PREFERRED_ACTOR_ALIASES });
  for (const [profileId, alias] of Object.entries(PREFERRED_ACTOR_ALIASES)) {
    assert.equal(reg.get(profileId), alias);
  }
});

test('buildActorAliasRegistry disambiguates a colliding alias with an identity-derived suffix, never overwriting', () => {
  // Two distinct full ids that derive to the same base alias.
  const ids = ['live1-team-alpha', 'team-alpha'];
  const reg = buildActorAliasRegistry(ids);
  const aliases = [...reg.values()];
  assert.equal(new Set(aliases).size, 2, 'aliases must stay unique');
  assert.ok(aliases.includes('team-alpha'));
  const suffixed = aliases.find((a) => a !== 'team-alpha');
  assert.match(suffixed, /^team-alpha-[0-9a-f]{6}$/);
  // Deterministic regardless of order.
  assert.deepEqual([...buildActorAliasRegistry([...ids].reverse()).entries()].sort(), [...reg.entries()].sort());
});

test('buildActorAliasRegistry throws on an unresolvable override collision rather than overwriting', () => {
  assert.throws(
    () => buildActorAliasRegistry(['pA', 'pB'], { overrides: { pA: 'same', pB: 'same' } }),
    (e) => e.code === 'ARTIFACT_ALIAS_OVERRIDE_COLLISION',
  );
});

test('actorAliasFor rejects an unregistered profile deterministically', () => {
  const reg = buildActorAliasRegistry(['pA']);
  assert.throws(() => actorAliasFor(reg, 'pB'), (e) => e.code === 'ARTIFACT_ALIAS_UNREGISTERED');
});

test('sha256Hex is stable lowercase hex', () => {
  assert.match(sha256Hex('abc'), /^[0-9a-f]{64}$/);
  assert.equal(sha256Hex('abc'), sha256Hex('abc'));
});
