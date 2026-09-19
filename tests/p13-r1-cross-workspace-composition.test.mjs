// P13-R1 §15: the first owner-value acceptance scenario, proved through the
// REAL createP5ProductionComposition() wiring (Tier 1 -- a fake, in-memory
// coordination store stands in for Postgres so this runs under plain
// `npm test`; see docs/p13/04_*.md for the Tier-2 status).
//
//   Task A : Project X, RUNNING
//   Owner submits Task B : Project Y, a DIFFERENT canonical physical
//   workspace
//   EXPECTED: Task B starts before Task A finishes; both are independently
//   observable; each completes on its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createP5ProductionComposition } from '../src/runtime/p5-production-composition.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';

// Mirrors tests/p11-r12-production-workflow-composition.test.mjs's
// coordinationFixture(), generalized to track MULTIPLE independent work
// items (keyed by work_item_id) instead of exactly one.
function coordinationFixture() {
  const work = new Map();
  const claimed = new Set();
  const done = new Set();
  const registeredWorkers = [];
  return {
    registeredWorkers,
    assertReady: async () => true,
    close: async () => {},
    registerWorkIdentity: async (value) => { work.set(value.work_item_id, value); },
    registerWorkerIncarnation: async (value) => { registeredWorkers.push(value); },
    listPmActionCandidates: async () => [...work.values()].filter((w) => !claimed.has(w.work_item_id) && !done.has(w.work_item_id)),
    acquireClaim: async ({ work_item_id, worker_incarnation_id }) => {
      if (claimed.has(work_item_id)) return null;
      claimed.add(work_item_id);
      return { work_item_id, owner_worker_incarnation_id: worker_incarnation_id, fencing_generation: 1, fencing_token: 'fixture-fence' };
    },
    renewClaim: async () => {},
    completeClaim: async (fence) => { claimed.delete(fence.work_item_id); done.add(fence.work_item_id); },
    withClaimAuthority: async (_fence, fn) => fn(),
    listTaskDispatchCandidates: async () => [],
  };
}

test('two independent tasks in two DIFFERENT physical workspaces run concurrently through the real production composition', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p13-r1-xws-'));
  const repoX = join(root, 'repo-x'); const repoY = join(root, 'repo-y');
  mkdirSync(repoX); mkdirSync(repoY);
  const sqlite = await new SqlitePersistenceStore().open({ path: join(root, 'state.db') });
  const gates = new Map(); // project.repo_path -> release()
  const invoked = [];
  const profile = { id: 'p13-delay', role_kind: 'PM', session_kind: 'STATELESS', product: 'p13-delay', transport: 'in-process' };
  const projectX = { id: 'project-x', repo_path: repoX, workspace_id: 'workspace-X', default_pm_profile_id: profile.id, autonomy: { revision: 1, effects: { SUBMIT_TASK: 'ALLOW' } } };
  const projectY = { id: 'project-y', repo_path: repoY, workspace_id: 'workspace-Y', default_pm_profile_id: profile.id, autonomy: { revision: 1, effects: { SUBMIT_TASK: 'ALLOW' } } };
  const config = {
    postgres: { connectionString: 'not-used' }, sqlitePath: join(root, 'state.db'), projects: [projectX, projectY], profiles: [profile],
    telegram: { token: 'opaque', ownerUserId: '1', ownerChatId: '2', projectId: projectX.id, pollIntervalMs: 10 },
    coordinator: { logicalId: 'c', leaseMs: 5000, pollIntervalMs: 10 }, worker: { logicalId: 'w', leaseMs: 5000, pollIntervalMs: 10 },
    pm: { scriptedDecisions: null },
  };
  const coordination = coordinationFixture();
  const owner = { close: async () => {}, claimNotifications: async () => [] };
  let composition;
  try {
    composition = await createP5ProductionComposition(config, {
      sqliteStore: sqlite, coordinationStore: coordination, ownerRepository: owner,
      fetchImpl: async () => ({ ok: true, json: async () => ({ result: [] }) }),
      pmDriverFactories: {
        'p13-delay': (_profile, { project }) => ({
          name: 'p13-delay',
          decide: async () => {
            invoked.push(project.repo_path);
            await new Promise((resolve) => gates.set(project.repo_path, resolve));
            return { type: 'finish', output: `done:${project.id}` };
          },
        }),
      },
    });
    for (const project of [projectX, projectY]) {
      await composition.taskController.submit({ command: { command_id: `cmd-${project.id}`, payload: { body: `inspect ${project.repo_path}` }, accepted_at: '2026-08-29T00:00:00.000Z' }, project, profile: composition.profileRegistry.get(profile.id) });
    }
    const worker = await composition.buildWorker();
    assert.equal(coordination.registeredWorkers[0].capacity.max_concurrency, 2, 'P15-A-003: advertised metadata derives from the same default global authority');
    const started = await worker.runOnce();
    assert.equal(started.status, 'WORK');
    assert.equal(started.started.length, 2, 'both independent workspace X and Y tasks are admitted in the SAME tick');
    // Neither task waited for the other to even begin.
    for (let i = 0; i < 200 && invoked.length < 2; i += 1) await new Promise((r) => setTimeout(r, 5));
    assert.equal(invoked.length, 2, 'task B started before task A finished -- both backends were actually invoked');
    // Complete Y first; X keeps running unaffected (completion of one never
    // touches the other -- §15's isolation requirement) -- then complete X.
    gates.get(repoY)();
    const yEntry = started.started.find((s) => s.workspace_id === 'workspace-Y');
    const yResult = await yEntry.promise;
    assert.equal(yResult.status, 'WORK');
    assert.equal(yResult.outcome.result.status, 'completed');
    const xEntry = started.started.find((s) => s.workspace_id === 'workspace-X');
    assert.equal(await Promise.race([xEntry.promise, new Promise((r) => setTimeout(() => r('STILL_RUNNING'), 20))]), 'STILL_RUNNING', 'X must not have been affected by Y completing');
    gates.get(repoX)();
    const results = await Promise.all(started.started.map((s) => s.promise));
    for (const r of results) { assert.equal(r.status, 'WORK'); assert.equal(r.outcome.result.status, 'completed'); }
    assert.deepEqual(invoked.slice().sort(), [repoX, repoY].sort());
    assert.equal(composition.pmRepository.listTerminalRuns().length, 2);
  } finally {
    await composition?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
