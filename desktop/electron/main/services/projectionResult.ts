// P15-REM-R3-E (P15-D-014 + the false-empty projection family,
// docs/p15-rem/04_*.md): the ONE shared result envelope for a ReadProjection
// method whose underlying read (a live PostgreSQL/SQLite query) can fail
// independently of whether the data itself is genuinely empty.
//
// Before this module, every affected method's failure path collapsed to a
// bare `[]` (or `null`) — indistinguishable, to any caller, from "the query
// ran fine and there is truly nothing to show." The worst instance
// (P15-D-014): a real pending owner approval existed, the PostgreSQL read
// failed, and the owner-facing panel rendered "Nothing awaiting a decision"
// — a false negative on exactly the kind of fact an owner must never miss.
//
// This contract makes EMPTY and ERROR (and the partial row-level case,
// DEGRADED_PARTIAL) structurally distinct, so a caller — and, ultimately,
// the renderer — can never conflate them by accident.

export type ProjectionStatus = 'OK' | 'EMPTY' | 'DEGRADED_PARTIAL' | 'ERROR';

export interface ProjectionErrorInfo {
  code: string;
  message: string;
}

export interface ProjectionResult<T> {
  status: ProjectionStatus;
  data: T;
  // Present only for DEGRADED_PARTIAL/ERROR — sanitized (never a raw DB
  // error, connection string, or stack trace; bounded length).
  error: ProjectionErrorInfo | null;
  // True only for DEGRADED_PARTIAL: some rows loaded, others were skipped
  // (see rowLevelIsolation()) or the read is a fallback to stale data.
  partial: boolean;
  // ISO timestamp of when this result was produced — lets a renderer show
  // "as of <time>" instead of silently presenting stale/fallback data as
  // current.
  asOf: string;
}

const MAX_ERROR_MESSAGE = 200;

// Never forward a raw driver/db error verbatim (connection strings, host
// details, stack traces) to the renderer — only a short, generic message.
function sanitizeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? 'unknown error');
  return raw.replace(/[\r\n]+/g, ' ').slice(0, MAX_ERROR_MESSAGE);
}

function nowIso(): string {
  return new Date().toISOString();
}

/** A read that succeeded. `isEmptyData` defaults to "empty array" — pass an explicit check for a non-array payload (e.g. MultiTaskStatus). */
export function okResult<T>(data: T, isEmptyData: (value: T) => boolean = (value) => Array.isArray(value) && value.length === 0): ProjectionResult<T> {
  return { status: isEmptyData(data) ? 'EMPTY' : 'OK', data, error: null, partial: false, asOf: nowIso() };
}

/** The read itself failed (query threw, pool unreachable, projection not initialized). `fallback` is what the caller can safely render alongside the error — never invented data, typically the prior known-good value or an empty collection explicitly labeled by `status: 'ERROR'`. */
export function errorResult<T>(fallback: T, code: string, error: unknown): ProjectionResult<T> {
  return { status: 'ERROR', data: fallback, error: { code, message: sanitizeMessage(error) }, partial: false, asOf: nowIso() };
}

/** Some rows loaded, at least one row/field could not be parsed and was skipped — never silently dropped without a trace, never used to discard the rows that DID parse. */
export function degradedResult<T>(data: T, code: string, error: unknown): ProjectionResult<T> {
  return { status: 'DEGRADED_PARTIAL', data, error: { code, message: sanitizeMessage(error) }, partial: true, asOf: nowIso() };
}
