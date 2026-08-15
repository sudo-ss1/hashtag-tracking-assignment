import { S3Client, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import type { Storage } from './types.js';
import { config } from '../../config/index.js';

const PRESIGN_TTL_SECONDS = 3600;

export class S3Storage implements Storage {
  private client = new S3Client({ region: config.s3.region });
  private bucket = config.s3.bucket!;

  async put(key: string, body: Readable, contentType: string): Promise<{ bytes: number }> {
    let bytes = 0;
    body.on('data', (c: Buffer) => { bytes += c.length; });
    // Upload handles multipart for unknown-length streams; PutObject alone requires a length.
    const upload = new Upload({
      client: this.client,
      params: { Bucket: this.bucket, Key: key, Body: body, ContentType: contentType },
    });
    await upload.done();
    return { bytes };
  }

  async getReadUrl(key: string): Promise<string> {
    // Presigned so the bucket can stay private.
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: PRESIGN_TTL_SECONDS,
    });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch { return false; }
  }
}
