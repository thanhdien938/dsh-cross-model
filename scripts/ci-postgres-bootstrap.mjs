import { migrateCoordination } from './coordination-migrate.mjs';
import pg from 'pg';

const dsn = process.env.DSH_CI_POSTGRES_DSN;
if (!dsn) throw new Error('DSH_CI_POSTGRES_DSN is required for disposable CI bootstrap');

if (process.argv.includes('--reset')) {
  const client = new pg.Client({ connectionString: dsn });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS dsh_coordination CASCADE');
  } finally {
    await client.end();
  }
}

const result = await migrateCoordination({ dsn });
console.log(JSON.stringify({ status: result.status, schema: result.schema, version: result.schemaVersion, result: result.result }));
