const SENSITIVE_KEY = /(?:token|secret|password|credential|api[-_]?key|authorization|cookie)/i;

export function sanitizePmDurable(value, depth = 0) {
  if (depth > 20) return '[MAX_DEPTH]';
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') {
    return value
      .replace(/\bBearer\s+[-_A-Za-z0-9.]{8,}\b/gi, '[REDACTED]')
      .replace(/\b(?:sk|xai|ghp|github_pat)[-_A-Za-z0-9.]{8,}\b/gi, '[REDACTED]');
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => sanitizePmDurable(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitizePmDurable(item, depth + 1);
    return out;
  }
  return String(value);
}
