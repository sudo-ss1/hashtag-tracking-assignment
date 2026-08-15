import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Pin the local drivers for tests regardless of what .env selects. Without
    // this the suite's behaviour depends on whether the developer happens to
    // have AWS configured — e.g. assetUrl assertions would see a presigned S3
    // URL instead of the local /assets/<key> path. Tests must not require, or
    // reach, real cloud resources. dotenv does not override existing env vars,
    // so these win over .env.
    env: {
      QUEUE_DRIVER: 'memory',
      STORAGE_DRIVER: 'local',
    },
  },
});
