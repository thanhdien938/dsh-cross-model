import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { openMultiProcessTaskWorker, completedResultForWork } from '../../src/coordination/multi-process-worker.mjs';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
let runtime;
let stopping = false;
const stop = () => { stopping = true; runtime?.worker.requestStop(); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
try {
  while (config.startBarrier && !existsSync(config.startBarrier)) await delay(5);
  runtime = await openMultiProcessTaskWorker({
    postgres: { connectionString: process.env.DSH_P3G4_POSTGRES_DSN, connectionTimeoutMillis: 500, query_timeout: 2_000 },
    sqlitePath: config.sqlitePath, logicalWorkerId: config.logicalWorkerId,
    leaseMs: config.leaseMs ?? 30_000,
    afterClaim: config.claimedMarker ? async () => {
      durableMarker(config.claimedMarker, runtime.incarnationId);
      while (config.claimRelease && !existsSync(config.claimRelease)) await delay(5);
    } : undefined,
    provider: async ({ work }) => {
      appendDurable(config.ledgerPath, { work_item_id: work.work_item_id, incarnation_id: runtime.incarnationId });
      if (config.providerEntered) durableMarker(config.providerEntered, runtime.incarnationId);
      while (config.providerRelease && !existsSync(config.providerRelease)) await delay(5);
      return completedResultForWork(work);
    },
  });
  if (config.identityMarker) durableMarker(config.identityMarker, runtime.incarnationId);
  const stopWatcher = config.stopFile ? setInterval(() => { if (existsSync(config.stopFile)) runtime.worker.requestStop(); }, 5) : null;
  const outcomes = stopping ? [] : await runtime.worker.run({ maxIdlePolls: config.maxIdlePolls ?? 20, pollIntervalMs: config.pollIntervalMs ?? 10 });
  if (stopWatcher) clearInterval(stopWatcher);
  process.stdout.write(`${JSON.stringify({ event: 'DONE', incarnation_id: runtime.incarnationId, pid: process.pid, work: outcomes.filter((x) => x.status === 'WORK').map((x) => x.work_item_id) })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ event: 'ERROR', code: error?.code ?? 'ERROR', message: String(error?.message ?? error).replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[REDACTED_DSN]') })}\n`);
  process.exitCode = 2;
} finally { await runtime?.close().catch(() => {}); }

function appendDurable(path, value) { const fd = openSync(path, 'a'); try { appendFileSync(fd, `${JSON.stringify(value)}\n`); fsyncSync(fd); } finally { closeSync(fd); } }
function durableMarker(path, value) { const fd = openSync(path, 'w'); try { writeFileSync(fd, String(value)); fsyncSync(fd); } finally { closeSync(fd); } }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
