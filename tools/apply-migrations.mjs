// Applies nhost/migrations/default in order and records each version in
// hdb_catalog.schema_migrations -- the same table the Hasura CLI uses -- so that
// `hasura migrate apply` (and therefore an nhost deploy) agrees with what this
// script did and does not try to replay anything.
//
// Pass --reset to drop and recreate the public schema first.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import 'dotenv/config';

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'nhost', 'migrations', 'default');
const reset = process.argv.includes('--reset');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env first.');
  process.exit(1);
}

const client = new pg.Client({ connectionString });
await client.connect();

await client.query('CREATE SCHEMA IF NOT EXISTS hdb_catalog');
await client.query(`
  CREATE TABLE IF NOT EXISTS hdb_catalog.schema_migrations (
    version bigint NOT NULL PRIMARY KEY,
    dirty   boolean NOT NULL DEFAULT false
  )
`);

const dirs = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

if (reset) {
  // Roll back through the down migrations rather than dropping the schema.
  // `public` also holds the pgcrypto/citext extensions, and dropping it would
  // take auth.users.email (a citext column) down with it.
  console.log('rolling back down migrations');
  for (const dir of [...dirs].reverse()) {
    const downFile = join(MIGRATIONS_DIR, dir, 'down.sql');
    if (!existsSync(downFile)) continue;
    try {
      await client.query(readFileSync(downFile, 'utf8'));
      console.log(`down   ${dir}`);
    } catch (err) {
      console.log(`down   ${dir} (skipped: ${err.message.split('\n')[0]})`);
    }
  }
  await client.query('DELETE FROM hdb_catalog.schema_migrations');
}

const { rows: applied } = await client.query('SELECT version FROM hdb_catalog.schema_migrations');
const done = new Set(applied.map((r) => String(r.version)));

let count = 0;
for (const dir of dirs) {
  const version = dir.split('_')[0];
  if (done.has(version)) {
    console.log(`skip   ${dir} (already applied)`);
    continue;
  }
  const upFile = join(MIGRATIONS_DIR, dir, 'up.sql');
  if (!existsSync(upFile)) continue;

  const sql = readFileSync(upFile, 'utf8');
  try {
    // Each migration is one transaction: a failure half way through leaves
    // nothing behind, so re-running after a fix is always safe.
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO hdb_catalog.schema_migrations (version, dirty) VALUES ($1, false)', [version]);
    await client.query('COMMIT');
    console.log(`apply  ${dir}`);
    count += 1;
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`\nFAILED ${dir}\n${err.message}`);
    await client.end();
    process.exit(1);
  }
}

console.log(`\n${count} migration(s) applied, ${dirs.length - count} already present.`);
await client.end();
