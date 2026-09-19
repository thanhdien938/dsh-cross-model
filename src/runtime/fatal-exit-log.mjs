/**
 * P13-R1.3 — process-level fatal-exit observability.
 *
 * The real production runtime (scripts/p5-runtime.mjs) had no
 * `uncaughtException`/`unhandledRejection` handling at all before this
 * module: a fatal process-level failure exited the process (Node's own
 * default behavior, or an uncaught rejection from the top-level
 * `Promise.all()`) with nothing durable ever recorded beyond a possibly-
 * overwritten Desktop in-memory log. Two real owner-live incidents
 * (P13-R1-LIVE, P13-R1.2) both ended `ROOT_CAUSE_NOT_PERSISTED`.
 *
 * This module is deliberately dependency-free beyond `node:fs` and the
 * ONE existing, most comprehensive redaction primitive already used
 * project-wide for exactly this purpose
 * (operator-control-service.mjs's `sanitizeOperatorOutput()` — already
 * covers Bearer tokens, DSNs (`postgres://user:pass@...`), and
 * token/password/secret/api-key key=value pairs, plus sensitive KEY
 * NAMES). It never imports SQLite/Postgres/anything that could itself be
 * the source of the fault being reported, and the log write is
 * SYNCHRONOUS by design: an `uncaughtException`/`unhandledRejection`
 * handler cannot rely on async work completing before the process
 * terminates.
 */
import { appendFileSync } from 'node:fs';
import { sanitizeOperatorOutput } from './operator-control-service.mjs';

const MAX_STACK_LINES = 50;

function sanitizeMessage(message) {
  if (typeof message !== 'string') return null;
  const safe = sanitizeOperatorOutput(message);
  return typeof safe === 'string' ? safe : '[REDACTED]';
}

// Line-by-line, not whole-block: a single secret-laden line (only
// possible when a line repeats a message that itself embedded a secret)
// is redacted independently so the rest of the frame structure
// (file:line references, which carry no secrets) survives for diagnosis.
function sanitizeStack(stack) {
  if (typeof stack !== 'string') return null;
  return stack
    .split('\n')
    .slice(0, MAX_STACK_LINES)
    .map((line) => {
      const safe = sanitizeOperatorOutput(line);
      return typeof safe === 'string' ? safe : '[REDACTED]';
    })
    .join('\n');
}

/** @returns {{name:string, code:string|null, message:string|null, stack:string|null}} */
export function sanitizeFatalError(error) {
  if (error instanceof Error) {
    return {
      name: typeof error.name === 'string' && error.name ? error.name : 'Error',
      code: error.code !== undefined && error.code !== null ? String(error.code) : null,
      message: sanitizeMessage(error.message),
      stack: sanitizeStack(error.stack),
    };
  }
  // Node allows throwing/rejecting a non-Error value; never let that
  // crash the fatal-capture path itself.
  let message = null;
  try { message = typeof error === 'string' ? error : JSON.stringify(error); } catch { message = String(error); }
  return { name: 'NonErrorThrown', code: null, message: sanitizeMessage(message), stack: null };
}

/**
 * @param {{stage:string, error:unknown, pid?:number, extra?:object}} input
 * @returns {object} one sanitized, JSON-serializable fatal record.
 */
export function buildFatalRecord({ stage, error, pid = process.pid, extra = {} } = {}) {
  if (typeof stage !== 'string' || !stage) throw new TypeError('fatal record stage is required');
  const safeExtra = sanitizeOperatorOutput(extra ?? {});
  return {
    timestamp: new Date().toISOString(),
    stage,
    pid,
    ...sanitizeFatalError(error),
    extra: safeExtra && typeof safeExtra === 'object' ? safeExtra : { value: safeExtra },
  };
}

/**
 * Append one fatal record as a JSON line. Synchronous and best-effort: a
 * logging failure (disk full, permissions) must never mask or replace the
 * real fatal exit it was trying to record.
 * @returns {boolean} whether the write succeeded.
 */
export function appendFatalRecordSync(path, record) {
  try {
    appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Installs process-level `uncaughtException`/`unhandledRejection`
 * capture. Call this BEFORE any other async work in the entrypoint, so a
 * rejection during startup (config load, composition construction) is
 * also caught.
 *
 * This does NOT swallow or mask the fatal condition (Part C: "the goal is
 * evidence, not masking corruption") — it persists a sanitized record and
 * then re-establishes the equivalent fatal exit itself
 * (`process.exitCode = 1; process.exit(1)`), since registering either
 * listener suppresses Node's own default terminate-the-process behavior.
 *
 * @returns {{logPath:string, recordFatal:Function, uninstall:Function}}
 *   `recordFatal(stage, error, extra)` is for the EXISTING top-level
 *   try/catch and the finally/close() paths, which already control their
 *   own exit flow and must not have this module terminate the process a
 *   second time.
 */
export function installFatalExitCapture({ logPath, pid = process.pid } = {}) {
  if (typeof logPath !== 'string' || !logPath) throw new TypeError('fatal log path is required');
  let handled = false; // a process can only genuinely die once; avoid a
  // duplicate record if both handlers somehow fire for the same tick.
  const terminate = (stage) => (error) => {
    if (handled) return;
    handled = true;
    appendFatalRecordSync(logPath, buildFatalRecord({ stage, error, pid }));
    process.exitCode = 1;
    process.exit(1);
  };
  const onUncaughtException = terminate('UNCAUGHT_EXCEPTION');
  const onUnhandledRejection = terminate('UNHANDLED_REJECTION');
  process.on('uncaughtException', onUncaughtException);
  process.on('unhandledRejection', onUnhandledRejection);
  return Object.freeze({
    logPath,
    recordFatal: (stage, error, extra) => appendFatalRecordSync(logPath, buildFatalRecord({ stage, error, pid, extra })),
    uninstall: () => {
      process.off('uncaughtException', onUncaughtException);
      process.off('unhandledRejection', onUnhandledRejection);
    },
  });
}
