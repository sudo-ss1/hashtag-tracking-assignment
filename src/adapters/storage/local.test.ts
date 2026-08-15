import { describe, it, expect, afterAll } from 'vitest';
import { Readable } from 'node:stream';
import { rm } from 'node:fs/promises';
import { LocalStorage } from './local.js';

const dir = './.tmp-storage-test';
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

describe('LocalStorage', () => {
  it('writes a nested key and reports byte count', async () => {
    const s = new LocalStorage(dir);
    const res = await s.put('media/abc/1.jpg', Readable.from([Buffer.from('hello')]), 'image/jpeg');
    expect(res.bytes).toBe(5);
    expect(await s.exists('media/abc/1.jpg')).toBe(true);
  });

  it('reports a missing key as absent', async () => {
    const s = new LocalStorage(dir);
    expect(await s.exists('media/nope.jpg')).toBe(false);
  });

  it('rejects keys that escape the storage root', async () => {
    const s = new LocalStorage(dir);
    await expect(s.exists('../../etc/passwd')).rejects.toThrow(/invalid key/i);
  });
});
