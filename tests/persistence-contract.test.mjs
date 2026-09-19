import test from 'node:test';
import assert from 'node:assert/strict';

import { assertPersistenceContract, isPersistenceStore, PERSISTENCE_CONTRACT_METHODS } from '../src/persistence/persistence-contract.mjs';
import { PersistenceError } from '../src/persistence/persistence-errors.mjs';
import { SqlitePersistenceStore } from '../src/persistence/sqlite/sqlite-persistence-store.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('persistence contract rejects a store missing required primitives', () => {
  for (const name of PERSISTENCE_CONTRACT_METHODS) {
    const partial = {};
    for (const other of PERSISTENCE_CONTRACT_METHODS) {
      if (other !== name) partial[other] = () => {};
    }
    assert.throws(() => assertPersistenceContract(partial), (error) => {
      assert.ok(error instanceof PersistenceError);
      assert.equal(error.code, 'INVALID_PERSISTENCE_STORE');
      assert.deepEqual(error.missing, [name]);
      return true;
    }, `expected missing ${name} to be rejected`);
  }
});

test('persistence contract rejects non-object stores', () => {
  for (const value of [null, undefined, 42, 'store', []]) {
    assert.equal(isPersistenceStore(value), false);
    assert.throws(() => assertPersistenceContract(value), (error) => error.code === 'INVALID_PERSISTENCE_STORE');
  }
});

test('sqlite store satisfies the persistence contract', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-p2g1-contract-'));
  const dbPath = join(dir, 'store.db');
  try {
    const store = new SqlitePersistenceStore();
    await store.open({ path: dbPath });
    assert.equal(assertPersistenceContract(store), true);
    assert.equal(isPersistenceStore(store), true);
    for (const name of PERSISTENCE_CONTRACT_METHODS) assert.equal(typeof store[name], 'function');
    await store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
