import { SQSClient, SendMessageCommand, SendMessageBatchCommand, ReceiveMessageCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';
import type { Queue, QueueEntry, QueueMessage, JobName } from './types.js';
import { config } from '../../config/index.js';

const SQS_BATCH_LIMIT = 10;

export class SqsQueue implements Queue {
  private client = new SQSClient({ region: config.sqs.region });
  private queueUrl = config.sqs.queueUrl!;

  async enqueue(job: JobName, payload: unknown): Promise<void> {
    await this.client.send(new SendMessageCommand({
      QueueUrl: this.queueUrl,
      MessageBody: JSON.stringify({ job, payload }),
    }));
  }

  async enqueueBatch(entries: QueueEntry[]): Promise<void> {
    for (let i = 0; i < entries.length; i += SQS_BATCH_LIMIT) {
      const chunk = entries.slice(i, i + SQS_BATCH_LIMIT);
      const res = await this.client.send(new SendMessageBatchCommand({
        QueueUrl: this.queueUrl,
        Entries: chunk.map((e, idx) => ({
          Id: `m-${i + idx}`,
          MessageBody: JSON.stringify({ job: e.job, payload: e.payload }),
        })),
      }));
      if (res.Failed?.length) {
        throw new Error(`SQS batch partially failed: ${res.Failed.map((f) => f.Message).join(', ')}`);
      }
    }
  }

  async receive(max: number): Promise<QueueMessage[]> {
    const res = await this.client.send(new ReceiveMessageCommand({
      QueueUrl: this.queueUrl,
      MaxNumberOfMessages: Math.min(max, SQS_BATCH_LIMIT),
      WaitTimeSeconds: 10,
    }));
    return (res.Messages ?? []).map((m) => {
      const body = JSON.parse(m.Body!);
      return { id: m.MessageId!, job: body.job, payload: body.payload, receipt: m.ReceiptHandle! };
    });
  }

  async ack(message: QueueMessage): Promise<void> {
    await this.client.send(new DeleteMessageCommand({
      QueueUrl: this.queueUrl,
      ReceiptHandle: message.receipt!,
    }));
  }
}
