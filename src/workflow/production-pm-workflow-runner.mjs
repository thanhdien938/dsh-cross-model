/**
 * Production SINGLE-PM workflow composition.
 *
 * This module is deliberately backend-neutral. A workflow step is dispatched
 * through the existing AgentBus and each registered PM profile is adapted to
 * the AgentAdapter contract. The profile's normal production driver remains
 * the only transport boundary; API and CLI profiles therefore share this
 * exact workflow path.
 */

import { AgentBus } from '../bus/agent-bus.mjs';
import { AgentRegistry } from '../bus/agent-registry.mjs';
import { EventBus } from '../bus/event-bus.mjs';
import { DurableStateStore } from '../bus/durable-state-store.mjs';
import { WorkflowRepository } from '../persistence/repositories/workflow-repository.mjs';
import { DurableWorkflowState } from './durable-workflow-state.mjs';
import { WorkflowRunner } from './workflow-runner.mjs';
import { EXECUTION_STAGE, resolveExecutionOptions } from '../pm/pm-execution-timeout-policy.mjs';

function workflowError(message, code) {
  return Object.assign(new Error(message), { code });
}

/**
 * The first-generation PM prompt documented the compact `{task,agent}` form,
 * while the core runner's canonical contract is `steps[]`. Normalize that
 * production-wide vocabulary here, immediately before workflow validation.
 * This is not parsing model text and is not provider-specific.
 */
export function normalizeProductionWorkflowSpec(spec = {}) {
  if (Array.isArray(spec.steps)) return spec;
  if (typeof spec.task === 'string' && spec.task.trim() && typeof spec.agent === 'string' && spec.agent.trim()) {
    const { task, agent, ...rest } = spec;
    return { ...rest, steps: [{ recipient: agent, body: task }] };
  }
  return spec;
}

function createProfileStepAdapter({ profile, project, resolveDriver, extraCtx }) {
  return Object.freeze({
    async start({ task, signal }) {
      const driver = resolveDriver(profile, {
        project,
        extraCtx: {
          ...(typeof extraCtx === 'function' ? extraCtx(task) : {}),
          taskMode: 'SINGLE_WORKFLOW_STEP',
        },
        // P18-W4R3: this IS the worker/implementation step (dispatched via
        // the 'worker' AgentBus recipient — see createProductionPmWorkflow
        // Runner() below) — the one place in the SINGLE task lifecycle that
        // genuinely needs to read/edit files and run tests/build commands
        // in the task workspace, as opposed to the PM's own planning/
        // decision turn (p5-production-composition.mjs's top-level driver,
        // still `executionCapable: false` by omission). DSH's own task-
        // branch lifecycle (verifyBoundBranch/publish authority) is
        // unaffected either way — this only changes what the CLI session
        // may do inside its own turn.
        //
        // DSH-TIMEOUT-1 Part B (audit Finding T-1): `task.context.runtimeClass`
        // — merged in by durable-pm-runtime.mjs's #processCommitted() only
        // when the owning task was genuinely dispatched LONG (never
        // inferred here, never defaulted to LONG for an ordinary task) —
        // is the one signal this adapter can read to resolve the SAME LONG
        // budget the top-level PM planning turn already gets for that task
        // (p5-production-composition.mjs's createRuntime()). Any value
        // other than the exact literal `'LONG'` (including absent/null,
        // i.e. every pre-existing caller and every NORMAL task) resolves
        // the exact same OWNER_SINGLE stage as before this wave — byte-
        // for-byte backward compatible.
        executionOptions: resolveExecutionOptions(
          task.context?.runtimeClass === 'LONG' ? EXECUTION_STAGE.OWNER_SINGLE_LONG : EXECUTION_STAGE.OWNER_SINGLE,
          { executionCapable: true },
        ),
      });
      const decision = await driver.decide({
        request: { id: task.id, objective: task.body, context: task.context ?? {}, createdAt: task.createdAt },
        turn: 0,
        history: [],
        capabilities: ['finish'],
        signal,
      });
      if (decision?.type !== 'finish') {
        throw workflowError(`workflow step backend returned ${decision?.type ?? 'no decision'} instead of finish`, 'WORKFLOW_STEP_DECISION_UNSUPPORTED');
      }
      return { output: decision.output ?? '', stopReason: 'finish', artifacts: [] };
    },
  });
}

export function createProductionPmWorkflowRunner({ store, agentBusRepository, profileRegistry, resolveDriver, project, extraCtx = null } = {}) {
  if (!store || !agentBusRepository || !profileRegistry || typeof resolveDriver !== 'function' || !project?.default_pm_profile_id) {
    throw new TypeError('production PM workflow composition dependencies required');
  }
  const registry = new AgentRegistry();
  for (const profile of profileRegistry.list()) {
    registry.register(
      profile.id,
      createProfileStepAdapter({ profile, project, resolveDriver, extraCtx }),
      { profile_id: profile.id, product: profile.product, transport: profile.transport },
    );
  }
  const defaultProfile = profileRegistry.get(project.default_pm_profile_id);
  registry.register(
    'worker',
    createProfileStepAdapter({ profile: defaultProfile, project, resolveDriver, extraCtx }),
    { profile_id: defaultProfile.id, product: defaultProfile.product, transport: defaultProfile.transport, alias: 'project-default' },
  );
  const events = new EventBus();
  // P20.8 PRE-R3 R3-4 — advertise the dispatch-durability capability that
  // `agentBusRepository` (AgentBusRepository) already fully implements
  // (prepareDispatch / startDispatch / terminalCommitSuccess /
  // terminalCommitFailure) but does not itself expose as a bare property.
  // Without this wrap AgentBus silently takes its legacy createTask/createRun
  // path with no write-ahead intent — the exact production gap the Astra
  // audit found (a crash between run creation and the adapter call, or
  // during a long adapter call, left no durable dispatch-attempt row to
  // recover from). DurableStateStore is the SAME proven wrapper already
  // exercised end-to-end against a real AgentBusRepository in
  // tests/dispatch-intent-recovery.test.mjs and tests/p2gate3-remediation.test.mjs
  // — this is composition-only; no new primitive.
  const bus = new AgentBus({ registry, events, state: new DurableStateStore({ repository: agentBusRepository }) });
  const state = new DurableWorkflowState({ repository: new WorkflowRepository({ store }) });
  const runner = new WorkflowRunner({ bus, events, state });
  return Object.freeze({
    run: (spec) => runner.run(normalizeProductionWorkflowSpec(spec)),
    result: (workflowId) => runner.result(workflowId),
    cancel: (workflowId) => runner.cancel(workflowId),
    getWorkflow: (workflowId) => runner.getWorkflow(workflowId),
    transcript: (workflowId) => runner.transcript(workflowId),
    registry,
    contract: 'shared-production-pm-workflow',
  });
}
