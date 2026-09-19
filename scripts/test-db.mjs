#!/usr/bin/env node
/**
 * Run the database test suites in `db/tests/`.
 *
 * These are assertions expressed in SQL that must hold for the schema to be
 * sound: ledger balances, state consistency, money sign rules, the Part 2
 * model guards, and so on. Each file manages its own transaction and any
 * check that fails raises, which fails the run.
 *
 * Usage: pnpm db:test
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import './load-env.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const testsDir = join(root, 'db', 'tests');

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
  const files = readdirSync(testsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    console.log('No database test files found.');
    return;
  }

  await client.connect();

  let failed = 0;
  for (const file of files) {
    const raw = readFileSync(join(testsDir, file), 'utf8');
    // The files are written for psql. Strip its meta-commands (\set, \echo, ...)
    // so the same assertions run through the plain PostgreSQL driver.
    const sql = raw
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('\\'))
      .join('\n');

    process.stdout.write(`Running ${file} ... `);
    try {
      await client.query(sql);
      console.log('ok');
    } catch (err) {
      console.log('FAILED');
      console.error(`  ${err.message}`);
      failed += 1;
    }
  }

  if (failed > 0) {
    throw new Error(`${failed} database test file(s) failed`);
  }
  console.log('All database tests passed.');
}

main()
  .catch((err) => {
    console.error(`Database tests failed: ${err.message}`);
    process.exit(1);
  })
  .finally(() => client.end());
