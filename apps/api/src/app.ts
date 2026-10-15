import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Ctx } from './context';
import { AppError } from './lib/errors';
import { SESSION_COOKIE } from './lib/http';
import { adminRoutes } from './routes/admin';
import { authRoutes } from './routes/auth';
import { carrierRoutes } from './routes/carrier';
import { miscRoutes } from './routes/misc';
import { shipperRoutes } from './routes/shipper';
import { operationsRoutes } from './routes/operations';
import { sessionFromToken } from './services/auth';
// Job handlers register themselves on import
import './services/booking';
import './services/payments';
import './services/trips';
import './services/payouts';
import './services/notifications';
import './services/invoices';

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function buildApp(
  ctx: Ctx,
  opts: { logger?: boolean; rateLimit?: boolean } = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true, bodyLimit: 1_000_000 });

  // Keep the raw body: payment webhooks are verified against the exact bytes received
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = body as string;
    if (!body) return done(null, {});
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(new AppError(400, 'bad_json', 'The request body is not valid JSON'), undefined);
    }
  });
  // Photos, signatures and PDFs arrive as raw bytes; their content is checked in saveFile
  app.addContentTypeParser(
    ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body),
  );
  // Zod does the validation; JSON schemas on routes are documentation only
  app.setValidatorCompiler(() => () => true);

  await app.register(cookie);
  // Other origins (e.g. the driver app's web build) may call the API with a bearer token only:
  // no cookies are accepted cross-origin, so the session cookie can never be used from another site.
  if (ctx.config.corsOrigins.length)
    await app.register(cors, {
      origin: ctx.config.corsOrigins,
      credentials: false,
      allowedHeaders: ['authorization', 'content-type', 'x-requested-with'],
    });
  // Off only in automated tests, where every request comes from one address (one test turns it on)
  if (opts.rateLimit ?? ctx.config.env !== 'test')
    await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  await app.register(swagger, {
    openapi: {
      info: {
        title: `${ctx.config.brand.name} API`,
        version: '0.1.0',
        description:
          'Session cookie authentication. Unsafe methods need the header x-requested-with.',
      },
    },
  });
  await app.register(swaggerUi, { routePrefix: '/api/docs' });

  app.decorateRequest('session', null);
  app.addHook('onRequest', async (req) => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : req.cookies[SESSION_COOKIE];
    req.session = token ? await sessionFromToken(ctx, token) : null;
    // CSRF: a cross-site form or script cannot add a custom header without CORS (which we do not allow)
    if (
      UNSAFE.has(req.method) &&
      !header &&
      req.url !== '/api/webhooks/payments' &&
      req.headers['x-requested-with'] !== 'freight'
    )
      throw new AppError(403, 'csrf', 'Missing request header');
  });
  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('X-Frame-Options', 'DENY');
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError)
      return reply
        .code(err.statusCode)
        .send({ error: err.code, message: err.message, details: err.details });
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode === 429)
      return reply
        .code(429)
        .send({ error: 'rate_limited', message: 'Too many requests. Wait a moment.' });
    if (e.statusCode && e.statusCode < 500)
      return reply.code(e.statusCode).send({ error: 'bad_request', message: e.message });
    req.log.error(err);
    ctx.log.error({
      msg: 'unhandled error',
      url: req.url,
      err: String(err),
      stack: (err as Error).stack,
    });
    return reply.code(500).send({
      error: 'server_error',
      message: 'Something went wrong on our side. Please try again.',
    });
  });

  authRoutes(app, ctx);
  shipperRoutes(app, ctx);
  carrierRoutes(app, ctx);
  adminRoutes(app, ctx);
  operationsRoutes(app, ctx);
  miscRoutes(app, ctx);
  return app;
}
