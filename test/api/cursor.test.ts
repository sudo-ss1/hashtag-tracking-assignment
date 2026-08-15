import { describe, it, expect } from 'vitest';
import { encodeCursor, decodeCursor } from '../../src/api/cursor.js';

describe('cursor', () => {
  it('round-trips a timestamp and id', () => {
    const ts = new Date('2026-08-13T15:13:39.000Z');
    const decoded = decodeCursor(encodeCursor(ts, 4242));
    expect(decoded.ts.toISOString()).toBe(ts.toISOString());
    expect(decoded.id).toBe(4242);
  });

  it('rejects a malformed cursor', () => {
    expect(() => decodeCursor('not-base64!!')).toThrow();
    expect(() => decodeCursor(Buffer.from('garbage').toString('base64url'))).toThrow();
  });

  it('rejects an out-of-range id beyond Postgres bigint bounds', () => {
    const raw = Buffer.from('2026-01-01T00:00:00.000Z|99999999999999999999').toString('base64url');
    expect(() => decodeCursor(raw)).toThrow();
  });
});
