import net from 'node:net';
import { timingSafeEqual } from 'node:crypto';

export const MAX_CONTROL_FRAME_BYTES = 64 * 1024;

// W1 exposed only PING/READINESS/SHUTDOWN. W2 adds a closed set of owner
// mutation/read operations that forward into the sole runtime
// OwnerControlService. This list is intentionally exhaustive: there is no
// generic dispatch, no exec/shell/fs/SQL surface, and no claim/fencing
// surface reachable from this channel.
const OWNER_MUTATION_OPERATIONS = new Set([
  'SUBMIT_TASK',
  'REPLY_TO_INTERACTION',
  'DECIDE_INTERACTION',
  'REQUEST_CANCEL',
  'NARROW_AUTONOMY',
  'EXPAND_AUTONOMY',
]);
const OWNER_READ_OPERATIONS = new Set(['GET_PM_PROFILES', 'GET_PROJECTS']);

// P12-R1: the ONLY TaskSourceError codes (src/owner/task-source-resolver.mjs)
// ever forwarded verbatim across the pipe — mirrors KNOWN_OWNER_ERROR_CODES'
// discipline below exactly (never pattern-match an arbitrary uppercase code;
// only this explicit allow-list is safe to expose to the renderer).
const KNOWN_TASK_SOURCE_ERROR_CODES = new Set([
  'TASK_FILE_PATH_INVALID',
  'TASK_FILE_REF_INVALID',
  'TASK_FILE_REPOSITORY_MISMATCH',
  'TASK_FILE_FETCH_FAILED',
  'TASK_FILE_NOT_FOUND',
  'TASK_FILE_TOO_LARGE',
  'TASK_FILE_READ_FAILED',
  'TASK_FILE_INVALID_TEXT',
]);

// Only OwnerControlError codes we know are sanitized-and-typed are ever
// returned verbatim. Anything else collapses to a generic code so no
// message/stack/path/env can leak across the pipe boundary.
const KNOWN_OWNER_ERROR_CODES = new Set([
  'OWNER_COMMAND_CONFLICT',
  'STALE_INTERACTION',
  'STALE_CALLBACK',
  'PM_PROFILE_UNAVAILABLE',
  'PROJECT_REFUSED',
  'PROJECT_PATH_MISSING',
  'INVALID_OWNER_COMMAND',
  'RESPONSE_REFUSED',
  'TASK_NOT_FOUND',
  'STALE_AUTONOMY_REVISION',
  'CANCELLATION_UNAVAILABLE',
  'OWNER_INTEGRATION_UNAVAILABLE',
  'OWNER_OPERATION_REFUSED',
  'OWNER_STORE_UNAVAILABLE',
  'INTERACTION_NOT_FOUND',
  'INTERACTION_TASK_MISMATCH',
  'PM_RUN_ID_CONFLICT',
  // P12-R5B Part E/R: these OwnerControlError codes (P9-R0.4's
  // #assertProfileActive and council-contracts.mjs's CouncilValidationError,
  // re-thrown as OwnerControlError by owner-control-service.mjs's
  // #validateBeforeAcceptance) were real, typed, pre-existing failure codes
  // that were NEVER added to this allow-list — every one of them silently
  // collapsed to the generic 'OWNER_COMMAND_FAILED' fallback below,
  // regardless of how specific and actionable the real cause was (e.g. a
  // Desktop COUNCIL dispatch naming a profile id that is not currently
  // registered, or one that IS registered but deactivated). This is the
  // exact "OWNER_COMMAND_FAILED before task creation" observability gap
  // R5's owner-live TEST 3/TEST 4 hit: whichever of these actually fired,
  // the owner had no way to tell it apart from a generic transport failure.
  'PM_PROFILE_INACTIVE',
  'COUNCIL_INVALID_SPEC',
  'COUNCIL_INVALID_PROFILE_ID',
  'COUNCIL_ZERO_PARTICIPANTS',
  'COUNCIL_DUPLICATE_PARTICIPANT',
  'COUNCIL_TOO_MANY_PARTICIPANTS',
  'COUNCIL_INVALID_ROUNDS',
  'COUNCIL_UNSUPPORTED_STRATEGY',
  'COUNCIL_UNKNOWN_CHAIR',
  'COUNCIL_UNKNOWN_PARTICIPANT',
  // P18-W4R6: implementation_participant_id, when supplied, must already be
  // one of this council's own owner-selected participants — same allow-list
  // discipline as the two codes just above.
  'COUNCIL_UNKNOWN_IMPLEMENTATION_PARTICIPANT',
  // P15-REM-R3-B (P15-D-002): OwnerTaskController#submit() now enforces
  // requires_context itself (the shared authority) — the pipe's own early
  // check above (resolveSubmitTaskPayload()) already throws this same typed
  // code directly (via safeCode(), not this allow-list) for the common
  // case, but a request that reaches ownerCommand() should still surface
  // the real code rather than collapsing to OWNER_COMMAND_FAILED.
  'TASK_CONTEXT_REQUIRED_UNAVAILABLE',
  'REQUIRES_CONTEXT_MALFORMED',
  // P18-W4R2: task-branch-binding.mjs's TaskBranchLifecycleError codes,
  // re-thrown as OwnerControlError by owner-task-controller.mjs#submit()
  // — same discipline as every other allow-listed code above: only these
  // exact strings ever cross the pipe verbatim, never a raw git error
  // message/path/stack.
  'TASK_BRANCH_TASK_ID_INVALID',
  'TASK_BRANCH_PREPARE_FAILED',
  'TASK_BRANCH_WORKSPACE_DIRTY',
  'TASK_BRANCH_BASE_SHA_DRIFT',
  'TASK_BRANCH_PROTECTED_NAME',
  'TASK_BRANCH_BINDING_VIOLATION',
  'TASK_BRANCH_BINDING_MISSING',
  'TASK_BRANCH_REMOTE_MISMATCH',
  'TASK_BRANCH_NAMESPACE_VIOLATION',
  'TASK_BRANCH_WORKTREE_NOT_CLEAN',
  // P18-W4R5: base-isolation remediation added two further typed
  // task-branch-binding.mjs codes — same allow-list discipline.
  'TASK_BRANCH_BASE_BRANCH_UNRESOLVED',
  'TASK_BRANCH_BASE_ANCESTRY_UNRESOLVED',
  // P21.2 — owner-task-controller.mjs#submit() now re-throws a
  // deterministic, pre-spawn startPm() composition/routing failure
  // (ProductionPmBackendError/CliReportBackendError — never a transient
  // DB/network error) as an OwnerControlError carrying this SAME original
  // code, so a Desktop-originated SUBMIT_TASK that hits one settles with
  // the specific, actionable reason instead of the generic
  // OWNER_COMMAND_FAILED fallback. Exhaustive as of P21.2: every code these
  // two error classes can throw from createRuntime()/DurablePmRuntime#
  // prepare() (the only functions startPm() calls before any backend is
  // ever spawned) — never the mid-execution codes those same classes also
  // use elsewhere (e.g. CLI_REPORT_OUTPUT_MISSING), which startPm() cannot
  // reach and so can never surface here.
  'SINGLE_ARTIFACT_WIRING_DISABLED',
  'COUNCIL_ARTIFACT_DEPS_MISSING',
  'CLI_REPORT_ROUTE_UNSUPPORTED_PRODUCT',
  'CLI_REPORT_BACKEND_UNSUPPORTED_PRODUCT',
  'CLI_REPORT_RESOLVER_NO_REGISTRY',
  'CLI_REPORT_RESOLVER_NO_PROJECT',
  'PM_BACKEND_UNAVAILABLE',
  'ARTIFACT_STORE_NOT_CONFIGURED',
]);

// P11-R4.2 Part E: `reloadPmProfiles` (optional) is the ONE bounded
// hot-reload entry point Desktop's pmProfiles:create IPC handler triggers
// right after a successful pm-profiles.yaml write — see
// p5-production-composition.mjs's reloadPmProfiles(). Deliberately its
// own top-level operation (not folded into OWNER_MUTATION_OPERATIONS/
// OWNER_READ_OPERATIONS below): it never touches OwnerControlService's
// command/read surface or needs command_id/actor stamping, exactly like
// PING/READINESS/SHUTDOWN above it.
export function startLocalRuntimeControl({ pipeName, authCapability, readiness, runtimeTaskStatus = null, onShutdown, ownerCommand = null, ownerRead = null, reloadPmProfiles = null, resolveTaskFile = null, resolveRequiredContext = null, enrolledOwnerActorId = null } = {}) {
  if (!isLocalPipe(pipeName) || !validCapability(authCapability) || typeof readiness !== 'function' || typeof onShutdown !== 'function') {
    throw new TypeError('local control pipe, capability, readiness, and shutdown handler are required');
  }
  if ((ownerCommand || ownerRead) && !validActorId(enrolledOwnerActorId)) {
    throw new TypeError('enrolledOwnerActorId is required when owner operations are wired');
  }

  // The server owns every accepted persistent connection. `server.close()`
  // only stops new accepts; by itself it waits for existing sockets forever.
  // Desktop intentionally keeps one connection open for status traffic, so a
  // normal runtime shutdown must close those accepted sockets explicitly.
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    let buffered = Buffer.alloc(0);

    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > MAX_CONTROL_FRAME_BYTES && !buffered.includes(0x0a)) {
        refuse(socket, null, 'FRAME_TOO_LARGE');
        return;
      }

      let newline;
      while ((newline = buffered.indexOf(0x0a)) !== -1) {
        const frame = buffered.subarray(0, newline);
        buffered = buffered.subarray(newline + 1);
        if (frame.length > MAX_CONTROL_FRAME_BYTES) {
          refuse(socket, null, 'FRAME_TOO_LARGE');
          return;
        }
        void respond(socket, frame, { authCapability, readiness, runtimeTaskStatus, onShutdown, ownerCommand, ownerRead, reloadPmProfiles, resolveTaskFile, resolveRequiredContext, enrolledOwnerActorId });
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipeName, () => resolve(Object.freeze({
      server,
      close: () => new Promise((done, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : done());
        // Shutdown is reached only after the SHUTDOWN acknowledgement and
        // runtime loops have settled. No further control response is valid;
        // destroy each runtime-owned connection so listener close can finish
        // without depending on the Desktop peer to disconnect first.
        for (const socket of sockets) socket.destroy();
      }),
    })));
  });
}

async function respond(socket, frame, deps) {
  const { authCapability, readiness, runtimeTaskStatus, onShutdown, ownerCommand, ownerRead, reloadPmProfiles, resolveTaskFile, resolveRequiredContext, enrolledOwnerActorId } = deps;
  let id = null;
  try {
    const request = JSON.parse(frame.toString('utf8'));
    id = typeof request?.id === 'string' ? request.id : null;
    if (!id) throw typed('MALFORMED_REQUEST');
    if (!authenticated(request.auth, authCapability)) throw typed('AUTH_REFUSED');
    if (typeof request.operation !== 'string') throw typed('MALFORMED_REQUEST');

    if (request.operation === 'PING') return send(socket, { id, success: true, result: 'PONG' });
    if (request.operation === 'READINESS') return send(socket, { id, success: true, result: readiness() });
    if (request.operation === 'RUNTIME_TASK_STATUS') {
      if (!runtimeTaskStatus) throw typed('UNKNOWN_OPERATION');
      return send(socket, { id, success: true, result: runtimeTaskStatus() });
    }
    if (request.operation === 'SHUTDOWN') {
      send(socket, { id, success: true, result: { status: 'DRAINING' } });
      queueMicrotask(onShutdown);
      return;
    }
    if (request.operation === 'RELOAD_PM_PROFILES') {
      if (!reloadPmProfiles) throw typed('UNKNOWN_OPERATION');
      let result;
      try { result = await reloadPmProfiles(); }
      catch { throw typed('PM_PROFILE_RELOAD_FAILED'); }
      return send(socket, { id, success: true, result });
    }

    if (OWNER_READ_OPERATIONS.has(request.operation)) {
      if (!ownerRead) throw typed('UNKNOWN_OPERATION');
      let result;
      try { result = await ownerRead(request.operation, request.command ?? {}); }
      catch (error) { throw typed(ownerErrorCode(error)); }
      return send(socket, { id, success: true, result });
    }

    if (OWNER_MUTATION_OPERATIONS.has(request.operation)) {
      if (!ownerCommand) throw typed('UNKNOWN_OPERATION');
      // P12-R1: Desktop's SUBMIT_TASK may carry an unresolved
      // `payload.task_file:{ref,path}` directive — the exact same shape
      // Telegram's `--task-file <ref> <path>` already resolves via
      // task-source-resolver.mjs. Resolution happens HERE, once, in the
      // shared runtime-control layer, BEFORE ownerCommand() is ever called
      // — never inside Electron main (no duplicate orchestration logic,
      // P12-R0 §7/§1.7) and never by re-deriving it from Telegram's parser.
      // A resolution failure never reaches ownerCommand: no backend is ever
      // spawned on an unresolved/invalid task source (same "never spawn on
      // a thrown result" discipline task-source-resolver.mjs already
      // documents for the Telegram path).
      const resolvedPayload = await resolveSubmitTaskPayload(request, resolveTaskFile, resolveRequiredContext);
      const input = buildOwnerCommandInput(request, enrolledOwnerActorId, resolvedPayload);
      let result;
      try { result = await ownerCommand(input); }
      catch (error) { throw typed(ownerErrorCode(error)); }
      return send(socket, { id, success: true, result });
    }

    throw typed('UNKNOWN_OPERATION');
  } catch (error) {
    refuse(socket, id, safeCode(error?.code));
  }
}

// The pipe is the sole LOCAL entry point into the runtime's canonical
// OwnerControlService. client_kind and actor_id are never trusted from the
// caller: every command arriving here is unconditionally re-stamped with
// the already-enrolled owner identity, so a compromised renderer cannot
// mint a new owner identity or impersonate a different client_kind.
function buildOwnerCommandInput(request, enrolledOwnerActorId, resolvedPayload) {
  const command = request.command;
  if (!command || typeof command !== 'object') throw typed('MALFORMED_REQUEST');
  if (typeof command.command_id !== 'string' || !command.command_id) throw typed('MALFORMED_REQUEST');
  return {
    command_id: command.command_id,
    actor_id: enrolledOwnerActorId,
    client_kind: 'LOCAL',
    operation: request.operation,
    project_id: command.project_id ?? null,
    target_id: command.target_id ?? null,
    expected_revision: command.expected_revision ?? null,
    payload: resolvedPayload,
  };
}

// P12-R1/R3: resolve (or pass through) the SUBMIT_TASK payload. Every other
// mutation operation's payload is returned completely unchanged — this
// function only ever looks at `payload.task_file` and `payload.requires_context`
// on a SUBMIT_TASK request, and only when those dependencies are wired.
async function resolveSubmitTaskPayload(request, resolveTaskFile, resolveRequiredContext) {
  const command = request.command;
  let payload = command && typeof command === 'object' && command.payload && typeof command.payload === 'object'
    ? command.payload
    : {};
  if (request.operation !== 'SUBMIT_TASK') return payload;

  // P12-R3-H: an optional, EXPLICIT "this task requires a specific prior
  // task's durable context to exist" pre-flight check — resolved BEFORE any
  // pm_run is ever created, exactly like task-file resolution, so a missing
  // required context never leaves a half-started run behind (mirrors the
  // "never spawn a backend on a thrown result" discipline task-source-
  // resolver.mjs already documents). Never triggered unless the owner
  // explicitly names a `requires_context.task_id` — most tasks never touch
  // this path at all (P12-R0 §2.2: context is discoverable, not mandatory).
  if (payload.requires_context != null) {
    const requiresContext = payload.requires_context;
    if (typeof requiresContext !== 'object' || requiresContext === null || typeof requiresContext.task_id !== 'string' || !requiresContext.task_id) {
      throw typed('MALFORMED_REQUEST');
    }
    if (!resolveRequiredContext) throw typed('TASK_CONTEXT_REQUIRED_UNAVAILABLE');
    const found = await resolveRequiredContext({ projectId: command?.project_id ?? null, taskId: requiresContext.task_id });
    if (!found) throw typed('TASK_CONTEXT_REQUIRED_UNAVAILABLE');
  }

  if (payload.task_file == null) return payload;

  const taskFile = payload.task_file;
  if (
    typeof taskFile !== 'object' || taskFile === null ||
    typeof taskFile.ref !== 'string' || !taskFile.ref ||
    typeof taskFile.path !== 'string' || !taskFile.path
  ) {
    throw typed('MALFORMED_REQUEST');
  }
  // Reuses the exact same refusal Telegram's `/c` council-shorthand parser
  // already enforces (telegram-owner-client.mjs) — a task-file directive
  // combined with a council spec is refused, never half-supported, from
  // whichever channel it arrives on.
  if (payload.council) throw typed('TASK_FILE_COUNCIL_NOT_SUPPORTED');
  // Mirrors Telegram's exact FLAGS_INVALID rule ("--task-file does not
  // accept additional task text — the resolved file content is the entire
  // task body"): never leave it ambiguous which text is authoritative.
  if (typeof payload.body === 'string' && payload.body.trim().length > 0) {
    throw typed('TASK_FILE_ADDITIONAL_TEXT_REFUSED');
  }
  if (!resolveTaskFile) throw typed('TASK_FILE_UNAVAILABLE');

  let resolved;
  try {
    resolved = await resolveTaskFile({ projectId: command?.project_id ?? null, ref: taskFile.ref, path: taskFile.path });
  } catch (error) {
    throw typed(taskSourceErrorCode(error));
  }

  // Matches TelegramOwnerAdapter.pollOnce() exactly: the resolved file
  // content BECOMES the task body (OwnerTaskController reads
  // `payload.body` verbatim — it never reads `task_source.content` itself,
  // see src/owner/owner-task-controller.mjs) — `task_source` alone carries
  // the immutable provenance forward for diagnostics/history.
  const { task_file: _taskFile, ...rest } = payload;
  return { ...rest, body: resolved.content, task_source: resolved };
}

function send(socket, value) {
  // The authenticated Desktop client intentionally reuses one local pipe
  // connection. Ending the writable side after each response creates a
  // half-close race when READINESS is immediately followed by the first
  // runtime-status refresh. Keep newline framing, but keep the connection
  // alive until the client disconnects.
  if (!socket.destroyed && socket.writable && !socket.writableEnded) socket.write(`${JSON.stringify(value)}\n`);
}

function refuse(socket, id, code) {
  send(socket, { id, success: false, error: code });
}

function isLocalPipe(value) {
  return typeof value === 'string' && (
    /^\\\\\.\\pipe\\[A-Za-z0-9._-]+$/.test(value) ||
    /^\/[^\0]+\.sock$/.test(value)
  );
}

function validCapability(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function validActorId(value) {
  return typeof value === 'string' && /^\d+$/.test(value);
}

function authenticated(candidate, expected) {
  if (!validCapability(candidate) || !validCapability(expected)) return false;
  const candidateBytes = Buffer.from(candidate, 'hex');
  const expectedBytes = Buffer.from(expected, 'hex');
  return candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes);
}

function safeCode(value) {
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(value ?? '') ? value : 'MALFORMED_REQUEST';
}

// Owner-command failures may carry an OwnerControlError with a known typed
// code (safe to forward verbatim) or an arbitrary error whose message/
// stack/cause must never cross the pipe. Unlike the generic control-frame
// safeCode() fallback, this never pattern-matches an arbitrary uppercase
// error code (e.g. Node's ENOENT, ECONNREFUSED) — only the explicit
// allow-list is forwarded; everything else collapses to one generic code.
function ownerErrorCode(error) {
  const code = error?.code;
  return typeof code === 'string' && KNOWN_OWNER_ERROR_CODES.has(code) ? code : 'OWNER_COMMAND_FAILED';
}

// P12-R1: same discipline as ownerErrorCode() above, scoped to
// TaskSourceError codes from src/owner/task-source-resolver.mjs.
function taskSourceErrorCode(error) {
  const code = error?.code;
  return typeof code === 'string' && KNOWN_TASK_SOURCE_ERROR_CODES.has(code) ? code : 'TASK_FILE_RESOLUTION_FAILED';
}

function typed(code) {
  return Object.assign(new Error(code), { code });
}
