import { randomUUID } from 'crypto';
import { OutboxRecord, OutboxStore } from './outboxStore';
import { NamedPipeClient, OwnerMutationOperation } from './namedPipeClient';

export interface OwnerCommandInput {
  operation: OwnerMutationOperation;
  projectId: string | null;
  targetId?: string | null;
  expectedRevision?: number | null;
  payload: Record<string, unknown>;
}

export interface OwnerCommandOutcome {
  clientMessageId: string;
  commandId: string;
  state: OutboxRecord['state'];
  result?: unknown;
  errorCode?: string;
}

// The sole LOCAL owner-write path: renderer -> typed preload IPC -> this
// service -> durable outbox -> authenticated named pipe -> runtime
// OwnerControlService. This class never talks to PostgreSQL/SQLite, never
// materializes a task itself, and holds no second copy of owner state; it
// only owns delivery-safety bookkeeping (the outbox) plus the arming guard.
export class OwnerCommandService {
  constructor(
    private readonly outbox: OutboxStore,
    private readonly getPipeClient: () => NamedPipeClient | null,
    private readonly getArmedProjectId: () => string | null,
  ) {}

  // A brand-new owner action from the composer/approval/cancel UI. Always
  // writes the outbox row before any network activity.
  async submit(input: OwnerCommandInput): Promise<OwnerCommandOutcome> {
    const clientMessageId = randomUUID();
    const record = this.outbox.createPending({
      clientMessageId,
      commandId: clientMessageId,
      operation: input.operation,
      projectId: input.projectId,
      payload: { targetId: input.targetId ?? null, expectedRevision: input.expectedRevision ?? null, payload: input.payload },
    });
    return this.send(record);
  }

  // Called after a crash/restart once the runtime is reachable again, and
  // may be called opportunistically whenever the pipe reconnects. Every
  // incomplete row is retried with its exact original command_id and
  // payload — a new command_id is never minted for a retry.
  async replayIncomplete(): Promise<OwnerCommandOutcome[]> {
    const outcomes: OwnerCommandOutcome[] = [];
    for (const record of this.outbox.listIncomplete()) {
      outcomes.push(await this.send(record));
    }
    return outcomes;
  }

  listRecent(limit = 200): OutboxRecord[] {
    return this.outbox.listRecent(limit);
  }

  private async send(record: OutboxRecord): Promise<OwnerCommandOutcome> {
    const stored = JSON.parse(record.payload_json) as { targetId: string | null; expectedRevision: number | null; payload: Record<string, unknown> };

    // Defense in depth: even though the renderer disables the composer and
    // approval controls unless selected === armed, the service
    // independently refuses to dispatch ANY project-scoped mutation
    // (SUBMIT_TASK, REPLY_TO_INTERACTION, DECIDE_INTERACTION,
    // REQUEST_CANCEL, NARROW/EXPAND_AUTONOMY) whose project is not
    // currently armed. This is what makes the draft-retarget attack and a
    // stale/other-project approval control structurally impossible, not
    // merely a UI convention.
    if (record.project_id && record.project_id !== this.getArmedProjectId()) {
      this.outbox.markFailedTerminal(record.client_message_id, 'PROJECT_NOT_ARMED');
      return { clientMessageId: record.client_message_id, commandId: record.command_id, state: 'FAILED_TERMINAL', errorCode: 'PROJECT_NOT_ARMED' };
    }

    const pipe = this.getPipeClient();
    if (!pipe) {
      this.outbox.markSending(record.client_message_id);
      this.outbox.markFailedRetryable(record.client_message_id, 'LOCAL_OWNER_PIPE_UNAVAILABLE');
      return { clientMessageId: record.client_message_id, commandId: record.command_id, state: 'FAILED_RETRYABLE', errorCode: 'LOCAL_OWNER_PIPE_UNAVAILABLE' };
    }

    this.outbox.markSending(record.client_message_id);
    this.outbox.markAwaitingAck(record.client_message_id);
    try {
      const result = await pipe.ownerMutate(record.operation as OwnerMutationOperation, {
        command_id: record.command_id,
        project_id: record.project_id,
        target_id: stored.targetId,
        expected_revision: stored.expectedRevision,
        payload: stored.payload,
      });
      this.outbox.markCompleted(record.client_message_id, result);
      return { clientMessageId: record.client_message_id, commandId: record.command_id, state: 'COMPLETED', result };
    } catch (error: any) {
      const code = typeof error?.code === 'string' ? error.code : 'OWNER_COMMAND_FAILED';
      if (code === 'OWNER_COMMAND_CONFLICT') {
        this.outbox.markConflict(record.client_message_id, code);
        return { clientMessageId: record.client_message_id, commandId: record.command_id, state: 'CONFLICT', errorCode: code };
      }
      if (code === 'LOCAL_OWNER_PIPE_UNAVAILABLE') {
        this.outbox.markFailedRetryable(record.client_message_id, code);
        return { clientMessageId: record.client_message_id, commandId: record.command_id, state: 'FAILED_RETRYABLE', errorCode: code };
      }
      // Every other sanitized code (STALE_INTERACTION, PROJECT_REFUSED,
      // PM_PROFILE_UNAVAILABLE, ...) is a canonical, deterministic outcome
      // for this exact command_id/payload; retrying it verbatim cannot
      // produce a different result, so the row is terminal, not retryable.
      this.outbox.markFailedTerminal(record.client_message_id, code);
      return { clientMessageId: record.client_message_id, commandId: record.command_id, state: 'FAILED_TERMINAL', errorCode: code };
    }
  }
}
