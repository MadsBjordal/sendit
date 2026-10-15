import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context';
import { unauthorised } from '../lib/errors';
import { doc, parse, staff } from '../lib/http';
import { analytics, analyticsCsv, analyticsXlsx } from '../services/analytics';
import {
  disputesOf,
  listDisputes,
  openDispute,
  openDisputeSchema,
  resolveDispute,
  resolveDisputeSchema,
} from '../services/disputes';
import { listAlerts, reviewAlert } from '../services/fraud';
import {
  handleErasure,
  listPrivacyRequests,
  requestErasure,
  requestExport,
} from '../services/privacy';
import {
  createTicket,
  listTickets,
  replyTicket,
  ticketDetail,
  ticketSchema,
} from '../services/support';

const uuid = z.object({ id: z.string().uuid() });

export function serviceRoutes(app: FastifyInstance, ctx: Ctx) {
  // ---- disputes
  app.post(
    '/api/shipments/:id/disputes',
    {
      schema: {
        tags: ['disputes'],
        summary: 'Report a problem with a delivery (holds the payout)',
        body: doc(openDisputeSchema),
      },
    },
    async (req) => {
      if (!req.session) throw unauthorised();
      return openDispute(
        ctx,
        req.session,
        parse(uuid, req.params).id,
        parse(openDisputeSchema, req.body),
      );
    },
  );
  app.get('/api/shipments/:id/disputes', { schema: { tags: ['disputes'] } }, async (req) => {
    if (!req.session) throw unauthorised();
    return disputesOf(ctx, req.session, parse(uuid, req.params).id);
  });
  app.get('/api/admin/disputes', { schema: { tags: ['admin'] } }, async (req) => {
    staff(req, 'disputes.resolve');
    const { status } = parse(z.object({ status: z.string().optional() }), req.query);
    return listDisputes(ctx, status);
  });
  app.post(
    '/api/admin/disputes/:id/resolve',
    { schema: { tags: ['admin'], body: doc(resolveDisputeSchema) } },
    async (req) => {
      const a = staff(req, 'disputes.resolve');
      await resolveDispute(
        ctx,
        a,
        parse(uuid, req.params).id,
        parse(resolveDisputeSchema, req.body),
      );
      return { ok: true };
    },
  );

  // ---- support
  app.post(
    '/api/support/tickets',
    { schema: { tags: ['support'], body: doc(ticketSchema) } },
    async (req) => {
      if (!req.session) throw unauthorised();
      return createTicket(ctx, req.session, parse(ticketSchema, req.body));
    },
  );
  app.get('/api/support/tickets', { schema: { tags: ['support'] } }, async (req) => {
    if (!req.session) throw unauthorised();
    if (req.session.user.platformRole) staff(req, 'support.reply');
    const { status } = parse(z.object({ status: z.string().optional() }), req.query);
    return listTickets(ctx, req.session, status);
  });
  app.get('/api/support/tickets/:id', { schema: { tags: ['support'] } }, async (req) => {
    if (!req.session) throw unauthorised();
    return ticketDetail(ctx, req.session, parse(uuid, req.params).id);
  });
  app.post('/api/support/tickets/:id/reply', { schema: { tags: ['support'] } }, async (req) => {
    if (!req.session) throw unauthorised();
    if (req.session.user.platformRole) staff(req, 'support.reply');
    const input = parse(
      z.object({ body: z.string().trim().min(1).max(8000), close: z.boolean().default(false) }),
      req.body,
    );
    await replyTicket(ctx, req.session, parse(uuid, req.params).id, input.body, input.close);
    return { ok: true };
  });

  // ---- privacy (GDPR)
  app.get(
    '/api/me/data-export',
    { schema: { tags: ['privacy'], summary: 'A copy of my personal data (JSON)' } },
    async (req, reply) => {
      if (!req.session) throw unauthorised();
      const data = await requestExport(ctx, req.session);
      reply.header('Content-Disposition', 'attachment; filename="my-data.json"');
      reply.header('Cache-Control', 'no-store');
      return data;
    },
  );
  app.post(
    '/api/me/erasure-request',
    { schema: { tags: ['privacy'], summary: 'Ask for my personal data to be erased' } },
    async (req) => {
      if (!req.session) throw unauthorised();
      const { note } = parse(
        z.object({ note: z.string().max(2000).nullable().default(null) }),
        req.body ?? {},
      );
      return requestErasure(ctx, req.session, note);
    },
  );
  app.get('/api/admin/privacy-requests', { schema: { tags: ['admin'] } }, async (req) => {
    staff(req, 'privacy.handle');
    return listPrivacyRequests(ctx);
  });
  app.post('/api/admin/privacy-requests/:id', { schema: { tags: ['admin'] } }, async (req) => {
    const a = staff(req, 'privacy.handle');
    const input = parse(
      z.object({
        decision: z.enum(['completed', 'rejected']),
        note: z.string().max(2000).nullable().default(null),
      }),
      req.body,
    );
    await handleErasure(ctx, a, parse(uuid, req.params).id, input.decision, input.note);
    return { ok: true };
  });

  // ---- fraud
  app.get('/api/admin/fraud-alerts', { schema: { tags: ['admin'] } }, async (req) => {
    staff(req, 'fraud.review');
    const { status } = parse(
      z.object({ status: z.enum(['open', 'dismissed', 'confirmed']).default('open') }),
      req.query,
    );
    return listAlerts(ctx, status);
  });
  app.post('/api/admin/fraud-alerts/:id/review', { schema: { tags: ['admin'] } }, async (req) => {
    const a = staff(req, 'fraud.review');
    const input = parse(
      z.object({
        decision: z.enum(['dismissed', 'confirmed']),
        note: z.string().max(2000).nullable().default(null),
        suspend: z.boolean().default(false),
      }),
      req.body,
    );
    await reviewAlert(
      ctx,
      a,
      parse(uuid, req.params).id,
      input.decision,
      input.note,
      input.suspend,
    );
    return { ok: true };
  });

  // ---- analytics
  app.get(
    '/api/admin/analytics',
    { schema: { tags: ['admin'], summary: 'Platform analytics; format=csv or xlsx downloads it' } },
    async (req, reply) => {
      staff(req, 'analytics.view');
      const q = parse(
        z.object({
          from: z.string().date(),
          to: z.string().date(),
          country: z
            .string()
            .regex(/^[A-Z]{2}$/)
            .optional(),
          format: z.enum(['json', 'csv', 'xlsx']).default('json'),
        }),
        req.query,
      );
      const report = await analytics(ctx, q);
      if (q.format === 'csv') {
        reply
          .header('Content-Type', 'text/csv; charset=utf-8')
          .header('Content-Disposition', `attachment; filename="analytics-${q.from}-${q.to}.csv"`);
        return analyticsCsv(report);
      }
      if (q.format === 'xlsx') {
        reply
          .header(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          )
          .header('Content-Disposition', `attachment; filename="analytics-${q.from}-${q.to}.xlsx"`);
        return reply.send(await analyticsXlsx(report));
      }
      return report;
    },
  );
}
