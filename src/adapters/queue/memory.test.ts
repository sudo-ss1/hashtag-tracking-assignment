import { describe, it, expect } from 'vitest';
import { InMemoryQueue } from './memory.js';

describe('InMemoryQueue', () => {
  it('returns enqueued messages in FIFO order', async () => {
    const q = new InMemoryQueue();
    await q.enqueue('DOWNLOAD_ASSET', { mediaId: 1 });
    await q.enqueue('DOWNLOAD_ASSET', { mediaId: 2 });
    const got = await q.receive(10);
    expect(got.map((m) => (m.payload as any).mediaId)).toEqual([1, 2]);
  });

  it('enqueueBatch preserves every entry', async () => {
    const q = new InMemoryQueue();
    await q.enqueueBatch(Array.from({ length: 23 }, (_, i) => ({ job: 'DOWNLOAD_ASSET' as const, payload: { mediaId: i } })));
    expect((await q.receive(100)).length).toBe(23);
  });

  it('respects the max on receive', async () => {
    const q = new InMemoryQueue();
    await q.enqueueBatch(Array.from({ length: 5 }, () => ({ job: 'DOWNLOAD_ASSET' as const, payload: {} })));
    expect((await q.receive(2)).length).toBe(2);
    expect((await q.receive(10)).length).toBe(3);
  });
});
