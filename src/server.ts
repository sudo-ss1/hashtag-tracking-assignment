import express from 'express';
import path from 'node:path';
import { config } from './config/index.js';
import { hashtagsRouter } from './api/hashtags.routes.js';
import { BadRequestError } from './api/errors.js';

export function buildApp() {
  const app = express();

  app.get('/health', (_req, res) => { res.json({ ok: true }); });
  app.use(hashtagsRouter());

  // Serves assets written by the local storage driver.
  if (config.storageDriver === 'local') {
    app.use('/assets', express.static(path.resolve(config.localStorageDir)));
  }

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = err instanceof BadRequestError ? 400 : 500;
    if (status === 500) console.error('[api]', err);
    res.status(status).json({ error: status === 400 ? err.message : 'internal server error' });
  });

  return app;
}

if (process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
  buildApp().listen(config.port, () => console.log(`[api] listening on :${config.port}`));
}
