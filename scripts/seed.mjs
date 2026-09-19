#!/usr/bin/env node
/**
 * Seed the database with catalog, settings, and (in development) demo accounts.
 *
 * Delegates to `db/seed/seed.sql`, which is written to be idempotent, so this
 * can be run safely against a database that already has data.
 *
 * Usage: pnpm db:seed
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import './load-env.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const useSsl = process.env.DATABASE_SSL !== 'false';

const client = new pg.Client({
  connectionString,
  ssl: useSsl ? { rejectUnauthorized: false } : undefined,
});

async function main() {
  const sql = readFileSync(join(root, 'db', 'seed', 'seed.sql'), 'utf8');
  await client.connect();
  process.stdout.write('Seeding ... ');
  try {
    await client.query('begin');
    await client.query(sql);
    await client.query('commit');
    console.log('ok');
  } catch (err) {
    await client.query('rollback');
    console.log('FAILED');
    throw err;
  }
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  })
  .finally(() => client.end());
