import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

test('19. durable workflow/peer state facades, runner, and relay contain no SQLite/SQL', async () => {
  const files = [
    'src/workflow/durable-workflow-state.mjs',
    'src/peer/durable-peer-state.mjs',
    'src/workflow/workflow-runner.mjs',
    'src/peer/peer-relay.mjs',
  ];
  const sqliteImports = new Set(['better-sqlite3', 'better-sqlite3-multiple-ciphers', 'sqlite3', 'node:sqlite']);
  const sqlKeywords = [
    'CREATE TABLE',
    'ALTER TABLE',
    'INSERT INTO',
    'SELECT ',
    'UPDATE ',
    'DELETE FROM',
    'PRAGMA ',
    'db.exec',
    'db.prepare',
    '.transactionSync',
  ];
  for (const file of files) {
    const source = await readFile(resolve(file), 'utf8');
    assert.ok(!/sqlite/i.test(source), `${file} must not reference sqlite`);
    for (const driver of sqliteImports) {
      assert.ok(!source.includes(driver), `${file} must not import ${driver}`);
    }
    for (const keyword of sqlKeywords) {
      assert.ok(!source.includes(keyword), `${file} must not contain SQL literal ${JSON.stringify(keyword)}`);
    }
  }
});

test('19b. durable facades delegate exclusively to project repositories', async () => {
  const { DurableWorkflowState } = await import('../src/workflow/durable-workflow-state.mjs');
  const { DurablePeerState } = await import('../src/peer/durable-peer-state.mjs');
  const workflowSource = await readFile(resolve('src/workflow/durable-workflow-state.mjs'), 'utf8');
  const peerSource = await readFile(resolve('src/peer/durable-peer-state.mjs'), 'utf8');
  assert.ok(workflowSource.includes('workflow-repository.mjs'), 'workflow facade must delegate to the workflow repository');
  assert.ok(peerSource.includes('peer-repository.mjs'), 'peer facade must delegate to the peer repository');
  const wfRepoStub = {
    createWorkflow() {},
    getWorkflow() {},
    listWorkflows() {},
    updateWorkflowStatus() {},
    getStep() {},
    listSteps() {},
    updateStepStatus() {},
    appendEvent() {},
    transcript() {},
    assertComplete() {
      return true;
    },
  };
  const peerRepoStub = {
    createConversation() {},
    getConversation() {},
    updateConversationStatus() {},
    createHop() {},
    getHop() {},
    hopsForConversation() {},
    updateHopStatus() {},
    addConversationMessage() {},
    messagesForConversation() {},
    appendEvent() {},
    transcriptForConversation() {},
    transcript() {},
    prepareHopAtomic() {},
    countConversations() {},
    countHops() {},
    assertComplete() {
      return true;
    },
  };
  assert.equal(new DurableWorkflowState({ repository: wfRepoStub }).hasWorkflowDurability, true);
  assert.equal(new DurablePeerState({ repository: peerRepoStub }).hasAtomicHopPrepare, true);
});