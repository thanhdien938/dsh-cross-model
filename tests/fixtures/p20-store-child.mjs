/**
 * P20.1R test fixture — a genuinely independent OS process that opens the
 * SAME artifact store and performs a bounded operation, for real
 * cross-process concurrency proof (R4 attempt allocation, R5 store
 * identity). Never imported by product code.
 *
 * Usage: node tests/fixtures/p20-store-child.mjs '<json-config>'
 * Prints one JSON line to stdout; exit 0 on success, 1 on a handled error.
 */
import { existsSync } from 'node:fs';
import {
  createArtifactStore,
} from '../../src/artifacts/artifact-store.mjs';
import { ARTIFACT_ROLE, ARTIFACT_STAGE } from '../../src/artifacts/artifact-paths.mjs';
import { DELIVERY_MECHANISM } from '../../src/artifacts/artifact-schema.mjs';

function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function waitForBarrier(barrierFile) {
  if (!barrierFile) return;
  const deadline = Date.now() + 8000;
  while (!existsSync(barrierFile)) {
    if (Date.now() > deadline) throw new Error('barrier timeout');
    sleep(5);
  }
}

const cfg = JSON.parse(process.argv[2] ?? '{}');

try {
  const store = createArtifactStore({ storeId: cfg.storeId, projectId: cfg.projectId, root: cfg.root });

  if (cfg.op === 'ensure') {
    waitForBarrier(cfg.barrierFile);
    store.ensureStore();
    process.stdout.write(`${JSON.stringify({ ok: true, storeId: store.storeId, projectId: store.projectId })}\n`);
    process.exit(0);
  }

  if (cfg.op === 'bindtask') {
    waitForBarrier(cfg.barrierFile);
    const task = store.allocateTask({ taskId: cfg.taskId, taskSlug: cfg.taskSlug ?? 'child', createdAt: cfg.createdAt });
    process.stdout.write(`${JSON.stringify({ ok: true, pid: process.pid, folder: task.path.split(/[\\/]/).pop() })}\n`);
    process.exit(0);
  }

  if (cfg.op === 'bindinv') {
    const task = store.allocateTask({ taskId: cfg.taskId, taskSlug: cfg.taskSlug ?? 'child', createdAt: cfg.createdAt });
    waitForBarrier(cfg.barrierFile);
    const inv = task.allocateInvocation({
      invocationId: cfg.invocationId,
      role: cfg.role ?? ARTIFACT_ROLE.SINGLE,
      stage: cfg.stage ?? ARTIFACT_STAGE.SINGLE,
      profileId: cfg.profileId ?? 'pid',
      actorAlias: cfg.actorAlias ?? 'a',
      round: cfg.round ?? null,
    });
    process.stdout.write(`${JSON.stringify({ ok: true, pid: process.pid, relpath: inv.record.stage_relpath, key: inv.invocationKey })}\n`);
    process.exit(0);
  }

  if (cfg.op === 'attempts') {
    const task = store.allocateTask({ taskId: cfg.taskId, taskSlug: cfg.taskSlug ?? 'child task', createdAt: cfg.createdAt });
    const inv = task.allocateInvocation({
      invocationId: cfg.invocationId,
      role: cfg.role ?? ARTIFACT_ROLE.SINGLE,
      stage: cfg.stage ?? ARTIFACT_STAGE.SINGLE,
      profileId: cfg.profileId ?? 'pid',
      actorAlias: cfg.actorAlias ?? 'a',
      round: cfg.round ?? null,
    });
    waitForBarrier(cfg.barrierFile);
    const ordinals = [];
    for (let i = 0; i < (cfg.count ?? 3); i += 1) {
      const a = inv.allocateAttempt({ deliveryMechanism: DELIVERY_MECHANISM.DIRECT_WRITE, startedAt: new Date(Date.UTC(2026, 8, 10, 8, 40, i % 60)).toISOString() });
      ordinals.push(a.ordinal);
    }
    process.stdout.write(`${JSON.stringify({ ok: true, pid: process.pid, ordinals })}\n`);
    process.exit(0);
  }

  throw new Error(`unknown op: ${cfg.op}`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, code: error.code ?? null, message: String(error.message ?? error) })}\n`);
  process.exit(1);
}
