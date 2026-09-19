import { execFile as execFileCallback, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { discoverShards, validateShards } from './test-shards.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(repositoryRoot);
const execFile = promisify(execFileCallback);
const argv = process.argv.slice(2);
const shards = discoverShards();

if (argv[0] === '--validate') {
  const errors = validateShards(shards);
  if (errors.length) throw new Error(errors.join('\n'));
  const inventory = Object.fromEntries(Object.entries(shards).map(([name, shard]) => [name, shard.files.length]));
  console.log(JSON.stringify({ status: 'PASS', inventory }, null, 2));
  process.exit(0);
}

const shardName = argv[0];
const shard = shards[shardName];
if (!shard) {
  console.error(`usage: node scripts/run-test-shard.mjs <${Object.keys(shards).join('|')}> [--list] [--summary path]`);
  process.exit(2);
}

const summaryIndex = argv.indexOf('--summary');
const summaryPath = summaryIndex >= 0 ? argv[summaryIndex + 1] : `.test-results/${shardName}.json`;
if (argv.includes('--list')) {
  console.log(JSON.stringify({ shard: shardName, ...shard }, null, 2));
  process.exit(0);
}

const validationErrors = validateShards(shards);
if (validationErrors.length) throw new Error(validationErrors.join('\n'));

const secretPattern = /(TOKEN|SECRET|API_KEY|APIKEY|AUTH|PASSWORD|\bDSN\b)/i;
const allowedTestSecrets = new Set([
  'DSH_P3G1_POSTGRES_DSN', 'DSH_P3G2_POSTGRES_DSN', 'DSH_P3G3_POSTGRES_DSN',
  'DSH_P3G4_POSTGRES_DSN', 'DSH_P3FINAL_POSTGRES_DSN', 'DSH_P5_POSTGRES_DSN',
  'DSH_P5_R2_POSTGRES_DSN', 'DSH_P6_P0_POSTGRES_DSN', 'DSH_P13_R2_POSTGRES_DSN',
  'DSH_RECON_CANCELLATION_POSTGRES_DSN',
  'DSH_R22_TEST_DSN', 'DSH_TEST_POSTGRES_CONTAINER_ID',
]);

function sanitizedEnvironment() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (secretPattern.test(key) && !allowedTestSecrets.has(key)) continue;
    env[key] = value;
  }
  return env;
}

function commandFor(file) {
  if (shard.kind === 'node') {
    return { command: process.execPath, args: ['--test', '--test-reporter=tap', `--test-timeout=${Math.min(shard.timeoutMs - 5_000, 120_000)}`, file], cwd: process.cwd() };
  }
  return {
    command: process.execPath,
    args: [resolve('desktop/node_modules/vitest/vitest.mjs'), 'run', file.replace(/^desktop\//, ''), '--reporter=json'],
    cwd: resolve('desktop'),
  };
}

async function killOwnedTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    await execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }).catch(() => {});
  } else {
    child.kill('SIGTERM');
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

function runUnit(file) {
  const spec = commandFor(file);
  const started = performance.now();
  return new Promise((resolveUnit) => {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: sanitizedEnvironment(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    let timedOut = false;
    const timer = setTimeout(async () => {
      timedOut = true;
      await killOwnedTree(child);
    }, shard.timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      resolveUnit({ file, status: 'FAIL', exitCode: null, timedOut, durationMs: Math.round(performance.now() - started), tests: 0, passed: 0, failed: 1, skipped: 0, stdout, stderr: `${stderr}\n${error.stack}`.trim() });
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      const counts = shard.kind === 'node' ? parseTap(stdout) : parseVitest(stdout);
      const skipViolation = shard.forbidSkips && counts.skipped > 0;
      resolveUnit({
        file,
        status: code === 0 && !timedOut && !skipViolation ? 'PASS' : 'FAIL',
        exitCode: code,
        timedOut,
        skipViolation,
        durationMs: Math.round(performance.now() - started),
        ...counts,
        stdout,
        stderr,
      });
    });
  });
}

function lastNumber(text, label) {
  const matches = [...text.matchAll(new RegExp(`^# ${label} (\\d+)\\s*$`, 'gm'))];
  return matches.length ? Number(matches.at(-1)[1]) : 0;
}

function parseTap(text) {
  return {
    tests: lastNumber(text, 'tests'),
    passed: lastNumber(text, 'pass'),
    failed: lastNumber(text, 'fail'),
    skipped: lastNumber(text, 'skipped'),
  };
}

function parseVitest(text) {
  try {
    const start = text.indexOf('{');
    const value = JSON.parse(text.slice(start));
    return {
      tests: value.numTotalTests ?? 0,
      passed: value.numPassedTests ?? 0,
      failed: value.numFailedTests ?? 0,
      skipped: value.numPendingTests ?? 0,
    };
  } catch {
    return { tests: 0, passed: 0, failed: 1, skipped: 0 };
  }
}

async function restorePostgres() {
  if (!shard.restorePostgres) return;
  const id = process.env.DSH_TEST_POSTGRES_CONTAINER_ID;
  if (!id) return;
  await execFile('docker', ['start', id], { windowsHide: true }).catch(() => {});
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await execFile('docker', ['exec', id, 'pg_isready', '-U', 'postgres', '-d', 'dsh_test'], { windowsHide: true });
      return;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    }
  }
  throw new Error('disposable PostgreSQL did not recover between test files');
}

async function preparePostgres() {
  if (!shard.restorePostgres) return;
  await restorePostgres();
  await execFile(process.execPath, [resolve('scripts/ci-postgres-bootstrap.mjs'), '--reset'], {
    cwd: repositoryRoot,
    env: sanitizedEnvironment(),
    windowsHide: true,
  });
}

async function worker(queue, results) {
  while (queue.length) {
    const file = queue.shift();
    await preparePostgres();
    const result = await runUnit(file);
    results.push(result);
    const suffix = result.status === 'PASS'
      ? `tests=${result.tests} pass=${result.passed} skip=${result.skipped} duration_ms=${result.durationMs}`
      : `exit=${result.exitCode} timeout=${result.timedOut} duration_ms=${result.durationMs}`;
    console.log(`${result.status} ${file} ${suffix}`);
    if (result.status === 'FAIL') {
      console.error(result.stderr.trim());
      console.error(result.stdout.slice(-12_000).trim());
    }
    await restorePostgres();
  }
}

const suiteStarted = performance.now();
const queue = [...shard.files];
const results = [];
await Promise.all(Array.from({ length: Math.min(shard.concurrency, queue.length) }, () => worker(queue, results)));
results.sort((a, b) => a.file.localeCompare(b.file));
const summary = {
  schemaVersion: 1,
  shard: shardName,
  status: results.every((result) => result.status === 'PASS') ? 'PASS' : 'FAIL',
  filesDiscovered: shard.files.length,
  filesExecuted: results.length,
  testsPassed: results.reduce((sum, result) => sum + result.passed, 0),
  testsFailed: results.reduce((sum, result) => sum + result.failed, 0),
  testsSkipped: results.reduce((sum, result) => sum + result.skipped, 0),
  durationMs: Math.round(performance.now() - suiteStarted),
  timeoutFiles: results.filter((result) => result.timedOut).map((result) => result.file),
  failureFiles: results.filter((result) => result.status === 'FAIL').map((result) => result.file),
  results: results.map(({ stdout, stderr, ...result }) => result),
};
mkdirSync(dirname(resolve(summaryPath)), { recursive: true });
writeFileSync(resolve(summaryPath), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
process.exitCode = summary.status === 'PASS' ? 0 : 1;
