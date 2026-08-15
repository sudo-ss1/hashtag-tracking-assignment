import { createQueue } from './adapters/queue/index.js';
import { createStorage } from './adapters/storage/index.js';
import { InstagramClient } from './adapters/instagram/client.js';
import { dispatch, type JobDeps } from './jobs/index.js';
import { startScheduler } from './scheduler.js';
import { pool } from './db/pool.js';
import { redact } from './config/index.js';

const IDLE_SLEEP_MS = 2000;
let shuttingDown = false;

async function main() {
  const queue = createQueue();
  const deps: JobDeps = { queue, storage: createStorage(), instagram: new InstagramClient() };

  await pool.query('SELECT 1');
  console.log('[worker] database ok');
  startScheduler(queue);

  if (process.env.SYNC_ON_BOOT) {
    const source = process.env.SYNC_ON_BOOT === 'recent' ? 'SYNC_RECENT_MEDIA' : 'SYNC_TOP_MEDIA';
    await queue.enqueue(source as any, { hashtagName: 'matcha' });
    console.log(`[worker] enqueued ${source} on boot`);
  }

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => { console.log(`[worker] ${sig} — draining`); shuttingDown = true; });
  }

  while (!shuttingDown) {
    const messages = await queue.receive(10);
    if (messages.length === 0) {
      await new Promise((r) => setTimeout(r, IDLE_SLEEP_MS));
      continue;
    }
    for (const message of messages) {
      try {
        await dispatch(deps, message);
        await queue.ack(message);              // ack only on success
      } catch (err) {
        // Left unacked so the queue redelivers; handlers are idempotent.
        console.error(`[worker] ${message.job} failed: ${redact((err as Error).message)}`);
      }
    }
  }

  await pool.end();
  console.log('[worker] stopped');
}

main().catch((err) => { console.error('[worker] fatal:', redact(err.message)); process.exit(1); });
