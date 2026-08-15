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

  it('does not redeliver a received-but-unacked message before the visibility timeout elapses', async () => {
    let clock = 0;
    const q = new InMemoryQueue(() => clock);
    await q.enqueue('DOWNLOAD_ASSET', { mediaId: 1 });
    const first = await q.receive(10);
    expect(first.length).toBe(1);

    clock += 29_999; // just under the 30s visibility timeout
    const second = await q.receive(10);
    expect(second.length).toBe(0);
  });

  it('redelivers a received-but-unacked message after the visibility timeout elapses', async () => {
    let clock = 0;
    const q = new InMemoryQueue(() => clock);
    await q.enqueue('DOWNLOAD_ASSET', { mediaId: 1 });
    const first = await q.receive(10);
    expect(first.length).toBe(1);

    clock += 30_000; // exactly at the visibility timeout
    const second = await q.receive(10);
    expect(second.length).toBe(1);
    expect((second[0]!.payload as any).mediaId).toBe(1);
  });

  it('never redelivers an acked message', async () => {
    let clock = 0;
    const q = new InMemoryQueue(() => clock);
    await q.enqueue('DOWNLOAD_ASSET', { mediaId: 1 });
    const [msg] = await q.receive(10);
    await q.ack(msg!);

    clock += 60_000; // well past the visibility timeout
    const second = await q.receive(10);
    expect(second.length).toBe(0);
  });
});
