import { pathToFileURL } from 'node:url';
import { PostgresCoordinationStore } from '../src/coordination/postgres/postgres-coordination-store.mjs';

class OperatorCommandError extends Error {
  constructor(message, code, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'OperatorCommandError';
    this.code = code;
  }
}

export function describePostgresTarget(dsn) {
  let url;
  try { url = new URL(dsn); }
  catch (cause) { throw new OperatorCommandError('PostgreSQL DSN must be a valid URL', 'COORDINATION_DSN_INVALID', cause); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) {
    throw new OperatorCommandError('PostgreSQL DSN must name an explicit host and database', 'COORDINATION_DSN_INVALID');
  }
  return Object.freeze({
    protocol: url.protocol,
    username: decodeURIComponent(url.username),
    host: url.hostname,
    port: url.port || '5432',
    database: decodeURIComponent(url.pathname.slice(1)),
  });
}

function findSqlState(error) {
  for (let current = error; current; current = current.cause) {
    if (typeof current.code === 'string' && /^\d[A-Z0-9]{4}$/.test(current.code)) return current.code;
  }
  return null;
}

function classifyFailure(error) {
  const sqlState = findSqlState(error);
  if (sqlState === '42501') return new OperatorCommandError('PostgreSQL role lacks permission to migrate the coordination schema', 'COORDINATION_MIGRATION_PERMISSION_DENIED', error);
  if (error?.code === 'COORDINATION_CONNECTION_FAILED') return new OperatorCommandError('PostgreSQL coordination target is unreachable or rejected the connection', error.code, error);
  if (error instanceof OperatorCommandError) return error;
  return new OperatorCommandError('PostgreSQL coordination migration failed', error?.code || 'COORDINATION_MIGRATION_FAILED', error);
}

export async function migrateCoordination({ dsn, StoreClass = PostgresCoordinationStore } = {}) {
  const target = describePostgresTarget(dsn);
  let store;
  try {
    store = await new StoreClass().open({ connectionString: dsn, connectionTimeoutMillis: 10_000 });
    const previousVersion = await store.readSchemaVersion();
    const schemaVersion = await store.migrate();
    await store.assertReady();
    return Object.freeze({
      status: 'PASS',
      target,
      schema: 'dsh_coordination',
      previousVersion,
      schemaVersion,
      result: previousVersion === schemaVersion ? 'ALREADY_CURRENT' : 'MIGRATED',
      autoMigrate: false,
    });
  } catch (error) {
    throw classifyFailure(error);
  } finally {
    await store?.close().catch(() => {});
  }
}

function parseArgs(args, env) {
  if (args.length !== 2 || args[0] !== '--dsn-env') {
    throw new OperatorCommandError('usage: npm run coordination:migrate -- --dsn-env <ENVIRONMENT_VARIABLE>', 'COORDINATION_DSN_INPUT_REQUIRED');
  }
  const name = args[1];
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new OperatorCommandError('DSN environment variable name is invalid', 'COORDINATION_DSN_ENV_INVALID');
  if (!env[name]) throw new OperatorCommandError(`DSN environment variable ${name} is not set`, 'COORDINATION_DSN_INPUT_REQUIRED');
  return env[name];
}

async function main() {
  try {
    const dsn = parseArgs(process.argv.slice(2), process.env);
    console.log(JSON.stringify(await migrateCoordination({ dsn })));
  } catch (error) {
    const failure = classifyFailure(error);
    console.error(JSON.stringify({ status: 'FAIL', code: failure.code, message: failure.message }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
