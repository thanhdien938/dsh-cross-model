import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import {
  PROVIDER_EXECUTABLE_RESOLUTION_SOURCE,
  buildProviderChildEnv,
  resolveProviderExecutableSync,
  concreteProviderExecutableCandidates,
} from '../src/session/provider-child-policy.mjs';
import { normalizeGitSyncRequest } from '../src/owner/owner-task-controller.mjs';
import { pushTaskResult } from '../src/pm/task-result-git-sync.mjs';
import { runClaudeProcess } from '../src/session/claude-code-session-bridge.mjs';
import { runOpenCodeProcess } from '../src/session/opencode-cli-session-bridge.mjs';
import { runCodexCliProcess } from '../src/session/codex-cli-session-bridge.mjs';
import { runGrokCliProcess } from '../src/session/grok-cli-session-bridge.mjs';
import { runAntigravityCliProcess } from '../src/session/antigravity-cli-session-bridge.mjs';
import { ProductionPmBackendRegistry } from '../src/pm/production-pm-backend-registry.mjs';
import { validateProviderEntry } from '../src/pm/api-backend/api-provider-config.mjs';
import { hangFixture, startFakeOpenAiServer } from './lib/fake-openai-server.mjs';

const root = mkdtempSync(join(tmpdir(), 'p15-rem-r4-'));
test.after(() => rmSync(root, { recursive: true, force: true }));

test('provider child environment is deny-by-default across all subprocess families', () => {
  const sourceEnv = {
    PATH: 'TEST_PATH',
    SystemRoot: 'TEST_SYSTEM_ROOT',
    DSH_RUNTIME_CONTROL_AUTH: 'TEST_CONTROL_SECRET',
    TELEGRAM_BOT_TOKEN: 'TEST_TELEGRAM_SECRET',
    DSH_POSTGRES_DSN: 'postgresql://TEST_DSN_SECRET',
    UNRELATED_SECRET: 'TEST_UNRELATED_SECRET',
    ANTHROPIC_API_KEY: 'TEST_CLAUDE_KEY',
    OPENAI_API_KEY: 'TEST_CODEX_KEY',
    XAI_API_KEY: 'TEST_GROK_KEY',
    GOOGLE_API_KEY: 'TEST_ANTIGRAVITY_KEY',
  };

  const expectedCredential = {
    'claude-code': 'ANTHROPIC_API_KEY',
    opencode: null,
    codex: 'OPENAI_API_KEY',
    grok: 'XAI_API_KEY',
    antigravity: 'GOOGLE_API_KEY',
  };
  for (const [provider, credential] of Object.entries(expectedCredential)) {
    const env = buildProviderChildEnv({ provider, sourceEnv });
    assert.equal(env.DSH_RUNTIME_CONTROL_AUTH, undefined, provider);
    assert.equal(env.TELEGRAM_BOT_TOKEN, undefined, provider);
    assert.equal(env.DSH_POSTGRES_DSN, undefined, provider);
    assert.equal(env.UNRELATED_SECRET, undefined, provider);
    if (credential) assert.equal(env[credential], sourceEnv[credential], provider);
    for (const other of Object.values(expectedCredential).filter(Boolean)) {
      if (other !== credential) assert.equal(env[other], undefined, `${provider} must not receive ${other}`);
    }
  }
});

test('a real fake provider child cannot read control, Telegram, or unrelated marker secrets', () => {
  const fixture = join(root, 'dump-provider-env.mjs');
  writeFileSync(fixture, `console.log(JSON.stringify({\n  control:process.env.DSH_RUNTIME_CONTROL_AUTH??null,\n  telegram:process.env.TELEGRAM_BOT_TOKEN??null,\n  unrelated:process.env.UNRELATED_SECRET??null,\n  provider:process.env.OPENAI_API_KEY??null\n}));\n`);
  const env = buildProviderChildEnv({ provider: 'codex', sourceEnv: {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    DSH_RUNTIME_CONTROL_AUTH: 'TEST_CONTROL_SECRET',
    TELEGRAM_BOT_TOKEN: 'TEST_TELEGRAM_SECRET',
    UNRELATED_SECRET: 'TEST_UNRELATED_SECRET',
    OPENAI_API_KEY: 'TEST_CODEX_KEY',
  } });
  const observed = JSON.parse(execFileSync(process.execPath, [fixture], { encoding: 'utf8', env }));
  assert.deepEqual(observed, { control: null, telegram: null, unrelated: null, provider: 'TEST_CODEX_KEY' });
});

test('all five active CLI bridge spawn paths receive the shared allowlisted environment', async () => {
  const previous = {
    DSH_RUNTIME_CONTROL_AUTH: process.env.DSH_RUNTIME_CONTROL_AUTH,
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    UNRELATED_SECRET: process.env.UNRELATED_SECRET,
  };
  Object.assign(process.env, {
    DSH_RUNTIME_CONTROL_AUTH: 'TEST_CONTROL_SECRET',
    TELEGRAM_BOT_TOKEN: 'TEST_TELEGRAM_SECRET',
    UNRELATED_SECRET: 'TEST_UNRELATED_SECRET',
  });
  try {
    const runners = [
      ['claude-code', (spawnImpl) => runClaudeProcess({ binary: process.execPath, prompt: 'p', spawnImpl, timeoutMs: 1000 })],
      ['opencode', (spawnImpl) => runOpenCodeProcess({ binary: process.execPath, prompt: 'p', spawnImpl, timeoutMs: 1000 })],
      ['codex', (spawnImpl) => runCodexCliProcess({ binary: process.execPath, prompt: 'p', spawnImpl, timeoutMs: 1000 })],
      ['grok', (spawnImpl) => runGrokCliProcess({ binary: process.execPath, prompt: 'p', spawnImpl, timeoutMs: 1000 })],
      ['antigravity', (spawnImpl) => runAntigravityCliProcess({ binary: process.execPath, prompt: 'p', spawnImpl, timeoutMs: 1000 })],
    ];
    for (const [provider, invoke] of runners) {
      let options;
      const pending = invoke((_binary, _args, spawnOptions) => {
        options = spawnOptions;
        const child = fakeChild();
        setImmediate(() => child.emit('error', new Error('fixture stop')));
        return child;
      });
      await pending.catch(() => null);
      assert.ok(options?.env, provider);
      assert.equal(options.env.DSH_RUNTIME_CONTROL_AUTH, undefined, provider);
      assert.equal(options.env.TELEGRAM_BOT_TOKEN, undefined, provider);
      assert.equal(options.env.UNRELATED_SECRET, undefined, provider);
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('strict executable policy refuses PATH discovery but accepts an explicit absolute configured executable', () => {
  const pathDir = join(root, 'path-hijack');
  mkdirSync(pathDir, { recursive: true });
  const maliciousName = process.platform === 'win32' ? 'provider-hijack.cmd' : 'provider-hijack';
  const malicious = join(pathDir, maliciousName);
  writeFileSync(malicious, process.platform === 'win32' ? '@echo malicious 1.0.0\r\n' : '#!/bin/sh\necho malicious 1.0.0\n', { mode: 0o755 });

  const refused = resolveProviderExecutableSync({
    provider: 'claude-code',
    executableName: 'provider-hijack',
    knownCandidates: [],
    sourceEnv: { PATH: pathDir, PATHEXT: '.CMD;.EXE' },
  });
  assert.equal(refused.available, false);
  assert.equal(refused.code, 'PROVIDER_EXECUTABLE_UNTRUSTED');

  const knownWins = resolveProviderExecutableSync({
    provider: 'claude-code',
    executableName: 'provider-hijack',
    knownCandidates: [process.execPath],
    sourceEnv: { PATH: pathDir, PATHEXT: '.CMD;.EXE' },
  });
  assert.equal(knownWins.path, process.execPath);
  assert.equal(knownWins.source, PROVIDER_EXECUTABLE_RESOLUTION_SOURCE.KNOWN_INSTALL);

  const configured = resolveProviderExecutableSync({
    provider: 'codex',
    configuredPath: process.execPath,
    executableName: 'unused',
    knownCandidates: [],
  });
  assert.equal(configured.available, true);
  assert.equal(configured.source, PROVIDER_EXECUTABLE_RESOLUTION_SOURCE.CONFIGURED);
  assert.equal(configured.path, process.execPath);
  assert.ok(configured.version);
});

test('configured executable must exist and be absolute; canonical path is recorded', () => {
  const relative = resolveProviderExecutableSync({ provider: 'grok', configuredPath: './grok', knownCandidates: [] });
  assert.equal(relative.available, false);
  assert.equal(relative.code, 'PROVIDER_EXECUTABLE_UNTRUSTED');
  const missing = resolveProviderExecutableSync({ provider: 'grok', configuredPath: join(root, 'missing.exe'), knownCandidates: [] });
  assert.equal(missing.available, false);
  assert.equal(missing.code, 'PROVIDER_EXECUTABLE_NOT_FOUND');
  assert.ok(concreteProviderExecutableCandidates('provider', { platform: 'win32', pathExt: '.CMD;.EXE' }).includes('provider.cmd'));
});

test('configured symlink is canonicalized before provenance is recorded', (t) => {
  const link = join(root, process.platform === 'win32' ? 'configured-node.exe' : 'configured-node');
  try { symlinkSync(process.execPath, link, 'file'); } catch { t.skip('host does not permit file symlinks'); return; }
  const resolution = resolveProviderExecutableSync({ provider: 'codex', configuredPath: link, knownCandidates: [] });
  assert.equal(resolution.available, true);
  assert.equal(resolution.path, process.execPath);
});

test('registry forwards the real owner AbortSignal to the underlying API fetch', async () => {
  const server = await startFakeOpenAiServer(hangFixture());
  try {
    const provider = { ...validateProviderEntry('fixture', { protocol: 'openai-chat', base_url: 'https://fixture.invalid/v1', api_key_env: 'DSH_API_FIXTURE_KEY' }), baseUrl: server.baseUrl };
    const registry = new ProductionPmBackendRegistry({
      probe: () => true,
      apiProviders: { fixture: provider },
      apiEnv: { DSH_API_FIXTURE_KEY: 'TEST_PROVIDER_KEY' },
      apiFetch: fetch,
    });
    const profile = { id: 'api-fixture', product: 'api', transport: 'http', session_kind: 'STATELESS', provider: 'fixture', model: 'fixture-model' };
    const ownerAbort = new AbortController();
    const pending = registry.resolve(profile, { project: { repo_path: root } }).decide({ turn: 0, request: {}, history: [], signal: ownerAbort.signal });
    for (let attempt = 0; attempt < 200 && server.requests.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(server.requests.length, 1);
    ownerAbort.abort('OWNER_CANCELLED');
    await assert.rejects(pending);
    for (let attempt = 0; attempt < 50 && server.disconnectCount === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(server.disconnectCount, 1);
  } finally {
    await server.close();
  }
});

test('Git remote intent distinguishes omitted, valid, and invalid values', () => {
  assert.deepEqual(normalizeGitSyncRequest({ push: true }), { commit: true, push: true });
  assert.deepEqual(normalizeGitSyncRequest({ push: true, remote: 'backup' }), { commit: true, push: true, remote: 'backup' });
  for (const remote of ['not a remote name!', 'origin;echo-pwned', 'https://user:secret@example.invalid/repo.git']) {
    assert.throws(() => normalizeGitSyncRequest({ push: true, remote }), (error) => error?.code === 'GIT_REMOTE_INVALID');
  }
});

test('wrong-target live proof: explicit backup changes only backup; invalid changes neither; omission uses origin', async () => {
  const fixture = createGitFixture(join(root, 'git-live-proof'));
  writeFileSync(join(fixture.work, 'backup.txt'), 'backup\n');
  git(fixture.work, ['add', '-A']);
  git(fixture.work, ['commit', '-m', 'backup target']);
  await pushTaskResult({ projectRepoPath: fixture.work, remote: 'backup' });
  const backupSha = remoteSha(fixture.backup);
  assert.equal(backupSha, git(fixture.work, ['rev-parse', 'HEAD']).trim());
  assert.notEqual(remoteSha(fixture.origin), backupSha);

  const beforeOrigin = remoteSha(fixture.origin);
  const beforeBackup = remoteSha(fixture.backup);
  await assert.rejects(pushTaskResult({ projectRepoPath: fixture.work, remote: 'origin;backup' }), (error) => error?.code === 'GIT_REMOTE_INVALID');
  assert.equal(remoteSha(fixture.origin), beforeOrigin);
  assert.equal(remoteSha(fixture.backup), beforeBackup);

  writeFileSync(join(fixture.work, 'origin.txt'), 'origin\n');
  git(fixture.work, ['add', '-A']);
  git(fixture.work, ['commit', '-m', 'origin default']);
  await pushTaskResult({ projectRepoPath: fixture.work });
  assert.equal(remoteSha(fixture.origin), git(fixture.work, ['rev-parse', 'HEAD']).trim());
  assert.equal(remoteSha(fixture.backup), beforeBackup);
});

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

function remoteSha(bare) {
  return git(dirname(bare), ['--git-dir', bare, 'rev-parse', 'refs/heads/main']).trim();
}

function createGitFixture(dir) {
  const work = join(dir, 'work');
  const origin = join(dir, 'origin.git');
  const backup = join(dir, 'backup.git');
  mkdirSync(work, { recursive: true });
  git(dir, ['init', '--bare', '--initial-branch=main', basename(origin)]);
  git(dir, ['init', '--bare', '--initial-branch=main', basename(backup)]);
  git(work, ['init', '--initial-branch=main']);
  git(work, ['config', 'user.email', 'p15-rem-r4@example.invalid']);
  git(work, ['config', 'user.name', 'P15 REM R4']);
  writeFileSync(join(work, 'seed.txt'), 'seed\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '-m', 'seed']);
  git(work, ['remote', 'add', 'origin', origin]);
  git(work, ['remote', 'add', 'backup', backup]);
  git(work, ['push', 'origin', 'main']);
  git(work, ['push', 'backup', 'main']);
  return { work, origin, backup };
}

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 12345;
  child.kill = () => true;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  return child;
}
