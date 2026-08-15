export type JobName = 'SYNC_TOP_MEDIA' | 'SYNC_RECENT_MEDIA' | 'DOWNLOAD_ASSET';

export type QueueMessage = {
  id: string;
  job: JobName;
  payload: unknown;
  receipt?: string;
};

export type QueueEntry = { job: JobName; payload: unknown };

export interface Queue {
  enqueue(job: JobName, payload: unknown): Promise<void>;
  enqueueBatch(entries: QueueEntry[]): Promise<void>;
  receive(max: number): Promise<QueueMessage[]>;
  ack(message: QueueMessage): Promise<void>;
}
