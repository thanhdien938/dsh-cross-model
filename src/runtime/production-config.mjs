import { isAbsolute } from 'node:path';

const MODES = new Set(['production', 'development', 'test']);
const SECRET_KEY = /(dsn|password|secret|token|api.?key|credential)/i;

export function loadProductionConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('configuration must be an object');
  const mode = input.mode ?? 'production';
  if (!MODES.has(mode)) throw new TypeError('configuration mode is invalid');
  const postgresDsn = required(input.postgresDsn, 'PostgreSQL DSN');
  const sqlitePath = required(input.sqlitePath, 'SQLite path');
  if (mode === 'production') {
    if (!isAbsolute(sqlitePath)) throw new TypeError('production SQLite path must be absolute');
    if (/^(\\\\|\/\/|smb:|nfs:)/i.test(sqlitePath)) throw new TypeError('network SQLite paths are unsupported');
  }
  const config = {
    mode, postgresDsn, sqlitePath,
    logicalCoordinatorId: bounded(input.logicalCoordinatorId ?? 'dsh-coordinator', 'logicalCoordinatorId'),
    logicalWorkerId: bounded(input.logicalWorkerId ?? 'dsh-worker', 'logicalWorkerId'),
    pollIntervalMs: integer(input.pollIntervalMs ?? 250, 10, 60_000, 'pollIntervalMs'),
    leaseMs: integer(input.leaseMs ?? 30_000, 1_000, 900_000, 'leaseMs'),
    concurrency: integer(input.concurrency ?? 1, 1, 1, 'concurrency')
  };
  return Object.freeze(config);
}

export function redactConfig(value) {
  if (!value || typeof value !== 'object') return value;
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEY.test(key) ? '[REDACTED]' : item])));
}

function required(value, name) { if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required`); return value; }
function bounded(value, name) { if (typeof value !== 'string' || !value || value.length > 128) throw new TypeError(`${name} is invalid`); return value; }
function integer(value, min, max, name) { if (!Number.isInteger(value) || value < min || value > max) throw new TypeError(`${name} is invalid`); return value; }
