import { describe, it, expect, afterAll } from 'vitest';
import { Readable } from 'node:stream';
import { rm } from 'node:fs/promises';
import { LocalStorage } from '../../../src/adapters/storage/local.js';

const dir = './.tmp-storage-test';
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

describe('LocalStorage', () => {
  it('writes a nested key and reports byte count', async () => {
    const s = new LocalStorage(dir);
    const res = await s.put('media/abc/1.jpg', Readable.from([Buffer.from('hello')]), 'image/jpeg');
    expect(res.bytes).toBe(5);
  });

  it('rejects keys that escape the storage root', async () => {
    const s = new LocalStorage(dir);
    await expect(s.put('../../etc/passwd', Readable.from([Buffer.from('x')]), 'text/plain'))
      .rejects.toThrow(/invalid key/i);
  });

  it('rejects absolute-path keys', async () => {
    const s = new LocalStorage(dir);
    await expect(s.put('/etc/passwd', Readable.from([Buffer.from('x')]), 'text/plain'))
      .rejects.toThrow(/invalid key/i);
  });
});
