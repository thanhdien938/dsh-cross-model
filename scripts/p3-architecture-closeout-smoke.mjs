import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const base = 'af6acdcf92ce8ae3a631630a48b1f66950eee10d';
const required = [
  'docs/phase3/P3_ARCHITECTURE_CLOSEOUT.md',
  'docs/phase3/P3_DISTRIBUTED_INVARIANTS.md',
  'docs/phase3/P3_RECOVERY_AND_FAILURE_MATRIX.md',
  'docs/phase3/P3_PHASE4_HANDOFF.md',
  'docs/evidence/P3_ARCHITECTURE_CLOSEOUT_HANDOFF.md',
];
for (const file of required) assert.equal(existsSync(file), true, `missing ${file}`);

const invariants = readFileSync(required[1], 'utf8');
const ids = [...invariants.matchAll(/\*\*(P3-\d{3})\*\*/g)].map((match) => match[1]);
assert.ok(ids.length >= 100, `expected >=100 invariants, found ${ids.length}`);
assert.equal(new Set(ids).size, ids.length, 'invariant IDs must be unique');
assert.deepEqual(ids, ids.map((_, index) => `P3-${String(index + 1).padStart(3, '0')}`), 'invariants must be sequential');

const pgMigration = readFileSync('src/coordination/postgres/coordination-migrations.mjs', 'utf8');
const sqliteMigration = readFileSync('src/persistence/sqlite/migrations.mjs', 'utf8');
assert.match(pgMigration, /COORDINATION_SCHEMA_VERSION = 3/);
assert.match(sqliteMigration, /SCHEMA_VERSION = 5/);

const sourceFiles = execFileSync('git', ['ls-tree', '-r', '--name-only', base, 'src'], { encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean);
const manifest = sourceFiles.map((file) => `${execFileSync('git', ['rev-parse', `${base}:${file}`], { encoding: 'utf8' }).trim()}  ${file}`).join('\n');
assert.equal(createHash('sha256').update(manifest).digest('hex'), 'a1df456ceaa412cbd0903fb0608d887e513ed8fc7b2ee2936b6731d080cb5ece');

const allDocs = required.map((file) => readFileSync(file, 'utf8')).join('\n');
for (const phrase of ['does **not** guarantee', 'not replay permission', 'No Phase-4 scope', 'No cross-store atomicity']) assert.ok(allDocs.includes(phrase), `missing frozen truth: ${phrase}`);
console.log(`P3 ARCHITECTURE CLOSEOUT: PASS (${ids.length} invariants; PostgreSQL v3; SQLite v5; accepted P3 source fingerprint unchanged)`);
