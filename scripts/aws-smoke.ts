import { Readable } from 'node:stream';
import { createQueue } from '../src/adapters/queue/index.js';
import { createStorage } from '../src/adapters/storage/index.js';
import { config } from '../src/config/index.js';

async function main() {
  const q = createQueue();
  const s = createStorage();
  console.log(`drivers: queue=${config.queueDriver} storage=${config.storageDriver} region=${config.s3.region}`);

  const key = `${config.s3.prefix}/_smoke-test.txt`;
  const put = await s.put(key, Readable.from([Buffer.from('smoke')]), 'text/plain');
  console.log(`S3  put        -> ${put.bytes} bytes at s3://${config.s3.bucket}/${key}`);

  const url = await s.getReadUrl(key);
  const host = new URL(url).host;
  console.log(`S3  presigned  -> host=${host} signed=${url.includes('X-Amz-Signature')}`);
  const got = await fetch(url);
  console.log(`S3  GET signed -> HTTP ${got.status} body="${(await got.text()).trim()}"`);

  await q.enqueue('DOWNLOAD_ASSET', { mediaId: -1 });
  console.log('SQS enqueue    -> sent');
  const msgs = await q.receive(10);
  console.log(`SQS receive    -> ${msgs.length} msg, payload=${JSON.stringify(msgs[0]?.payload)}`);
  for (const m of msgs) await q.ack(m);
  console.log(`SQS ack        -> deleted ${msgs.length}`);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
