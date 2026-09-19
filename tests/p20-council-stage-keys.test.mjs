/**
 * P20.4 §13 — deterministic Council artifact stage keys. Pure; no fs/model.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ARTIFACT_STAGE } from '../src/artifacts/artifact-paths.mjs';
import {
  councilStageKey,
  parseCouncilStageKey,
  councilFinalStageKey,
  councilStageKeyPlan,
  COUNCIL_ARTIFACT_STAGES,
  CouncilStageKeyError,
} from '../src/pm/council/council-artifact-stage-keys.mjs';

test('singleton chair stages map to their bare stage name and reject an alias', () => {
  assert.equal(councilStageKey({ artifactStage: ARTIFACT_STAGE.CHAIR_PLAN }), 'chair-plan');
  assert.equal(councilStageKey({ artifactStage: ARTIFACT_STAGE.CHAIR_COUNCIL_SYNTHESIS }), 'chair-council-synthesis');
  assert.equal(councilFinalStageKey(), 'chair-council-synthesis');
  assert.throws(
    () => councilStageKey({ artifactStage: ARTIFACT_STAGE.CHAIR_PLAN, actorAlias: 'claude-sonnet-low' }),
    (e) => e instanceof CouncilStageKeyError && e.code === 'COUNCIL_STAGE_KEY_UNEXPECTED_ALIAS',
  );
});

test('per-participant stages are keyed by artifact stage + registered actor alias', () => {
  assert.equal(
    councilStageKey({ artifactStage: ARTIFACT_STAGE.PARTICIPANT_REPORT, actorAlias: 'claude-sonnet-low' }),
    'participant-report::claude-sonnet-low',
  );
  assert.equal(
    councilStageKey({ artifactStage: ARTIFACT_STAGE.PARTICIPANT_CRITIQUE, actorAlias: 'codex-luna-low' }),
    'participant-critique::codex-luna-low',
  );
  assert.throws(
    () => councilStageKey({ artifactStage: ARTIFACT_STAGE.PARTICIPANT_REPORT }),
    (e) => e.code === 'COUNCIL_STAGE_KEY_ALIAS_REQUIRED',
  );
  // an unsafe alias is refused by the shared assertActorAlias guard
  assert.throws(() => councilStageKey({ artifactStage: ARTIFACT_STAGE.PARTICIPANT_REPORT, actorAlias: '../evil' }));
});

test('a Debate / unknown stage cannot produce a Council stage key (P20.5 not migrated)', () => {
  assert.throws(
    () => councilStageKey({ artifactStage: ARTIFACT_STAGE.DEBATE_MEMBER_RESPONSE, actorAlias: 'x' }),
    (e) => e.code === 'COUNCIL_STAGE_KEY_STAGE_UNSUPPORTED',
  );
  assert.throws(() => councilStageKey({ artifactStage: 'made-up' }), (e) => e.code === 'COUNCIL_STAGE_KEY_STAGE_UNSUPPORTED');
});

test('parseCouncilStageKey round-trips and rejects malformed keys', () => {
  assert.deepEqual(parseCouncilStageKey('chair-plan'), { artifactStage: 'chair-plan', actorAlias: null });
  assert.deepEqual(parseCouncilStageKey('participant-report::alpha'), { artifactStage: 'participant-report', actorAlias: 'alpha' });
  assert.deepEqual(parseCouncilStageKey('participant-critique::beta'), { artifactStage: 'participant-critique', actorAlias: 'beta' });
  assert.equal(parseCouncilStageKey('participant-report::'), null);
  assert.equal(parseCouncilStageKey('single'), null);
  assert.equal(parseCouncilStageKey('debate-member-response::x'), null);
  assert.equal(parseCouncilStageKey(null), null);
  for (const stage of COUNCIL_ARTIFACT_STAGES) {
    const key = councilStageKey(stage === ARTIFACT_STAGE.PARTICIPANT_REPORT || stage === ARTIFACT_STAGE.PARTICIPANT_CRITIQUE
      ? { artifactStage: stage, actorAlias: 'zeta' }
      : { artifactStage: stage });
    const parsed = parseCouncilStageKey(key);
    assert.equal(parsed.artifactStage, stage);
  }
});

test('councilStageKeyPlan is deterministic and enumeration-order independent', () => {
  const a = councilStageKeyPlan({ rounds: 2, participantAliases: ['alpha', 'beta', 'gamma'] });
  const b = councilStageKeyPlan({ rounds: 2, participantAliases: ['alpha', 'beta', 'gamma'] });
  assert.deepEqual(a, b);
  assert.deepEqual([...a.reports], ['participant-report::alpha', 'participant-report::beta', 'participant-report::gamma']);
  assert.deepEqual([...a.critiques], ['participant-critique::alpha', 'participant-critique::beta', 'participant-critique::gamma']);
  assert.equal(a.chairPlan, 'chair-plan');
  assert.equal(a.synthesis, 'chair-council-synthesis');

  const oneRound = councilStageKeyPlan({ rounds: 1, participantAliases: ['alpha', 'beta'] });
  assert.deepEqual([...oneRound.critiques], []);

  assert.throws(() => councilStageKeyPlan({ rounds: 2, participantAliases: ['dup', 'dup'] }), (e) => e.code === 'COUNCIL_STAGE_KEY_DUP_ALIAS');
  assert.throws(() => councilStageKeyPlan({ rounds: 1, participantAliases: [] }), (e) => e.code === 'COUNCIL_STAGE_KEY_NO_PARTICIPANTS');
});
