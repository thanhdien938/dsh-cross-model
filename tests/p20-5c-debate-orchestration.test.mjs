/**
 * P20.5C — durable artifact Debate orchestration on the REAL machine
 * (DurablePmRuntime + CouncilChairDriver + CouncilStepWorkflowRunner +
 * DurableWorkflowState + PmRepository/SQLite + real P20 artifact store).
 * Council prerequisite verified but NOT prematurely completed; Debate rounds
 * seal round-scoped artifacts; continuation is the SEPARATE typed control;
 * final_ref = the final Debate synthesis. Offline.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeCouncilSpec } from '../src/pm/council/council-contracts.mjs';
import { resolveAndVerifySealedReference } from '../src/artifacts/artifact-recovery.mjs';
import { withStores, buildRuntime } from './fixtures/p20-durable-council-harness.mjs';

const SPEC = (over = {}) => normalizeCouncilSpec({ chair_profile_id: 'c', participant_profile_ids: ['p1', 'p2', 'p3'], rounds: 1, ...over });

async function debateRun(taskId, { debate, maxRounds = 2, maxTurns = 40, pmSuffix = 'C1', assertions }) {
  await withStores(async ({ sqlite, newArtifactStore, newPmRepo, newStepState }) => {
    const council = SPEC({ debate: { enabled: true, max_rounds: maxRounds } });
    const calls = [];
    const rt = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls, taskId, maxTurns, debate });
    const pmRunId = 'c5'.repeat(50) + pmSuffix;
    const res = await rt.run({ objective: 'x', pmRunId, context: { council, transport_version: 'artifact_v1' } });
    await assertions({ sqlite, res, calls, newArtifactStore, newPmRepo, newStepState, council, pmRunId, taskId });
  });
}

test('P20.5C — round-1 typed STOP: final_ref = round-01 debate synthesis; Council not prematurely completed', async () => {
  await debateRun('task-C-STOP1', {
    debate: { debateTypedControl: true, continueDebate: () => false },
    assertions: ({ res, calls, newArtifactStore }) => {
      assert.equal(res.status, 'completed');
      assert.equal(res.data.type, 'council_debate');
      assert.equal(res.data.debate.rounds_run, 1);
      assert.equal(res.data.debate.engine_forced_stop, false);
      assert.equal(res.data.debate.final_continue_debate, false);
      assert.deepEqual(res.data.completed_participants, ['p1', 'p2', 'p3']);

      const m = newArtifactStore().openTaskById('task-C-STOP1').freshManifest();
      assert.equal(m.task_state, 'COMPLETED');
      assert.equal(m.artifact_gate_state, 'TASK_ARTIFACT_PASS');
      assert.ok(m.stages['debate::round-01::chair-brief']);
      assert.ok(m.stages['debate::round-01::response::p1']);
      assert.ok(m.stages['debate::round-01::chair-synthesis']);
      assert.equal('debate::round-02::chair-brief' in m.stages, false, 'no round 2 stage');
      assert.deepEqual(m.final_ref, m.stages['debate::round-01::chair-synthesis'].sealed_ref);

      const v = resolveAndVerifySealedReference({ store: newArtifactStore(), reference: m.final_ref });
      assert.equal(res.output, new TextDecoder('utf-8', { fatal: true }).decode(v.buffer));
      assert.match(res.output, /debate-chair-synthesis r1 by c/);
      assert.equal(calls.filter((x) => x.stage === 'debate-chair-brief').length, 1);
      assert.equal(calls.filter((x) => x.stage === 'debate-member-response').length, 3);
      assert.equal(calls.filter((x) => x.stage === 'debate-chair-synthesis').length, 1);
    },
  });
});

test('P20.5C — typed CONTINUE round1 -> round2 then typed STOP: final_ref = round-02 debate synthesis', async () => {
  await debateRun('task-C-R2', {
    debate: { debateTypedControl: true, continueDebate: ({ round }) => round === 1 },
    pmSuffix: 'C2',
    assertions: ({ res, calls, newArtifactStore }) => {
      assert.equal(res.status, 'completed');
      assert.equal(res.data.debate.rounds_run, 2);
      assert.equal(res.data.debate.engine_forced_stop, false);
      const m = newArtifactStore().openTaskById('task-C-R2').freshManifest();
      assert.ok(m.stages['debate::round-02::chair-synthesis']);
      assert.deepEqual(m.final_ref, m.stages['debate::round-02::chair-synthesis'].sealed_ref);
      assert.equal('debate::round-03::chair-brief' in m.stages, false);
      assert.notDeepEqual(m.stages['debate::round-01::chair-synthesis'].sealed_ref, m.stages['debate::round-02::chair-synthesis'].sealed_ref);
      assert.equal(calls.filter((x) => x.stage === 'debate-chair-synthesis').length, 2);
    },
  });
});

test('P20.5C — hard cap: max_rounds=1 + typed CONTINUE -> engine_forced_stop after round 1', async () => {
  await debateRun('task-C-CAP', {
    debate: { debateTypedControl: true, continueDebate: () => true },
    maxRounds: 1, pmSuffix: 'C3',
    assertions: ({ res, newArtifactStore }) => {
      assert.equal(res.status, 'completed');
      assert.equal(res.data.debate.rounds_run, 1);
      assert.equal(res.data.debate.engine_forced_stop, true);
      assert.equal(res.data.debate.final_continue_debate, true);
      const m = newArtifactStore().openTaskById('task-C-CAP').freshManifest();
      assert.deepEqual(m.final_ref, m.stages['debate::round-01::chair-synthesis'].sealed_ref);
      assert.equal('debate::round-02::chair-brief' in m.stages, false);
    },
  });
});

test('P20.5C — same-round peer isolation (§13/§43): a response prompt never carries a sibling response', async () => {
  const prompts = [];
  await debateRun('task-C-ISO', {
    debate: { debateTypedControl: true, continueDebate: () => false, onPrompt: (p) => prompts.push(p) },
    pmSuffix: 'C4',
    assertions: () => {
      const responsePrompts = prompts.filter((p) => p.stage === 'debate-member-response');
      assert.equal(responsePrompts.length, 3);
      for (const rp of responsePrompts) {
        for (const other of ['p1', 'p2', 'p3'].filter((id) => id !== rp.profileId)) {
          assert.equal(rp.prompt.includes(`debate response (${other})`), false, `response ${rp.profileId} must not reference peer ${other}`);
          assert.equal(rp.prompt.includes(`debate-member-response:${other}`), false);
        }
        assert.match(rp.prompt, /debate brief \(round 1\)/);
        assert.match(rp.prompt, /council-synthesis/);
      }
    },
  });
});

test('P20.5C — one Debate response fails: round continues on >=1 success; all fail -> Debate fails', async () => {
  await debateRun('task-C-1FAIL', {
    debate: { debateTypedControl: true, continueDebate: () => false, responseFails: ({ profileId }) => profileId === 'p2' },
    pmSuffix: 'C5',
    assertions: ({ res, newArtifactStore }) => {
      assert.equal(res.status, 'completed');
      assert.equal(res.data.debate.rounds_run, 1);
      const m = newArtifactStore().openTaskById('task-C-1FAIL').freshManifest();
      assert.equal('debate::round-01::response::p2' in m.stages, false, 'no fabricated ref for the failed response');
      assert.ok(m.stages['debate::round-01::response::p1'] && m.stages['debate::round-01::response::p3']);
      assert.deepEqual(m.final_ref, m.stages['debate::round-01::chair-synthesis'].sealed_ref);
    },
  });
  await debateRun('task-C-ALLFAIL', {
    debate: { debateTypedControl: true, continueDebate: () => false, responseFails: () => true },
    pmSuffix: 'C6',
    assertions: ({ res, newArtifactStore }) => {
      assert.equal(res.status, 'failed');
      assert.match(JSON.stringify(res.error ?? {}), /COUNCIL_DEBATE_ALL_RESPONSES_FAILED/);
      assert.equal(newArtifactStore().openTaskById('task-C-ALLFAIL').freshManifest().final_ref, null);
    },
  });
});

test('P20.5C — Debate-OFF artifact Council is byte-for-byte unchanged: final_ref = Council synthesis', async () => {
  await withStores(async ({ newArtifactStore, newPmRepo, newStepState }) => {
    const council = SPEC(); // debate disabled
    const calls = [];
    const rt = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls, taskId: 'task-C-OFF', maxTurns: 24 });
    const res = await rt.run({ objective: 'x', pmRunId: 'c5off'.repeat(20) + 'OFF', context: { council, transport_version: 'artifact_v1' } });
    assert.equal(res.status, 'completed');
    assert.equal(res.data.type, 'council');
    assert.equal(calls.some((x) => String(x.stage).startsWith('debate-')), false, 'no Debate stage ran');
    const m = newArtifactStore().openTaskById('task-C-OFF').freshManifest();
    assert.deepEqual(m.final_ref, m.stages['chair-council-synthesis'].sealed_ref);
    assert.equal(Object.keys(m.stages).some((k) => k.startsWith('debate::')), false);
  });
});

test('P20.5C — a fully completed Debate run resumes idempotently: 0 provider calls, same final_ref/output', async () => {
  await withStores(async ({ newArtifactStore, newPmRepo, newStepState }) => {
    const council = SPEC({ debate: { enabled: true, max_rounds: 2 } });
    const debate = { debateTypedControl: true, continueDebate: ({ round }) => round === 1 };
    const calls1 = [];
    const r1 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: calls1, taskId: 'task-C-IDEM', maxTurns: 40, debate });
    const pmRunId = 'c5idem'.repeat(18) + 'ID';
    const first = await r1.run({ objective: 'x', pmRunId, context: { council, transport_version: 'artifact_v1' } });
    assert.equal(first.status, 'completed');
    assert.equal(first.data.debate.rounds_run, 2);

    const calls2 = [];
    const r2 = buildRuntime({ council, artifactStore: newArtifactStore(), stepState: newStepState(), pmRepository: newPmRepo(), calls: calls2, taskId: 'task-C-IDEM', maxTurns: 40, debate });
    const res2 = await r2.resume(pmRunId);
    assert.equal(res2.status, 'completed');
    assert.equal(calls2.length, 0, 'zero provider calls on a fresh resume of a completed Debate run');
    assert.deepEqual(res2.data.final_ref, first.data.final_ref);
    assert.equal(res2.output, first.output);
  });
});
