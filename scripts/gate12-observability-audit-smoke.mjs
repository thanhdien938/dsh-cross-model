#!/usr/bin/env node
import process from 'node:process';

import { AgentRegistry } from '../src/bus/agent-registry.mjs';
import { EventBus } from '../src/bus/event-bus.mjs';
import { StateStore } from '../src/bus/state-store.mjs';
import { AgentBus } from '../src/bus/agent-bus.mjs';
import { BackendHealthRegistry } from '../src/orchestration/backend-health-registry.mjs';
import { attachExecutionHealthFeedback } from '../src/orchestration/execution-health-feedback.mjs';
import { RetryFailoverExecutor } from '../src/orchestration/retry-failover-executor.mjs';
import { OrchestrationAuditTrace, createAuditHealthFeedbackSink } from '../src/orchestration/orchestration-audit-trace.mjs';

const registry = new AgentRegistry();
const events = new EventBus({ onListenerError: () => {} });
const state = new StateStore();
const bus = new AgentBus({ registry, events, state });
const health = new BackendHealthRegistry({ cooldownMs: 60_000 });
const trace = new OrchestrationAuditTrace({ traceId: 'trace_gate12' });

registry.register('grok', { async start() { throw new Error('503 Service temporarily unavailable'); } });
registry.register('opencode', { async start() { return { output: 'audit-fallback-ok' }; } });
health.recordSuccess('grok');
health.recordSuccess('opencode');

const feedback = attachExecutionHealthFeedback({
  events,
  healthRegistry: health,
  onFeedback: createAuditHealthFeedbackSink(trace),
});
const executor = new RetryFailoverExecutor({ agentBus: bus, healthRegistry: health, maxAttempts: 3, auditTrace: trace });

const secretBody = 'GATE12_SECRET_BODY_MUST_NOT_APPEAR';
let outcome;
let error = null;
try {
  outcome = await executor.execute({
    selector: { requires: ['interrupt_active_turn'], prefer: ['grok'] },
    body: secretBody,
    context: { safeContext: 'not-recorded-by-audit-hook' },
  });
} catch (caught) {
  error = caught;
}
feedback.dispose();
const snapshot = trace.seal({ status: error ? 'failed' : outcome?.status ?? 'unknown', backend: outcome?.backend ?? null });
const entries = snapshot.entries;
const types = entries.map((entry) => entry.type);
const checks = [];
const check = (name, condition, detail) => checks.push({ name, ok: Boolean(condition), detail });

check('failover outcome completes on OpenCode', !error && outcome?.status === 'completed' && outcome?.backend === 'opencode', `${outcome?.status}/${outcome?.backend}`);
check('trace records two selections grok then opencode', entries.filter((e) => e.type === 'selection.made').map((e) => e.data.backend).join('->') === 'grok->opencode', entries.filter((e) => e.type === 'selection.made').map((e) => e.data.backend).join('->'));
const healthFeedbackIndex = types.indexOf('health.feedback');
const failedIndex = types.indexOf('attempt.failed');
const reselectIndex = types.indexOf('failover.reselect');
check('health feedback precedes failed-attempt audit and reselection', healthFeedbackIndex >= 0 && healthFeedbackIndex < failedIndex && failedIndex < reselectIndex, `${healthFeedbackIndex}<${failedIndex}<${reselectIndex}`);
const failed = entries.find((entry) => entry.type === 'attempt.failed');
check('503 classification is auditable', failed?.data?.classification === 'UPSTREAM_UNAVAILABLE' && failed?.data?.retryable === true, `${failed?.data?.classification}/${failed?.data?.retryable}`);
check('task body is absent from audit snapshot', !JSON.stringify(snapshot).includes(secretBody), 'body-redacted-by-design');
check('trace is sealed, ordered, and immutable', snapshot.sealed === true && entries.every((entry, index) => entry.sequence === index + 1 && Object.isFrozen(entry) && Object.isFrozen(entry.data)), `${entries.length} entries`);

for (const entry of checks) console.log(`${entry.ok ? 'PASS' : 'FAIL'} ${entry.name}: ${entry.detail}`);
const passed = checks.filter((entry) => entry.ok).length;
console.log(`GATE 12: ${passed}/${checks.length} checks ${passed === checks.length ? 'PASS' : 'FAIL'}`);
process.exitCode = passed === checks.length ? 0 : 1;
