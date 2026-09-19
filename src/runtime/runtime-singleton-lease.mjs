import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const RUNTIME_ALREADY_ACTIVE = 'RUNTIME_ALREADY_ACTIVE';
export const RUNTIME_LOCK_INVALID = 'RUNTIME_LOCK_INVALID';

export class RuntimeSingletonError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RuntimeSingletonError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function hash(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function canonicalLocalPath(value) {
  let normalized = resolve(String(value)).replace(/\\/g, '/').replace(/\/+$/, '');
  if (/^[A-Za-z]:\//.test(normalized)) normalized = normalized.toLowerCase();
  return normalized;
}

function canonicalPostgresIdentity(connectionString) {
  const text = String(connectionString ?? '');
  try {
    const parsed = new URL(text);
    // Connection mechanics (password rotation, SSL mode, timeouts) do not
    // create a different coordination authority. Username/host/port/db and
    // schema-affecting options do. No credential bytes leave this function.
    const options = parsed.searchParams.get('options') ?? '';
    const schema = parsed.searchParams.get('search_path') ?? '';
    return `${parsed.protocol}//${decodeURIComponent(parsed.username)}@${parsed.hostname.toLowerCase()}:${parsed.port || '5432'}${parsed.pathname}?options=${options}&search_path=${schema}`;
  } catch {
    return text
      .replace(/\b(password|pass|secret|token|key|credential)\s*=\s*(?:'[^']*'|"[^"]*"|\S+)/gi, '$1=<redacted>')
      .trim();
  }
}

export function buildRuntimeLockDomain({ sqlitePath, postgresConnectionString, projects = [] } = {}) {
  if (typeof sqlitePath !== 'string' || !sqlitePath) throw new TypeError('runtime singleton SQLite path is required');
  if (typeof postgresConnectionString !== 'string' || !postgresConnectionString) throw new TypeError('runtime singleton PostgreSQL identity is required');
  const resources = [
    { kind: 'sqlite', id: hash(`sqlite\0${canonicalLocalPath(sqlitePath)}`) },
    { kind: 'postgres', id: hash(`postgres\0${canonicalPostgresIdentity(postgresConnectionString)}`) },
  ];
  for (const project of projects) {
    if (project?.workspace_verified === true && typeof project.workspace_id === 'string' && project.workspace_id) {
      resources.push({ kind: 'workspace', id: hash(`workspace\0${project.workspace_id}`) });
    }
  }
  const unique = [...new Map(resources.map((resource) => [`${resource.kind}:${resource.id}`, resource])).values()]
    .sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
  const resourceIds = unique.map((resource) => `${resource.kind}:${resource.id}`);
  return Object.freeze({
    version: 1,
    id: hash(resourceIds.join('\n')),
    resources: Object.freeze(unique.map(Object.freeze)),
  });
}

export function defaultRuntimeLockRoot() {
  return join(tmpdir(), 'dsh-runtime-singleton-v1');
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function validateOwnerRecord(value, expectedResourceId) {
  return Boolean(
    value && typeof value === 'object' &&
    value.version === 1 &&
    Number.isSafeInteger(value.pid) && value.pid > 0 &&
    typeof value.owner_token === 'string' && /^[0-9a-f-]{16,64}$/i.test(value.owner_token) &&
    typeof value.created_at === 'string' && Number.isFinite(Date.parse(value.created_at)) &&
    Number.isFinite(value.created_at_ms) &&
    typeof value.domain_id === 'string' && /^[0-9a-f]{64}$/i.test(value.domain_id) &&
    value.resource_id === expectedResourceId
  );
}

async function readOwner(lockPath, expectedResourceId) {
  let raw;
  try {
    raw = await readFile(lockPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  let owner;
  try { owner = JSON.parse(raw); } catch { owner = null; }
  if (!validateOwnerRecord(owner, expectedResourceId)) {
    throw new RuntimeSingletonError(RUNTIME_LOCK_INVALID, 'Runtime singleton lease metadata is invalid; refusing unsafe recovery.', { resource_id: expectedResourceId });
  }
  return owner;
}

async function releaseOwnedLock(lockPath, resourceId, ownerToken) {
  const owner = await readOwner(lockPath, resourceId).catch((error) => {
    if (error?.code === RUNTIME_LOCK_INVALID) return null;
    throw error;
  });
  if (!owner || owner.owner_token !== ownerToken) return false;
  const retired = `${lockPath}.released-${ownerToken}`;
  try {
    await rename(lockPath, retired);
    await rm(retired, { force: true });
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function acquireOne({ lockPath, resourceId, record, isProcessAlive }) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let handle;
    try {
      handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      return;
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error?.code !== 'EEXIST') throw error;
    }

    const owner = await readOwner(lockPath, resourceId);
    if (!owner) continue;
    if (isProcessAlive(owner.pid)) {
      throw new RuntimeSingletonError(RUNTIME_ALREADY_ACTIVE, 'A runtime is already active for this state domain.', {
        owner_pid: owner.pid,
        owner_created_at: owner.created_at,
        domain_id: owner.domain_id,
        resource_id: resourceId,
      });
    }
    // Serialize the stale->replacement microsection for this resource.
    // Without this guard, two reclaimers could both observe the same dead
    // owner and the slower one could rename the faster one's newly-created
    // live lease. A guard collision refuses safely; it never steals.
    const recoveryPath = `${lockPath}.recovery`;
    let recoveryHandle;
    let recoveryAcquired = false;
    const recoveryRecord = { ...record, owner_token: randomUUID() };
    for (let guardAttempt = 0; guardAttempt < 4; guardAttempt += 1) {
      try {
        recoveryHandle = await open(recoveryPath, 'wx', 0o600);
        await recoveryHandle.writeFile(`${JSON.stringify(recoveryRecord)}\n`, 'utf8');
        await recoveryHandle.sync();
        await recoveryHandle.close();
        recoveryHandle = null;
        recoveryAcquired = true;
        break;
      } catch (error) {
        await recoveryHandle?.close().catch(() => {});
        recoveryHandle = null;
        if (error?.code !== 'EEXIST') throw error;
        // A recovery guard is itself a singleton lease. Reclaim it only
        // when its complete owner record is valid and that exact PID is
        // provably dead. Live owners, malformed legacy guards, and PID-reuse
        // ambiguity all fail closed.
        const recoveryOwner = await readOwner(recoveryPath, resourceId);
        if (!recoveryOwner || isProcessAlive(recoveryOwner.pid)) {
          throw new RuntimeSingletonError(RUNTIME_ALREADY_ACTIVE, 'Runtime singleton stale recovery is already in progress.', { resource_id: resourceId, owner_pid: recoveryOwner?.pid ?? null });
        }
        const retiredRecovery = `${recoveryPath}.stale-${randomUUID()}`;
        try {
          await rename(recoveryPath, retiredRecovery);
          await rm(retiredRecovery, { force: true });
        } catch (reclaimError) {
          if (reclaimError?.code !== 'ENOENT') throw reclaimError;
        }
      }
    }
    if (!recoveryAcquired) throw new RuntimeSingletonError(RUNTIME_ALREADY_ACTIVE, 'Runtime singleton stale recovery contention did not settle safely.', { resource_id: resourceId });
    try {
      const currentOwner = await readOwner(lockPath, resourceId);
      if (currentOwner && isProcessAlive(currentOwner.pid)) {
        throw new RuntimeSingletonError(RUNTIME_ALREADY_ACTIVE, 'A runtime became active during stale recovery.', { owner_pid: currentOwner.pid, resource_id: resourceId });
      }
      if (currentOwner) {
        const stalePath = `${lockPath}.stale-${randomUUID()}`;
        await rename(lockPath, stalePath);
        await rm(stalePath, { force: true });
      }
      let replacement;
      try {
        replacement = await open(lockPath, 'wx', 0o600);
        await replacement.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
        await replacement.sync();
        await replacement.close();
      } catch (error) {
        await replacement?.close().catch(() => {});
        if (error?.code === 'EEXIST') throw new RuntimeSingletonError(RUNTIME_ALREADY_ACTIVE, 'A runtime became active during stale recovery.', { resource_id: resourceId });
        throw error;
      }
      return;
    } finally {
      await releaseOwnedLock(recoveryPath, resourceId, recoveryRecord.owner_token).catch(() => {});
    }
  }
  throw new RuntimeSingletonError(RUNTIME_ALREADY_ACTIVE, 'Runtime singleton lease contention did not settle safely.', { resource_id: resourceId });
}

export async function acquireRuntimeSingletonLease({
  domain,
  lockRoot = defaultRuntimeLockRoot(),
  pid = process.pid,
  now = () => Date.now(),
  isProcessAlive = processIsAlive,
} = {}) {
  if (!domain || domain.version !== 1 || !Array.isArray(domain.resources) || !domain.resources.length) throw new TypeError('runtime singleton domain is required');
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError('runtime singleton PID is invalid');
  await mkdir(lockRoot, { recursive: true, mode: 0o700 });
  const ownerToken = randomUUID();
  const createdAtMs = now();
  const acquired = [];
  try {
    for (const resource of domain.resources) {
      const resourceId = `${resource.kind}:${resource.id}`;
      const lockPath = join(lockRoot, `${resource.kind}-${resource.id}.lock`);
      const record = {
        version: 1,
        pid,
        process_start_approx_ms: Math.max(0, Math.round(Date.now() - process.uptime() * 1000)),
        owner_token: ownerToken,
        created_at: new Date(createdAtMs).toISOString(),
        created_at_ms: createdAtMs,
        domain_id: domain.id,
        resource_id: resourceId,
      };
      await acquireOne({ lockPath, resourceId, record, isProcessAlive });
      acquired.push({ lockPath, resourceId });
    }
  } catch (error) {
    for (const item of acquired.reverse()) await releaseOwnedLock(item.lockPath, item.resourceId, ownerToken).catch(() => {});
    throw error;
  }

  let released = false;
  return Object.freeze({
    domain,
    pid,
    createdAt: new Date(createdAtMs).toISOString(),
    lockPaths: Object.freeze(acquired.map((item) => item.lockPath)),
    async release() {
      if (released) return;
      released = true;
      for (const item of [...acquired].reverse()) await releaseOwnedLock(item.lockPath, item.resourceId, ownerToken);
    },
  });
}
