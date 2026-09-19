#!/usr/bin/env node
import process from 'node:process';
import { PmRuntime } from '../src/pm/pm-runtime.mjs';
import { eligibleBackends, selectBackend } from '../src/orchestration/capability-selector.mjs';
import { createCapabilityAwarePmDriver } from '../src/orchestration/capability-aware-pm-driver.mjs';

const checks = [];
const check = (name, condition, detail = '') => {
  checks.push({ name, pass: Boolean(condition), detail });
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

check('resume candidates = all four', JSON.stringify(eligibleBackends({ requires: ['resume_existing'] })) === JSON.stringify(['claude-code', 'codex', 'grok', 'opencode']));
check('interrupt candidates = Grok + OpenCode', JSON.stringify(eligibleBackends({ requires: ['interrupt_active_turn'] })) === JSON.stringify(['grok', 'opencode']));
check('concurrent client = OpenCode only', JSON.stringify(eligibleBackends({ requires: ['concurrent_client_safe'] })) === JSON.stringify(['opencode']));

let noUi = false;
try { selectBackend({ requires: ['ui_live_refresh'] }); } catch (error) { noUi = error.code === 'NO_PROVEN_BACKEND'; }
check('UI live refresh has no proven backend', noUi);
check('preference cannot force ineligible backend', selectBackend({ requires: ['interrupt_active_turn'], prefer: ['codex', 'grok'] }).backend === 'grok');

const workflowCalls = [];
let turn = 0;
const driver = createCapabilityAwarePmDriver({
  name: 'gate8-smoke-pm',
  async decide({ backendCapabilities }) {
    if (!backendCapabilities?.opencode) throw new Error('missing backend capability snapshot');
    turn += 1;
    if (turn === 1) {
      return {
        type: 'workflow',
        spec: {
          sender: 'pm',
          steps: [{ recipient: { requires: ['interrupt_active_turn'], prefer: ['opencode'] }, body: 'capability smoke' }],
        },
      };
    }
    return { type: 'finish', output: 'done' };
  },
});
const workflowRunner = {
  async run(spec) {
    workflowCalls.push(spec);
    return {
      workflowId: 'wf_smoke', status: 'completed', finalStepId: 'step_smoke', finalTaskId: 'task_smoke', finalRunId: 'run_smoke',
      finalResult: { id: 'result_smoke', taskId: 'task_smoke', runId: 'run_smoke', agent: spec.steps[0].recipient, status: 'completed', output: 'ok', artifacts: [], handoff: null }, error: null,
    };
  },
};
const peerRelay = {
  createConversation() { return { id: 'conv_smoke' }; },
  async exchange(input) { return { conversationId: input.conversationId, status: 'completed', hops: [], finalResult: null }; },
};
const runtime = new PmRuntime({ driver, workflowRunner, peerRelay });
const result = await runtime.run({ objective: 'prove capability-aware selection' });
check('capability-aware PM run completes', result.status === 'completed');
check('workflow receives concrete selected backend', workflowCalls[0]?.steps?.[0]?.recipient === 'opencode', `recipient=${workflowCalls[0]?.steps?.[0]?.recipient ?? '<none>'}`);

const passed = checks.filter((item) => item.pass).length;
console.log(`\nGATE 8: ${passed === checks.length ? 'PASS' : 'FAIL'} — ${passed}/${checks.length} checks`);
process.exitCode = passed === checks.length ? 0 : 1;
