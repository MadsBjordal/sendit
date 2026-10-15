import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../context';
import { badRequest, unauthorised } from '../lib/errors';
import { doc, member, parse } from '../lib/http';
import { shipmentAccess } from '../services/access';
import {
  addDriver,
  assignDriver,
  assignOptions,
  driverInputSchema,
  listDrivers,
  updateDriver,
} from '../services/drivers';
import { FILE_KINDS, readFileFor, saveFile } from '../services/files';
import { listMessages, sendMessage } from '../services/messages';
import {
  carrierEarnings,
  payoutAccountSchema,
  payoutAccountView,
  retryFailedPayouts,
  setPayoutAccount,
} from '../services/payouts';
import {
  confirmDelivery,
  driverJobs,
  positionsSchema,
  recordPositions,
  recordTripEvent,
  tripEventSchema,
  tripView,
} from '../services/trips';

const uuid = z.object({ id: z.string().uuid() });

export function operationsRoutes(app: FastifyInstance, ctx: Ctx) {
  // ---- drivers (carrier)
  app.get('/api/carrier/drivers', { schema: { tags: ['carrier'] } }, async (req) => {
    const a = member(req, { kind: 'carrier' });
    return listDrivers(ctx, a.orgId);
  });
  app.post(
    '/api/carrier/drivers',
    {
      schema: {
        tags: ['carrier'],
        summary: 'Add a driver and invite them to the driver app',
        body: doc(driverInputSchema),
      },
    },
    async (req) => {
      const a = member(req, { kind: 'carrier', permission: 'fleet.manage' });
      return addDriver(ctx, a, parse(driverInputSchema, req.body));
    },
  );
  app.put('/api/carrier/drivers/:id', { schema: { tags: ['carrier'] } }, async (req) => {
    const a = member(req, { kind: 'carrier', permission: 'fleet.manage' });
    const { id } = parse(uuid, req.params);
    return updateDriver(
      ctx,
      a,
      id,
      parse(driverInputSchema.extend({ active: z.boolean() }), req.body),
    );
  });
  app.get(
    '/api/carrier/bookings/:id/assign-options',
    {
      schema: {
        tags: ['carrier'],
        summary: 'Drivers for a job, best first, with empty kilometres to the pickup',
      },
    },
    async (req) => {
      const a = member(req, { kind: 'carrier' });
      const { id } = parse(uuid, req.params);
      return assignOptions(ctx, a.orgId, id);
    },
  );
  app.post('/api/carrier/bookings/:id/assign', { schema: { tags: ['carrier'] } }, async (req) => {
    const a = member(req, { kind: 'carrier', permission: 'loads.accept' });
    const { id } = parse(uuid, req.params);
    const { driverId } = parse(z.object({ driverId: z.string().uuid() }), req.body);
    return assignDriver(ctx, a, id, driverId);
  });

  // ---- money for carriers
  app.get('/api/carrier/earnings', { schema: { tags: ['carrier'] } }, async (req) => {
    const a = member(req, { kind: ['carrier', 'customs_provider'], permission: 'finance.view' });
    return carrierEarnings(ctx, a.orgId);
  });
  app.get('/api/org/payout-account', { schema: { tags: ['organisation'] } }, async (req) => {
    const a = member(req, { kind: ['carrier', 'customs_provider'], permission: 'finance.view' });
    return payoutAccountView(ctx, a.orgId);
  });
  app.put(
    '/api/org/payout-account',
    {
      schema: {
        tags: ['organisation'],
        summary: 'Bank account for payouts (owners and admins only)',
        body: doc(payoutAccountSchema),
      },
    },
    async (req) => {
      const a = member(req, { kind: ['carrier', 'customs_provider'], permission: 'org.manage' });
      await setPayoutAccount(ctx, a, parse(payoutAccountSchema, req.body));
      await retryFailedPayouts(ctx, a.orgId);
      return { ok: true };
    },
  );

  // ---- driver app
  app.get(
    '/api/driver/jobs',
    { schema: { tags: ['driver'], summary: 'Jobs assigned to the logged-in driver' } },
    async (req) => {
      if (!req.session) throw unauthorised();
      return driverJobs(ctx, req.session);
    },
  );
  app.post(
    '/api/shipments/:id/trip-events',
    {
      schema: {
        tags: ['driver'],
        summary: 'Record arrival, loading, departure, border, delay or delivery',
        body: doc(tripEventSchema),
      },
    },
    async (req, reply) => {
      const { id } = parse(uuid, req.params);
      const res = await recordTripEvent(ctx, req.session!, id, parse(tripEventSchema, req.body));
      if (!res.duplicate) reply.code(201);
      return res;
    },
  );
  app.post(
    '/api/shipments/:id/positions',
    {
      schema: {
        tags: ['driver'],
        summary: 'Batch of positions (only while the job is active)',
        body: doc(positionsSchema),
      },
    },
    async (req) => {
      const { id } = parse(uuid, req.params);
      return recordPositions(ctx, req.session!, id, parse(positionsSchema, req.body));
    },
  );

  // ---- everyone with access to the shipment
  app.get(
    '/api/shipments/:id/trip',
    {
      schema: {
        tags: ['shipments'],
        summary: 'Progress, last position, estimated arrival and evidence',
      },
    },
    async (req) => {
      const { id } = parse(uuid, req.params);
      return tripView(ctx, req.session!, id);
    },
  );
  app.post(
    '/api/shipments/:id/confirm-delivery',
    {
      schema: {
        tags: ['shipper'],
        summary: 'Accept the delivery (else accepted automatically after the period)',
      },
    },
    async (req) => {
      const { id } = parse(uuid, req.params);
      if (!req.session) throw unauthorised();
      await confirmDelivery(ctx, req.session, id);
      return { ok: true };
    },
  );
  app.get('/api/shipments/:id/messages', { schema: { tags: ['shipments'] } }, async (req) => {
    const { id } = parse(uuid, req.params);
    if (!req.session) throw unauthorised();
    return listMessages(ctx, req.session, id);
  });
  app.post('/api/shipments/:id/messages', { schema: { tags: ['shipments'] } }, async (req) => {
    const { id } = parse(uuid, req.params);
    if (!req.session) throw unauthorised();
    const input = parse(
      z.object({
        body: z.string().trim().min(1).max(4000),
        fileId: z.string().uuid().nullable().optional(),
      }),
      req.body,
    );
    return sendMessage(ctx, req.session, id, input);
  });

  // ---- files: upload the raw bytes (Content-Type image/jpeg|png|webp or application/pdf)
  app.post(
    '/api/shipments/:id/files',
    {
      bodyLimit: 16_000_000,
      schema: { tags: ['files'], summary: 'Upload a photo, signature or document for a shipment' },
    },
    async (req) => {
      const { id } = parse(uuid, req.params);
      if (!req.session) throw unauthorised();
      const { kind, name } = parse(
        z.object({ kind: z.enum(FILE_KINDS), name: z.string().max(200).optional() }),
        req.query,
      );
      if (['pod', 'invoice', 'statement'].includes(kind))
        throw badRequest('file_kind', 'This kind of file is made by the platform');
      await shipmentAccess(ctx, req.session, id);
      if (!Buffer.isBuffer(req.body))
        throw badRequest('file_type', 'Send the file itself with its Content-Type');
      const f = await saveFile(ctx, ctx.db, {
        orgId: req.session.org?.id ?? null,
        shipmentId: id,
        kind,
        contentType: String(req.headers['content-type']).split(';')[0]!,
        data: req.body,
        fileName: name ?? null,
        uploadedBy: req.session.user.id,
      });
      return { id: f.id, kind: f.kind, contentType: f.contentType, sizeBytes: f.sizeBytes };
    },
  );
  // The same upload as JSON with base64 content, for mobile apps that cannot send raw bytes easily
  app.post(
    '/api/shipments/:id/files/base64',
    { bodyLimit: 22_000_000, schema: { tags: ['files'] } },
    async (req) => {
      const { id } = parse(uuid, req.params);
      if (!req.session) throw unauthorised();
      const input = parse(
        z.object({
          kind: z.enum(FILE_KINDS),
          contentType: z.string().max(100),
          data: z.string().min(4).max(21_000_000),
          name: z.string().max(200).optional(),
        }),
        req.body,
      );
      if (['pod', 'invoice', 'statement'].includes(input.kind))
        throw badRequest('file_kind', 'This kind of file is made by the platform');
      await shipmentAccess(ctx, req.session, id);
      const f = await saveFile(ctx, ctx.db, {
        orgId: req.session.org?.id ?? null,
        shipmentId: id,
        kind: input.kind,
        contentType: input.contentType,
        data: Buffer.from(input.data.replace(/^data:[^,]+,/, ''), 'base64'),
        fileName: input.name ?? null,
        uploadedBy: req.session.user.id,
      });
      return { id: f.id, kind: f.kind, contentType: f.contentType, sizeBytes: f.sizeBytes };
    },
  );

  app.get(
    '/api/files/:id',
    { schema: { tags: ['files'], summary: 'Download a file you may see' } },
    async (req, reply) => {
      const { id } = parse(uuid, req.params);
      const { file, data } = await readFileFor(ctx, req.session, id);
      reply.header('Content-Type', file.contentType);
      reply.header('Cache-Control', 'private, no-store');
      reply.header(
        'Content-Disposition',
        `${file.contentType === 'application/pdf' ? 'inline' : 'inline'}; filename="${(file.fileName ?? file.id).replace(/[^\w.-]/g, '_')}"`,
      );
      reply.header(
        'Content-Security-Policy',
        "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
      );
      return reply.send(data);
    },
  );
}
