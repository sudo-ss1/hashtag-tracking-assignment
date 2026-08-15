import { createQueue } from '../src/adapters/queue/index.js';

const queue = createQueue();
await queue.enqueue('SYNC_TOP_MEDIA', { hashtagName: 'matcha' });
console.log('[seed] enqueued SYNC_TOP_MEDIA for matcha');
