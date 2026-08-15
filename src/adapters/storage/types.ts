import type { Readable } from 'node:stream';

export interface Storage {
  put(key: string, body: Readable, contentType: string): Promise<{ bytes: number }>;
  getReadUrl(key: string): Promise<string>;
  exists(key: string): Promise<boolean>;
}
