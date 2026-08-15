import cron from 'node-cron';
import type { ScheduledTask } from 'node-cron';
import type { Queue } from './adapters/queue/index.js';

const EVERY_THREE_HOURS = '0 */3 * * *';
const HASHTAG = 'matcha';

export function startScheduler(queue: Queue): ScheduledTask {
  const task = cron.schedule(EVERY_THREE_HOURS, async () => {
    console.log('[cron] enqueueing SYNC_RECENT_MEDIA');
    await queue.enqueue('SYNC_RECENT_MEDIA', { hashtagName: HASHTAG });
  });
  console.log(`[cron] scheduled SYNC_RECENT_MEDIA at "${EVERY_THREE_HOURS}"`);
  return task;
}
