import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { quoteInputSchema, shipmentInputSchema } from '@freight/shared';
import type { Ctx } from '../context';
import { doc, member, parse } from '../lib/http';
import { approveOffer, rejectOffer } from '../services/booking';
import {
  cancelShipment,
  createShipment,
  customerShipment,
  customerShipments,
  quote,
  retryPayment,
} from '../services/shipments';
import { assertRouteOpen } from '../services/platformConfig';

export function shipperRoutes(app: FastifyInstance, ctx: Ctx) {
  const uuidParam = z.object({ id: z.string().uuid() });

  app.post(
    '/api/quotes',
    {
      schema: {
        tags: ['shipper'],
        summary: 'Live price estimate for the booking screen (nothing is saved)',
        body: doc(quoteInputSchema),
      },
    },
    async (req) => {
      const a = member(req, { kind: 'shipper' });
      const input = parse(quoteInputSchema, req.body);
      await assertRouteOpen(ctx.db, input.pickup.country, input.delivery.country);
      const q = await quote(ctx, input, a.session.org!.country);
      return {
        vehicleClass: q.vehicleClass,
        distanceKm: q.route.distanceKm,
        durationMinutes: q.route.durationMinutes,
        routeSource: q.route.source,
        totals: q.totals,
        price: {
          currency: q.estimate.customer.currency,
          netMinor: q.estimate.customer.netMinor,
          vatMinor: q.estimate.customer.vatMinor,
          totalMinor: q.estimate.customer.totalMinor,
          taxBasis: q.estimate.customer.taxBasis,
          indicative: q.estimate.indicative,
        },
        customs: q.customs,
        pricingVersion: q.pricing.version,
      };
    },
  );

  app.post(
    '/api/shipments',
    {
      schema: {
        tags: ['shipper'],
        summary: 'Request transport (creates the shipment and its prepayment)',
        body: doc(shipmentInputSchema),
      },
    },
    async (req) => {
      const a = member(req, { kind: 'shipper', permission: 'shipments.create' });
      const input = parse(shipmentInputSchema, req.body);
      return createShipment(ctx, a, a.session.user.emailVerified, input);
    },
  );

  app.get('/api/shipments', { schema: { tags: ['shipper'] } }, async (req) => {
    const a = member(req, { kind: 'shipper', permission: 'shipments.view' });
    return customerShipments(ctx, a.orgId);
  });

  app.get('/api/shipments/:id', { schema: { tags: ['shipper'] } }, async (req) => {
    const a = member(req, { kind: 'shipper', permission: 'shipments.view' });
    const { id } = parse(uuidParam, req.params);
    return customerShipment(ctx, a.orgId, id);
  });

  app.post(
    '/api/shipments/:id/pay',
    { schema: { tags: ['shipper'], summary: 'Start a new prepayment after a failed one' } },
    async (req) => {
      const a = member(req, { kind: 'shipper', permission: 'payments.manage' });
      const { id } = parse(uuidParam, req.params);
      return retryPayment(ctx, a, id);
    },
  );

  app.post('/api/shipments/:id/cancel', { schema: { tags: ['shipper'] } }, async (req) => {
    const a = member(req, { kind: 'shipper', permission: 'shipments.create' });
    const { id } = parse(uuidParam, req.params);
    const { reason } = parse(
      z.object({ reason: z.string().trim().min(1).max(500) }),
      req.body ?? {},
    );
    await cancelShipment(ctx, a, id, reason);
    return { ok: true };
  });

  app.post(
    '/api/shipments/:id/offers/:offerId/approve',
    { schema: { tags: ['shipper'], summary: 'Approve a carrier offer above your maximum' } },
    async (req) => {
      const a = member(req, { kind: 'shipper', permission: 'offers.decide' });
      const { id, offerId } = parse(
        z.object({ id: z.string().uuid(), offerId: z.string().uuid() }),
        req.params,
      );
      return approveOffer(ctx, a, id, offerId);
    },
  );

  app.post(
    '/api/shipments/:id/offers/:offerId/reject',
    { schema: { tags: ['shipper'] } },
    async (req) => {
      const a = member(req, { kind: 'shipper', permission: 'offers.decide' });
      const { id, offerId } = parse(
        z.object({ id: z.string().uuid(), offerId: z.string().uuid() }),
        req.params,
      );
      await rejectOffer(ctx, a, id, offerId);
      return { ok: true };
    },
  );
}
