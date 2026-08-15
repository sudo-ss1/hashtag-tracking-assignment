import { config } from '../../config/index.js';
import { LocalStorage } from './local.js';
import { S3Storage } from './s3.js';
import type { Storage } from './types.js';

export function createStorage(): Storage {
  return config.storageDriver === 's3'
    ? new S3Storage()
    : new LocalStorage(config.localStorageDir);
}

export * from './types.js';
