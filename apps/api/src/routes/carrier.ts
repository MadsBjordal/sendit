import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  acceptLoadSchema,
  countryCode,
  VERIFICATION_DOCUMENT_KINDS,
  vehicleInputSchema,
} from '@freight/shared';
import type { Ctx } from '../context';
import { doc, member, parse } from '../lib/http';
import { AppError } from '../lib/errors';
import {
  acceptLoad,
  carrierBookings,
  carrierOffers,
  loadBoard,
  withdrawOffer,
} from '../services/booking';
import {
  addVehicle,
  carrierProblems,
  listDocuments,
  listVehicles,
  removeVehicle,
  setOperatingCountries,
  submitDocument,
  updateVehicle,
} from '../services/carriers';
import { eq } from 'drizzle-orm';
import { organisations } from '../db/schema';

export function carrierRoutes(app: FastifyInstance, ctx: Ctx) {
  const uuidParam = z.object({ id: z.string().uuid() });

  app.get(
    '/api/carrier/profile',
    {
      schema: {
        tags: ['carrier'],
        summary: 'Verification state, documents and operating countries',
      },
    },
    async (req) => {
      const a = member(req, { kind: ['carrier', 'customs_provider'] });
      const [org] = await ctx.db.select().from(organisations).where(eq(organisations.id, a.orgId));
      const today = ctx.now().toISOString().slice(0, 10);
      const documents = await listDocuments(ctx.db, a.orgId);
      // Customs providers need an approved customs authorisation; carriers a licence and insurance
      const problems =
        org!.kind === 'customs_provider'
          ? [
              ...(org!.status !== 'verified'
                ? [{ code: 'carrier_not_verified', status: org!.status }]
                : []),
              ...(documents.some(
                (d) =>
                  d.kind === 'customs_authorisation' &&
                  d.status === 'approved' &&
                  (!d.validUntil || d.validUntil >= today),
              )
                ? []
                : [{ code: 'document_missing', kind: 'customs_authorisation' }]),
            ]
          : await carrierProblems(ctx.db, a.orgId, today);
      return {
        status: org!.status,
        statusNote: org!.statusNote,
        operatingCountries: org!.operatingCountries,
        documents,
        problems,
      };
    },
  );

  app.put('/api/carrier/operating-countries', { schema: { tags: ['carrier'] } }, async (req) => {
    const a = member(req, { kind: 'carrier', permission: 'fleet.manage' });
    const { countries } = parse(z.object({ countries: z.array(countryCode).max(60) }), req.body);
    return { countries: await setOperatingCountries(ctx, a, countries) };
  });

  app.post(
    '/api/carrier/documents',
    { schema: { tags: ['carrier'], summary: 'Submit a licence or insurance for verification' } },
    async (req) => {
      const a = member(req, { kind: ['carrier', 'customs_provider'], permission: 'org.manage' });
      const input = parse(
        z.object({
          kind: z.enum(VERIFICATION_DOCUMENT_KINDS),
          reference: z.string().trim().min(2).max(100),
          issuerCountry: countryCode.optional().nullable(),
          validFrom: z.string().date().optional().nullable(),
          validUntil: z.string().date().optional().nullable(),
        }),
        req.body,
      );
      return submitDocument(ctx, a, input);
    },
  );

  app.get('/api/carrier/vehicles', { schema: { tags: ['carrier'] } }, async (req) => {
    const a = member(req, { kind: 'carrier' });
    return listVehicles(ctx.db, a.orgId);
  });

  app.post(
    '/api/carrier/vehicles',
    { schema: { tags: ['carrier'], body: doc(vehicleInputSchema) } },
    async (req) => {
      const a = member(req, { kind: 'carrier', permission: 'fleet.manage' });
      return addVehicle(ctx, a, parse(vehicleInputSchema, req.body));
    },
  );

  app.put(
    '/api/carrier/vehicles/:id',
    { schema: { tags: ['carrier'], body: doc(vehicleInputSchema) } },
    async (req) => {
      const a = member(req, { kind: 'carrier', permission: 'fleet.manage' });
      const { id } = parse(uuidParam, req.params);
      return updateVehicle(ctx, a, id, parse(vehicleInputSchema, req.body));
    },
  );

  app.delete('/api/carrier/vehicles/:id', { schema: { tags: ['carrier'] } }, async (req) => {
    const a = member(req, { kind: 'carrier', permission: 'fleet.manage' });
    const { id } = parse(uuidParam, req.params);
    await removeVehicle(ctx, a, id);
    return { ok: true };
  });

  app.get(
    '/api/carrier/loads',
    { schema: { tags: ['carrier'], summary: 'Open loads that one of my vehicles can carry' } },
    async (req) => {
      const a = member(req, { kind: 'carrier' });
      return loadBoard(ctx, a.orgId);
    },
  );

  app.post(
    '/api/carrier/loads/:id/accept',
    {
      schema: {
        tags: ['carrier'],
        summary: 'Accept a load (first qualified acceptance wins)',
        body: doc(acceptLoadSchema),
      },
    },
    async (req, reply) => {
      const a = member(req, { kind: 'carrier', permission: 'loads.accept' });
      if (!a.session.user.emailVerified)
        throw new AppError(403, 'email_not_verified', 'Confirm your email address first');
      const { id } = parse(uuidParam, req.params);
      const input = parse(
        acceptLoadSchema.extend({ cabotageConfirmed: z.boolean().optional() }),
        req.body,
      );
      const res = await acceptLoad(ctx, a, id, input);
      if (res.result === 'already_assigned') reply.code(409);
      else if (res.result === 'not_available' || res.result === 'not_eligible') reply.code(422);
      return res;
    },
  );

  app.get('/api/carrier/bookings', { schema: { tags: ['carrier'] } }, async (req) => {
    const a = member(req, { kind: 'carrier' });
    return carrierBookings(ctx, a.orgId);
  });

  app.get('/api/carrier/offers', { schema: { tags: ['carrier'] } }, async (req) => {
    const a = member(req, { kind: 'carrier' });
    return carrierOffers(ctx, a.orgId);
  });

  app.post('/api/carrier/offers/:id/withdraw', { schema: { tags: ['carrier'] } }, async (req) => {
    const a = member(req, { kind: 'carrier', permission: 'loads.accept' });
    const { id } = parse(uuidParam, req.params);
    await withdrawOffer(ctx, a, id);
    return { ok: true };
  });
}
