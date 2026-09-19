const AMBIGUOUS = new Set(['AMBIGUOUS_EXTERNAL_ACCEPTANCE', 'AMBIGUOUS_RESULT_COMMIT', 'INTERRUPTED_EXTERNAL_RUN', 'NATIVE_RECONCILE_REQUIRED', 'OPERATOR_ACTION_REQUIRED']);

export class OperatorControlService {
  constructor({ coordinationStore, classifyDispatch, safeRecovery, requestCancellation, inspectNative, inspectParents, inspectPm } = {}) {
    if (!coordinationStore) throw new TypeError('coordination store is required');
    this.store = coordinationStore; this.classifyDispatch = classifyDispatch; this.safeRecovery = safeRecovery; this.cancel = requestCancellation;
    this.inspectNative = inspectNative; this.inspectParents = inspectParents; this.inspectPm = inspectPm;
  }
  async inspect(workItemId) {
    const [work, claim, classification, cancellation, native, parents, pm] = await Promise.all([
      this.store.readWorkItem(workItemId), this.store.readClaim(workItemId), this.classifyDispatch?.(workItemId), this.store.readCancellation?.(workItemId), this.inspectNative?.(workItemId), this.inspectParents?.(workItemId), this.inspectPm?.(workItemId)
    ]);
    return sanitizeOperatorOutput({ work: referenceOnly(work), claim: publicClaim(claim), classification: classification ?? null, cancellation: cancellation ?? null, native: native ?? null, parents: parents ?? null, pm: pm ?? null });
  }
  async executeSafeRecovery(workItemId) {
    const classification = await this.classifyDispatch(workItemId);
    const state = classification?.classification ?? classification?.state ?? classification;
    if (state !== 'SAFE_TO_DISPATCH' || AMBIGUOUS.has(state)) return Object.freeze({ executed: false, state, reason: 'AUTOMATIC_REPLAY_REFUSED' });
    return this.safeRecovery(workItemId);
  }
  async requestCancellation(workItemId, leaderFence) { return this.cancel(workItemId, leaderFence); }
}

function publicClaim(claim) { if (!claim) return null; const { fencing_token, ...safe } = claim; return Object.freeze(safe); }
function referenceOnly(work) { if (!work) return null; return Object.freeze(Object.fromEntries(Object.entries(work).filter(([key]) => key.endsWith('_id') || key === 'work_kind' || key === 'record_version' || key === 'created_at'))); }

const SENSITIVE_KEY = /(password|credential|secret|token|dsn|connection.?string|api.?key|authorization|prompt|task.?body|result|session)/i;
const SENSITIVE_VALUE = /(bearer\s+\S+|(?:token|password|credential|secret|api.?key)\s*[=:]\s*\S+|(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis):\/\/[^\s/@:]+:[^\s/@]+@)/i;
const MAX_DEPTH = 5; const MAX_KEYS = 32; const MAX_ARRAY = 32; const MAX_STRING = 512;

export function sanitizeOperatorOutput(value) { return sanitize(value, 0); }
function sanitize(value, depth) {
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return value ?? null;
  if (typeof value === 'string') return SENSITIVE_VALUE.test(value) ? '[REDACTED]' : value.slice(0, MAX_STRING);
  if (depth >= MAX_DEPTH || typeof value !== 'object') return '[TRUNCATED]';
  if (Array.isArray(value)) return Object.freeze(value.slice(0, MAX_ARRAY).map((item) => sanitize(item, depth + 1)));
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_KEYS)) output[key.slice(0, 80)] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitize(item, depth + 1);
  return Object.freeze(output);
}
