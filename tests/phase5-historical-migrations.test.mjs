import test from 'node:test';
import assert from 'node:assert/strict';
import { COORDINATION_MIGRATIONS, COORDINATION_SCHEMA_VERSION } from '../src/coordination/postgres/coordination-migrations.mjs';
import { migrationDefinitions, SCHEMA_VERSION } from '../src/persistence/sqlite/migrations.mjs';

test('historical migration identities and checksums are exact while current stores advance additively', () => {
  assert.equal(COORDINATION_SCHEMA_VERSION, 5);
  assert.equal(SCHEMA_VERSION, 11);
  assert.deepEqual(COORDINATION_MIGRATIONS.slice(0, 3).map(({ version, name, checksum }) => [version, name, checksum]), [
    [1, 'identity_incarnations', '5372e8f24fe3b549ed7211933b1037d655d48987b15b8c05273c3b61bb2abd8f'],
    [2, 'work_claim_lease_fencing', 'aba2b3049edbaf8bb6bc993ae444346b3c8b2348337c38d26b1fab71cb46cc19'],
    [3, 'coordinator_leadership_cancellation', '94dff16ded227856a9c49d0d99c7ed050633df21348dfe280d860eb31efda90d'],
  ]);
  assert.deepEqual(migrationDefinitions().slice(0, 5).map(({ version, name, checksum }) => [version, name, checksum]), [
    [1, 'phase2-gate1-schema-v1', '8cf47ff8c149cfad5c28a6be3ed218d960338dbca404623354de162b4d98a796'],
    [2, 'phase2-gate4-workflow-peer-durability', '7bc442e37cb0f27c96798b0b8468e0dd758d27013bde3b098fa167641d54d264'],
    [3, 'phase2-gate4-peer-hop-index-unique', '0f87a20a88b488d5a02ef932580e54d28f63a3077aef6aea796d0ce3f88111f2'],
    [4, 'phase2-gate7-durable-pm-turns', 'b0ae90948907aecc864b243ddbd2ef80cd6e47560a75a3a0e06d95ffe95728eb'],
    [5, 'phase2-gate8-native-session-reconciliation', '4209717b08b97807a90d71da11662512652fc41141ce7eedaf2d7f925d07e676'],
  ]);
});
