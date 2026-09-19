import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

class SqliteSnapshotError extends Error {
  constructor(message, code, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'SqliteSnapshotError';
    this.code = code;
  }
}

function canonicalPath(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new SqliteSnapshotError(`${label} path is required`, 'SQLITE_SNAPSHOT_PATH_REQUIRED');
  return resolve(value);
}

export async function snapshotSqliteDatabase({ sourcePath, destinationPath } = {}) {
  const source = canonicalPath(sourcePath, 'source');
  const destination = canonicalPath(destinationPath, 'destination');
  if (source === destination) throw new SqliteSnapshotError('source and destination must be different files', 'SQLITE_SNAPSHOT_PATH_CONFLICT');
  if (!existsSync(source)) throw new SqliteSnapshotError('source SQLite database does not exist', 'SQLITE_SNAPSHOT_SOURCE_NOT_FOUND');
  if (existsSync(destination)) throw new SqliteSnapshotError('destination already exists; choose a new snapshot path', 'SQLITE_SNAPSHOT_DESTINATION_EXISTS');
  if (!existsSync(dirname(destination))) throw new SqliteSnapshotError('destination directory does not exist', 'SQLITE_SNAPSHOT_DESTINATION_DIRECTORY_NOT_FOUND');

  let sourceDb;
  let snapshotDb;
  try {
    sourceDb = new Database(source, { readonly: true, fileMustExist: true });
    const journalMode = String(sourceDb.pragma('journal_mode', { simple: true })).toLowerCase();
    await sourceDb.backup(destination);
    sourceDb.close();
    sourceDb = undefined;

    snapshotDb = new Database(destination, { fileMustExist: true });
    const integrity = snapshotDb.pragma('integrity_check', { simple: true });
    const foreignKeyViolations = snapshotDb.pragma('foreign_key_check');
    const schemaObjects = snapshotDb.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get().count;
    if (integrity !== 'ok') throw new SqliteSnapshotError('snapshot integrity_check failed', 'SQLITE_SNAPSHOT_INTEGRITY_FAILED');
    if (foreignKeyViolations.length !== 0) throw new SqliteSnapshotError('snapshot foreign_key_check found violations', 'SQLITE_SNAPSHOT_FOREIGN_KEY_FAILED');
    snapshotDb.pragma('wal_checkpoint(TRUNCATE)');
    snapshotDb.pragma('journal_mode = DELETE');
    snapshotDb.close();
    snapshotDb = undefined;
    return Object.freeze({
      status: 'PASS',
      source,
      destination,
      method: 'SQLite backup API',
      journalMode,
      integrity,
      foreignKeys: 'ok',
      schemaObjects,
      selfContained: !existsSync(`${destination}-wal`) && !existsSync(`${destination}-shm`),
    });
  } catch (cause) {
    if (cause instanceof SqliteSnapshotError) throw cause;
    throw new SqliteSnapshotError('SQLite snapshot failed', 'SQLITE_SNAPSHOT_FAILED', cause);
  } finally {
    snapshotDb?.close();
    sourceDb?.close();
  }
}

function parseArgs(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!['--source', '--destination'].includes(key) || value === undefined) throw new SqliteSnapshotError('usage: npm run sqlite:snapshot -- --source <database.sqlite> --destination <snapshot.sqlite>', 'SQLITE_SNAPSHOT_ARGUMENTS_INVALID');
    if (values[key]) throw new SqliteSnapshotError(`duplicate argument ${key}`, 'SQLITE_SNAPSHOT_ARGUMENTS_INVALID');
    values[key] = value;
  }
  return { sourcePath: values['--source'], destinationPath: values['--destination'] };
}

async function main() {
  try {
    console.log(JSON.stringify(await snapshotSqliteDatabase(parseArgs(process.argv.slice(2)))));
  } catch (error) {
    console.error(JSON.stringify({ status: 'FAIL', code: error.code || 'SQLITE_SNAPSHOT_FAILED', message: error.message }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
