import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { OutboxStore } from '../electron/main/services/outboxStore';

describe('OutboxStore', () => {
  let dir: string;
  let store: OutboxStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-outbox-'));
    store = new OutboxStore(dir);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('persists a PENDING row before any dispatch happens', () => {
    const record = store.createPending({
      clientMessageId: 'cm-1',
      commandId: 'cmd-1',
      operation: 'SUBMIT_TASK',
      projectId: 'proj-a',
      payload: { body: 'hello' },
    });
    expect(record.state).toBe('PENDING');
    expect(store.get('cm-1')?.state).toBe('PENDING');
  });

  it('survives a fresh OutboxStore instance pointed at the same directory (restart simulation)', () => {
    store.createPending({ clientMessageId: 'cm-2', commandId: 'cmd-2', operation: 'SUBMIT_TASK', projectId: 'p', payload: { body: 'x' } });
    store.close();
    const reopened = new OutboxStore(dir);
    expect(reopened.get('cm-2')?.command_id).toBe('cmd-2');
    reopened.close();
    store = new OutboxStore(dir); // so afterEach can close it again harmlessly
  });

  it('state machine transitions track attempts and terminal state', () => {
    store.createPending({ clientMessageId: 'cm-3', commandId: 'cmd-3', operation: 'DECIDE_INTERACTION', projectId: 'p', payload: {} });
    store.markSending('cm-3');
    expect(store.get('cm-3')?.state).toBe('SENDING');
    expect(store.get('cm-3')?.attempt_count).toBe(1);
    store.markAwaitingAck('cm-3');
    expect(store.get('cm-3')?.state).toBe('AWAITING_ACK');
    store.markCompleted('cm-3', { status: 'DECIDED' });
    const final = store.get('cm-3');
    expect(final?.state).toBe('COMPLETED');
    expect(JSON.parse(final!.canonical_result_json!)).toEqual({ status: 'DECIDED' });
  });

  it('listIncomplete only returns rows that have not reached a durable-safe terminal state', () => {
    store.createPending({ clientMessageId: 'a', commandId: 'a', operation: 'SUBMIT_TASK', projectId: 'p', payload: {} });
    store.createPending({ clientMessageId: 'b', commandId: 'b', operation: 'SUBMIT_TASK', projectId: 'p', payload: {} });
    store.createPending({ clientMessageId: 'c', commandId: 'c', operation: 'SUBMIT_TASK', projectId: 'p', payload: {} });
    store.markCompleted('a', { ok: true });
    store.markFailedTerminal('b', 'PROJECT_REFUSED');
    // 'c' stays PENDING, simulating a crash before dispatch.
    const incomplete = store.listIncomplete();
    expect(incomplete.map((r) => r.client_message_id)).toEqual(['c']);
  });

  it('compactCompleted only removes old COMPLETED rows, never canonical-adjacent state', () => {
    store.createPending({ clientMessageId: 'old', commandId: 'old', operation: 'SUBMIT_TASK', projectId: 'p', payload: {} });
    store.markCompleted('old', {});
    // Force updated_at into the past directly since we cannot wait real time in a unit test.
    (store as any).db.prepare(`UPDATE outbox SET updated_at = ? WHERE client_message_id = ?`).run('2000-01-01T00:00:00.000Z', 'old');
    store.createPending({ clientMessageId: 'recent', commandId: 'recent', operation: 'SUBMIT_TASK', projectId: 'p', payload: {} });
    store.markCompleted('recent', {});
    const removed = store.compactCompleted(24 * 60 * 60 * 1000);
    expect(removed).toBe(1);
    expect(store.get('old')).toBeUndefined();
    expect(store.get('recent')).toBeDefined();
  });
});
