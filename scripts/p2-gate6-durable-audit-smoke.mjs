#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { AgentRegistry } from '../src/bus/agent-registry.mjs';
import { EventBus } from '../src/bus/event-bus.mjs';
import { StateStore } from '../src/bus/state-store.mjs';
import { AgentBus } from '../src/bus/agent-bus.mjs';
import { BackendHealthRegistry } from '../src/orchestration/backend-health-registry.mjs';
import { DurableOrchestrationAuditTrace } from '../src/orchestration/durable-orchestration-audit-trace.mjs';
import { attachExecutionHealthFeedback } from '../src/orchestration/execution-health-feedback.mjs';
import { createAuditHealthFeedbackSink } from '../src/orchestration/orchestration-audit-trace.mjs';
import { RetryFailoverExecutor } from '../src/orchestration/retry-failover-executor.mjs';
import { AuditRepository } from '../src/persistence/repositories/audit-repository.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { classifySmoke, exitCodeFor } from './lib/smoke-status.mjs';

const dir = mkdtempSync(join(tmpdir(), 'dsh-p2g6-smoke-'));
const dbPath = join(dir, 'audit.db');
const checks = [];
let tick = 0;
const clock = () => `2026-08-18T00:00:${String(tick++).padStart(2, '0')}.000Z`;

async function check(name, fn) {
  try {
    const result = await fn();
    checks.push({ name, passed: result === true, error: result === true ? null : 'assertion returned false' });
  } catch (error) {
    checks.push({ name, passed: false, error: error.message });
  }
}

async function open() {
  const store = new SqlitePersistenceStore();
  await store.open({ path: dbPath });
  await store.migrate();
  return { store, repository: new AuditRepository({ store }) };
}

const stores = [];
try {
  const a = await open(); stores.push(a.store);
  const trace = DurableOrchestrationAuditTrace.create({ repository: a.repository, traceId: 'trace_smoke', clock });
  trace.record('one', { authorization: 'Bearer SUPERSECRET123456' });
  trace.record('two', { n: 2 });
  await a.store.close();
  const b = await open(); stores.push(b.store);
  const reopened = DurableOrchestrationAuditTrace.open({ repository: b.repository, traceId: 'trace_smoke', clock });
  const hydratedCount = b.repository.countEntries('trace_smoke');

  await check('1. append + reopen continues sequence', () => reopened.record('three', {}).sequence === 3);
  await check('2. hydration creates zero extra entries', () => hydratedCount === 2);
  await check('3. sanitized secret absent from raw DB', () => {
    const raw = b.store.get('SELECT data FROM audit_entries WHERE trace_id = ? AND sequence = 1', ['trace_smoke']).data;
    return !raw.includes('SUPERSECRET123456') && raw.includes('REDACTED');
  });

  await check('4. failed append leaves sequence/count unchanged', () => {
    const beforeCount = b.repository.countEntries('trace_smoke');
    const beforeMax = b.repository.maxSequence('trace_smoke');
    const crashing = new Proxy(b.store, {
      get(target, prop) {
        if (prop === 'transactionSync') return (fn) => target.transactionSync((ctx) => fn(Object.freeze({ ...ctx, run() { throw new Error('INJECTED_APPEND_FAILURE'); } })));
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const flaky = DurableOrchestrationAuditTrace.open({ repository: new AuditRepository({ store: crashing }), traceId: 'trace_smoke', clock });
    try { flaky.record('failed', {}); } catch {}
    return b.repository.countEntries('trace_smoke') === beforeCount && b.repository.maxSequence('trace_smoke') === beforeMax;
  });

  await check('5. seal entry + sealed flag are atomic and exactly-once', () => {
    const sealTrace = DurableOrchestrationAuditTrace.create({ repository: b.repository, traceId: 'trace_seal_atomic', clock });
    sealTrace.record('one', {});
    const crashing = new Proxy(b.store, {
      get(target, prop) {
        if (prop === 'transactionSync') {
          return (fn) => target.transactionSync((ctx) => fn(Object.freeze({
            ...ctx,
            run(sql, params) {
              if (String(sql).startsWith('UPDATE audit_traces SET sealed')) throw new Error('INJECTED_SEAL_FAILURE');
              return ctx.run(sql, params);
            },
          })));
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const flaky = DurableOrchestrationAuditTrace.open({ repository: new AuditRepository({ store: crashing }), traceId: 'trace_seal_atomic', clock });
    try { flaky.seal({ failed: true }); } catch {}
    const rolledBack = b.repository.countEntries('trace_seal_atomic') === 1 && b.repository.loadTrace('trace_seal_atomic').sealed === false;
    const first = sealTrace.seal({ done: true });
    const second = sealTrace.seal({ ignored: true });
    return rolledBack && first.entries.length === 2 && JSON.stringify(first) === JSON.stringify(second);
  });

  reopened.seal({ done: true });
  const c = await open(); stores.push(c.store);
  const sealed = DurableOrchestrationAuditTrace.open({ repository: c.repository, traceId: 'trace_smoke', clock });
  await check('6. sealed reopen rejects append', () => {
    const before = c.repository.countEntries('trace_smoke');
    let rejected = false;
    try { sealed.record('later', {}); } catch (error) { rejected = error.code === 'AUDIT_TRACE_SEALED'; }
    return rejected && c.repository.countEntries('trace_smoke') === before;
  });
  await check('7. snapshot order/immutability survives reopen', () => {
    const snapshot = sealed.snapshot();
    return Object.isFrozen(snapshot) && Object.isFrozen(snapshot.entries) && snapshot.entries.every((entry, index) => entry.sequence === index + 1 && Object.isFrozen(entry) && Object.isFrozen(entry.data));
  });

  await check('8. Gate 12 ordering remains observational with durable audit', async () => {
    const audit = DurableOrchestrationAuditTrace.create({ repository: c.repository, traceId: 'trace_ordering', clock });
    const registry = new AgentRegistry();
    const events = new EventBus({ onListenerError: () => {} });
    const bus = new AgentBus({ registry, events, state: new StateStore() });
    const health = new BackendHealthRegistry();
    registry.register('grok', { async start() { throw new Error('503 Service temporarily unavailable'); } });
    registry.register('opencode', { async start() { return { output: 'ok' }; } });
    health.recordSuccess('grok'); health.recordSuccess('opencode');
    const feedback = attachExecutionHealthFeedback({ events, healthRegistry: health, onFeedback: createAuditHealthFeedbackSink(audit) });
    const executor = new RetryFailoverExecutor({ agentBus: bus, healthRegistry: health, auditTrace: audit });
    const outcome = await executor.execute({ selector: { requires: ['interrupt_active_turn'], prefer: ['grok'] }, body: 'not audited' });
    feedback.dispose();
    const types = audit.snapshot().entries.map((entry) => entry.type);
    return outcome.backend === 'opencode' && types.indexOf('health.feedback') < types.indexOf('attempt.failed') && types.indexOf('attempt.failed') < types.indexOf('failover.reselect');
  });

  for (const item of checks) console.log(`${item.passed ? 'PASS' : 'FAIL'}  ${item.name}${item.error ? ` — ${item.error}` : ''}`);
  const proved = checks.filter((item) => item.passed).length;
  const status = classifySmoke({ proved, required: 8 });
  console.log(`P2-GATE6: ${status} (${proved}/8 checks) — durable audit trace`);
  process.exitCode = exitCodeFor(status);
} catch (error) {
  console.error('P2-GATE6 harness fatal');
  console.error(String(error));
  process.exitCode = 1;
} finally {
  for (const store of stores.reverse()) await store.close();
  rmSync(dir, { recursive: true, force: true });
}
