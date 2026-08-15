import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { Storage } from './types.js';

export class LocalStorage implements Storage {
  constructor(private root: string) {}

  private resolve(key: string): string {
    const full = path.resolve(this.root, key);
    const rootAbs = path.resolve(this.root);
    if (full !== rootAbs && !full.startsWith(rootAbs + path.sep)) {
      throw new Error(`invalid key: ${key}`);
    }
    return full;
  }

  async put(key: string, body: Readable, _contentType: string): Promise<{ bytes: number }> {
    const full = this.resolve(key);
    await mkdir(path.dirname(full), { recursive: true });
    let bytes = 0;
    body.on('data', (c: Buffer) => { bytes += c.length; });
    await pipeline(body, createWriteStream(full));
    return { bytes };
  }

  async getReadUrl(key: string): Promise<string> {
    return `/assets/${key}`;
  }

  async exists(key: string): Promise<boolean> {
    const full = this.resolve(key);
    try { await stat(full); return true; } catch { return false; }
  }
}
