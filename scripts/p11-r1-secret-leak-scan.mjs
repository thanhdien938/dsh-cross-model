// P11-R1 Part R — a safe, programmatic secret-leak scan.
//
// Reads the REAL secret value from the environment (never from a CLI
// argument, never printed) and greps a fixed list of owner-visible/durable
// surfaces for that exact string. Prints ONLY:
//   SECRET_LEAK_SCAN: PASS | FAIL
// and, on FAIL, the affected file paths — never the matched secret text
// itself.
//
// Usage (PowerShell):
//   node scripts/p11-r1-secret-leak-scan.mjs DSH_API_OPENROUTER_KEY
//
// Run this AFTER a real owner-live OpenRouter canary (successful or
// failed) to prove the key never reached any durable/owner-visible
// surface.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const envName = process.argv[2];
if (!envName) {
  console.log(JSON.stringify({ ok: false, message: 'usage: node scripts/p11-r1-secret-leak-scan.mjs <ENV_VAR_NAME>' }));
  process.exit(1);
}
const secret = process.env[envName];
if (!secret) {
  console.log(`SECRET_LEAK_SCAN: SKIPPED (env var ${envName} is not set — nothing to search for)`);
  process.exit(0);
}
if (secret.length < 6) {
  console.log('SECRET_LEAK_SCAN: SKIPPED (secret value too short to scan safely)');
  process.exit(0);
}

const repoRoot = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
// Fixed, bounded surface list — every place the task rule's Part R names.
// `.runtime/<env>/logs/tasks` is the operational diagnostic surface;
// `docs/history` is the portable materialized history; `progress.md` is
// the durable task log. SQLite/PostgreSQL textual payload scanning is
// intentionally OUT of scope for this static-file scanner — see the doc's
// note on why (durable stores are queried, not grepped as flat files).
const SURFACES = ['.runtime', 'docs/history', 'progress.md'];

const hits = [];
function scanFile(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return; // binary or unreadable — never a scan failure, just skipped
  }
  if (text.includes(secret)) hits.push(relative(repoRoot, path));
}
function walk(path) {
  let info;
  try {
    info = statSync(path);
  } catch {
    return;
  }
  if (info.isDirectory()) {
    for (const entry of readdirSync(path)) walk(join(path, entry));
  } else if (info.isFile()) {
    scanFile(path);
  }
}
for (const surface of SURFACES) walk(join(repoRoot, surface));

if (hits.length === 0) {
  console.log('SECRET_LEAK_SCAN: PASS');
} else {
  console.log('SECRET_LEAK_SCAN: FAIL');
  for (const path of hits) console.log(`  affected: ${path}`);
  process.exitCode = 1;
}
