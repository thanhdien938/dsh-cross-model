import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

import { startLocalRuntimeControl } from '../src/runtime/local-runtime-control.mjs';
import {
  resolveGitFileTaskSource, TaskSourceError,
  TASK_SOURCE_KIND, classifyTaskSourceKind,
} from '../src/owner/task-source-resolver.mjs';

// P12-R1 — proves the Desktop/pipe-side wiring that lets a `SUBMIT_TASK`
// carry an unresolved `payload.task_file:{ref,path}` directive, resolved by
// the SAME src/owner/task-source-resolver.mjs the Telegram path already
// uses, in the shared runtime-control layer (never duplicated inside
// Electron main — P12-R0 §7/§1.7). Deep resolver-internals coverage (path
// traversal, ref/commit resolution, size/UTF-8 bounds, immutability/no-drift)
// already lives in tests/p10-r024-task-source-resolver.test.mjs and is not
// re-proven here; this file proves the NEW pipe-layer contract only.

function git(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); }
function initRepo(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'dsh-test@example.invalid']);
  git(dir, ['config', 'user.name', 'DSH Test']);
  mkdirSync(join(dir, 'tasks', 'dsh'), { recursive: true });
  writeFileSync(join(dir, 'tasks', 'dsh', 'PINNED.md'), 'pinned task body\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'seed']);
  git(dir, ['remote', 'add', 'origin', 'https://example.invalid/placeholder.git']);
  return dir;
}

// ---- classification helper (pure, no git) ----------------------------------

test('classifyTaskSourceKind: absent source is DIRECT_PROMPT', () => {
  assert.equal(classifyTaskSourceKind(null), TASK_SOURCE_KIND.DIRECT_PROMPT);
  assert.equal(classifyTaskSourceKind(undefined), TASK_SOURCE_KIND.DIRECT_PROMPT);
});

test('classifyTaskSourceKind: resolved-without-fetch is LOCAL_TASK_FILE', () => {
  assert.equal(classifyTaskSourceKind({ type: 'GIT_FILE', fetched: false }), TASK_SOURCE_KIND.LOCAL_TASK_FILE);
});

test('classifyTaskSourceKind: resolved-via-fetch is PINNED_GIT_TASK_FILE', () => {
  assert.equal(classifyTaskSourceKind({ type: 'GIT_FILE', fetched: true }), TASK_SOURCE_KIND.PINNED_GIT_TASK_FILE);
});

// ---- pipe-layer integration -------------------------------------------------

let root;
let projectsById;
let control;
let receivedCommands = [];
let nextResult = null;
let resolveTaskFileImpl = null;
const pipeName = `\\\\.\\pipe\\dsh-p12r1-control-${process.pid}-${randomUUID()}`;
const authCapability = randomBytes(32).toString('hex');
const enrolledOwnerActorId = '100000001';

test.before(async () => {
  root = mkdtempSync(join(tmpdir(), 'p12-r1-pipe-'));
  initRepo(root);
  projectsById = new Map([['proj-a', { id: 'proj-a', repo_path: root }]]);

  control = await startLocalRuntimeControl({
    pipeName,
    authCapability,
    readiness: () => ({ ready: true }),
    onShutdown: () => {},
    enrolledOwnerActorId,
    ownerCommand: async (input) => {
      receivedCommands.push(input);
      return nextResult;
    },
    // Mirrors p5-production-composition.mjs's real taskFileResolver closure
    // exactly: unknown project -> TASK_FILE_REPOSITORY_MISMATCH, else the
    // real resolver against that project's repo_path.
    resolveTaskFile: async ({ projectId, ref, path }) => {
      if (resolveTaskFileImpl) return resolveTaskFileImpl({ projectId, ref, path });
      const project = projectsById.get(projectId);
      if (!project) throw new TaskSourceError('unknown project for task-file dispatch', 'TASK_FILE_REPOSITORY_MISMATCH', {});
      return resolveGitFileTaskSource({ projectRepoPath: project.repo_path, requestedRef: ref, path });
    },
  });
});

test.after(async () => {
  await control.close();
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
});

test.beforeEach(() => {
  receivedCommands = [];
  nextResult = { status: 'MATERIALIZED', task_id: 'task-1', pm_run_id: 'pmrun-1' };
  resolveTaskFileImpl = null;
});

test('a DIRECT prompt SUBMIT_TASK (no task_file) is completely unaffected', async () => {
  const response = await request({
    id: 'direct-1',
    operation: 'SUBMIT_TASK',
    auth: authCapability,
    command: { command_id: 'cmd-direct-1', project_id: 'proj-a', payload: { body: 'plain conversational task' } },
  });
  assert.equal(response.success, true);
  assert.equal(receivedCommands.length, 1);
  assert.deepEqual(receivedCommands[0].payload, { body: 'plain conversational task' });
});

test('a pinned task-file SUBMIT_TASK resolves via the shared resolver: body becomes file content, task_source carries provenance, task_file never forwarded', async () => {
  const response = await request({
    id: 'pinned-1',
    operation: 'SUBMIT_TASK',
    auth: authCapability,
    command: {
      command_id: 'cmd-pinned-1',
      project_id: 'proj-a',
      payload: { pm_profile_id: 'pm-1', task_file: { ref: 'main', path: 'tasks/dsh/PINNED.md' } },
    },
  });
  assert.equal(response.success, true);
  assert.equal(receivedCommands.length, 1);
  const forwarded = receivedCommands[0].payload;
  assert.equal(forwarded.body, 'pinned task body\n');
  assert.equal(forwarded.pm_profile_id, 'pm-1');
  assert.equal('task_file' in forwarded, false);
  assert.equal(forwarded.task_source.type, 'GIT_FILE');
  assert.equal(forwarded.task_source.path, 'tasks/dsh/PINNED.md');
  assert.match(forwarded.task_source.resolvedCommitSha, /^[0-9a-f]{40}$/);
  // Resolved locally (the commit already exists in the worktree) -> never
  // fetched -> LOCAL_TASK_FILE, not PINNED_GIT_TASK_FILE.
  assert.equal(classifyTaskSourceKind(forwarded.task_source), TASK_SOURCE_KIND.LOCAL_TASK_FILE);
});

test('task_file combined with council is refused before resolution or execution', async () => {
  const response = await request({
    id: 'council-refused',
    operation: 'SUBMIT_TASK',
    auth: authCapability,
    command: {
      command_id: 'cmd-council-refused',
      project_id: 'proj-a',
      payload: { task_file: { ref: 'main', path: 'tasks/dsh/PINNED.md' }, council: { chair_profile_id: 'c', participant_profile_ids: ['p1'] } },
    },
  });
  assert.deepEqual(response, { id: 'council-refused', success: false, error: 'TASK_FILE_COUNCIL_NOT_SUPPORTED' });
  assert.equal(receivedCommands.length, 0);
});

test('task_file combined with non-empty typed text is refused — never ambiguous which text is authoritative', async () => {
  const response = await request({
    id: 'text-refused',
    operation: 'SUBMIT_TASK',
    auth: authCapability,
    command: {
      command_id: 'cmd-text-refused',
      project_id: 'proj-a',
      payload: { body: 'also do this', task_file: { ref: 'main', path: 'tasks/dsh/PINNED.md' } },
    },
  });
  assert.deepEqual(response, { id: 'text-refused', success: false, error: 'TASK_FILE_ADDITIONAL_TEXT_REFUSED' });
  assert.equal(receivedCommands.length, 0);
});

test('a malformed task_file shape is refused before any resolution attempt', async () => {
  for (const badTaskFile of [{ ref: 'main' }, { path: 'tasks/dsh/PINNED.md' }, 'not-an-object', 42]) {
    const response = await request({
      id: 'malformed-tf',
      operation: 'SUBMIT_TASK',
      auth: authCapability,
      command: { command_id: `cmd-malformed-${JSON.stringify(badTaskFile)}`, project_id: 'proj-a', payload: { task_file: badTaskFile } },
    });
    assert.deepEqual(response, { id: 'malformed-tf', success: false, error: 'MALFORMED_REQUEST' });
  }
  assert.equal(receivedCommands.length, 0);
});

test('an unknown project id surfaces TASK_FILE_REPOSITORY_MISMATCH verbatim, never spawning a backend', async () => {
  const response = await request({
    id: 'unknown-project',
    operation: 'SUBMIT_TASK',
    auth: authCapability,
    command: { command_id: 'cmd-unknown-project', project_id: 'no-such-project', payload: { task_file: { ref: 'main', path: 'tasks/dsh/PINNED.md' } } },
  });
  assert.deepEqual(response, { id: 'unknown-project', success: false, error: 'TASK_FILE_REPOSITORY_MISMATCH' });
  assert.equal(receivedCommands.length, 0);
});

test('a nonexistent path surfaces TASK_FILE_NOT_FOUND verbatim, never spawning a backend', async () => {
  const response = await request({
    id: 'missing-path',
    operation: 'SUBMIT_TASK',
    auth: authCapability,
    command: { command_id: 'cmd-missing-path', project_id: 'proj-a', payload: { task_file: { ref: 'main', path: 'tasks/dsh/DOES_NOT_EXIST.md' } } },
  });
  assert.deepEqual(response, { id: 'missing-path', success: false, error: 'TASK_FILE_NOT_FOUND' });
  assert.equal(receivedCommands.length, 0);
});

test('an unrecognized resolver error collapses to a generic sanitized code — no message/path leak', async () => {
  resolveTaskFileImpl = async () => { throw Object.assign(new Error('ENOENT: /C/secret/internal.db'), { code: 'ENOENT', stack: 'at internal (C:/secret)' }); };
  const response = await request({
    id: 'leaky-resolver',
    operation: 'SUBMIT_TASK',
    auth: authCapability,
    command: { command_id: 'cmd-leaky-resolver', project_id: 'proj-a', payload: { task_file: { ref: 'main', path: 'tasks/dsh/PINNED.md' } } },
  });
  assert.equal(response.success, false);
  assert.equal(response.error, 'TASK_FILE_RESOLUTION_FAILED');
  assert.equal(JSON.stringify(response).includes('secret'), false);
  assert.equal(JSON.stringify(response).includes('internal.db'), false);
  assert.equal(receivedCommands.length, 0);
});

test('when no resolveTaskFile dependency is wired, a task_file directive is refused with TASK_FILE_UNAVAILABLE', async () => {
  const barePipeName = `\\\\.\\pipe\\dsh-p12r1-bare-${process.pid}-${randomUUID()}`;
  const bareControl = await startLocalRuntimeControl({
    pipeName: barePipeName,
    authCapability,
    readiness: () => ({ ready: true }),
    onShutdown: () => {},
    enrolledOwnerActorId,
    ownerCommand: async () => ({ status: 'MATERIALIZED' }),
  });
  try {
    const response = await requestOn(barePipeName, {
      id: 'no-resolver',
      operation: 'SUBMIT_TASK',
      auth: authCapability,
      command: { command_id: 'cmd-no-resolver', project_id: 'proj-a', payload: { task_file: { ref: 'main', path: 'tasks/dsh/PINNED.md' } } },
    });
    assert.deepEqual(response, { id: 'no-resolver', success: false, error: 'TASK_FILE_UNAVAILABLE' });
  } finally {
    await bareControl.close();
  }
});

// P12-R1-G: GitHub/resolver unavailability must never break an independent
// DIRECT task submitted through the very same runtime/pipe instance.
test('resolver unavailability (simulated GitHub outage) does not affect a separate DIRECT task on the same channel', async () => {
  resolveTaskFileImpl = async () => { throw new TaskSourceError('git fetch failed for ref: main', 'TASK_FILE_FETCH_FAILED', {}); };

  const blocked = await request({
    id: 'outage-blocked',
    operation: 'SUBMIT_TASK',
    auth: authCapability,
    command: { command_id: 'cmd-outage-blocked', project_id: 'proj-a', payload: { task_file: { ref: 'main', path: 'tasks/dsh/PINNED.md' } } },
  });
  assert.deepEqual(blocked, { id: 'outage-blocked', success: false, error: 'TASK_FILE_FETCH_FAILED' });

  const direct = await request({
    id: 'outage-direct-ok',
    operation: 'SUBMIT_TASK',
    auth: authCapability,
    command: { command_id: 'cmd-outage-direct-ok', project_id: 'proj-a', payload: { body: 'unaffected direct task' } },
  });
  assert.equal(direct.success, true);
  assert.equal(receivedCommands.length, 1);
  assert.deepEqual(receivedCommands[0].payload, { body: 'unaffected direct task' });
});

function request(value) { return requestOn(pipeName, value); }

function requestOn(targetPipeName, value) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(targetPipeName);
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
