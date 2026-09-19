import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { COORDINATION_SCHEMA_VERSION } from '../src/coordination/postgres/coordination-migrations.mjs';
import { SCHEMA_VERSION as SQLITE_SCHEMA_VERSION } from '../src/persistence/sqlite/migrations.mjs';

const files = [
  '../docs/phase4/P4_RUNTIME_ARCHITECTURE.md', '../docs/phase4/P4_ARCHITECTURE_CLOSEOUT.md',
  '../docs/phase4/P4_RUNTIME_INVARIANTS.md', '../docs/phase4/P4_OPERATIONS_RUNBOOK.md',
  '../docs/phase4/P4_FAILURE_AND_RECOVERY_MATRIX.md', '../docs/phase4/P4_NEXT_PHASE_HANDOFF.md',
  '../docs/evidence/P4_FULL_PHASE_HANDOFF.md'
];
const content = await Promise.all(files.map((file) => readFile(new URL(file, import.meta.url), 'utf8')));
assert.equal(COORDINATION_SCHEMA_VERSION, 4); assert.equal(SQLITE_SCHEMA_VERSION, 6);
const invariants = content[2].match(/P4-\d{3}/g) ?? [];
assert.equal(new Set(invariants).size >= 100, true);
for (let number = 1; number <= 128; number += 1) assert.equal(invariants.includes(`P4-${String(number).padStart(3, '0')}`), true);
assert.match(content.join('\n'), /no exactly-once|No global\/provider\/native exactly-once/i);
assert.match(content[0], /SQLite is never placed on NFS, SMB/i);
console.log(`P4 ARCHITECTURE CLOSEOUT: PASS; invariants=${new Set(invariants).size}; PostgreSQL=v${COORDINATION_SCHEMA_VERSION}; SQLite=v${SQLITE_SCHEMA_VERSION}`);
