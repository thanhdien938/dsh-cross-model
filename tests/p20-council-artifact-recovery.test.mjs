/**
 * P20.4 §27/§35 — artifact Council stage-level crash / restart recovery.
 * Already-sealed stages are reused with NO provider replay; stage refs are
 * reconstructed from RECORDED authority; a durably-failed stage stays failed
 * (never replayed); an ambiguous RUNNING stage is RECONCILED_NO_REPLAY;
 * participant order preserved; second restart idempotent; final_ref stable.
 * Offline.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

import { runArtifactCouncil } from '../src/pm/council/council-artifact-orchestrator.mjs';
import { withTempRoot, makeStore, councilBackends, council, aliasRegistryFor, COUNCIL_CREATED_AT } from './fixtures/p20-council-helpers.mjs';

function mk(store, spec, backends, over = {}) {
  return runArtifactCouncil({
    store, council: spec, ownerTask: 'recover', constraints: [],
    taskId: over.taskId ?? 'task-RECOV01', taskSlug: 'recover', createdAt: COUNCIL_CREATED_AT,
    aliasRegistry: aliasRegistryFor(spec), resolveReportBackend: backends,
    consumerInputTransport: 'VERBATIM_CONTENT', ...over,
  });
}
const rewrite = (p, m) => writeFileSync(p, `${JSON.stringify(m, null, 2)}\n`);
const aliasOf = (spec, id) => aliasRegistryFor(spec).get(id);

test('§35: a full re-run reuses every sealed stage with NO provider replay and a stable final_ref (idempotent x3)', async () => {
  await withTempRoot(async (dir) => {
    const spec = council({ rounds: 2 });
    const b1 = councilBackends();
    const first = await mk(makeStore(dir), spec, b1);
    assert.ok(b1.seen.length > 0);

    const b2 = councilBackends();
    const second = await mk(makeStore(dir), spec, b2);
    assert.equal(b2.seen.length, 0, 'no provider call on the idempotent re-run');
    assert.deepEqual(second.final_ref, first.final_ref);
    for (const s of second.steps) if (s.ok) assert.equal(s.execution_state, 'RECOVERED_FROM_SEAL');

    const b3 = councilBackends();
    const third = await mk(makeStore(dir), spec, b3);
    assert.equal(b3.seen.length, 0);
    assert.deepEqual(third.final_ref, first.final_ref);
  });
});

test('§35 (crash point E): synthesis SEALED but final_ref not committed -> restart recovers all stages + commits final_ref, no replay', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const spec = council({ rounds: 1 });
    const first = await mk(store, spec, councilBackends());

    const task = store.openTaskById('task-RECOV01');
    const m = JSON.parse(readFileSync(task.manifestPath, 'utf8'));
    m.final_ref = null; m.task_state = 'OPEN'; m.artifact_gate_state = null;
    rewrite(task.manifestPath, m);

    const b2 = councilBackends();
    const second = await mk(makeStore(dir), spec, b2);
    assert.equal(b2.seen.length, 0, 'no replay');
    assert.deepEqual(second.final_ref, first.final_ref);
    const m2 = JSON.parse(readFileSync(store.openTaskById('task-RECOV01').manifestPath, 'utf8'));
    assert.equal(m2.task_state, 'COMPLETED');
    assert.deepEqual(m2.stages['chair-council-synthesis'].sealed_ref, first.final_ref);
  });
});

test('§35 (crash points A-D): a partial run seals chair-plan + some reports; a healthy restart reuses them and only re-executes the unsealed stages, in owner order', async () => {
  await withTempRoot(async (dir) => {
    const spec = council({ participant_profile_ids: ['live1-gamma', 'live1-alpha', 'live1-beta'], rounds: 2 });
    // Run 1: alpha's report throws inside the backend (provider crash) -> alpha
    // report unsealed; chair-plan + gamma report seal; then run rejects at the
    // point alpha's failure cascades? No: >=1 report ok -> continues. beta seals.
    // Critiques: alpha skipped; gamma+beta run. Synthesis seals. Council completes degraded.
    const b1 = councilBackends({ plan: { 'live1-alpha': ({ stage }) => stage === 'participant-report' ? { terminalState: 'PROVIDER_ERROR', finishReason: 'error' } : {} } });
    const first = await mk(makeStore(dir), spec, b1);
    assert.equal(first.ok, true);
    assert.deepEqual(first.failed_participants, ['live1-alpha']);

    // Restart with healthy backends. Everything already sealed is reused; alpha's
    // report was durably FAILED -> it stays failed (no replay).
    const b2 = councilBackends();
    const second = await mk(makeStore(dir), spec, b2);
    assert.equal(second.seen === undefined, true);
    assert.equal(b2.seen.length, 0, 'a durably-failed stage is NOT replayed on restart');
    assert.deepEqual(second.failed_participants, ['live1-alpha']);
    assert.deepEqual(second.completed_participants, ['live1-gamma', 'live1-beta']);
    assert.deepEqual(second.final_ref, first.final_ref, 'final_ref stable');
    // owner order preserved in the step list
    const reportAliases = second.steps.filter((s) => s.step_kind === 'participant_report').map((s) => s.actor_alias);
    assert.deepEqual(reportAliases, [aliasOf(spec, 'live1-gamma'), aliasOf(spec, 'live1-alpha'), aliasOf(spec, 'live1-beta')]);
  });
});

test('§35: an ambiguous RUNNING invocation after restart is RECONCILED_NO_REPLAY (never re-executed)', async () => {
  await withTempRoot(async (dir) => {
    const store = makeStore(dir);
    const spec = council({ participant_profile_ids: ['live1-alpha', 'live1-beta'], rounds: 1 });
    await mk(store, spec, councilBackends());

    // Corrupt alpha's report invocation to a mid-call 'RUNNING' state and wipe
    // its stage entry + final_ref so the orchestrator re-walks the stage.
    const task = store.openTaskById('task-RECOV01');
    const alphaKey = 'participant-report::' + aliasOf(spec, 'live1-alpha');
    const inv = task.openInvocationById('council:task-RECOV01:participant-report:' + aliasOf(spec, 'live1-alpha'));
    const rec = JSON.parse(readFileSync(inv.recordPath, 'utf8'));
    rec.lifecycle = 'RUNNING'; rec.authoritative_attempt = null; delete rec.seal;
    writeFileSync(inv.recordPath, `${JSON.stringify(rec, null, 2)}\n`);
    const m = JSON.parse(readFileSync(task.manifestPath, 'utf8'));
    m.final_ref = null; m.task_state = 'OPEN'; m.artifact_gate_state = null; delete m.stages[alphaKey];
    rewrite(task.manifestPath, m);

    const b3 = councilBackends();
    const out = await mk(makeStore(dir), spec, b3);
    const alphaStep = out.steps.find((s) => s.step_kind === 'participant_report' && s.actor_alias === aliasOf(spec, 'live1-alpha'));
    assert.equal(alphaStep.ok, false);
    assert.equal(alphaStep.execution_state, 'RECONCILED_NO_REPLAY');
    assert.equal(b3.seen.some((s) => s.stage === 'participant-report' && s.profileId === 'live1-alpha'), false, 'alpha was never replayed');
    // beta still sealed & reused -> Council still completes on >=1 report
    assert.equal(out.ok, true);
    assert.deepEqual(out.completed_participants, ['live1-beta']);
  });
});
