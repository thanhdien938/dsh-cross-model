import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { OutboxStore } from '../electron/main/services/outboxStore';
import { OwnerCommandService } from '../electron/main/services/ownerCommandService';

// A fake pipe client that mimics the real runtime's idempotency contract:
// same command_id + same semantic payload => one materialization, replayed
// verbatim; same command_id + different payload => OWNER_COMMAND_CONFLICT.
class FakeRuntime {
  calls: any[] = [];
  private byCommandId = new Map<string, { digest: string; result: any }>();
  private nextTaskSeq = 1;
  online = true;

  async ownerMutate(operation: string, command: any) {
    this.calls.push({ operation, command });
    if (!this.online) {
      const error: any = new Error('LOCAL_OWNER_PIPE_UNAVAILABLE');
      error.code = 'LOCAL_OWNER_PIPE_UNAVAILABLE';
      throw error;
    }
    const digest = JSON.stringify(command.payload);
    const existing = this.byCommandId.get(command.command_id);
    if (existing) {
      if (existing.digest !== digest) {
        const error: any = new Error('OWNER_COMMAND_CONFLICT');
        error.code = 'OWNER_COMMAND_CONFLICT';
        throw error;
      }
      return existing.result;
    }
    const result = operation === 'SUBMIT_TASK' ? { status: 'MATERIALIZED', task_id: `task-${this.nextTaskSeq++}` } : { status: 'DECIDED' };
    this.byCommandId.set(command.command_id, { digest, result });
    return result;
  }
}

describe('OwnerCommandService', () => {
  let dir: string;
  let outbox: OutboxStore;
  let runtime: FakeRuntime;
  let armed: string | null;
  let service: OwnerCommandService;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-owner-cmd-'));
    outbox = new OutboxStore(dir);
    runtime = new FakeRuntime();
    armed = 'proj-a';
    service = new OwnerCommandService(outbox, () => runtime as any, () => armed);
  });

  afterEach(() => {
    outbox.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('submits SUBMIT_TASK into the armed project and reaches COMPLETED with one canonical effect', async () => {
    const outcome = await service.submit({ operation: 'SUBMIT_TASK', projectId: 'proj-a', payload: { body: 'do the thing' } });
    expect(outcome.state).toBe('COMPLETED');
    expect(runtime.calls.length).toBe(1);
  });

  it('a project mismatch (draft-retarget) is refused before any pipe dispatch', async () => {
    armed = 'proj-b';
    const outcome = await service.submit({ operation: 'SUBMIT_TASK', projectId: 'proj-a', payload: { body: 'sneaky' } });
    expect(outcome.state).toBe('FAILED_TERMINAL');
    expect(outcome.errorCode).toBe('PROJECT_NOT_ARMED');
    expect(runtime.calls.length).toBe(0);
  });

  it('the same project-armed guard applies to approvals and cancel, not just SUBMIT_TASK', async () => {
    armed = 'proj-b';
    for (const operation of ['DECIDE_INTERACTION', 'REPLY_TO_INTERACTION', 'REQUEST_CANCEL'] as const) {
      const outcome = await service.submit({ operation, projectId: 'proj-a', targetId: 'i-1', expectedRevision: 1, payload: {} });
      expect(outcome.state).toBe('FAILED_TERMINAL');
      expect(outcome.errorCode).toBe('PROJECT_NOT_ARMED');
    }
    expect(runtime.calls.length).toBe(0);
  });

  it('replaying an incomplete row after a simulated crash reuses the exact same command_id and produces no duplicate', async () => {
    // Simulate: outbox row written, pipe goes offline before dispatch completes (the crash window).
    runtime.online = false;
    const first = await service.submit({ operation: 'SUBMIT_TASK', projectId: 'proj-a', payload: { body: 'restart-safe task' } });
    expect(first.state).toBe('FAILED_RETRYABLE');
    expect(outbox.listIncomplete().length).toBe(1);

    // "Restart": runtime comes back online, Desktop replays incomplete outbox rows.
    runtime.online = true;
    const replayed = await service.replayIncomplete();
    expect(replayed.length).toBe(1);
    expect(replayed[0].state).toBe('COMPLETED');
    expect(replayed[0].commandId).toBe(first.commandId);
    expect(outbox.listIncomplete().length).toBe(0);

    // A second replay attempt (e.g. a duplicate restart) must not duplicate materialization.
    const secondReplay = await service.replayIncomplete();
    expect(secondReplay.length).toBe(0); // nothing incomplete left to replay
    // Two pipe attempts were made for this command_id (the offline attempt,
    // then the successful replay), but both carried the identical
    // command_id/payload and only one canonical task was ever materialized
    // by the (fake) runtime's idempotency contract.
    const callsForCommand = runtime.calls.filter((c) => c.command.command_id === first.commandId);
    expect(callsForCommand.length).toBe(2);
    expect(new Set(callsForCommand.map((c) => JSON.stringify(c.command.payload))).size).toBe(1);
    expect(replayed[0].result).toEqual({ status: 'MATERIALIZED', task_id: 'task-1' });
  });

  it('DECIDE_INTERACTION: same command_id + same payload is idempotent, different payload is OWNER_COMMAND_CONFLICT', async () => {
    const outcomeA = await service.submit({ operation: 'DECIDE_INTERACTION', projectId: 'proj-a', targetId: 'i-1', expectedRevision: 1, payload: { response: 'YES' } });
    expect(outcomeA.state).toBe('COMPLETED');

    // Re-dispatch the exact same outbox record (simulating "resend same command_id after uncertain delivery").
    const record = outbox.get(outcomeA.clientMessageId)!;
    const replay = await (service as any).send(record);
    expect(replay.state).toBe('COMPLETED');
    expect(runtime.calls.filter((c) => c.command.command_id === outcomeA.commandId).length).toBe(2);
    expect(new Set(runtime.calls.map((c) => JSON.stringify(c.command.payload))).size).toBe(1);

    // A structurally different command_id with a different semantic payload must not collide.
    const outcomeB = await service.submit({ operation: 'DECIDE_INTERACTION', projectId: 'proj-a', targetId: 'i-1', expectedRevision: 1, payload: { response: 'NO' } });
    expect(outcomeB.state).toBe('COMPLETED');
    expect(outcomeB.commandId).not.toBe(outcomeA.commandId);
  });

  it('reusing one command_id for two different payloads (row payload changed) surfaces OWNER_COMMAND_CONFLICT, not a silent second effect', async () => {
    const outcomeA = await service.submit({ operation: 'SUBMIT_TASK', projectId: 'proj-a', payload: { body: 'first body' } });
    expect(outcomeA.state).toBe('COMPLETED');

    const record = outbox.get(outcomeA.clientMessageId)!;
    const tampered = { ...record, payload_json: JSON.stringify({ targetId: null, expectedRevision: null, payload: { body: 'different body' } }) };
    const outcome = await (service as any).send(tampered);
    expect(outcome.state).toBe('CONFLICT');
    expect(outcome.errorCode).toBe('OWNER_COMMAND_CONFLICT');
  });

  it('listRecent surfaces outbox rows for renderer reconciliation', async () => {
    await service.submit({ operation: 'SUBMIT_TASK', projectId: 'proj-a', payload: { body: 'a' } });
    await service.submit({ operation: 'SUBMIT_TASK', projectId: 'proj-a', payload: { body: 'b' } });
    expect(service.listRecent().length).toBe(2);
  });
});
