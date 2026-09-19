import net from 'net';
import crypto from 'crypto';

const MAX_FRAME_SIZE = 1024 * 64; // 64KB
const REQUEST_TIMEOUT_MS = 5000;

export type OwnerMutationOperation =
  | 'SUBMIT_TASK'
  | 'REPLY_TO_INTERACTION'
  | 'DECIDE_INTERACTION'
  | 'REQUEST_CANCEL'
  | 'NARROW_AUTONOMY'
  | 'EXPAND_AUTONOMY';

export type OwnerReadOperation = 'GET_PM_PROFILES' | 'GET_PROJECTS';

// P12-R1: mirrors Telegram's `--task-file <ref> <path>` directive shape
// exactly (src/owner/task-source-resolver.mjs's `matchTaskFileDirective`) —
// resolution happens runtime-side (local-runtime-control.mjs), never here.
export interface OwnerTaskFileDirective {
  ref: string;
  path: string;
}

export interface OwnerCommandEnvelope {
  command_id: string;
  project_id?: string | null;
  target_id?: string | null;
  expected_revision?: number | null;
  payload: Record<string, unknown> & { task_file?: OwnerTaskFileDirective };
}

interface PipeRequest {
  id: string;
  operation: 'PING' | 'READINESS' | 'RUNTIME_TASK_STATUS' | 'SHUTDOWN' | 'RELOAD_PM_PROFILES' | OwnerMutationOperation | OwnerReadOperation;
  auth: string;
  command?: OwnerCommandEnvelope;
}

// P11-R4.2 Part E: the bounded, non-secret summary
// src/runtime/local-runtime-control.mjs's RELOAD_PM_PROFILES operation
// returns — see p5-production-composition.mjs's reloadPmProfiles().
export interface PmProfileReloadResult {
  admitted: string[];
  rejected: { id: string | null; code: string; message: string }[];
  aliasesAssigned: Record<string, string>;
}

interface PipeResponse {
  id: string;
  success: boolean;
  result?: any;
  error?: string;
}

// Sanitized, typed error surfaced to the renderer. Only the pipe's known
// closed error-code vocabulary and the local transport failures below are
// ever produced; raw messages/stacks from the runtime never cross here.
export class OwnerPipeError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.name = 'OwnerPipeError';
    this.code = code;
  }
}

export class NamedPipeClient {
  private client: net.Socket | null = null;
  private responseBuffer = Buffer.alloc(0);
  constructor(
    private readonly pipeName: string,
    private readonly authCapability: string,
  ) {}

  private pendingRequests: Map<string, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }> = new Map();

  async connect(): Promise<void> {
    if (this.client && !this.client.destroyed) {
      return;
    }

    return new Promise((resolve, reject) => {
      this.client = net.connect(this.pipeName, () => {
        resolve();
      });

      this.client.on('error', (error) => {
        reject(error);
      });

      this.client.on('data', (data) => {
        this.handleResponse(data);
      });

      this.client.on('close', () => {
        this.cleanup();
      });
    });
  }

  disconnect(): void {
    if (this.client && !this.client.destroyed) {
      this.client.destroy();
    }
    this.cleanup();
  }

  async ping(): Promise<boolean> {
    try {
      await this.connect();
      const response = await this.sendRequest({ operation: 'PING' });
      return response === 'PONG';
    } catch (error) {
      return false;
    }
  }

  async readiness(): Promise<boolean> {
    try {
      const response = await this.readinessDetails();
      return response?.ready === true;
    } catch (error) {
      return false;
    }
  }

  async readinessDetails(): Promise<any> {
    await this.connect();
    return this.sendRequest({ operation: 'READINESS' });
  }

  async runtimeTaskStatus(): Promise<any> {
    await this.connect();
    return this.sendRequest({ operation: 'RUNTIME_TASK_STATUS' });
  }

  async shutdown(timeoutMs: number = 30000): Promise<void> {
    await this.connect();
    await this.sendRequest({ operation: 'SHUTDOWN' }, timeoutMs);
  }

  // P11-R4.2 Part E: triggers the running runtime's bounded PM-profile+
  // alias hot-reload — the one call main.ts's pmProfiles:create IPC
  // handler makes right after a successful write, so a newly-created
  // profile is admitted and (if valid) assigned a real alias without a
  // runtime/Desktop restart. Best-effort by design at the call site: the
  // profile is already durably persisted in pm-profiles.yaml regardless
  // of whether this succeeds (a stopped runtime, or one that predates
  // this feature, simply won't hot-admit it until its next real start —
  // never a data-loss risk, only a "not yet live" state).
  async reloadPmProfiles(): Promise<PmProfileReloadResult> {
    try {
      await this.connect();
      return await this.sendRequest({ operation: 'RELOAD_PM_PROFILES' });
    } catch (error: any) {
      throw toOwnerPipeError(error);
    }
  }

  // Closed set of owner mutations. There is no generic "mutate(anything)"
  // escape hatch: each caller must name one of these six operations, and
  // the runtime independently enforces the same closed enum server-side.
  async ownerMutate(operation: OwnerMutationOperation, command: OwnerCommandEnvelope): Promise<any> {
    try {
      await this.connect();
      return await this.sendRequest({ operation, command });
    } catch (error: any) {
      throw toOwnerPipeError(error);
    }
  }

  async ownerRead(operation: OwnerReadOperation): Promise<any> {
    try {
      await this.connect();
      return await this.sendRequest({ operation });
    } catch (error: any) {
      throw toOwnerPipeError(error);
    }
  }

  private async sendRequest(request: Omit<PipeRequest, 'id' | 'auth'>, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<any> {
    if (!this.client || this.client.destroyed) {
      throw new Error('Pipe client not connected');
    }

    const id = crypto.randomBytes(16).toString('hex');
    const fullRequest: PipeRequest = { id, auth: this.authCapability, ...request };

    const message = JSON.stringify(fullRequest);
    const messageBuffer = Buffer.from(message, 'utf8');

    if (messageBuffer.length > MAX_FRAME_SIZE) {
      throw new Error('Request exceeds maximum frame size');
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error('Request timeout'));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timeout });

      this.client!.write(messageBuffer);
      this.client!.write('\n'); // Frame delimiter
    });
  }

  private handleResponse(data: Buffer): void {
    this.responseBuffer = Buffer.concat([this.responseBuffer, data]);

    // A peer must not be able to bypass the frame limit by fragmenting a
    // response across multiple socket data events.
    if (this.responseBuffer.length > MAX_FRAME_SIZE && !this.responseBuffer.includes(0x0a)) {
      this.refuseFrame(new Error('Received oversized frame'));
      return;
    }

    const messages: Buffer[] = [];
    let delimiterIndex: number;
    while ((delimiterIndex = this.responseBuffer.indexOf(0x0a)) !== -1) {
      messages.push(this.responseBuffer.subarray(0, delimiterIndex));
      this.responseBuffer = this.responseBuffer.subarray(delimiterIndex + 1);
    }

    for (const message of messages) {
      if (message.length > MAX_FRAME_SIZE) {
        this.refuseFrame(new Error('Received oversized frame'));
        return;
      }

      try {
        if (message.length === 0) continue;
        const response: PipeResponse = JSON.parse(message.toString('utf8'));
        
        const pending = this.pendingRequests.get(response.id);
        if (!pending) {
          continue;
        }

        clearTimeout(pending.timeout);
        this.pendingRequests.delete(response.id);

        if (response.success) {
          pending.resolve(response.result);
        } else {
          pending.reject(new Error(response.error || 'Unknown error'));
        }
      } catch (error) {
        console.error('Failed to parse pipe response:', error);
      }
    }
  }

  private cleanup(): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Connection closed'));
    }
    this.pendingRequests.clear();
    this.responseBuffer = Buffer.alloc(0);
    this.client = null;
  }

  private refuseFrame(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();
    this.responseBuffer = Buffer.alloc(0);
    this.client?.destroy();
    this.client = null;
  }
}

// Known sanitized error codes the runtime pipe can return for an owner
// operation (see src/runtime/local-runtime-control.mjs KNOWN_OWNER_ERROR_CODES
// plus the fixed control-protocol vocabulary). Anything else observed here
// is a local transport failure (pipe absent, connection refused, timed
// out) rather than a runtime-issued code, and is mapped to a distinct,
// typed, non-leaking failure so the renderer can tell the two apart.
const KNOWN_PIPE_ERROR_CODES = new Set([
  'AUTH_REFUSED', 'MALFORMED_REQUEST', 'UNKNOWN_OPERATION', 'FRAME_TOO_LARGE',
  'OWNER_COMMAND_CONFLICT', 'STALE_INTERACTION', 'STALE_CALLBACK',
  'PM_PROFILE_UNAVAILABLE', 'PROJECT_REFUSED', 'PROJECT_PATH_MISSING', 'INVALID_OWNER_COMMAND',
  'RESPONSE_REFUSED', 'TASK_NOT_FOUND', 'STALE_AUTONOMY_REVISION',
  'CANCELLATION_UNAVAILABLE', 'OWNER_INTEGRATION_UNAVAILABLE',
  'OWNER_OPERATION_REFUSED', 'OWNER_STORE_UNAVAILABLE',
  'INTERACTION_NOT_FOUND', 'PM_RUN_ID_CONFLICT', 'OWNER_COMMAND_FAILED',
  'INTERACTION_TASK_MISMATCH',
  'PM_PROFILE_RELOAD_FAILED',
  // P12-R1: task-file (pinned source) resolution codes — see
  // src/runtime/local-runtime-control.mjs KNOWN_TASK_SOURCE_ERROR_CODES
  // plus the two runtime-control-native codes (UNAVAILABLE/COUNCIL) and the
  // generic resolution-failed fallback.
  'TASK_FILE_PATH_INVALID', 'TASK_FILE_REF_INVALID', 'TASK_FILE_REPOSITORY_MISMATCH',
  'TASK_FILE_FETCH_FAILED', 'TASK_FILE_NOT_FOUND', 'TASK_FILE_TOO_LARGE',
  'TASK_FILE_READ_FAILED', 'TASK_FILE_INVALID_TEXT', 'TASK_FILE_COUNCIL_NOT_SUPPORTED',
  'TASK_FILE_UNAVAILABLE', 'TASK_FILE_RESOLUTION_FAILED', 'TASK_FILE_ADDITIONAL_TEXT_REFUSED',
  // P12-R3: the optional "required prior-task context" pre-flight check.
  'TASK_CONTEXT_REQUIRED_UNAVAILABLE',
  // P12-R5B: mirrors src/runtime/local-runtime-control.mjs's own addition —
  // real, typed OwnerControlError codes (inactive PM profile / council spec
  // validation) that were never forwarded, collapsing every one of them
  // into the generic OWNER_COMMAND_FAILED this Desktop client already
  // passes through unchanged (see the entry above). Without this, even
  // after the runtime side stopped genericizing them, this client would
  // have re-genericized them right back via toOwnerPipeError()'s fallback.
  'PM_PROFILE_INACTIVE',
  'COUNCIL_INVALID_SPEC', 'COUNCIL_INVALID_PROFILE_ID', 'COUNCIL_ZERO_PARTICIPANTS',
  'COUNCIL_DUPLICATE_PARTICIPANT', 'COUNCIL_TOO_MANY_PARTICIPANTS', 'COUNCIL_INVALID_ROUNDS',
  'COUNCIL_UNSUPPORTED_STRATEGY', 'COUNCIL_UNKNOWN_CHAIR', 'COUNCIL_UNKNOWN_PARTICIPANT',
]);

function toOwnerPipeError(error: any): OwnerPipeError {
  const message = typeof error?.message === 'string' ? error.message : '';
  if (KNOWN_PIPE_ERROR_CODES.has(message)) return new OwnerPipeError(message);
  return new OwnerPipeError('LOCAL_OWNER_PIPE_UNAVAILABLE');
}
