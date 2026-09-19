import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { WorkflowRepository } from '../src/persistence/repositories/workflow-repository.mjs';
import { DurableWorkflowState } from '../src/workflow/durable-workflow-state.mjs';
import { CouncilStepWorkflowRunner } from '../src/pm/council/council-step-workflow-runner.mjs';

const PROJECT = { id: 'dsh-p6-test-b', repo_path: 'C:/repo-b' };

async function withStepState(run) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-p19-d51r-'));
  const store = new SqlitePersistenceStore();
  try {
    await store.open({ path: join(dir, 'state.db') });
    await store.migrate();
    const stepState = new DurableWorkflowState({ repository: new WorkflowRepository({ store }) });
    await run(stepState);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function throwingDriver(code, diagnostics = null) {
  return () => ({
    name: 'live-shape-fake',
    async decide() {
      const error = new Error(code);
      error.code = code;
      if (diagnostics !== null) error.diagnostics = diagnostics;
      throw error;
    },
  });
}

function stepSpec({ id, stepKind = 'participant_report', profileId = 'live1-claude-code-pm' }) {
  return {
    id,
    kind: 'council_step',
    stepKind,
    round: 1,
    profileId,
    prompt: 'focused D5.1R regression',
    participantProfileIds: ['live1-claude-code-pm', 'live1-antigravity-gemini-high'],
    isImplementationParticipant: profileId === 'live1-claude-code-pm' && stepKind === 'participant_report',
  };
}

test('D5.1 live shape: CLAUDE_TIMEOUT without structured output persists faithfully and remains the primary step failure', async () => {
  await withStepState(async (stepState) => {
    const spec = stepSpec({ id: 'wf-d51r-live-timeout' });
    const runner = new CouncilStepWorkflowRunner({
      resolveDriver: throwingDriver('CLAUDE_TIMEOUT'),
      project: PROJECT,
      stepState,
    });

    const outcome = await runner.run(spec);
    assert.equal(outcome.status, 'completed', 'Council failure convention is unchanged');
    assert.equal(outcome.finalResult.status, 'failed');
    assert.equal(outcome.finalResult.handoff.ok, false);
    assert.equal(outcome.finalResult.handoff.reason, 'CLAUDE_TIMEOUT');
    assert.deepEqual(outcome.finalResult.handoff.attempts, [{
      attempt: 0,
      ok: false,
      error_code: 'CLAUDE_TIMEOUT',
      parse_subreason: null,
      output_bytes: null,
      structured_output_present: null,
    }]);
    assert.doesNotThrow(() => JSON.stringify(outcome.finalResult));

    const durable = stepState.getWorkflow(spec.id);
    assert.equal(durable.status, 'completed');
    assert.equal(durable.steps[0].status, 'completed');
    assert.equal(durable.steps[0].dispatchedContext.handoff.reason, 'CLAUDE_TIMEOUT');
    assert.equal(durable.steps[0].dispatchedContext.handoff.attempts[0].structured_output_present, null);
    assert.equal(JSON.stringify(durable).includes('NOT_JSON_FAITHFUL'), false);

    const recovered = new CouncilStepWorkflowRunner({
      resolveDriver: () => { throw new Error('must not re-execute'); },
      project: PROJECT,
      stepState,
    }).result(spec.id);
    assert.equal(recovered.finalResult.handoff.reason, 'CLAUDE_TIMEOUT');
  });
});

test('ordinary failed non-timeout Council report keeps its typed reason and JSON null evidence', async () => {
  await withStepState(async (stepState) => {
    const spec = stepSpec({ id: 'wf-d51r-empty-output' });
    const runner = new CouncilStepWorkflowRunner({
      resolveDriver: throwingDriver('PM_DECISION_EMPTY_OUTPUT', { bytes: 0 }),
      project: PROJECT,
      stepState,
    });
    const outcome = await runner.run(spec);
    assert.equal(outcome.finalResult.handoff.reason, 'PM_DECISION_EMPTY_OUTPUT');
    assert.equal(outcome.finalResult.handoff.attempts[0].output_bytes, 0);
    assert.equal(outcome.finalResult.handoff.attempts[0].structured_output_present, null);
    assert.equal(stepState.getWorkflow(spec.id).steps[0].dispatchedContext.handoff.reason, 'PM_DECISION_EMPTY_OUTPUT');
  });
});

test('Debate failure uses the same JSON-faithful null without changing Debate semantics', async () => {
  await withStepState(async (stepState) => {
    const spec = stepSpec({ id: 'wf-d51r-debate-timeout', stepKind: 'debate_response', profileId: 'live1-antigravity-gemini-high' });
    const runner = new CouncilStepWorkflowRunner({
      resolveDriver: throwingDriver('CLAUDE_TIMEOUT'),
      project: PROJECT,
      stepState,
    });
    const outcome = await runner.run(spec);
    assert.equal(outcome.finalResult.handoff.stepKind, 'debate_response');
    assert.equal(outcome.finalResult.handoff.reason, 'CLAUDE_TIMEOUT');
    assert.equal(outcome.finalResult.handoff.attempts[0].structured_output_present, null);
    assert.equal(stepState.getWorkflow(spec.id).steps[0].dispatchedContext.handoff.reason, 'CLAUDE_TIMEOUT');
  });
});

test('ordinary successful native structured-output chair plan remains present=true', async () => {
  await withStepState(async (stepState) => {
    const spec = {
      ...stepSpec({ id: 'wf-d51r-structured-success', stepKind: 'chair_plan', profileId: 'live1-claude-pm' }),
      round: 0,
      isImplementationParticipant: false,
    };
    const profileRegistry = { get: () => ({ id: 'live1-claude-pm', product: 'claude-code' }) };
    const resolveDriver = () => ({
      name: 'structured-success-fake',
      async decide() {
        return {
          type: 'finish',
          output: 'plan ready',
          data: {
            type: 'council_plan',
            participant_instructions: {
              'live1-claude-code-pm': 'implement',
              'live1-antigravity-gemini-high': 'analyze',
            },
            critique_focus: 'critique',
            synthesis_focus: 'synthesize',
          },
        };
      },
    });
    const runner = new CouncilStepWorkflowRunner({ resolveDriver, profileRegistry, project: PROJECT, stepState });
    const outcome = await runner.run(spec);
    assert.equal(outcome.finalResult.handoff.ok, true);
    assert.equal(outcome.finalResult.handoff.attempts[0].structured_output_present, true);
    assert.deepEqual(outcome.finalResult.handoff.structured_output, {
      requested: true,
      provider: 'claude-code',
      schema_kind: 'council_chair_plan',
      present: true,
    });
    assert.equal(stepState.getWorkflow(spec.id).steps[0].dispatchedContext.handoff.structured_output.present, true);
  });
});

test('requested-but-missing native structured output remains false, distinct from not-applicable null', async () => {
  await withStepState(async (stepState) => {
    const spec = {
      ...stepSpec({ id: 'wf-d51r-structured-missing', stepKind: 'chair_plan', profileId: 'live1-claude-pm' }),
      round: 0,
      isImplementationParticipant: false,
    };
    const runner = new CouncilStepWorkflowRunner({
      resolveDriver: throwingDriver('CLAUDE_STRUCTURED_OUTPUT_MISSING'),
      profileRegistry: { get: () => ({ id: 'live1-claude-pm', product: 'claude-code' }) },
      project: PROJECT,
      stepState,
    });
    const outcome = await runner.run(spec);
    assert.equal(outcome.finalResult.handoff.reason, 'CLAUDE_STRUCTURED_OUTPUT_MISSING');
    assert.equal(outcome.finalResult.handoff.attempts[0].structured_output_present, false);
    assert.equal(outcome.finalResult.handoff.structured_output.present, false);
  });
});
