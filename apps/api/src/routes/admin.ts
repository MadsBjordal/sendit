import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PricingConfig } from '@freight/shared';
import type { Ctx } from '../context';
import { parse, staff } from '../lib/http';
import * as admin from '../services/admin';

export function adminRoutes(app: FastifyInstance, ctx: Ctx) {
  const tags = ['admin'];
  app.get('/api/admin/organisations', { schema: { tags } }, async (req) => {
    staff(req, 'orgs.review');
    const { status } = parse(z.object({ status: z.string().optional() }), req.query);
    return admin.listOrganisations(ctx, status);
  });
  app.post('/api/admin/organisations/:id/decision', { schema: { tags } }, async (req) => {
    const a = staff(req, 'orgs.review');
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const input = parse(
      z.object({
        decision: z.enum(['verified', 'rejected', 'suspended']),
        note: z.string().max(1000).nullable().default(null),
      }),
      req.body,
    );
    await admin.decideOrganisation(ctx, a, id, input.decision, input.note);
    return { ok: true };
  });
  app.post('/api/admin/documents/:id/review', { schema: { tags } }, async (req) => {
    const a = staff(req, 'orgs.review');
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const input = parse(
      z.object({
        decision: z.enum(['approved', 'rejected']),
        note: z.string().max(1000).nullable().default(null),
      }),
      req.body,
    );
    await admin.reviewDocument(ctx, a, id, input.decision, input.note);
    return { ok: true };
  });
  app.get('/api/admin/countries', { schema: { tags } }, async (req) => {
    staff(req, 'countries.manage');
    return admin.listCountries(ctx);
  });
  app.put(
    '/api/admin/countries/:code',
    {
      schema: { tags, summary: 'Open or close a country (only after legal review: COMPLIANCE.md)' },
    },
    async (req) => {
      const a = staff(req, 'countries.manage');
      const { code } = parse(z.object({ code: z.string().regex(/^[A-Z]{2}$/) }), req.params);
      const input = parse(
        z.object({
          enabled: z.boolean(),
          domesticEnabled: z.boolean(),
          note: z.string().max(1000).nullable().default(null),
        }),
        req.body,
      );
      await admin.setCountry(ctx, a, code, input);
      return { ok: true };
    },
  );
  app.get('/api/admin/pricing', { schema: { tags } }, async (req) => {
    staff(req, 'pricing.manage');
    return admin.listPricing(ctx);
  });
  app.post('/api/admin/pricing', { schema: { tags } }, async (req) => {
    const a = staff(req, 'pricing.manage');
    const input = parse(
      z.object({
        config: z.record(z.unknown()),
        activate: z.boolean().default(false),
        note: z.string().max(1000).nullable().default(null),
      }),
      req.body,
    );
    await admin.createPricing(
      ctx,
      a,
      input.config as unknown as PricingConfig,
      input.activate,
      input.note,
    );
    return { ok: true };
  });
  app.post('/api/admin/pricing/:version/activate', { schema: { tags } }, async (req) => {
    const a = staff(req, 'pricing.manage');
    const { version } = parse(z.object({ version: z.string().min(1) }), req.params);
    await admin.activatePricing(ctx, a, version);
    return { ok: true };
  });
  app.get('/api/admin/shipments', { schema: { tags } }, async (req) => {
    staff(req, 'shipments.view');
    return admin.shipmentsOverview(ctx);
  });
  app.get('/api/admin/ledger', { schema: { tags } }, async (req) => {
    staff(req, 'finance.view');
    return admin.ledgerSummary(ctx);
  });
  app.get('/api/admin/audit', { schema: { tags } }, async (req) => {
    staff(req, 'audit.view');
    return admin.auditTrail(ctx);
  });
  app.get('/api/admin/jobs', { schema: { tags } }, async (req) => {
    staff(req, 'jobs.view');
    return admin.problemJobs(ctx);
  });
}
