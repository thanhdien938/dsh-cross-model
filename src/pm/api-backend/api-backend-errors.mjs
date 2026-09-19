// P11-R0 — typed external-API backend failure taxonomy.
//
// Every code below is CONTAINED at the single backend invocation boundary:
// `createCliPmDriver()`'s `decide()` (production-pm-backend-registry.mjs)
// already wraps any `run()` throw into a sanitized 'terminal' FAILED
// observer event and rethrows to the ONE task that requested this
// execution — this class adds nothing that changes that boundary. It only
// gives the API run() closure (api-backend-adapter.mjs) a stable, typed
// `code` plus safe (never-secret) `message`/`extra` so Telegram/Desktop/
// diagnostics can show *why* without ever seeing raw provider payloads or
// credentials (see api-redaction.mjs — every diagnostic string that could
// carry provider-echoed text is redacted before it reaches this class).
//
// `error.code` for a timeout specifically is `API_TIMEOUT`, which — like
// every existing bridge's own `_TIMEOUT` convention (CLAUDE_TIMEOUT,
// CODEX_TIMEOUT, ...) — ends in `_TIMEOUT`, so the generic structural
// timeout-diagnostic branch in createCliPmDriver's decide() (matched via
// `error.code.endsWith('_TIMEOUT')`) picks it up for free, without any
// api-specific branch added there.
export class ApiBackendError extends Error {
  constructor(message, code = API_ERROR_CODE_DEFAULT, extra = {}) {
    super(message);
    this.name = 'ApiBackendError';
    this.code = code;
    Object.assign(this, extra);
  }
}

export const API_ERROR_CODES = Object.freeze({
  AUTH_FAILED: 'API_AUTH_FAILED',
  BILLING_FAILED: 'API_BILLING_FAILED',
  FORBIDDEN: 'API_FORBIDDEN',
  MODEL_NOT_FOUND: 'API_MODEL_NOT_FOUND',
  RATE_LIMITED: 'API_RATE_LIMITED',
  REQUEST_INVALID: 'API_REQUEST_INVALID',
  NETWORK_ERROR: 'API_NETWORK_ERROR',
  PROVIDER_UNAVAILABLE: 'API_PROVIDER_UNAVAILABLE',
  TIMEOUT: 'API_TIMEOUT',
  RESPONSE_INVALID: 'API_RESPONSE_INVALID',
  EMPTY_RESPONSE: 'API_EMPTY_RESPONSE',
  CANCELLED: 'API_CANCELLED',
  SECRET_MISSING: 'API_SECRET_MISSING',
  PROVIDER_CONFIG_INVALID: 'API_PROVIDER_CONFIG_INVALID',
});
const API_ERROR_CODE_DEFAULT = API_ERROR_CODES.PROVIDER_UNAVAILABLE;

// HTTP status -> typed code, per the task rule's "HTTP STATUS MAPPING"
// section. A status this table doesn't explicitly enumerate still resolves
// to a bounded, sane bucket (other 4xx -> REQUEST_INVALID, other 5xx/
// unrecognized -> PROVIDER_UNAVAILABLE) — never an uncaught/unmapped throw
// and never a silent pass-through of a raw HTTP status as the DSH-facing
// error code.
export function mapHttpStatusToApiErrorCode(status) {
  const code = Number(status);
  if (code === 400) return API_ERROR_CODES.REQUEST_INVALID;
  if (code === 401) return API_ERROR_CODES.AUTH_FAILED;
  if (code === 402) return API_ERROR_CODES.BILLING_FAILED;
  if (code === 403) return API_ERROR_CODES.FORBIDDEN;
  if (code === 404) return API_ERROR_CODES.MODEL_NOT_FOUND;
  if (code === 408) return API_ERROR_CODES.TIMEOUT;
  if (code === 429) return API_ERROR_CODES.RATE_LIMITED;
  if (code >= 500 && code <= 504) return API_ERROR_CODES.PROVIDER_UNAVAILABLE;
  if (code >= 400 && code < 500) return API_ERROR_CODES.REQUEST_INVALID;
  return API_ERROR_CODES.PROVIDER_UNAVAILABLE;
}
