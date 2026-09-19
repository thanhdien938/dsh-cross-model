#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { BACKEND_FAILURE_CLASSIFICATION } from '../src/orchestration/backend-health-registry.mjs';
import { DurableBackendHealthRegistry } from '../src/orchestration/durable-backend-health-registry.mjs';
import { selectBackendWithHealth } from '../src/orchestration/health-aware-selector.mjs';
import { HealthRepository } from '../src/persistence/repositories/health-repository.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { classifySmoke, exitCodeFor } from './lib/smoke-status.mjs';

const dir = mkdtempSync(join(tmpdir(), 'dsh-p2g5-smoke-'));
const dbPath = join(dir, 'health.db');
const checks = [];
let now = Date.parse('2026-08-18T00:00:00.000Z');

function check(name, fn) {
  try {
    const passed = fn() === true;
    checks.push({ name, passed, error: passed ? null : 'assertion returned false' });
  } catch (error) {
    checks.push({ name, passed: false, error: error.message });
  }
}

async function open() {
  const store = new SqlitePersistenceStore();
  await store.open({ path: dbPath });
  await store.migrate();
  const repository = new HealthRepository({ store });
  const registry = new DurableBackendHealthRegistry({ repository, clock: () => now, freshnessMs: 1_000, cooldownMs: 500 });
  return { store, repository, registry };
}

let first;
let second;
try {
  first = await open();
  const healthy = first.registry.recordSuccess('codex');
  await first.store.close();
  first = null;
  now += 999;
  second = await open();

  check('1. fresh HEALTHY survives reopen', () => JSON.stringify(second.registry.get('codex')) === JSON.stringify(healthy));
  now += 1;
  check('2. stale HEALTHY materializes UNKNOWN', () => second.registry.get('codex').status === 'UNKNOWN' && second.repository.getRaw('codex').status === 'HEALTHY');

  second.registry.recordFailure('opencode', { classification: BACKEND_FAILURE_CLASSIFICATION.UPSTREAM_UNAVAILABLE });
  check('3. active retry cooldown remains UNAVAILABLE', () => second.registry.get('opencode').status === 'UNAVAILABLE');
  now += 500;
  check('4. expired retry cooldown materializes UNKNOWN', () => second.registry.get('opencode').status === 'UNKNOWN');

  second.registry.recordFailure('grok', { classification: BACKEND_FAILURE_CLASSIFICATION.AUTH });
  now += 10_000;
  check('5. sticky AUTH remains UNAVAILABLE', () => second.registry.get('grok').status === 'UNAVAILABLE');
  const success = second.registry.recordSuccess('grok');
  check('6. real success clears sticky UNAVAILABLE', () => success.status === 'HEALTHY' && success.revision === 2);

  const rowsBeforeUnknownRead = second.repository.count();
  const unknown = second.registry.get('claude-code');
  check('7. restart creates no fake success/no row for UNKNOWN', () => unknown.status === 'UNKNOWN' && unknown.revision === 0 && second.repository.count() === rowsBeforeUnknownRead);

  second.registry.recordSuccess('opencode');
  second.registry.recordSuccess('grok', { degraded: true });
  check('8. selector consumes materialized durable snapshot', () => {
    const selected = selectBackendWithHealth({ requires: ['interrupt_active_turn'], prefer: ['grok'] }, second.registry.snapshot());
    return selected.backend === 'opencode' && selected.health.status === 'HEALTHY';
  });

  for (const item of checks) console.log(`${item.passed ? 'PASS' : 'FAIL'}  ${item.name}${item.error ? ` — ${item.error}` : ''}`);
  const proved = checks.filter((item) => item.passed).length;
  const status = classifySmoke({ proved, required: 8 });
  console.log(`P2-GATE5: ${status} (${proved}/8 checks) — durable health + freshness`);
  process.exitCode = exitCodeFor(status);
} catch (error) {
  console.error('P2-GATE5 harness fatal');
  console.error(String(error));
  process.exitCode = 1;
} finally {
  await first?.store.close();
  await second?.store.close();
  rmSync(dir, { recursive: true, force: true });
}
