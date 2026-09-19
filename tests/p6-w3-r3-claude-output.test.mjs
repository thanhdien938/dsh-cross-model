import test from 'node:test';
import assert from 'node:assert/strict';
import { ProductionPmBackendRegistry, createCliPmDriver } from '../src/pm/production-pm-backend-registry.mjs';
import { createBackendExecutionObserver } from '../src/runtime/backend-execution-observer.mjs';

// P6-W3-R3 M09 — real Project-B Claude empty-output root cause.
//
// Live reproduction (2026-08-21, real `claude` 2.1.235, real dsh-p6-test-b
// checkout) showed the *previous* renderRequest() prompt — "Return exactly
// one JSON object matching the DSH PM decision contract" with no field
// names given — sometimes gets a real Claude response back in this exact
// shape: a genuine, non-empty finish decision that never uses the
// mandatory top-level "output" key. `parseDecision()`'s M06 guard then
// (correctly, per A6) rejects it as PM_DECISION_EMPTY_OUTPUT even though
// real assistant content was produced. This fixture is that literal
// observed shape, byte for byte.
const REAL_OBSERVED_NONCOMPLIANT_SHAPE = JSON.stringify({
  type: 'finish',
  ownerCommandId: 'repro-B',
  turn: 0,
  summary: 'Repository is dsh-p6-test-b (root: E:/dev/dsh-p6-test-b, no configured git remote); current branch is master. No files were modified.',
  result: { repository: 'dsh-p6-test-b', repositoryRoot: 'E:/dev/dsh-p6-test-b', branch: 'master', remote: null, workingTreeClean: true, modified: false },
  evidence: [{ command: 'git rev-parse --abbrev-ref HEAD', output: 'master' }],
  nextAction: 'none',
});

test('M09: the real observed non-compliant Claude shape (summary/result, no output) still fails closed', async () => {
  const driver = createCliPmDriver({
    profile: { id: 'live1-claude-pm', product: 'claude-code' },
    project: { id: 'dsh-p6-test-b', repo_path: 'E:/dev/dsh-p6-test-b' },
    run: async () => REAL_OBSERVED_NONCOMPLIANT_SHAPE,
  });
  await assert.rejects(
    driver.decide({ turn: 0, request: { id: 'pmreq-x', objective: 'report repository name and current branch' }, history: [] }),
    (error) => error.code === 'PM_DECISION_EMPTY_OUTPUT',
  );
});

test('M09: renderRequest now spells out the exact "output" contract field name (regression guard against re-introducing the under-specified prompt)', async () => {
  let capturedPrompt = null;
  const registry = new ProductionPmBackendRegistry({
    probe: () => true,
    claudeBinary: 'claude',
    claudeRunner: async (input) => { capturedPrompt = input.prompt; return { result: '{"type":"finish","output":"ok"}' }; },
  });
  const driver = registry.resolve({ id: 'live1-claude-pm', product: 'claude-code', transport: 'stdio', session_kind: 'STATELESS' }, { project: { id: 'dsh-p6-test-b', repo_path: 'C:/repo-b' } });
  await driver.decide({ turn: 0, request: { id: 'pmreq-1', objective: 'x' }, history: [] });
  assert.match(capturedPrompt, /"type":"finish","output":/);
  assert.match(capturedPrompt, /do not substitute "summary", "result", "message"/);
});

test('M09: correct compliant shape (real second live reproduction, project B) extracts and completes', async () => {
  const REAL_COMPLIANT_SHAPE = JSON.stringify({
    type: 'finish',
    output: 'Repository: dsh-p6-test-b (root: E:/dev/dsh-p6-test-b; no git remotes configured, so the name comes from the repository root directory). Current branch: master. No files were modified.',
    data: { repository: 'dsh-p6-test-b', branch: 'master', remotes: [], readOnly: true },
  });
  const driver = createCliPmDriver({
    profile: { id: 'live1-claude-pm', product: 'claude-code' },
    project: { id: 'dsh-p6-test-b', repo_path: 'E:/dev/dsh-p6-test-b' },
    run: async () => REAL_COMPLIANT_SHAPE,
  });
  const decision = await driver.decide({ turn: 0, request: { id: 'pmreq-y', objective: 'report repository name and current branch' }, history: [] });
  assert.equal(decision.type, 'finish');
  assert.match(decision.output, /dsh-p6-test-b/);
  assert.match(decision.output, /master/);
});

// A3: cwd is a hard invariant — project B's child process cwd must equal
// project B's configured repo_path, never a global/desktop/main-repo cwd,
// and never cross-contaminate with a concurrently-configured project A.
test('A3: project A and project B each get their own exact cwd, never cross-routed', async () => {
  const observedCwds = [];
  const registry = new ProductionPmBackendRegistry({
    probe: () => true,
    claudeBinary: 'claude',
    claudeRunner: async (input) => { observedCwds.push(input.cwd); return { result: `{"type":"finish","output":"repo report for ${input.cwd}"}` }; },
  });
  const profile = { id: 'live1-claude-pm', product: 'claude-code', transport: 'stdio', session_kind: 'STATELESS' };
  const projectA = { id: 'live1-local', repo_path: 'E:/dev/dsh-cross-model-debate-poc' };
  const projectB = { id: 'dsh-p6-test-b', repo_path: 'E:/dev/dsh-p6-test-b' };

  const driverA = registry.resolve(profile, { project: projectA });
  const driverB = registry.resolve(profile, { project: projectB });

  const decisionA = await driverA.decide({ turn: 0, request: { id: 'r-a', objective: 'x' }, history: [] });
  const decisionB = await driverB.decide({ turn: 0, request: { id: 'r-b', objective: 'x' }, history: [] });

  assert.deepEqual(observedCwds, [projectA.repo_path, projectB.repo_path]);
  assert.match(decisionA.output, /dsh-cross-model-debate-poc/);
  assert.match(decisionB.output, /dsh-p6-test-b/);
  assert.equal(decisionA.output.includes('dsh-p6-test-b'), false);
  assert.equal(decisionB.output.includes('dsh-cross-model-debate-poc'), false);
});

// Part D — two disposable projects, same PM profile, non-empty correct
// result for both, no cross routing.
test('Part D: two-project regression — both A and B get non-empty, correctly-scoped results with the same PM profile', async () => {
  const registry = new ProductionPmBackendRegistry({
    probe: () => true,
    claudeBinary: 'claude',
    claudeRunner: async (input) => {
      const repoName = input.cwd.split(/[/\\]/).pop();
      return { result: JSON.stringify({ type: 'finish', output: `Repository: ${repoName}. Branch: main.` }) };
    },
  });
  const profile = { id: 'live1-claude-pm', product: 'claude-code', transport: 'stdio', session_kind: 'STATELESS' };
  const a = await registry.resolve(profile, { project: { id: 'a', repo_path: 'C:/disposable/a' } }).decide({ turn: 0, request: { id: 'r1', objective: 'report repository name and current branch' }, history: [] });
  const b = await registry.resolve(profile, { project: { id: 'b', repo_path: 'C:/disposable/b' } }).decide({ turn: 0, request: { id: 'r2', objective: 'report repository name and current branch' }, history: [] });
  assert.ok(a.output.trim().length > 0);
  assert.ok(b.output.trim().length > 0);
  assert.match(a.output, /\ba\b/);
  assert.match(b.output, /\bb\b/);
});

// B — the observer records the full lineage of one M09-shaped failure:
// START, PARSER outcome EMPTY_OUTPUT, TERMINAL FAILED — without altering
// the failure itself.
test('Backend execution observer records START/PARSER/TERMINAL for a real M09-shaped failure, and does not change the outcome', async () => {
  const events = [];
  const observer = createBackendExecutionObserver({ emit: (e) => events.push(e) });
  const registry = new ProductionPmBackendRegistry({
    probe: () => true,
    claudeBinary: 'claude',
    claudeRunner: async () => ({ result: REAL_OBSERVED_NONCOMPLIANT_SHAPE }),
    observer,
  });
  const driver = registry.resolve({ id: 'live1-claude-pm', product: 'claude-code', transport: 'stdio', session_kind: 'STATELESS' }, { project: { id: 'dsh-p6-test-b', repo_path: 'E:/dev/dsh-p6-test-b' } });

  await assert.rejects(driver.decide({ turn: 0, request: { id: 'pmreq-fail', objective: 'x' }, history: [] }), (e) => e.code === 'PM_DECISION_EMPTY_OUTPUT');

  const phases = events.map((e) => e.phase);
  assert.ok(phases.includes('START'));
  assert.ok(phases.includes('PARSER'));
  assert.ok(phases.includes('TERMINAL'));
  const parserEvent = events.find((e) => e.phase === 'PARSER');
  assert.equal(parserEvent.parserOutcome, 'PM_DECISION_EMPTY_OUTPUT');
  const terminalEvent = events.find((e) => e.phase === 'TERMINAL');
  assert.equal(terminalEvent.status, 'FAILED');
  for (const event of events) {
    assert.equal(event.projectId, 'dsh-p6-test-b');
    assert.equal(event.cwd, 'E:/dev/dsh-p6-test-b');
  }
});

test('an observer that throws on every call still lets a real PM decision succeed (B4: non-authoritative)', async () => {
  const explodingObserver = {
    start() { throw new Error('boom'); },
    parser() { throw new Error('boom'); },
    terminal() { throw new Error('boom'); },
    stdoutSummary() { throw new Error('boom'); },
    spawn() { throw new Error('boom'); },
    stdoutChunk() { throw new Error('boom'); },
    stderrChunk() { throw new Error('boom'); },
    exit() { throw new Error('boom'); },
  };
  const registry = new ProductionPmBackendRegistry({
    probe: () => true,
    claudeBinary: 'claude',
    claudeRunner: async () => ({ result: '{"type":"finish","output":"still works"}' }),
    observer: explodingObserver,
  });
  const driver = registry.resolve({ id: 'live1-claude-pm', product: 'claude-code', transport: 'stdio', session_kind: 'STATELESS' }, { project: { id: 'p', repo_path: 'C:/p' } });
  const decision = await driver.decide({ turn: 0, request: { id: 'r', objective: 'x' }, history: [] });
  assert.equal(decision.output, 'still works');
});
