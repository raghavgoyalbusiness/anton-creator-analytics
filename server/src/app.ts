import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { loadEnv } from './config/env.js';
import { errorHandler } from './lib/errors.js';
import { creatorRouter } from './routes/creator.js';
import { operatorAuthRouter } from './routes/operator-auth.js';
import { operatorQueueRouter } from './routes/operator-queue.js';
import { operatorRosterRouter } from './routes/operator-roster.js';
import { storageRouter } from './routes/storage.js';

export function createApp(): Express {
  const env = loadEnv();
  const app = express();

  // Behind one proxy in production; needed for req.ip to be the client's
  // address rather than the proxy's, which the consent IP hash depends on.
  app.set('trust proxy', env.NODE_ENV === 'production' ? 1 : false);

  app.use(
    helmet({
      // The API serves JSON and images, never HTML, so a restrictive default
      // CSP costs nothing here.
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  app.use(
    cors({
      origin: env.WEB_ORIGIN,
      // Sessions are cookie-backed, so the browser must be allowed to send
      // them. Origin is pinned to a single value — never a reflected wildcard,
      // which with credentials:true would let any site call this API as the user.
      credentials: true,
      allowedHeaders: ['content-type'],
    }),
  );

  app.use(cookieParser());

  /**
   * Brand share views must never be indexed. The header is the load-bearing
   * control — robots.txt is only a request — but both are set.
   */
  app.get('/robots.txt', (_req, res) => {
    res.type('text/plain').send('User-agent: *\nDisallow: /r/\nDisallow: /c/\nDisallow: /api/\n');
  });
  app.use((_req, res, next) => {
    res.setHeader('x-robots-tag', 'noindex, nofollow, noarchive');
    next();
  });

  // Mounted before the JSON parser: the upload route needs the raw body.
  if (env.STORAGE_DRIVER === 'local') {
    app.use('/api/storage', storageRouter);
  }

  app.use(express.json({ limit: '256kb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, storage: env.STORAGE_DRIVER, env: env.NODE_ENV });
  });

  app.use('/api/creator', creatorRouter);
  app.use('/api/operator/auth', operatorAuthRouter);
  app.use('/api/operator', operatorQueueRouter);
  app.use('/api/operator', operatorRosterRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'No such endpoint.' } });
  });

  app.use(errorHandler);
  return app;
}
