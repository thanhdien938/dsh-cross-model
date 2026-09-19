import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { PostgresCoordinationStore } from '../../src/coordination/postgres/postgres-coordination-store.mjs';
const config = JSON.parse(readFileSync(process.argv[2], 'utf8')); while (config.barrier && !existsSync(config.barrier)) await new Promise((r) => setTimeout(r, 5));
const store = await new PostgresCoordinationStore().open({ connectionString: process.env.DSH_P3FINAL_POSTGRES_DSN, connectionTimeoutMillis: 500 });
try { await store.assertReady(); const incarnation = `${config.logicalId}:${randomUUID()}`; await store.registerCoordinatorIncarnation({ logical_coordinator_id: config.logicalId, coordinator_incarnation_id: incarnation, host_id: config.hostId }); const leader = await store.acquireLeadership({ logical_coordinator_id: config.logicalId, coordinator_incarnation_id: incarnation, leaseMs: config.leaseMs ?? 1_000 }); process.stdout.write(`${JSON.stringify({ winner: Boolean(leader), incarnation, generation: leader?.leader_generation ?? null, hostId: config.hostId })}\n`); } finally { await store.close(); }
