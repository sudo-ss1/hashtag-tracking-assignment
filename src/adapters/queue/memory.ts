import type { Queue, QueueEntry, QueueMessage, JobName } from './types.js';

export class InMemoryQueue implements Queue {
  private messages: QueueMessage[] = [];
  private seq = 0;

  async enqueue(job: JobName, payload: unknown): Promise<void> {
    this.messages.push({ id: String(++this.seq), job, payload });
  }

  async enqueueBatch(entries: QueueEntry[]): Promise<void> {
    for (const e of entries) await this.enqueue(e.job, e.payload);
  }

  async receive(max: number): Promise<QueueMessage[]> {
    return this.messages.splice(0, max);
  }

  async ack(_message: QueueMessage): Promise<void> {
    // receive() already removed it; nothing to do.
  }
}
