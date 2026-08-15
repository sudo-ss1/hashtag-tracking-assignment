import type { Queue, QueueEntry, QueueMessage, JobName } from './types.js';

const VISIBILITY_TIMEOUT_MS = 30_000;

export class InMemoryQueue implements Queue {
  private pending: QueueMessage[] = [];
  private inFlight = new Map<string, { message: QueueMessage; deliveredAt: number }>();
  private seq = 0;

  constructor(private now: () => number = Date.now) {}

  async enqueue(job: JobName, payload: unknown): Promise<void> {
    this.pending.push({ id: String(++this.seq), job, payload });
  }

  async enqueueBatch(entries: QueueEntry[]): Promise<void> {
    for (const e of entries) await this.enqueue(e.job, e.payload);
  }

  async receive(max: number): Promise<QueueMessage[]> {
    const cutoff = this.now() - VISIBILITY_TIMEOUT_MS;
    const expired: QueueMessage[] = [];
    for (const [id, entry] of this.inFlight) {
      if (entry.deliveredAt <= cutoff) {
        expired.push(entry.message);
        this.inFlight.delete(id);
      }
    }
    // Preserve FIFO: expired redeliveries go back to the front, in their original relative order,
    // ahead of messages that have never been delivered.
    expired.sort((a, b) => Number(a.id) - Number(b.id));
    this.pending = [...expired, ...this.pending];

    const taken = this.pending.splice(0, max);
    const deliveredAt = this.now();
    for (const m of taken) {
      this.inFlight.set(m.id, { message: m, deliveredAt });
    }
    return taken;
  }

  async ack(message: QueueMessage): Promise<void> {
    this.inFlight.delete(message.id);
  }
}
