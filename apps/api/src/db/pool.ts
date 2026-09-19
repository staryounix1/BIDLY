import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { env } from '@bidly/config';
import { createChildLogger } from '../core/logger.js';

/**
 * PostgreSQL access.
 *
 * The database is plain PostgreSQL, so the whole platform speaks SQL. A thin
 * query helper provides parameterised queries, transactions with automatic
 * rollback, and slow-query logging. No ORM magic sits between the schema in
 * db/migrations and the code that reads it.
 */

const log = createChildLogger({ component: 'db' });

let pool: Pool | null = null;

export function getPool(): Pool {
  if (pool) return pool;
  pool = new Pool({
    connectionString: env.DATABASE_URL,
    min: env.DATABASE_POOL_MIN,
    max: env.DATABASE_POOL_MAX,
    ssl: env.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'bidly-api',
  });

  pool.on('error', (err) => {
    log.error({ err: err.message }, 'db.pool_error');
  });

  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

const SLOW_QUERY_MS = 500;

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<QueryResult<T>> {
  const db = getPool();
  const started = Date.now();
  try {
    const result = await db.query<T>(text, params);
    const durationMs = Date.now() - started;
    if (durationMs > SLOW_QUERY_MS) {
      log.warn({ durationMs, sql: text.slice(0, 200) }, 'db.slow_query');
    }
    return result;
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : err, sql: text.slice(0, 200) }, 'db.query_error');
    throw err;
  }
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const result = await query<T>(text, params);
  return result.rows[0] ?? null;
}

export async function queryMany<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await query<T>(text, params);
  return result.rows;
}

/**
 * Run `fn` inside a transaction. Commits on success, rolls back on any throw.
 * The client is always released. Nested calls reuse the same client when a
 * client is passed explicitly.
 */
export async function transaction<T>(
  fn: (client: PoolClient) => Promise<T>,
  existingClient?: PoolClient,
): Promise<T> {
  if (existingClient) return fn(existingClient);

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      log.error(
        { err: rollbackErr instanceof Error ? rollbackErr.message : rollbackErr },
        'db.rollback_failed',
      );
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Convenience wrapper so transaction bodies can use the same helpers. */
export function clientQuery(client: PoolClient) {
  return {
    async query<T extends QueryResultRow = QueryResultRow>(
      text: string,
      params: unknown[] = [],
    ): Promise<QueryResult<T>> {
      return client.query<T>(text, params);
    },
    async one<T extends QueryResultRow = QueryResultRow>(
      text: string,
      params: unknown[] = [],
    ): Promise<T | null> {
      const res = await client.query<T>(text, params);
      return res.rows[0] ?? null;
    },
    async many<T extends QueryResultRow = QueryResultRow>(
      text: string,
      params: unknown[] = [],
    ): Promise<T[]> {
      const res = await client.query<T>(text, params);
      return res.rows;
    },
    /** For `insert ... returning`: throws if the row was not produced. */
    async insert<T extends QueryResultRow = QueryResultRow>(
      text: string,
      params: unknown[] = [],
    ): Promise<T> {
      const res = await client.query<T>(text, params);
      const row = res.rows[0];
      if (!row) throw new Error('Expected the statement to return a row.');
      return row;
    },
  };
}

export async function healthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
  const started = Date.now();
  try {
    await query('select 1');
    return { ok: true, latencyMs: Date.now() - started };
  } catch {
    return { ok: false, latencyMs: Date.now() - started };
  }
}
