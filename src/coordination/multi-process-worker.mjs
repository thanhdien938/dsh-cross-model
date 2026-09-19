import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { createResultEnvelope } from '../bus/envelopes.mjs';
import { AgentBusRepository } from '../persistence/repositories/agentbus-repository.mjs';
import { SqlitePersistenceStore } from '../persistence/sqlite/sqlite-persistence-store.mjs';
import { PostgresCoordinationStore } from './postgres/postgres-coordination-store.mjs';
import { FencedDispatchCoordinator } from './fenced-dispatch-coordinator.mjs';

export function createWorkerIncarnationId(logicalWorkerId) {
  return `${logicalWorkerId}:${randomUUID()}`;
}

export class MultiProcessTaskWorker {
  constructor({ coordinationStore, dispatchCoordinator, workerIncarnationId, provider, afterClaim, leaseMs = 30_000, discoveryLimit = 32 } = {}) {
    if (!coordinationStore || typeof coordinationStore.listTaskDispatchCandidates !== 'function' || typeof coordinationStore.acquireClaim !== 'function') throw new TypeError('worker requires coordination discovery and claim store');
    if (!dispatchCoordinator || typeof dispatchCoordinator.execute !== 'function') throw new TypeError('worker requires FencedDispatchCoordinator');
    if (typeof workerIncarnationId !== 'string' || !workerIncarnationId) throw new TypeError('worker incarnation ID is required');
    if (typeof provider !== 'function') throw new TypeError('worker provider is required');
    this.coordination = coordinationStore;
    this.dispatch = dispatchCoordinator;
    this.workerIncarnationId = workerIncarnationId;
    this.provider = provider;
    this.afterClaim = afterClaim;
    this.leaseMs = leaseMs;
    this.discoveryLimit = discoveryLimit;
    this.stopRequested = false;
  }

  requestStop() { this.stopRequested = true; }

  async runOnce() {
    if (this.stopRequested) return Object.freeze({ status: 'DRAINING' });
    const candidates = await this.coordination.listTaskDispatchCandidates({ limit: this.discoveryLimit });
    for (const work of candidates) {
      if (this.stopRequested) return Object.freeze({ status: 'DRAINING' });
      const claim = await this.coordination.acquireClaim({ work_item_id: work.work_item_id, worker_incarnation_id: this.workerIncarnationId, leaseMs: this.leaseMs });
      if (!claim) continue;
      if (this.afterClaim) await this.afterClaim({ work, generation: claim.fencing_generation });
      const fence = fenceOf(claim);
      const lineage = { task_id: work.task_id, run_id: work.run_id, dispatch_attempt_id: work.dispatch_attempt_id };
      const outcome = await this.dispatch.execute({ fence, lineage, provider: (boundary) => this.provider({ work, boundary }) });
      return Object.freeze({ status: 'WORK', work_item_id: work.work_item_id, generation: claim.fencing_generation, outcome });
    }
    return Object.freeze({ status: 'IDLE' });
  }

  async run({ maxIdlePolls = 10, pollIntervalMs = 20 } = {}) {
    let idle = 0;
    const outcomes = [];
    while (!this.stopRequested && idle < maxIdlePolls) {
      const outcome = await this.runOnce();
      outcomes.push(outcome);
      if (outcome.status === 'WORK') idle = 0;
      else { idle += 1; await delay(pollIntervalMs); }
    }
    return Object.freeze(outcomes);
  }
}

export async function openMultiProcessTaskWorker({ postgres, sqlitePath, logicalWorkerId, provider, afterClaim, leaseMs, discoveryLimit, hostId = hostname() } = {}) {
  const incarnationId = createWorkerIncarnationId(logicalWorkerId);
  const coordination = await new PostgresCoordinationStore().open(postgres);
  await coordination.assertReady();
  await coordination.registerWorkerIncarnation({ logical_worker_id: logicalWorkerId, worker_incarnation_id: incarnationId, host_id: sanitizeHost(hostId), installed_profiles: [], capacity: { max_concurrency: 1, reported_in_use: 0 } });
  const sqlite = await new SqlitePersistenceStore().open({ path: sqlitePath, busyTimeoutMs: 5_000 });
  await sqlite.migrate();
  const repository = new AgentBusRepository({ store: sqlite });
  const dispatch = new FencedDispatchCoordinator({ coordinationStore: coordination, agentBusRepository: repository });
  const worker = new MultiProcessTaskWorker({ coordinationStore: coordination, dispatchCoordinator: dispatch, workerIncarnationId: incarnationId, provider, afterClaim, leaseMs, discoveryLimit });
  return Object.freeze({ worker, incarnationId, coordination, sqlite, repository, close: async () => { await sqlite.close(); await coordination.close(); } });
}

export function completedResultForWork(work, output = `completed:${work.work_item_id}`) {
  return createResultEnvelope({ id: `result-${work.work_item_id}`, taskId: work.task_id, runId: work.run_id, agent: 'alpha', status: 'completed', output });
}

function fenceOf(claim) { return { work_item_id: claim.work_item_id, owner_worker_incarnation_id: claim.owner_worker_incarnation_id, fencing_generation: claim.fencing_generation, fencing_token: claim.fencing_token }; }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function sanitizeHost(value) { const safe = String(value).replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 128); return safe || 'unknown-host'; }
