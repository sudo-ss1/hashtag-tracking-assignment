import 'dotenv/config';
import { z } from 'zod';

const Schema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().default(3000),

  IG_ACCESS_TOKEN: z.string().min(1),
  IG_USER_ID: z.string().min(1),
  IG_API_VERSION: z.string().default('v25.0'),
  IG_GRAPH_BASE_URL: z.string().default('https://graph.facebook.com'),
  IG_PAGE_SIZE: z.coerce.number().int().min(1).max(50).default(9),

  SYNC_MAX_ITEMS: z.coerce.number().int().positive().default(500),
  SYNC_MAX_PAGES: z.coerce.number().int().positive().default(120),

  QUEUE_DRIVER: z.enum(['sqs', 'memory']).default('memory'),
  STORAGE_DRIVER: z.enum(['s3', 'local']).default('local'),

  AWS_REGION: z.string().default('ap-south-1'),
  SQS_QUEUE_URL: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_PREFIX: z.string().default('hashtag-media'),
  LOCAL_STORAGE_DIR: z.string().default('./storage'),
})
  .refine((v) => v.QUEUE_DRIVER !== 'sqs' || !!v.SQS_QUEUE_URL, {
    message: 'SQS_QUEUE_URL is required when QUEUE_DRIVER=sqs',
    path: ['SQS_QUEUE_URL'],
  })
  .refine((v) => v.STORAGE_DRIVER !== 's3' || !!v.S3_BUCKET, {
    message: 'S3_BUCKET is required when STORAGE_DRIVER=s3',
    path: ['S3_BUCKET'],
  });

export type Config = {
  databaseUrl: string;
  port: number;
  ig: { accessToken: string; userId: string; apiVersion: string; graphBaseUrl: string; pageSize: number };
  syncMaxItems: number;
  syncMaxPages: number;
  queueDriver: 'sqs' | 'memory';
  storageDriver: 's3' | 'local';
  sqs: { queueUrl?: string; region: string };
  s3: { bucket?: string; region: string; prefix: string };
  localStorageDir: string;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = Schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration — ${detail}`);
  }
  const e = parsed.data;
  return {
    databaseUrl: e.DATABASE_URL,
    port: e.PORT,
    ig: {
      accessToken: e.IG_ACCESS_TOKEN,
      userId: e.IG_USER_ID,
      apiVersion: e.IG_API_VERSION,
      graphBaseUrl: e.IG_GRAPH_BASE_URL,
      pageSize: e.IG_PAGE_SIZE,
    },
    syncMaxItems: e.SYNC_MAX_ITEMS,
    syncMaxPages: e.SYNC_MAX_PAGES,
    queueDriver: e.QUEUE_DRIVER,
    storageDriver: e.STORAGE_DRIVER,
    sqs: { queueUrl: e.SQS_QUEUE_URL, region: e.AWS_REGION },
    s3: { bucket: e.S3_BUCKET, region: e.AWS_REGION, prefix: e.S3_PREFIX },
    localStorageDir: e.LOCAL_STORAGE_DIR,
  };
}

export const config = loadConfig();

export function redact(s: string, token?: string): string {
  const secret = token ?? config.ig.accessToken;
  if (!secret) return s;
  return s.split(secret).join('***REDACTED***');
}
