import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EXECUTION_STAGE,
  LONG_TASK_HARD_DEADLINE_MS,
  LONG_WORKSPACE_READ_COUNCIL_TIMEOUT_MS,
  executionStageForCouncilStep,
  resolveExecutionTimeoutMs,
} from '../src/pm/pm-execution-timeout-policy.mjs';
import { CouncilStepWorkflowRunner } from '../src/pm/council/council-step-workflow-runner.mjs';
import { ProductionPmBackendRegistry } from '../src/pm/production-pm-backend-registry.mjs';

const PROJECT = Object.freeze({ id: 'project', repo_path: process.cwd() });
const PROFILE = Object.freeze({
  id: 'chair', role_kind: 'PM', session_kind: 'STATELESS',
  product: 'claude-code', transport: 'stdio', model: 'sonnet', reasoning: 'medium',
});

function spec(stepKind, { workspaceRequirement = 'NONE', isImplementationParticipant = false } = {}) {
  return {
    id: `wf-${stepKind}-${workspaceRequirement}-${isImplementationParticipant}`,
    kind: 'council_step', stepKind, round: 0, profileId: PROFILE.id,
    prompt: 'bounded fixture prompt', participantProfileIds: ['participant-a'],
    workspaceRequirement, isImplementationParticipant,
  };
}

async function captureRunnerOptions(inputSpec) {
  let executionOptions = null;
  const runner = new CouncilStepWorkflowRunner({
    project: PROJECT,
    profileRegistry: { get: () => PROFILE },
    resolveDriver: (_profile, context) => {
      executionOptions = context.executionOptions;
      return { decide: async () => { throw Object.assign(new Error('fixture stop'), { code: 'FIXTURE_STOP' }); } };
    },
  });
  await runner.run(inputSpec);
  return executionOptions;
}

test('normal Council retains the existing per-stage timeout values', () => {
  assert.equal(resolveExecutionTimeoutMs(EXECUTION_STAGE.COUNCIL_CHAIR_PLAN), 120_000);
  assert.equal(resolveExecutionTimeoutMs(EXECUTION_STAGE.COUNCIL_PARTICIPANT_REPORT), 120_000);
  assert.equal(resolveExecutionTimeoutMs(EXECUTION_STAGE.COUNCIL_PARTICIPANT_CRITIQUE), 120_000);
  assert.equal(resolveExecutionTimeoutMs(EXECUTION_STAGE.COUNCIL_CHAIR_SYNTHESIS), 180_000);
});

test('WORKSPACE_READ chair_plan deterministically selects the bounded long Council class', async () => {
  const options = await captureRunnerOptions(spec('chair_plan', { workspaceRequirement: 'READ' }));
  assert.equal(options.stage, EXECUTION_STAGE.COUNCIL_WORKSPACE_READ_LONG);
  assert.equal(options.timeoutMs, LONG_WORKSPACE_READ_COUNCIL_TIMEOUT_MS);
  assert.equal(options.timeoutMs, 600_000);
  assert.equal(options.permissionMode, 'plan');
});

test('WORKSPACE_READ participant, critique, and synthesis stages share the long evidence-reasoning bound', async () => {
  for (const stepKind of ['participant_report', 'participant_critique', 'chair_synthesis']) {
    const options = await captureRunnerOptions(spec(stepKind, { workspaceRequirement: 'READ' }));
    assert.equal(options.stage, EXECUTION_STAGE.COUNCIL_WORKSPACE_READ_LONG, stepKind);
    assert.equal(options.timeoutMs, 600_000, stepKind);
    assert.equal(options.permissionMode, 'plan', stepKind);
  }
});

test('Claude receives the resolved long timeout through the existing executionOptions path', async () => {
  let received = null;
  const registry = new ProductionPmBackendRegistry({
    claudeBinary: 'claude-fixture', openCodeBinary: 'unused', codexBinary: 'unused', grokBinary: 'unused', antigravityBinary: 'unused',
    probe: () => true, observer: null,
    claudeRunner: async (options) => {
      received = options;
      throw Object.assign(new Error('fixture stop'), { code: 'FIXTURE_STOP' });
    },
  });
  const runner = new CouncilStepWorkflowRunner({
    project: PROJECT,
    profileRegistry: { get: () => PROFILE },
    resolveDriver: (profile, context) => registry.resolve(profile, context),
  });
  await runner.run(spec('chair_plan', { workspaceRequirement: 'READ' }));
  assert.equal(received.timeoutMs, 600_000);
  assert.equal(received.permissionMode, 'bypassPermissions');
  assert.equal(received.prompt.includes('bounded fixture prompt'), true);
});

test('normal Debate, SINGLE, and implementation-participant timeout classes do not regress', async () => {
  assert.equal(executionStageForCouncilStep('debate_brief'), EXECUTION_STAGE.COUNCIL_DEBATE_BRIEF);
  assert.equal(resolveExecutionTimeoutMs(EXECUTION_STAGE.COUNCIL_DEBATE_BRIEF), 120_000);
  assert.equal(resolveExecutionTimeoutMs(EXECUTION_STAGE.COUNCIL_DEBATE_RESPONSE), 120_000);
  assert.equal(resolveExecutionTimeoutMs(EXECUTION_STAGE.COUNCIL_DEBATE_SYNTHESIS), 180_000);
  assert.equal(resolveExecutionTimeoutMs(EXECUTION_STAGE.OWNER_SINGLE), 300_000);
  assert.equal(resolveExecutionTimeoutMs(EXECUTION_STAGE.OWNER_SINGLE_LONG), LONG_TASK_HARD_DEADLINE_MS);

  const implementation = await captureRunnerOptions(spec('participant_report', {
    workspaceRequirement: 'READ', isImplementationParticipant: true,
  }));
  assert.equal(implementation.stage, EXECUTION_STAGE.COUNCIL_IMPLEMENTATION_PARTICIPANT);
  assert.equal(implementation.timeoutMs, LONG_TASK_HARD_DEADLINE_MS);
  assert.equal(implementation.permissionMode, 'bypassPermissions');
});

test('WORKSPACE_READ Debate reasoning also uses the same large evidence-packet bound', async () => {
  for (const stepKind of ['debate_brief', 'debate_response', 'debate_synthesis']) {
    const options = await captureRunnerOptions(spec(stepKind, { workspaceRequirement: 'READ' }));
    assert.equal(options.stage, EXECUTION_STAGE.COUNCIL_WORKSPACE_READ_LONG, stepKind);
    assert.equal(options.timeoutMs, 600_000, stepKind);
    assert.equal(options.permissionMode, 'plan', stepKind);
  }
});
