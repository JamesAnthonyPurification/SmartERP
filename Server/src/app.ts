import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { loadAuth } from './auth/context';
import { config } from './config';
import { appPool } from './db/pool';
import { forbidden, fromPgError, HttpError } from './lib/errors';
import { formatZodError } from './lib/validate';
import adminRoutes from './routes/admin';
import authRoutes from './routes/auth';
import catalogRoutes from './routes/catalog';
import financeRoutes from './routes/finance';
import hrRoutes from './routes/hr';
import inventoryRoutes from './routes/inventory';
import partyRoutes from './routes/parties';
import platformRoutes from './routes/platform';
import reportRoutes from './routes/reports';
import salesRoutes from './routes/sales';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function buildApp(opts: { logger?: boolean } = {}) {
  const app = Fastify({
    logger: opts.logger ?? (!config.isTest ? { level: config.isProd ? 'info' : 'warn' } : false),
    trustProxy: config.trustProxy,
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: config.isProd
      ? // Shops often run on a LAN over plain HTTP; only force HTTPS sub-resources when HTTPS is configured.
        { directives: { upgradeInsecureRequests: config.cookieSecure ? [] : null } }
      : false,
    strictTransportSecurity: config.cookieSecure,
  });
  await app.register(rateLimit, { global: false });

  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    // Cookie auth + JSON bodies + SameSite=Lax already block CSRF; this rejects
    // any cross-origin state-changing request outright as defence in depth.
    if (!SAFE_METHODS.has(req.method) && req.headers.origin) {
      const host = req.headers['x-forwarded-host'] ?? req.headers.host;
      let originHost = '';
      try {
        originHost = new URL(req.headers.origin).host;
      } catch {
        /* invalid origin */
      }
      if (originHost !== host) throw forbidden('Cross-origin request blocked');
    }
    req.auth = await loadAuth(req);
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: 'validation', message: formatZodError(err), issues: err.issues });
    }
    const mapped = typeof err.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code) ? fromPgError(err) : null;
    if (mapped) {
      if (mapped.statusCode === 403) req.log.warn({ err }, 'database denied access');
      return reply.status(mapped.statusCode).send({ error: mapped.code, message: mapped.message });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: 'request', message: err.message });
    }
    req.log.error(err);
    return reply.status(500).send({ error: 'internal', message: 'Something went wrong. Please try again.' });
  });

  app.get('/api/health', async () => {
    await appPool.query('SELECT 1');
    return { ok: true, time: new Date().toISOString() };
  });

  await app.register(authRoutes);
  await app.register(platformRoutes);
  await app.register(adminRoutes);
  await app.register(catalogRoutes);
  await app.register(inventoryRoutes);
  await app.register(salesRoutes);
  await app.register(partyRoutes);
  await app.register(financeRoutes);
  await app.register(reportRoutes);
  await app.register(hrRoutes);

  // Serve the built web app (single-container deployment).
  if (fs.existsSync(path.join(config.webDist, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: config.webDist,
      cacheControl: false,
      // Hashed build assets can be cached forever; index.html must always revalidate.
      setHeaders: (res, filePath) =>
        res.setHeader('cache-control', filePath.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache'),
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.method !== 'GET') {
        return reply.status(404).send({ error: 'not_found', message: 'Not found' });
      }
      return reply.sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: 'not_found', message: 'Not found' }));
  }

  return app;
}
