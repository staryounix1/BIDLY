#!/usr/bin/env node
/**
 * Apply database migrations.
 *
 * Runs every `db/migrations/*.sql` file in filename order. Each file manages
 * its own transaction and records itself in the `schema_migrations` table
 * (see 0001_init.sql), so this runner only tracks which files have run.
 *
 * Usage:
 *   pnpm db:migrate            # applies pending migrations
 *   pnpm db:migrate --dry-run  # lists what would run, changes nothing
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import './load-env.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(root, 'db', 'migrations');
const dryRun = process.argv.includes('--dry-run');

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

const VERSION_FROM_FILENAME = /^(\d+)/;

async function main() {
  await client.connect();

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  // The migrations table is created by the first migration; before that,
  // nothing has been applied.
  let applied = new Set();
  const tableExists = await client.query(
    `select to_regclass('public.schema_migrations') as t`,
  );
  if (tableExists.rows[0]?.t) {
    const { rows } = await client.query('select version from schema_migrations');
    // A migration is considered applied when its numeric prefix is recorded.
    applied = new Set(rows.map((r) => r.version));
  }

  const pending = files.filter((f) => {
    const match = f.match(VERSION_FROM_FILENAME);
    return !match || !applied.has(match[1]);
  });

  if (pending.length === 0) {
    console.log('No pending migrations.');
    return;
  }

  console.log(`Pending migrations: ${pending.join(', ')}`);
  if (dryRun) {
    console.log('(dry run — nothing applied)');
    return;
  }

  for (const file of pending) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    process.stdout.write(`Applying ${file} ... `);
    try {
      // Migration files contain their own begin/commit.
      await client.query(sql);
      console.log('ok');
    } catch (err) {
      console.log('FAILED');
      console.error(err.message);
      process.exit(1);
    }
  }
  console.log('Migrations complete.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => client.end());
