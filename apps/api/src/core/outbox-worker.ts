import { randomUUID } from 'node:crypto';
import { createChildLogger } from './logger.js';
import { drainOutbox, type DrainResult } from './outbox.js';

const log = createChildLogger({ component: 'outbox-worker' });

/**
 * Background dispatcher for the transactional outbox.
 *
 * One interval drains pending events and fans them out to the notification
 * table and the realtime hub. The interval is unref'd so it never keeps the
 * process alive on shutdown, and `stop()` clears it for tests and graceful
 * termination. `runOnce()` is exported so tests can drive a deterministic
 * drain instead of waiting on the timer.
 */

export interface OutboxWorker {
  stop: () => void;
  runOnce: () => Promise<DrainResult>;
}

let active: OutboxWorker | null = null;

export function startOutboxWorker(options: { intervalMs?: number; batchSize?: number } = {}): OutboxWorker {
  const intervalMs = options.intervalMs ?? 1000;
  const batchSize = options.batchSize ?? 25;
  const workerId = `worker-${process.pid}-${randomUUID().slice(0, 8)}`;

  const runOnce = async (): Promise<DrainResult> => {
    try {
      return await drainOutbox(batchSize, workerId);
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'outbox_worker.drain_failed');
      return { processed: 0, notifications: 0, realtime: 0, failed: 0 };
    }
  };

  const timer = setInterval(() => {
    void runOnce().then((result) => {
      if (result.processed || result.failed) {
        log.debug(result, 'outbox_worker.cycle');
      }
    });
  }, intervalMs);
  timer.unref?.();

  const worker: OutboxWorker = {
    stop: () => {
      clearInterval(timer);
      if (active === worker) active = null;
    },
    runOnce,
  };
  active = worker;
  log.info({ intervalMs, batchSize, workerId }, 'outbox_worker.started');
  return worker;
}

export function stopOutboxWorker(): void {
  active?.stop();
  active = null;
}

export function getOutboxWorker(): OutboxWorker | null {
  return active;
}
