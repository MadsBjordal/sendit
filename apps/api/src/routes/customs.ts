import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context';
import { unauthorised } from '../lib/errors';
import { doc, member, parse } from '../lib/http';
import * as customs from '../services/customs';

const uuid = z.object({ id: z.string().uuid() });

export function customsRoutes(app: FastifyInstance, ctx: Ctx) {
  const tags = ['customs'];
  // ---- customer and everyone with access to the shipment
  app.get(
    '/api/shipments/:id/customs',
    { schema: { tags, summary: 'Customs procedures, parties, documents, jobs and readiness' } },
    async (req) => {
      if (!req.session) throw unauthorised();
      return customs.customsOverview(ctx, req.session, parse(uuid, req.params).id);
    },
  );
  app.get(
    '/api/shipments/:id/border-readiness',
    { schema: { tags, summary: 'For the driver: ready for the border, references, contacts' } },
    async (req) => {
      if (!req.session) throw unauthorised();
      return customs.borderReadinessView(ctx, req.session, parse(uuid, req.params).id);
    },
  );
  app.post(
    '/api/shipments/:id/customs/parties',
    {
      schema: {
        tags,
        summary: 'Name who is responsible for a customs role',
        body: doc(customs.partyInputSchema),
      },
    },
    async (req) => {
      if (!req.session) throw unauthorised();
      await customs.setParty(
        ctx,
        req.session,
        parse(uuid, req.params).id,
        parse(customs.partyInputSchema, req.body),
      );
      return { ok: true };
    },
  );
  app.post(
    '/api/shipments/:id/customs/documents',
    {
      bodyLimit: 22_000_000,
      schema: { tags, summary: 'Add a customs document (a new version replaces the old one)' },
    },
    async (req) => {
      if (!req.session) throw unauthorised();
      return customs.uploadCustomsDocument(
        ctx,
        req.session,
        parse(uuid, req.params).id,
        parse(customs.customsDocumentSchema, req.body),
      );
    },
  );
  app.post(
    '/api/customs/procedures/:id/arrange',
    {
      schema: {
        tags,
        summary: 'Choose how a customs step is handled',
        body: doc(customs.arrangeSchema),
      },
    },
    async (req) => {
      if (!req.session) throw unauthorised();
      return customs.arrange(
        ctx,
        req.session,
        parse(uuid, req.params).id,
        parse(customs.arrangeSchema, req.body),
      );
    },
  );
  app.post(
    '/api/customs/procedures/:id/status',
    {
      schema: {
        tags,
        summary: 'Handler moves a customs step forward',
        body: doc(customs.procedureUpdateSchema),
      },
    },
    async (req) => {
      if (!req.session) throw unauthorised();
      await customs.updateProcedure(
        ctx,
        req.session,
        parse(uuid, req.params).id,
        parse(customs.procedureUpdateSchema, req.body),
      );
      return { ok: true };
    },
  );
  app.post('/api/customs/quotes/:id/approve', { schema: { tags } }, async (req) => {
    if (!req.session) throw unauthorised();
    return customs.approveCustomsQuote(ctx, req.session, parse(uuid, req.params).id);
  });

  // ---- confirmation link for a named party (no login: the token is the proof)
  app.get('/api/customs/confirm', { schema: { tags } }, async (req) => {
    const { token } = parse(z.object({ token: z.string().min(10) }), req.query);
    return customs.partyForToken(ctx, token);
  });
  app.post(
    '/api/customs/confirm',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, schema: { tags } },
    async (req) => {
      const { token, name } = parse(
        z.object({ token: z.string().min(10), name: z.string().trim().min(2).max(200) }),
        req.body,
      );
      return customs.acknowledgeParty(ctx, token, name);
    },
  );

  // ---- customs providers
  app.get('/api/customs-provider/profile', { schema: { tags } }, async (req) => {
    const a = member(req, { kind: 'customs_provider' });
    return customs.providerProfile(ctx, a.orgId);
  });
  app.put(
    '/api/customs-provider/profile',
    { schema: { tags, body: doc(customs.providerProfileSchema) } },
    async (req) => {
      const a = member(req, { kind: 'customs_provider', permission: 'org.manage' });
      await customs.setProviderProfile(ctx, a, parse(customs.providerProfileSchema, req.body));
      return { ok: true };
    },
  );
  app.get(
    '/api/customs-provider/jobs/open',
    { schema: { tags, summary: 'Open customs jobs I could take' } },
    async (req) => {
      const a = member(req, { kind: 'customs_provider' });
      return customs.openCustomsJobs(ctx, a.orgId);
    },
  );
  app.get(
    '/api/customs-provider/jobs',
    { schema: { tags, summary: 'My customs jobs' } },
    async (req) => {
      const a = member(req, { kind: 'customs_provider' });
      return customs.myCustomsJobs(ctx, a.orgId);
    },
  );
  app.post(
    '/api/customs-provider/jobs/:id/accept',
    {
      schema: {
        tags,
        summary: 'Take a customs job (first qualified within the budget wins) or quote',
        body: doc(customs.customsAcceptSchema),
      },
    },
    async (req, reply) => {
      member(req, { kind: 'customs_provider', permission: 'loads.accept' });
      const res = await customs.acceptCustomsJob(
        ctx,
        req.session!,
        parse(uuid, req.params).id,
        parse(customs.customsAcceptSchema, req.body ?? {}),
      );
      if (res.result === 'already_assigned') reply.code(409);
      else if (res.result === 'not_available' || res.result === 'not_eligible') reply.code(422);
      return res;
    },
  );
}
