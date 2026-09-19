import { CoordinationError } from './coordination-errors.mjs';

export const COORDINATION_RECORD_VERSION = 1;
export const WORKER_STATUSES = Object.freeze(['ACTIVE', 'DRAINING', 'DISABLED', 'DEAD']);
export const COORDINATOR_STATUSES = Object.freeze(['ACTIVE', 'DRAINING', 'DISABLED', 'DEAD']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROFILE_KEYS = new Set(['backend', 'product', 'version', 'transport', 'capabilities', 'fingerprint']);
const CAPABILITY_VALUES = new Set(['PROVED', 'UNPROVEN', 'ERROR']);

function fail(message, code = 'INVALID_COORDINATION_INPUT') {
  throw new CoordinationError(message, { code });
}

export function boundedId(value, field) {
  if (typeof value !== 'string' || !ID.test(value)) fail(`${field} is invalid`);
  return value;
}

function faithfulJson(value, field, maxBytes) {
  assertStrictJsonValue(value, field, '$', new Set());
  let encoded;
  try { encoded = JSON.stringify(value); } catch { fail(`${field} must be JSON-faithful`); }
  if (encoded === undefined || Buffer.byteLength(encoded) > maxBytes) fail(`${field} is invalid or oversized`);
  const parsed = JSON.parse(encoded);
  if (JSON.stringify(parsed) !== encoded) fail(`${field} must be JSON-faithful`);
  return parsed;
}

function assertStrictJsonValue(value, field, path, ancestors) {
  if (value === null) return;
  const type = typeof value;
  if (type === 'undefined' || type === 'function' || type === 'symbol' || type === 'bigint') fail(`${field} contains a non-JSON value at ${path}`);
  if (type === 'number') {
    if (!Number.isFinite(value)) fail(`${field} contains a non-finite number at ${path}`);
    return;
  }
  if (type !== 'object') return;
  if (ancestors.has(value)) fail(`${field} contains a cyclic reference at ${path}`);
  const proto = Object.getPrototypeOf(value);
  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value).filter((key) => key !== 'length');
    if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) fail(`${field} contains a non-faithful array at ${path}`);
  } else {
    if (proto !== Object.prototype && proto !== null) fail(`${field} contains a non-plain object at ${path}`);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !descriptor?.enumerable || !('value' in descriptor)) fail(`${field} contains hidden or accessor state at ${path}`);
    }
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) assertStrictJsonValue(value[index], field, `${path}[${index}]`, ancestors);
  } else {
    for (const key of Object.keys(value)) assertStrictJsonValue(value[key], field, `${path}.${key}`, ancestors);
  }
  ancestors.delete(value);
}

export function normalizeInstalledProfiles(input = []) {
  if (!Array.isArray(input) || input.length > 16) fail('installed_profiles must contain at most 16 profiles');
  const profiles = faithfulJson(input, 'installed_profiles', 16_384);
  for (const profile of profiles) {
    if (!profile || Array.isArray(profile) || typeof profile !== 'object') fail('profile must be an object');
    for (const key of Object.keys(profile)) if (!PROFILE_KEYS.has(key)) fail(`profile field ${key} is not allowlisted`);
    for (const key of ['backend', 'product', 'version', 'transport', 'fingerprint']) {
      if (profile[key] !== undefined && (typeof profile[key] !== 'string' || profile[key].length > 128 || /[\x00-\x1f\x7f]/.test(profile[key]))) fail(`profile ${key} is invalid`);
    }
    if (profile.capabilities !== undefined) {
      if (!profile.capabilities || Array.isArray(profile.capabilities) || typeof profile.capabilities !== 'object' || Object.keys(profile.capabilities).length > 32) fail('profile capabilities are invalid');
      for (const [name, status] of Object.entries(profile.capabilities)) {
        boundedId(name, 'capability');
        if (!CAPABILITY_VALUES.has(status)) fail('capability status is invalid');
      }
    }
  }
  return profiles;
}

export function normalizeCapacity(input = { max_concurrency: 1, reported_in_use: 0 }) {
  const value = faithfulJson(input, 'capacity', 1024);
  const keys = Object.keys(value);
  if (!value || Array.isArray(value) || typeof value !== 'object' || keys.some((k) => !['max_concurrency', 'reported_in_use', 'resource_class'].includes(k))) fail('capacity fields are invalid');
  const { max_concurrency: max = 1, reported_in_use: used = 0 } = value;
  if (!Number.isSafeInteger(max) || max < 1 || max > 10_000 || !Number.isSafeInteger(used) || used < 0 || used > max) fail('capacity values are invalid');
  if (value.resource_class !== undefined) boundedId(value.resource_class, 'resource_class');
  return { max_concurrency: max, reported_in_use: used, ...(value.resource_class ? { resource_class: value.resource_class } : {}) };
}

export function normalizeWorkerIdentity(input) {
  if (!input || typeof input !== 'object') fail('worker identity is required');
  const status = input.status ?? 'ACTIVE';
  if (!WORKER_STATUSES.includes(status)) fail('worker status is invalid');
  return Object.freeze({
    logical_worker_id: boundedId(input.logical_worker_id, 'logical_worker_id'),
    worker_incarnation_id: boundedId(input.worker_incarnation_id, 'worker_incarnation_id'),
    host_id: boundedId(input.host_id, 'host_id'), status,
    installed_profiles: normalizeInstalledProfiles(input.installed_profiles),
    capacity: normalizeCapacity(input.capacity), record_version: COORDINATION_RECORD_VERSION,
  });
}

export function normalizeCoordinatorIdentity(input) {
  if (!input || typeof input !== 'object') fail('coordinator identity is required');
  const status = input.status ?? 'ACTIVE';
  if (!COORDINATOR_STATUSES.includes(status)) fail('coordinator status is invalid');
  return Object.freeze({
    logical_coordinator_id: boundedId(input.logical_coordinator_id, 'logical_coordinator_id'),
    coordinator_incarnation_id: boundedId(input.coordinator_incarnation_id, 'coordinator_incarnation_id'),
    host_id: boundedId(input.host_id, 'host_id'), status, record_version: COORDINATION_RECORD_VERSION,
  });
}

const WORK_KINDS = Object.freeze({
  TASK_DISPATCH: ['task_id', 'run_id', 'dispatch_attempt_id'],
  WORKFLOW_STEP: ['workflow_id', 'step_id'],
  PEER_HOP: ['conversation_id', 'hop_id'],
  PM_ACTION: ['pm_run_id', 'action_id'],
});

export function createWorkIdentity(input) {
  if (!input || typeof input !== 'object') fail('work identity is required');
  const proto = Object.getPrototypeOf(input);
  if (proto !== Object.prototype && proto !== null) fail('work identity must be a plain object');
  const required = WORK_KINDS[input.work_kind];
  if (!required) fail('work_kind is invalid');
  const allowed = new Set(['work_kind', 'work_item_id', ...required]);
  const unknown = Reflect.ownKeys(input).filter((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    return typeof key !== 'string' || !allowed.has(key) || !descriptor?.enumerable || !('value' in descriptor);
  });
  if (unknown.length) fail('work identity contains unknown fields');
  const lineageKeys = [...new Set(Object.values(WORK_KINDS).flat())];
  const supplied = lineageKeys.filter((key) => input[key] !== undefined);
  if (supplied.length !== required.length || required.some((key) => !supplied.includes(key))) fail('work lineage does not match work_kind');
  const result = { work_item_id: boundedId(input.work_item_id, 'work_item_id'), work_kind: input.work_kind };
  for (const key of required) result[key] = boundedId(input[key], key);
  return Object.freeze({ ...result, record_version: COORDINATION_RECORD_VERSION });
}
