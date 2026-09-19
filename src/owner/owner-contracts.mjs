import { createHash, randomBytes } from 'node:crypto';

export const OWNER_MUTATIONS = Object.freeze(['SUBMIT_TASK', 'REPLY_TO_INTERACTION', 'DECIDE_INTERACTION', 'REQUEST_CANCEL', 'NARROW_AUTONOMY', 'EXPAND_AUTONOMY']);
export const OWNER_READS = Object.freeze(['GET_TASK', 'LIST_TASKS', 'GET_INBOX', 'GET_TASK_SUMMARY', 'GET_PROJECTS', 'GET_PM_PROFILES']);
export const INTERACTION_KINDS = Object.freeze(['QUESTION', 'APPROVAL', 'INFO']);
export const INTERACTION_ORIGINS = Object.freeze(['PM', 'SYSTEM']);

export class OwnerControlError extends Error {
  constructor(message, code, details = {}) { super(message); this.name = 'OwnerControlError'; this.code = code; Object.assign(this, details); }
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function semanticDigest(value) { return createHash('sha256').update(stableJson(value)).digest('hex'); }
export function deterministicOwnerId(prefix, ...parts) { return `${prefix}-${createHash('sha256').update(parts.join('\0')).digest('base64url').slice(0, 32)}`; }
export function callbackNonce() { return randomBytes(16).toString('base64url'); }
export function callbackDigest(nonce) { return createHash('sha256').update(nonce).digest('hex'); }

export function normalizeOwnerCommand(input) {
  if (!input || typeof input !== 'object' || !OWNER_MUTATIONS.includes(input.operation)) throw new OwnerControlError('unsupported owner mutation', 'OWNER_OPERATION_REFUSED');
  for (const key of ['command_id', 'actor_id']) if (typeof input[key] !== 'string' || !input[key]) throw new OwnerControlError(`${key} is required`, 'INVALID_OWNER_COMMAND');
  if (!/^\d+$/.test(input.actor_id)) throw new OwnerControlError('actor_id must be numeric', 'INVALID_OWNER_COMMAND');
  if (!['TELEGRAM', 'LOCAL'].includes(input.client_kind)) throw new OwnerControlError('client_kind is invalid', 'INVALID_OWNER_COMMAND');
  if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) throw new OwnerControlError('payload must be an object', 'INVALID_OWNER_COMMAND');
  const semantic = { operation: input.operation, actor_id: input.actor_id, client_kind: input.client_kind, project_id: input.project_id ?? null, target_id: input.target_id ?? null, expected_revision: input.expected_revision ?? null, payload: input.payload };
  return Object.freeze({ ...semantic, command_id: input.command_id, payload_digest: semanticDigest(semantic) });
}

export function normalizeInteraction(input) {
  if (!input || !INTERACTION_ORIGINS.includes(input.origin) || !INTERACTION_KINDS.includes(input.kind)) throw new OwnerControlError('invalid owner interaction', 'INVALID_OWNER_INTERACTION');
  if (input.kind === 'INFO' && input.requires_response) throw new OwnerControlError('INFO cannot require a response', 'INVALID_OWNER_INTERACTION');
  if (input.origin === 'SYSTEM' && input.local_only !== true) throw new OwnerControlError('SYSTEM interaction must be local-only', 'INVALID_OWNER_INTERACTION');
  const allowed = [...new Set(input.allowed_responses ?? [])];
  if (allowed.some((v) => typeof v !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(v))) throw new OwnerControlError('allowed responses are invalid', 'INVALID_OWNER_INTERACTION');
  return Object.freeze({ ...input, allowed_responses: allowed, runtime_facts: input.runtime_facts ?? {}, response_bindings: input.response_bindings ?? {}, status: input.status ?? 'OPEN' });
}
