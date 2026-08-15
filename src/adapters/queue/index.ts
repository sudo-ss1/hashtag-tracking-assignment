import { config } from '../../config/index.js';
import { InMemoryQueue } from './memory.js';
import { SqsQueue } from './sqs.js';
import type { Queue } from './types.js';

export function createQueue(): Queue {
  return config.queueDriver === 'sqs' ? new SqsQueue() : new InMemoryQueue();
}

export * from './types.js';
