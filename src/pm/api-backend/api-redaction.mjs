// P11-R0 — API secret redaction. The one place every API-backend surface
// (thrown ApiBackendError diagnostics, BackendExecutionObserver events,
// anything that could reach Telegram/Desktop/history) routes API response
// text and header maps through before attaching them to anything a caller
// could log/display/persist. Never applied to the owner's task/objective
// text or the model's assistant output itself — only to provider transport
// diagnostics (HTTP error bodies, header maps), which is the only surface
// that could ever carry an echoed secret.
const REDACTED = '[REDACTED]';
const SENSITIVE_KEY_RE = /^(authorization|x-api-key|api[-_]?key|apikey|secret|token|bearer)$/i;

// `secrets`: the exact resolved runtime values (e.g. the API key currently
// in play) that must never appear verbatim in anything derived from this
// call. Short/empty values are skipped so this never redacts common short
// substrings by accident.
export function redactSecretValues(text, secrets = []) {
  if (typeof text !== 'string' || text === '') return text;
  let out = text;
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 6) out = out.split(secret).join(REDACTED);
  }
  // Defense in depth: catches an Authorization/Bearer pattern even when the
  // caller didn't (or couldn't) supply the exact secret value up front —
  // e.g. a provider error body that echoes back a DIFFERENT bearer-shaped
  // token than the one DSH sent.
  out = out.replace(/Authorization:\s*Bearer\s+\S+/gi, `Authorization: Bearer ${REDACTED}`);
  out = out.replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/g, `Bearer ${REDACTED}`);
  return out;
}

export function redactHeaders(headers = {}) {
  const out = {};
  for (const [key, value] of Object.entries(headers ?? {})) out[key] = SENSITIVE_KEY_RE.test(key) ? REDACTED : value;
  return out;
}

// Bounded, depth-limited recursive redaction for arbitrary diagnostic
// objects. Only ever masks known-sensitive KEY NAMES (case-insensitive) or
// values matching `secrets` — never touches unrelated content by
// coincidence of substring.
export function redactObjectDeep(value, { secrets = [], depth = 4 } = {}) {
  if (depth <= 0) return '[TRUNCATED]';
  if (typeof value === 'string') return redactSecretValues(value, secrets);
  if (Array.isArray(value)) return value.map((v) => redactObjectDeep(v, { secrets, depth: depth - 1 }));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, v] of Object.entries(value)) out[key] = SENSITIVE_KEY_RE.test(key) ? REDACTED : redactObjectDeep(v, { secrets, depth: depth - 1 });
    return out;
  }
  return value;
}

// Bounded excerpt of a provider error body suitable for a typed error's
// `extra.providerDetail` — redacted, and hard-capped so a pathological/
// malicious response body can never balloon a diagnostic event or log line.
export function safeProviderDetail(text, { secrets = [], maxLength = 400 } = {}) {
  const redacted = redactSecretValues(typeof text === 'string' ? text : '', secrets);
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}…` : redacted;
}
