const SENSITIVE_KEY = /(?:token|secret|password|credential|api[-_]?key|authorization|cookie)/i;
const MAX_STRING = 500;

export function sanitizeAuditString(value) {
  return value
    .replace(/\b(?:sk|xai|ghp|github_pat|Bearer)[-_A-Za-z0-9.]{8,}\b/gi, '[REDACTED]')
    .slice(0, MAX_STRING);
}

export function sanitizeAuditData(value, depth = 0) {
  if (depth > 6) return '[MAX_DEPTH]';
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return sanitizeAuditString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) {
    return Object.freeze({
      name: sanitizeAuditString(value.name || 'Error'),
      message: sanitizeAuditString(value.message || ''),
      code: value.code === undefined ? null : sanitizeAuditString(String(value.code)),
    });
  }
  if (Array.isArray(value)) return Object.freeze(value.map((item) => sanitizeAuditData(item, depth + 1)));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitizeAuditData(item, depth + 1);
    }
    return Object.freeze(out);
  }
  return sanitizeAuditString(String(value));
}
