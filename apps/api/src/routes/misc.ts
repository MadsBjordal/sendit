import type { FastifyInstance } from 'fastify';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../context';
import { notifications, users } from '../db/schema';
import { EMAIL_KINDS } from '../services/notifications';
import { AppError, badRequest, unauthorised } from '../lib/errors';
import { parse } from '../lib/http';
import { handleWebhook } from '../services/payments';
import { listCountries } from '../services/admin';

export function miscRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/api/health', { schema: { tags: ['platform'] } }, async () => {
    await ctx.db.execute('select 1' as never);
    return {
      ok: true,
      brand: ctx.config.brand.name,
      paymentProvider: ctx.config.paymentProvider,
      routing: ctx.config.routingProvider,
    };
  });

  app.get(
    '/api/countries',
    { schema: { tags: ['platform'], summary: 'Countries and whether they are open for business' } },
    async () => {
      const all = await listCountries(ctx);
      return all.map((c) => ({
        code: c.code,
        name: c.name,
        enabled: c.enabled,
        domesticEnabled: c.domesticEnabled,
      }));
    },
  );

  app.get(
    '/api/geo/search',
    { schema: { tags: ['platform'], summary: 'Address search (development: sample places only)' } },
    async (req) => {
      if (!req.session) throw unauthorised();
      const { q } = parse(z.object({ q: z.string().min(2).max(120) }), req.query);
      return ctx.geocoder.search(q);
    },
  );

  app.get('/api/notifications', { schema: { tags: ['platform'] } }, async (req) => {
    if (!req.session) throw unauthorised();
    return ctx.db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, req.session.user.id))
      .orderBy(desc(notifications.createdAt))
      .limit(50);
  });

  app.post('/api/notifications/read', { schema: { tags: ['platform'] } }, async (req) => {
    if (!req.session) throw unauthorised();
    await ctx.db
      .update(notifications)
      .set({ readAt: ctx.now() })
      .where(and(eq(notifications.userId, req.session.user.id), isNull(notifications.readAt)));
    return { ok: true };
  });

  app.get('/api/me/settings', { schema: { tags: ['platform'] } }, async (req) => {
    if (!req.session) throw unauthorised();
    const [u] = await ctx.db.select().from(users).where(eq(users.id, req.session.user.id));
    return {
      locale: u!.locale,
      notificationPrefs: u!.notificationPrefs,
      emailKinds: Object.keys(EMAIL_KINDS),
    };
  });

  app.put(
    '/api/me/settings',
    {
      schema: {
        tags: ['platform'],
        summary: 'Language and which notifications also come by email',
      },
    },
    async (req) => {
      if (!req.session) throw unauthorised();
      const input = parse(
        z.object({
          locale: z.enum(['en', 'de', 'pl', 'fr', 'es', 'it', 'nl']),
          notificationPrefs: z.record(
            z.enum(Object.keys(EMAIL_KINDS) as [string, ...string[]]),
            z.object({ email: z.boolean() }),
          ),
        }),
        req.body,
      );
      await ctx.db
        .update(users)
        .set({ locale: input.locale, notificationPrefs: input.notificationPrefs })
        .where(eq(users.id, req.session.user.id));
      return { ok: true };
    },
  );

  // Payment provider webhooks: no session, no CSRF header; the signature is the authentication
  app.post(
    '/api/webhooks/payments',
    { schema: { tags: ['payments'], summary: 'Payment provider webhook (signed)' } },
    async (req) => {
      const signature = req.headers['x-signature'];
      return handleWebhook(
        ctx,
        req.rawBody ?? '',
        typeof signature === 'string' ? signature : undefined,
      );
    },
  );

  // The simulated checkout. Exists only with the test provider, never in production.
  if (ctx.config.paymentProvider === 'test' && ctx.config.env !== 'production') {
    app.post(
      '/api/test-payments/:ref/complete',
      {
        schema: {
          tags: ['payments'],
          summary: 'TEST ONLY: simulate the customer paying (or the card failing)',
        },
      },
      async (req) => {
        if (!req.session) throw unauthorised();
        const { ref } = parse(z.object({ ref: z.string().startsWith('testpay_') }), req.params);
        const { outcome } = parse(z.object({ outcome: z.enum(['succeed', 'fail']) }), req.body);
        const { payments } = await import('../db/schema');
        const [p] = await ctx.db
          .select()
          .from(payments)
          .where(and(eq(payments.providerRef, ref), eq(payments.provider, 'test')));
        if (!p || req.session.org?.id !== p.orgId)
          throw new AppError(404, 'not_found', 'Not found');
        if (!ctx.payments.makeWebhook) throw badRequest('not_test', 'Not the test provider');
        const hook = ctx.payments.makeWebhook({
          id: `evt_${ref}_${outcome}`,
          type: outcome === 'succeed' ? 'payment.succeeded' : 'payment.failed',
          data: {
            providerRef: ref,
            amountMinor: p.amountMinor,
            currency: p.currency,
            reason: outcome === 'fail' ? 'card_declined (test)' : undefined,
          },
        });
        return handleWebhook(ctx, hook.body, hook.signature);
      },
    );
  }
}
