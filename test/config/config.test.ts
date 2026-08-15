import { describe, it, expect } from 'vitest';
import { loadConfig, redact } from '../../src/config/index.js';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  IG_ACCESS_TOKEN: 'tok',
  IG_USER_ID: '123',
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig(base);
    expect(c.ig.apiVersion).toBe('v25.0');
    expect(c.ig.pageSize).toBe(9);
    expect(c.queueDriver).toBe('memory');
  });

  it('throws when a required var is missing', () => {
    expect(() => loadConfig({ ...base, IG_ACCESS_TOKEN: undefined })).toThrow(/IG_ACCESS_TOKEN/);
  });

  it('requires SQS_QUEUE_URL when the sqs driver is selected', () => {
    expect(() => loadConfig({ ...base, QUEUE_DRIVER: 'sqs' })).toThrow(/SQS_QUEUE_URL/);
  });

  it('requires S3_BUCKET when the s3 driver is selected', () => {
    expect(() => loadConfig({ ...base, STORAGE_DRIVER: 's3' })).toThrow(/S3_BUCKET/);
  });
});

describe('redact', () => {
  it('masks an access token appearing anywhere in a string', () => {
    expect(redact('failed: access_token=SECRET123&x=1', 'SECRET123'))
      .toBe('failed: access_token=***REDACTED***&x=1');
  });
});
