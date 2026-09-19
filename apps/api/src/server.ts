import { buildApp } from './app.js';
import { env } from '@bidly/config';
import { closePool } from './db/pool.js';
import { createChildLogger } from './core/logger.js';
import { startOutboxWorker, stopOutboxWorker } from './core/outbox-worker.js';

/**
 * API entry point.
 *
 * Starts the HTTP server, the outbox worker that turns domain events into
 * notifications and realtime pushes, and wires graceful shutdown so in-flight
 * requests finish and the database pool closes cleanly on SIGTERM.
 */
const log = createChildLogger({ component: 'server' });

async function main(): Promise<void> {
  const app = await buildApp();

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, 'server.shutdown_started');
    try {
      stopOutboxWorker();
      await app.close();
      await closePool();
      log.info({}, 'server.shutdown_complete');
      process.exit(0);
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : err }, 'server.shutdown_error');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    log.error({ err: reason instanceof Error ? reason.message : String(reason) }, 'process.unhandled_rejection');
  });
  process.on('uncaughtException', (err) => {
    log.error({ err: err.message, stack: err.stack }, 'process.uncaught_exception');
    void shutdown('uncaughtException');
  });

  try {
    await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
    log.info({ port: env.API_PORT, env: env.NODE_ENV }, 'server.listening');
    startOutboxWorker({ intervalMs: 1000, batchSize: 25 });
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : err }, 'server.listen_failed');
    process.exit(1);
  }
}

void main();
