#!/usr/bin/env node
/**
 * Gate 6 deterministic smoke — proves the PM implementation is swappable while
 * the same AgentBus / WorkflowRunner / PeerRelay substrate remains unchanged.
 *
 * No native subscriptions are required here; provider connectivity is already
 * covered by Gates 1–5. DeepSeek local should still run prior smokes separately
 * as regression evidence.
 */

import { AgentRegistry } from '../src/bus/agent-registry.mjs';
import { EventBus } from '../src/bus/event-bus.mjs';
import { StateStore } from '../src/bus/state-store.mjs';
import { AgentBus } from '../src/bus/agent-bus.mjs';
import { WorkflowRunner } from '../src/workflow/workflow-runner.mjs';
import { PeerRelay } from '../src/peer/peer-relay.mjs';
import { PmRuntime } from '../src/pm/pm-runtime.mjs';
import { createScriptedPmDriver } from '../src/pm/scripted-pm-driver.mjs';

function fakeAdapter(name) {
  return {
    async start({ task }) {
      const peerSource = task.context?.source?.output;
      const workflowSource = task.context?.previousResult?.output;
      const inherited = peerSource || workflowSource || null;
      return {
        output: inherited ? `${name}:${inherited}` : `${name}:seed`,
        stopReason: 'completed',
        artifacts: [],
        handoff: { backend: name },
      };
    },
    async dispose() {},
  };
}

const registry = new AgentRegistry();
registry.register('alpha', fakeAdapter('alpha'));
registry.register('bravo', fakeAdapter('bravo'));

const events = new EventBus();
const state = new StateStore();
const bus = new AgentBus({ registry, events, state });
const workflowRunner = new WorkflowRunner({ bus });
const peerRelay = new PeerRelay({ bus });

const driverA = createScriptedPmDriver({
  name: 'scripted-orchestrator-a',
  decisions: [
    {
      type: 'workflow',
      spec: {
        sender: 'pm',
        steps: [
          { recipient: 'alpha', body: 'produce seed' },
          { recipient: 'bravo', body: 'consume previous result', contextFromPrevious: true },
        ],
      },
    },
    {
      type: 'peer_exchange',
      routes: [{ from: 'alpha', to: 'bravo' }],
      body: 'peer seed',
      maxHops: 2,
    },
    ({ history }) => ({
      type: 'finish',
      output: history.at(-1)?.outcome?.finalResult?.output ?? 'missing-peer-output',
      data: { path: 'workflow+peer' },
    }),
  ],
});

const driverB = createScriptedPmDriver({
  name: 'scripted-orchestrator-b',
  decisions: [{ type: 'finish', output: 'alternate-pm-complete', data: { path: 'finish-only' } }],
});

const runtimeA = new PmRuntime({ driver: driverA, workflowRunner, peerRelay });
const runtimeB = new PmRuntime({ driver: driverB, workflowRunner, peerRelay });

const resultA = await runtimeA.run({ objective: 'prove workflow and peer actions through a swappable PM' });
const resultB = await runtimeB.run({ objective: 'prove a second PM driver can use the exact same runtime dependencies' });

const checks = {
  firstPmCompleted: resultA.status === 'completed',
  firstPmUsedWorkflow: resultA.history.some((entry) => entry.outcome?.kind === 'workflow'),
  firstPmUsedPeer: resultA.history.some((entry) => entry.outcome?.kind === 'peer_exchange'),
  firstPmObservedPeerOutput: /^bravo:alpha:seed$/.test(resultA.output),
  secondPmCompleted: resultB.status === 'completed',
  driversDiffer: resultA.driver !== resultB.driver,
  capabilitiesStable: JSON.stringify(runtimeA.capabilities) === JSON.stringify(runtimeB.capabilities),
  realInfrastructureRunsOccurred: bus.listRuns().length === 4,
};

const passed = Object.values(checks).every(Boolean);
process.stdout.write('\n===== GATE 6 PLUGGABLE PM SMOKE =====\n');
process.stdout.write(`driver A: ${resultA.driver} -> ${resultA.status} (${resultA.output})\n`);
process.stdout.write(`driver B: ${resultB.driver} -> ${resultB.status} (${resultB.output})\n`);
process.stdout.write(`AgentBus runs: ${bus.listRuns().length}\n`);
for (const [name, ok] of Object.entries(checks)) process.stdout.write(`${name}: ${ok ? 'PASS' : 'FAIL'}\n`);
process.stdout.write(`GATE 6: ${passed ? 'PASS' : 'FAIL'}\n`);
process.exit(passed ? 0 : 1);
