// W2 real-Postgres canary. Spins up a disposable real PostgreSQL 18
// container, builds the exact production composition (real coordination
// store, real owner repository, real SQLite v6, two real registered
// projects with no telegram.project_id), starts the real
// startLocalRuntimeControl pipe wired to the real OwnerControlService, and
// proves through the pipe protocol only (no direct service calls):
//
//   - SUBMIT_TASK same command_id/payload -> idempotent, one canonical task
//   - SUBMIT_TASK same command_id/different payload -> OWNER_COMMAND_CONFLICT
//   - DECIDE_INTERACTION same command_id/payload -> idempotent
//   - DECIDE_INTERACTION after decision -> STALE_INTERACTION
//   - project-scoped SQLite reads never leak across the two projects
//
// Usage: node scripts/w2-real-postgres-canary.mjs
import { spawnSync, spawn } from 'node:child_process';
import net from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { PostgresCoordinationStore } from '../src/coordination/postgres/postgres-coordination-store.mjs';
import { createP5ProductionComposition } from '../src/runtime/p5-production-composition.mjs';
import { startLocalRuntimeControl } from '../src/runtime/local-runtime-control.mjs';

function docker(...args) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`docker ${args.join(' ')} failed: ${result.stderr}`);
  return result;
}

function request(pipeName, value) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipeName);
    let response = '';
    socket.setEncoding('utf8');
    socket.once('error', reject);
    socket.once('connect', () => socket.write(`${JSON.stringify(value)}\n`));
    socket.on('data', (chunk) => {
      response += chunk;
      const newline = response.indexOf('\n');
      if (newline === -1) return;
      socket.end();
      resolve(JSON.parse(response.slice(0, newline)));
    });
  });
}

let container;
let root;
let composition;
let control;

try {
  const password = randomBytes(24).toString('hex');
  const name = `dsh-w2-canary-${process.pid}-${Date.now()}`;
  container = docker('run', '--detach', '--rm', '--name', name, '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=dsh_w2_canary', '-p', '127.0.0.1::5432', 'postgres:18-alpine').stdout.trim();
  const port = docker('port', container, '5432/tcp').stdout.trim().match(/:(\d+)$/)?.[1];
  const dsn = `postgresql://postgres:${password}@127.0.0.1:${port}/dsh_w2_canary`;

  let ready = false;
  for (let i = 0; i < 60; i += 1) {
    const client = new pg.Client({ connectionString: dsn, connectionTimeoutMillis: 500 });
    try {
      await client.connect();
      await client.end();
      ready = true;
      break;
    } catch {
      await client.end().catch(() => {});
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  if (!ready) throw new Error('PostgreSQL did not become ready');

  const bootstrap = await new PostgresCoordinationStore().open({ connectionString: dsn });
  await bootstrap.migrate();
  await bootstrap.close();

  root = mktempRoot();
  mkdirSync(join(root, 'repo-a'));
  mkdirSync(join(root, 'repo-b'));

  const config = {
    mode: 'production',
    postgres: { connectionString: dsn },
    sqlitePath: join(root, 'state.db'),
    projects: [
      { id: 'w2-canary-a', repo_path: join(root, 'repo-a'), path_missing: false, default_pm_profile_id: 'pm', autonomy: { revision: 1, effects: { SUBMIT_TASK: 'ALLOW', REQUEST_CANCEL: 'ALLOW' } } },
      { id: 'w2-canary-b', repo_path: join(root, 'repo-b'), path_missing: false, default_pm_profile_id: 'pm', autonomy: { revision: 1, effects: { SUBMIT_TASK: 'ALLOW', REQUEST_CANCEL: 'ALLOW' } } },
      // R1-A: registered but its folder is never created — proves the real
      // OwnerControlService PROJECT_PATH_MISSING gate end to end, not just
      // the loader's path_missing detection (unit-tested separately).
      { id: 'w2-canary-c-missing', repo_path: join(root, 'repo-c-never-created'), path_missing: true, default_pm_profile_id: 'pm', autonomy: { revision: 1, effects: { SUBMIT_TASK: 'ALLOW', REQUEST_CANCEL: 'ALLOW' } } },
    ],
    profiles: [{ id: 'pm', role_kind: 'PM', session_kind: 'STATELESS', product: 'scripted', transport: 'in-process' }],
    // Deliberately no telegram.project_id: proves M4 no longer requires it.
    telegram: { token: 'canary-token', ownerUserId: '424242', ownerChatId: '424242', projectId: null, pollIntervalMs: 5000 },
    coordinator: { logicalId: 'w2-canary-coordinator', leaseMs: 30000, pollIntervalMs: 250 },
    worker: { logicalId: 'w2-canary-worker', leaseMs: 30000, pollIntervalMs: 250 },
    pm: { scriptedDecisions: [{ type: 'await_owner', kind: 'QUESTION', title: 'Approve', prompt: 'Continue?', allowedResponses: ['YES', 'NO'] }, { type: 'finish', output: 'w2-canary-complete' }] },
  };

  composition = await createP5ProductionComposition(config, { fetchImpl: async () => ({ ok: true, json: async () => ({ result: [] }) }) });

  const authCapability = randomBytes(32).toString('hex');
  const pipeName = `\\\\.\\pipe\\dsh-w2-canary-${process.pid}-${randomUUID()}`;
  control = await startLocalRuntimeControl({
    pipeName,
    authCapability,
    readiness: () => composition.readiness(),
    onShutdown: () => {},
    ownerCommand: (input) => composition.ownerService.mutate(input),
    ownerRead: (operation, params) => composition.ownerService.read(operation, params),
    enrolledOwnerActorId: config.telegram.ownerUserId,
  });

  const results = {};

  // 1) SUBMIT_TASK idempotency: same command_id + same payload -> one canonical task.
  const submitCommandId = randomUUID();
  const submitPayload = { command_id: submitCommandId, project_id: 'w2-canary-a', payload: { body: 'W2 REAL CANARY: report nothing, just finish.' } };
  const first = await request(pipeName, { id: 'submit-1', operation: 'SUBMIT_TASK', auth: authCapability, command: submitPayload });
  const second = await request(pipeName, { id: 'submit-2', operation: 'SUBMIT_TASK', auth: authCapability, command: submitPayload });
  results.submitIdempotent = first.success && second.success && first.result.task_id === second.result.task_id;
  results.submitTaskCountA = composition.sqlite.get(`SELECT count(*) n FROM tasks WHERE project_id = 'w2-canary-a'`).n;
  results.submitTaskCountB = composition.sqlite.get(`SELECT count(*) n FROM tasks WHERE project_id = 'w2-canary-b'`).n;

  // 2) SUBMIT_TASK same command_id, different payload -> OWNER_COMMAND_CONFLICT.
  const conflict = await request(pipeName, { id: 'submit-conflict', operation: 'SUBMIT_TASK', auth: authCapability, command: { ...submitPayload, payload: { body: 'different body' } } });
  results.submitConflict = conflict.success === false && conflict.error === 'OWNER_COMMAND_CONFLICT';

  // 3) Server ignores client-claimed client_kind/actor_id: the owner_command row must show LOCAL + enrolled owner.
  const pgPool = new pg.Pool({ connectionString: dsn });
  const commandRow = (await pgPool.query(`SELECT client_kind, actor_id, project_id FROM dsh_coordination.owner_command WHERE command_id = $1`, [submitCommandId])).rows[0];
  results.identityStamped = commandRow?.client_kind === 'LOCAL' && commandRow?.actor_id === config.telegram.ownerUserId;

  // 4) Drive the worker so the scripted await_owner decision parks and creates an interaction.
  const worker = await composition.buildWorker();
  const parked = await worker.runOnce();
  results.parked = parked.status === 'WORK' && parked.outcome.status === 'PARKED';
  const inbox = await composition.ownerRepository.listInbox({});
  const interaction = inbox.find((i) => i.project_id === 'w2-canary-a');
  results.interactionFound = Boolean(interaction);

  // 5) DECIDE_INTERACTION idempotency: same command_id/payload -> idempotent.
  const decideCommandId = randomUUID();
  const decidePayload = { command_id: decideCommandId, project_id: 'w2-canary-a', target_id: interaction.interaction_id, expected_revision: interaction.revision, payload: { response: 'YES' } };
  const decideFirst = await request(pipeName, { id: 'decide-1', operation: 'DECIDE_INTERACTION', auth: authCapability, command: decidePayload });
  const decideSecond = await request(pipeName, { id: 'decide-2', operation: 'DECIDE_INTERACTION', auth: authCapability, command: decidePayload });
  results.decideIdempotent = decideFirst.success && decideSecond.success;

  // 6) A fresh command_id trying to decide the now-decided interaction -> STALE_INTERACTION.
  const staleAttempt = await request(pipeName, { id: 'decide-stale', operation: 'DECIDE_INTERACTION', auth: authCapability, command: { command_id: randomUUID(), project_id: 'w2-canary-a', target_id: interaction.interaction_id, expected_revision: interaction.revision, payload: { response: 'NO' } } });
  results.staleInteraction = staleAttempt.success === false && staleAttempt.error === 'STALE_INTERACTION';

  // 7) Project isolation: project B has zero tasks/interactions from A's activity.
  results.projectIsolation = results.submitTaskCountB === 0 && !inbox.some((i) => i.project_id === 'w2-canary-b');

  // 8) PATH MISSING: SUBMIT_TASK to a registered-but-path-missing project
  // is refused by the real OwnerControlService, before any materialization,
  // and the other two real projects remain completely unaffected.
  const pathMissingAttempt = await request(pipeName, { id: 'submit-path-missing', operation: 'SUBMIT_TASK', auth: authCapability, command: { command_id: randomUUID(), project_id: 'w2-canary-c-missing', payload: { body: 'should never materialize' } } });
  results.pathMissingRefused = pathMissingAttempt.success === false && pathMissingAttempt.error === 'PROJECT_PATH_MISSING';
  results.pathMissingTaskCount = composition.sqlite.get(`SELECT count(*) n FROM tasks WHERE project_id = 'w2-canary-c-missing'`).n;

  // 9) Unknown/generic op still refused, no arbitrary dispatch.
  const unknownOp = await request(pipeName, { id: 'unknown', operation: 'EXEC_SHELL', auth: authCapability, command: { command_id: randomUUID() } });
  results.unknownOpRefused = unknownOp.success === false && unknownOp.error === 'UNKNOWN_OPERATION';

  await pgPool.end();

  const expectations = {
    submitIdempotent: true,
    submitTaskCountA: 1,
    submitTaskCountB: 0,
    submitConflict: true,
    identityStamped: true,
    parked: true,
    interactionFound: true,
    decideIdempotent: true,
    staleInteraction: true,
    projectIsolation: true,
    pathMissingRefused: true,
    pathMissingTaskCount: 0,
    unknownOpRefused: true,
  };
  const pass = Object.entries(expectations).filter(([key, expected]) => results[key] !== expected);
  console.log(JSON.stringify(results, null, 2));
  if (pass.length) {
    console.error(`W2 REAL POSTGRES CANARY: FAIL (${pass.map(([k]) => k).join(', ')})`);
    process.exitCode = 1;
  } else {
    console.log('W2 REAL POSTGRES CANARY: PASS');
  }
} catch (error) {
  console.error(`W2 REAL POSTGRES CANARY: FAIL (${error.message})`);
  process.exitCode = 1;
} finally {
  await control?.close().catch(() => {});
  await composition?.close().catch(() => {});
  if (container) docker('rm', '--force', container);
  if (root) rmSync(root, { recursive: true, force: true });
}

function mktempRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-w2-canary-'));
}
