import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CouncilStepWorkflowRunner } from '../src/pm/council/council-step-workflow-runner.mjs';
import { createP5ProductionComposition } from '../src/runtime/p5-production-composition.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { runClaudeProcess } from '../src/session/claude-code-session-bridge.mjs';
import { EXECUTION_STAGE, resolveExecutionTimeoutMs } from '../src/pm/pm-execution-timeout-policy.mjs';

// ---- Part G/X: council regression protection -----------------------------
// Proves, through the REAL CouncilStepWorkflowRunner orchestration class
// (not just the policy module in isolation), that every step kind resolves
// to its correct, bounded timeout class -- and specifically that chair_plan/
// participant_report/participant_critique stay at the pre-existing 120s
// class (T1 regression-safe) while only chair_synthesis moves to 180s.

function fakeCouncilResolveDriver(captured) {
  return (profile, context) => {
    captured.push({ profileId: profile.id, executionOptions: context.executionOptions });
    return {
      name: `fake:${profile.id}`,
      async decide(input) {
        const stepKind = input.request.context.stepKind;
        if (stepKind === 'chair_plan') {
          const ids = input.request.context.participantProfileIds ?? [];
          const instructions = Object.fromEntries(ids.map((id) => [id, `focus ${id}`]));
          return { type: 'finish', output: 'plan ready', data: { type: 'council_plan', participant_instructions: instructions, critique_focus: 'be rigorous', synthesis_focus: 'converge' } };
        }
        if (stepKind === 'participant_report') return { type: 'finish', output: 'report', data: { type: 'council_report', analysis: 'a', recommendation: 'r', risks: [], uncertainties: [] } };
        if (stepKind === 'participant_critique') return { type: 'finish', output: 'critique', data: { type: 'council_critique', criticisms: [], agreements: ['agree'], revised_recommendation: 'r2', remaining_disagreements: [] } };
        return { type: 'finish', output: 'synthesis', data: { type: 'council_synthesis' } };
      },
    };
  };
}

function stepSpec(stepKind, extra = {}) {
  return { id: `council:${stepKind}:0`, kind: 'council_step', stepKind, round: 0, profileId: 'p1', prompt: 'do it', participantProfileIds: ['p1', 'p2'], ...extra };
}

test('CouncilStepWorkflowRunner requests the COUNCIL_CHAIR_PLAN class (120000ms) for chair_plan', async () => {
  const captured = [];
  const runner = new CouncilStepWorkflowRunner({ resolveDriver: fakeCouncilResolveDriver(captured), project: { repo_path: 'C:/repo' } });
  await runner.run(stepSpec('chair_plan'));
  assert.equal(captured[0].executionOptions.timeoutMs, 120_000);
  assert.equal(captured[0].executionOptions.stage, EXECUTION_STAGE.COUNCIL_CHAIR_PLAN);
});

test('CouncilStepWorkflowRunner requests the COUNCIL_PARTICIPANT_REPORT class (120000ms) for participant_report', async () => {
  const captured = [];
  const runner = new CouncilStepWorkflowRunner({ resolveDriver: fakeCouncilResolveDriver(captured), project: { repo_path: 'C:/repo' } });
  await runner.run(stepSpec('participant_report'));
  assert.equal(captured[0].executionOptions.timeoutMs, 120_000);
  assert.equal(captured[0].executionOptions.stage, EXECUTION_STAGE.COUNCIL_PARTICIPANT_REPORT);
});

test('CouncilStepWorkflowRunner requests the COUNCIL_PARTICIPANT_CRITIQUE class (120000ms) for participant_critique', async () => {
  const captured = [];
  const runner = new CouncilStepWorkflowRunner({ resolveDriver: fakeCouncilResolveDriver(captured), project: { repo_path: 'C:/repo' } });
  await runner.run(stepSpec('participant_critique'));
  assert.equal(captured[0].executionOptions.timeoutMs, 120_000);
  assert.equal(captured[0].executionOptions.stage, EXECUTION_STAGE.COUNCIL_PARTICIPANT_CRITIQUE);
});

test('CouncilStepWorkflowRunner requests the COUNCIL_CHAIR_SYNTHESIS class (180000ms) for chair_synthesis', async () => {
  const captured = [];
  const runner = new CouncilStepWorkflowRunner({ resolveDriver: fakeCouncilResolveDriver(captured), project: { repo_path: 'C:/repo' } });
  await runner.run(stepSpec('chair_synthesis'));
  assert.equal(captured[0].executionOptions.timeoutMs, 180_000);
  assert.equal(captured[0].executionOptions.stage, EXECUTION_STAGE.COUNCIL_CHAIR_SYNTHESIS);
});

test('no council step is accidentally promoted to the OWNER_SINGLE 300000ms class', async () => {
  for (const stepKind of ['chair_plan', 'participant_report', 'participant_critique', 'chair_synthesis']) {
    const captured = [];
    const runner = new CouncilStepWorkflowRunner({ resolveDriver: fakeCouncilResolveDriver(captured), project: { repo_path: 'C:/repo' } });
    await runner.run(stepSpec(stepKind));
    assert.notEqual(captured[0].executionOptions.timeoutMs, 300_000, `${stepKind} must not use the OWNER_SINGLE class`);
  }
});

test('the SAME re-resolved driver on a bounded parse-retry re-requests the identical timeout class (no drift across attempts)', async () => {
  const captured = [];
  let calls = 0;
  const resolveDriver = (profile, context) => {
    captured.push(context.executionOptions);
    return {
      name: 'flaky',
      async decide() {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error('malformed'), { code: 'PM_DECISION_PARSE_FAILED' });
        return { type: 'finish', output: 'report', data: { type: 'council_report', analysis: 'a', recommendation: 'r', risks: [], uncertainties: [] } };
      },
    };
  };
  const runner = new CouncilStepWorkflowRunner({ resolveDriver, project: { repo_path: 'C:/repo' } });
  const outcome = await runner.run(stepSpec('participant_report'));
  assert.equal(outcome.finalResult.status, 'completed');
  assert.equal(captured.length, 2);
  assert.deepEqual(captured[0], captured[1]);
  assert.equal(captured[0].timeoutMs, 120_000);
});

// ---- Part F: the REAL production composition wires OWNER SINGLE tasks ---
// ---- to the OWNER_SINGLE policy, not the Claude bridge's blind default --

async function withSingleTaskComposition(t, fn) {
  const root = mkdtempSync(join(tmpdir(), 'p10-r021-single-'));
  mkdirSync(join(root, 'repo'));
  const sqlite = await new SqlitePersistenceStore().open({ path: join(root, 'state.db') });
  const captured = [];
  const resolvePmDriver = (profile, context) => {
    captured.push(context);
    return { name: `fake:${profile.id}`, async decide() { return { type: 'finish', output: 'ok' }; } };
  };
  resolvePmDriver.inspect = (profile) => ({ available: true, code: null, product: profile.product, transport: profile.transport, session_kind: profile.session_kind });
  const profile = { id: 'pm', role_kind: 'PM', session_kind: 'STATELESS', product: 'claude-code', transport: 'stdio', model: null };
  const project = { id: 'p', repo_path: join(root, 'repo'), default_pm_profile_id: 'pm', autonomy: { revision: 1, effects: { SUBMIT_TASK: 'ALLOW' } } };
  const config = {
    postgres: { connectionString: 'not-used' }, sqlitePath: join(root, 'state.db'),
    projects: [project], profiles: [profile],
    telegram: { token: 'opaque', ownerUserId: '1', ownerChatId: '2', projectId: 'p', pollIntervalMs: 10 },
    coordinator: { logicalId: 'c', leaseMs: 5000, pollIntervalMs: 10 }, worker: { logicalId: 'w', leaseMs: 5000, pollIntervalMs: 10 },
    pm: { scriptedDecisions: null },
  };
  const coordination = { assertReady: async () => true, close: async () => {}, registerWorkIdentity: async () => {} };
  const owner = { close: async () => {}, claimNotifications: async () => [] };
  const composition = await createP5ProductionComposition(config, { resolvePmDriver, sqliteStore: sqlite, coordinationStore: coordination, ownerRepository: owner, fetchImpl: async () => ({ ok: true, json: async () => ({ result: [] }) }) });
  try { await fn({ composition, captured, project, profile: composition.profileRegistry.get('pm') }); }
  finally { await composition.close(); rmSync(root, { recursive: true, force: true }); }
}

test('P10-R0.2.1 Part F/S: a real SINGLE task submission resolves the driver with the OWNER_SINGLE timeout policy (300000ms), never the Claude bridge blind 120000ms default', async (t) => {
  await withSingleTaskComposition(t, async ({ composition, captured, project, profile }) => {
    await composition.taskController.submit({ command: { command_id: 'cmd', payload: { body: 'objective' }, accepted_at: '2026-01-01T00:00:00.000Z' }, project, profile });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].executionOptions.timeoutMs, 300_000);
    assert.equal(captured[0].executionOptions.stage, 'single_pm');
    // Part B: never smuggled through extraCtx.
    assert.equal('timeoutMs' in captured[0].extraCtx, false);
    assert.equal(captured[0].extraCtx.taskMode, 'SINGLE');
  });
});

// ---- Part S: reproduce the old owner-live failure mechanism at a --------
// ---- deliberately scaled-down (millisecond, not minute) magnitude -------
// A real Claude backend call whose real elapsed time exceeds the OLD
// hardcoded 120000ms bridge default -- but comfortably fits inside the
// NEW OWNER_SINGLE 300000ms class -- must fail under the pre-R0.2.1
// wiring and succeed under the new one. The absolute numbers below are
// scaled by 1000x (120ms/300ms/150ms standing in for 120s/300s/150s) so
// this test finishes in well under a second (Part S: no real sleeping for
// minutes) while proving the exact same timer mechanism
// claude-code-session-bridge.mjs uses in production.
function fakeSlowSpawn(delayMs) {
  return (binary, args, options) => {
    const child = new EventEmitter();
    child.pid = 9001;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { child.killed = true; };
    setTimeout(() => {
      child.stdout.end(JSON.stringify({ session_id: 's1', result: JSON.stringify({ type: 'finish', output: 'recovered T1 context from repository history' }) }));
      child.stderr.end('');
      child.emit('close', 0);
    }, delayMs);
    return child;
  };
}

test('old owner-live failure mechanism, reproduced: a call slower than the OLD 120-class times out, but fits inside the NEW OWNER_SINGLE-class', async () => {
  const OLD_CLASS_MS = 120; // stands in for the old blind 120000ms bridge default
  const NEW_CLASS_MS = resolveExecutionTimeoutMs(EXECUTION_STAGE.OWNER_SINGLE) / 1000; // 300000/1000 = 300, scaled
  const REAL_CALL_DURATION_MS = 150; // stands in for a real >120s, <300s repo-reading T2 call

  await assert.rejects(
    runClaudeProcess({ binary: process.execPath, prompt: 'x', timeoutMs: OLD_CLASS_MS, spawnImpl: fakeSlowSpawn(REAL_CALL_DURATION_MS) }),
    (error) => error.code === 'CLAUDE_TIMEOUT',
    'the OLD class must reproduce the owner-live CLAUDE_TIMEOUT failure',
  );

  const out = await runClaudeProcess({ binary: process.execPath, prompt: 'x', timeoutMs: NEW_CLASS_MS, spawnImpl: fakeSlowSpawn(REAL_CALL_DURATION_MS) });
  assert.equal(out.result, JSON.stringify({ type: 'finish', output: 'recovered T1 context from repository history' }));
});
