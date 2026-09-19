import { createHash } from 'node:crypto';

const SENSITIVE_KEY = /(?:token|secret|password|credential|api[-_]?key|authorization|cookie)/i;
const TOKEN = /\b(?:Bearer\s+|sk[-_]|xai[-_]|ghp[-_]|github_pat[-_])[-_A-Za-z0-9.]{8,}\b/gi;

export function sanitizeNativeEvidence(value, depth = 0) {
  if (depth > 12) return '[MAX_DEPTH]';
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return value.replace(TOKEN, '[REDACTED]').slice(0, 500);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeNativeEvidence(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitizeNativeEvidence(item, depth + 1);
    return out;
  }
  return String(value);
}

export function nativeProfileFingerprint(profile) {
  const evidence = {
    backend: profile.backend,
    product: profile.product,
    version: profile.version,
    transport: profile.transport,
    capabilities: Object.fromEntries(Object.entries(profile.capabilities ?? {}).sort(([a], [b]) => a.localeCompare(b))),
  };
  return createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
}
