import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  borderReadiness,
  customerPriceForPayout,
  DOCUMENT_TYPES,
  filingCountry,
  HANDLER_TRANSITIONS,
  maxPayoutWithin,
  PARTY_ROLES,
  PREPARATION_STATUSES,
  QUOTE_SERVICES,
  REFERENCE_TYPES,
  requiredDocuments,
  requiredRoles,
  serviceFor,
  type CustomsAssessment,
  type CustomsService,
  type PartyRole,
  type PricingConfig,
  type ProcedureKind,
  type ProcedureStatus,
  type TaxContext,
} from '@freight/shared';
import type { Ctx } from '../context';
import type { DbOrTx, Tx } from '../db/client';
import {
  carrierObligations,
  customsDocuments,
  customsJobs,
  customsParties,
  customsProcedures,
  customsProviderProfiles,
  customsQuotes,
  organisations,
  payments,
  shipmentLocations,
  shipments,
  verificationDocuments,
} from '../db/schema';
import { newToken, sha256 } from '../lib/crypto';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { addShipmentAccessResolver, shipmentAccess } from './access';
import { audit, shipmentEvent, type Actor } from './audit';
import type { SessionInfo } from './auth';
import { saveFile } from './files';
import { enqueue, registerJob } from './jobs';
import { post } from './ledger';
import { notifyOrg } from './notifications';
import { createPayment } from './payments';

// ---------------------------------------------------------------- set-up from the assessment

/** Creates one procedure per customs step found for the route (called when the shipment is created). */
export async function setupProcedures(
  tx: Tx,
  shipmentId: string,
  a: CustomsAssessment,
  pickupCountry: string,
  deliveryCountry: string,
) {
  for (const p of a.procedures) {
    await tx.insert(customsProcedures).values({
      shipmentId,
      kind: p.kind,
      territory: p.territory,
      country:
        p.kind === 'check_route'
          ? null
          : filingCountry(p.kind, p.territory, pickupCountry, deliveryCountry),
      certainty: p.certainty,
      reason: p.reason,
      status: 'INFORMATION_MISSING',
      statusReason: p.kind === 'check_route' ? 'confirm_route' : 'choose_arrangement',
    });
  }
}

// ---------------------------------------------------------------- who may do what

/** Customs providers see a shipment once they hold a customs job on it. */
addShipmentAccessResolver(async (ctx, session, shipmentId) => {
  if (!session.org || session.org.kind !== 'customs_provider') return null;
  const [j] = await ctx.db
    .select({ id: customsJobs.id })
    .from(customsJobs)
    .where(
      and(
        eq(customsJobs.shipmentId, shipmentId),
        eq(customsJobs.providerOrgId, session.org.id),
        inArray(customsJobs.status, ['assigned', 'completed']),
      ),
    );
  return j ? 'customs' : null;
});

async function shipperOf(ctx: Ctx, session: SessionInfo, shipmentId: string) {
  const a = await shipmentAccess(ctx, session, shipmentId);
  if (a.role !== 'shipper') throw notFound();
  if (session.role && !['owner', 'admin', 'dispatcher', 'member'].includes(session.role))
    throw forbidden();
  return a;
}

// ---------------------------------------------------------------- preparation status

/**
 * Works out the early statuses (information missing / documents pending / broker assigned) from
 * the arrangement, the named parties and the documents. Later statuses are set by the handler.
 */
export async function refreshPreparation(tx: DbOrTx, shipmentId: string) {
  const procs = await tx
    .select()
    .from(customsProcedures)
    .where(eq(customsProcedures.shipmentId, shipmentId));
  const parties = await tx
    .select()
    .from(customsParties)
    .where(eq(customsParties.shipmentId, shipmentId));
  const docs = await tx
    .select()
    .from(customsDocuments)
    .where(
      and(eq(customsDocuments.shipmentId, shipmentId), eq(customsDocuments.status, 'current')),
    );
  const jobs = await tx.select().from(customsJobs).where(eq(customsJobs.shipmentId, shipmentId));
  for (const p of procs) {
    if (!PREPARATION_STATUSES.includes(p.status as ProcedureStatus)) continue;
    let status: ProcedureStatus;
    let reason: string | null = null;
    const job = jobs.find(
      (j) =>
        j.procedureIds.includes(p.id) &&
        ['open', 'awaiting_payment', 'assigned'].includes(j.status),
    );
    if (p.kind === 'check_route') {
      status = 'INFORMATION_MISSING';
      reason = 'confirm_route';
    } else if (!p.arrangement) {
      status = 'INFORMATION_MISSING';
      reason = 'choose_arrangement';
    } else {
      // On the marketplace the provider becomes the declarant when it takes the job
      const declarantRoles: PartyRole[] = [
        'export_declarant',
        'import_declarant',
        'transit_principal',
        'safety_security_filer',
        'movement_reference_party',
      ];
      const needed = requiredRoles(p.kind as ProcedureKind).filter(
        (r) => !(p.arrangement === 'marketplace' && declarantRoles.includes(r)),
      );
      const missingRole = needed.find(
        (r) => !parties.some((x) => x.role === r && x.acknowledgedAt),
      );
      const missingDoc = requiredDocuments(p.kind as ProcedureKind).find(
        (d) => !docs.some((x) => x.docType === d),
      );
      if (missingRole) {
        status = 'INFORMATION_MISSING';
        reason = `party:${missingRole}`;
      } else if (missingDoc) {
        status = 'DOCUMENTS_PENDING';
        reason = `document:${missingDoc}`;
      } else if (p.arrangement === 'marketplace' && job?.status !== 'assigned') {
        status = 'INFORMATION_MISSING';
        reason = job ? 'waiting_for_provider' : 'choose_arrangement';
      } else status = 'BROKER_ASSIGNED';
    }
    if (status !== p.status || reason !== p.statusReason)
      await tx
        .update(customsProcedures)
        .set({ status, statusReason: reason, updatedAt: new Date() })
        .where(eq(customsProcedures.id, p.id));
  }
}

// ---------------------------------------------------------------- parties

export const partyInputSchema = z.object({
  role: z.enum(PARTY_ROLES),
  /** The customer's own company takes the role (no confirmation needed) */
  self: z.boolean().default(false),
  name: z.string().trim().min(2).max(200).optional(),
  email: z.string().trim().toLowerCase().email().optional(),
  eori: z
    .string()
    .trim()
    .regex(/^[A-Z]{2}[A-Z0-9]{1,15}$/i)
    .optional()
    .nullable(),
});

/**
 * Names who is responsible for a role. Another party must confirm by the link sent to them: the
 * customer cannot silently make someone else responsible.
 */
export async function setParty(
  ctx: Ctx,
  session: SessionInfo,
  shipmentId: string,
  input: z.infer<typeof partyInputSchema>,
) {
  const { shipment } = await shipperOf(ctx, session, shipmentId);
  if (!input.self && (!input.name || !input.email))
    throw badRequest(
      'party_details',
      'Give the name and email of the responsible party, or take the role yourself',
    );
  const [org] = await ctx.db
    .select()
    .from(organisations)
    .where(eq(organisations.id, shipment.orgId));
  const token = input.self ? null : newToken();
  await ctx.db.transaction(async (tx) => {
    await tx
      .delete(customsParties)
      .where(and(eq(customsParties.shipmentId, shipmentId), eq(customsParties.role, input.role)));
    await tx.insert(customsParties).values({
      shipmentId,
      role: input.role,
      orgId: input.self ? shipment.orgId : null,
      name: input.self ? org!.name : input.name!,
      email: input.self ? session.user.email : input.email!,
      eori: input.eori ?? null,
      ackTokenHash: token ? sha256(token) : null,
      acknowledgedAt: input.self ? ctx.now() : null,
      acknowledgedName: input.self ? session.user.name : null,
      assignedBy: session.user.id,
    });
    if (token)
      await ctx.email.send(tx, {
        to: input.email!,
        template: 'customs_party_ack',
        subject: `Please confirm your customs role for a shipment (${ctx.config.brand.name})`,
        body: `${org!.name} names you as "${input.role.replaceAll('_', ' ')}" for a shipment.\n\nIf this is agreed, confirm here: ${ctx.config.publicUrl}/customs/confirm?token=${token}\n\nIf you do not agree, ignore this email; the role then stays open.`,
      });
    await shipmentEvent(
      tx,
      shipmentId,
      'customs.party_named',
      { userId: session.user.id, orgId: session.org?.id },
      { role: input.role, self: input.self },
    );
    await refreshPreparation(tx, shipmentId);
  });
}

export async function acknowledgeParty(ctx: Ctx, token: string, name: string) {
  return ctx.db.transaction(async (tx) => {
    const [p] = await tx
      .update(customsParties)
      .set({ acknowledgedAt: ctx.now(), acknowledgedName: name, ackTokenHash: null })
      .where(
        and(
          eq(customsParties.ackTokenHash, sha256(token)),
          sql`${customsParties.acknowledgedAt} IS NULL`,
        ),
      )
      .returning();
    if (!p) throw badRequest('bad_token', 'This link is not valid any more');
    await shipmentEvent(
      tx,
      p.shipmentId,
      'customs.party_confirmed',
      { userId: null, orgId: null },
      { role: p.role },
    );
    await audit(
      tx,
      { userId: null, orgId: null },
      'customs.party_confirmed',
      { type: 'customs_party', id: p.id },
      { name },
    );
    await refreshPreparation(tx, p.shipmentId);
    return { role: p.role };
  });
}

/** What the confirmation page shows before the party confirms. */
export async function partyForToken(ctx: Ctx, token: string) {
  const [p] = await ctx.db
    .select()
    .from(customsParties)
    .where(eq(customsParties.ackTokenHash, sha256(token)));
  if (!p) throw badRequest('bad_token', 'This link is not valid any more');
  const [s] = await ctx.db
    .select({ orgId: shipments.orgId })
    .from(shipments)
    .where(eq(shipments.id, p.shipmentId));
  const [org] = await ctx.db
    .select({ name: organisations.name })
    .from(organisations)
    .where(eq(organisations.id, s!.orgId));
  const locs = await ctx.db
    .select()
    .from(shipmentLocations)
    .where(eq(shipmentLocations.shipmentId, p.shipmentId));
  return {
    role: p.role,
    name: p.name,
    requestedBy: org!.name,
    from: locs.find((l) => l.kind === 'pickup')?.city,
    to: locs.find((l) => l.kind === 'delivery')?.city,
  };
}

// ---------------------------------------------------------------- arrangement

export const arrangeSchema = z.object({
  arrangement: z.enum(['marketplace', 'own_broker', 'responsible_party', 'not_required']),
  /** marketplace: the customs budget the customer authorises (incl. platform fee and VAT) */
  budgetMinor: z.number().int().positive().max(100_000_00).optional(),
  /** not_required (only for "possible" steps): the customer's confirmation, recorded */
  confirmation: z.string().trim().max(500).optional(),
});

export async function arrange(
  ctx: Ctx,
  session: SessionInfo,
  procedureId: string,
  input: z.infer<typeof arrangeSchema>,
) {
  const [p] = await ctx.db
    .select()
    .from(customsProcedures)
    .where(eq(customsProcedures.id, procedureId));
  if (!p) throw notFound();
  const { shipment } = await shipperOf(ctx, session, p.shipmentId);
  if (!PREPARATION_STATUSES.includes(p.status as ProcedureStatus))
    throw conflict('procedure_started', 'This customs step is already under way');
  const actor = { userId: session.user.id, orgId: session.org?.id };
  if (input.arrangement === 'not_required') {
    if (p.certainty !== 'possible')
      throw badRequest(
        'required_procedure',
        'This customs step is required for the route; it cannot be skipped',
      );
    if (!input.confirmation)
      throw badRequest(
        'confirmation_required',
        'Confirm why this step is not needed (e.g. the route stays inside the EU)',
      );
    await ctx.db
      .update(customsProcedures)
      .set({
        status: 'NOT_REQUIRED',
        arrangement: 'not_required',
        statusReason: input.confirmation,
        updatedAt: ctx.now(),
      })
      .where(eq(customsProcedures.id, p.id));
    await audit(
      ctx.db,
      actor,
      'customs.marked_not_required',
      { type: 'customs_procedure', id: p.id },
      { confirmation: input.confirmation },
    );
    return { ok: true };
  }
  if (p.kind === 'check_route') throw badRequest('confirm_route', 'Confirm the route first');
  await ctx.db
    .update(customsProcedures)
    .set({ arrangement: input.arrangement, updatedAt: ctx.now() })
    .where(eq(customsProcedures.id, p.id));
  await shipmentEvent(ctx.db, p.shipmentId, 'customs.arranged', actor, {
    kind: p.kind,
    arrangement: input.arrangement,
  });
  if (input.arrangement === 'marketplace') {
    if (!input.budgetMinor)
      throw badRequest('budget_required', 'Set the most you authorise for this customs work');
    const res = await createCustomsJob(ctx, session, shipment, p, input.budgetMinor);
    await refreshPreparation(ctx.db, p.shipmentId);
    return res;
  }
  await refreshPreparation(ctx.db, p.shipmentId);
  return { ok: true };
}

// ---------------------------------------------------------------- marketplace jobs

/** The platform's fee on customs work uses the shipment's pricing snapshot (same fee rule). */
function customsPrice(fee: number, s: typeof shipments.$inferSelect) {
  return customerPriceForPayout(
    fee,
    s.taxContext as TaxContext,
    s.pricingSnapshot as PricingConfig,
  );
}

async function createCustomsJob(
  ctx: Ctx,
  session: SessionInfo,
  s: typeof shipments.$inferSelect,
  p: typeof customsProcedures.$inferSelect,
  budgetMinor: number,
) {
  const service = serviceFor(p.kind as ProcedureKind) as CustomsService | null;
  if (!service || !p.country)
    throw badRequest('no_service', 'This step cannot be given to a customs provider');
  const listed = maxPayoutWithin(
    budgetMinor,
    s.taxContext as TaxContext,
    s.pricingSnapshot as PricingConfig,
  );
  if (listed <= 0) throw badRequest('budget_too_low', 'The budget does not cover the platform fee');
  const [pickup] = await ctx.db
    .select()
    .from(shipmentLocations)
    .where(and(eq(shipmentLocations.shipmentId, s.id), eq(shipmentLocations.kind, 'pickup')));
  const expiresAt = new Date(
    Math.min(ctx.now().getTime() + 48 * 3_600_000, pickup!.windowEnd.getTime()),
  );
  const [job] = await ctx.db
    .insert(customsJobs)
    .values({
      shipmentId: s.id,
      orgId: s.orgId,
      procedureIds: [p.id],
      service,
      country: p.country,
      mode: QUOTE_SERVICES.includes(service) ? 'quote_required' : 'standard',
      status: 'awaiting_payment',
      budgetMinor,
      listedFeeMinor: listed,
      currency: s.currency,
      expiresAt,
    })
    .returning();
  const pay = await createPayment(ctx, {
    shipmentId: s.id,
    orgId: s.orgId,
    purpose: 'customs',
    amountMinor: budgetMinor,
    currency: s.currency,
  });
  await ctx.db.insert(payments).values({ ...pay.row, customsJobId: job!.id });
  await audit(
    ctx.db,
    { userId: session.user.id, orgId: s.orgId },
    'customs.job_created',
    { type: 'customs_job', id: job!.id },
    { budgetMinor },
  );
  return { jobId: job!.id, payment: pay.clientAction };
}

/** Customs payment arrived: the job goes to providers (called from the payments webhook). */
export async function customsPaymentReceived(
  ctx: Ctx,
  tx: Tx,
  payment: typeof payments.$inferSelect,
): Promise<string> {
  const [job] = await tx
    .select()
    .from(customsJobs)
    .where(eq(customsJobs.id, payment.customsJobId!))
    .for('update');
  if (!job) return 'unknown_job';
  await post(
    tx,
    {
      kind: 'payment_received',
      refType: 'payment',
      refId: payment.id,
      idempotencyKey: `payment:${payment.id}:received`,
      currency: payment.currency,
    },
    [
      { account: 'psp_clearing', amountMinor: payment.amountMinor },
      { account: 'customer_funds', orgId: payment.orgId, amountMinor: -payment.amountMinor },
    ],
  );
  await tx
    .update(customsJobs)
    .set({ fundedMinor: sql`${customsJobs.fundedMinor} + ${payment.amountMinor}` })
    .where(eq(customsJobs.id, job.id));
  if (payment.purpose === 'customs' && job.status === 'awaiting_payment') {
    await tx.update(customsJobs).set({ status: 'open' }).where(eq(customsJobs.id, job.id));
    await enqueue(
      tx,
      'match_customs_job',
      { jobId: job.id },
      { dedupeKey: `match-customs:${job.id}` },
    );
    await enqueue(
      tx,
      'expire_customs_job',
      { jobId: job.id },
      { runAt: job.expiresAt, dedupeKey: `expire-customs:${job.id}` },
    );
    return 'customs_job_open';
  }
  if (payment.purpose === 'customs_top_up') {
    const [q] = await tx
      .select()
      .from(customsQuotes)
      .where(and(eq(customsQuotes.jobId, job.id), eq(customsQuotes.status, 'approved')))
      .for('update');
    const [fresh] = await tx.select().from(customsJobs).where(eq(customsJobs.id, job.id));
    if (
      q &&
      fresh!.status === 'open' &&
      q.expiresAt > ctx.now() &&
      fresh!.fundedMinor >= q.totalMinor
    ) {
      await assign(ctx, tx, fresh!, q.providerOrgId, q.feeMinor, q.id);
      return 'customs_assigned';
    }
  }
  // Paid but nothing to use it for (cancelled, expired, taken): give it back
  await enqueue(
    tx,
    'refund_customs_excess',
    { jobId: job.id },
    { dedupeKey: `refund-customs:${job.id}:${payment.id}` },
  );
  return 'refund_queued';
}

/** Is this customs provider allowed and able to take this job? */
export async function providerProblems(
  db: DbOrTx,
  providerOrgId: string,
  job: typeof customsJobs.$inferSelect,
  onDate: string,
) {
  const problems: string[] = [];
  const [org] = await db.select().from(organisations).where(eq(organisations.id, providerOrgId));
  if (!org || org.kind !== 'customs_provider') return ['not_a_customs_provider'];
  if (org.status !== 'verified') problems.push('provider_not_verified');
  const docs = await db
    .select()
    .from(verificationDocuments)
    .where(
      and(
        eq(verificationDocuments.orgId, providerOrgId),
        eq(verificationDocuments.kind, 'customs_authorisation'),
        eq(verificationDocuments.status, 'approved'),
      ),
    );
  if (!docs.some((d) => !d.validUntil || d.validUntil >= onDate))
    problems.push('authorisation_missing');
  const [profile] = await db
    .select()
    .from(customsProviderProfiles)
    .where(eq(customsProviderProfiles.orgId, providerOrgId));
  if (!profile || !profile.active) problems.push('no_profile');
  else {
    if (!profile.countries.includes(job.country)) problems.push('country_not_served');
    if (!profile.services.includes(job.service)) problems.push('service_not_offered');
  }
  return problems;
}

registerJob('match_customs_job', async (ctx, payload) => {
  const { jobId } = payload as { jobId: string };
  const [job] = await ctx.db.select().from(customsJobs).where(eq(customsJobs.id, jobId));
  if (!job || job.status !== 'open') return;
  const candidates = await ctx.db
    .select({ orgId: customsProviderProfiles.orgId })
    .from(customsProviderProfiles)
    .where(
      and(
        eq(customsProviderProfiles.active, true),
        sql`${job.country} = ANY(${customsProviderProfiles.countries})`,
        sql`${job.service} = ANY(${customsProviderProfiles.services})`,
      ),
    );
  let n = 0;
  for (const c of candidates) {
    if ((await providerProblems(ctx.db, c.orgId, job, ctx.now().toISOString().slice(0, 10))).length)
      continue;
    await notifyOrg(ctx.db, c.orgId, 'loads.accept', {
      kind: 'customs.job_matched',
      shipmentId: null,
      data: { jobId },
      dedupeKey: `customs-job:${jobId}`,
    });
    n++;
  }
  await shipmentEvent(
    ctx.db,
    job.shipmentId,
    'customs.providers_notified',
    { userId: null, orgId: null },
    { providers: n },
  );
});

registerJob('expire_customs_job', async (ctx, payload) => {
  const { jobId } = payload as { jobId: string };
  await ctx.db.transaction(async (tx) => {
    const [job] = await tx
      .select()
      .from(customsJobs)
      .where(eq(customsJobs.id, jobId))
      .for('update');
    if (!job || job.status !== 'open' || job.expiresAt > ctx.now()) return;
    await tx.update(customsJobs).set({ status: 'expired' }).where(eq(customsJobs.id, job.id));
    await tx
      .update(customsQuotes)
      .set({ status: 'expired' })
      .where(
        and(
          eq(customsQuotes.jobId, job.id),
          inArray(customsQuotes.status, ['pending_customer', 'approved']),
        ),
      );
    await enqueue(
      tx,
      'refund_customs_excess',
      { jobId: job.id },
      { dedupeKey: `refund-customs:${job.id}:expired` },
    );
    await notifyOrg(tx, job.orgId, 'shipments.view', {
      kind: 'customs.action_needed',
      shipmentId: job.shipmentId,
      dedupeKey: `customs-expired:${job.id}`,
    });
    await tx
      .update(customsProcedures)
      .set({ arrangement: null })
      .where(inArray(customsProcedures.id, job.procedureIds));
    await refreshPreparation(tx, job.shipmentId);
  });
});

/** Gives back what was paid for a customs job beyond what it costs (or everything if it was not assigned). */
registerJob('refund_customs_excess', async (ctx, payload) => {
  const { jobId } = payload as { jobId: string };
  await ctx.db.transaction(async (tx) => {
    const [job] = await tx
      .select()
      .from(customsJobs)
      .where(eq(customsJobs.id, jobId))
      .for('update');
    if (!job) return;
    const keep =
      job.status === 'assigned' || job.status === 'completed' ? (job.priceMinor ?? 0) : 0;
    let toRefund = job.fundedMinor - keep;
    if (toRefund <= 0) return;
    const paid = await tx
      .select()
      .from(payments)
      .where(and(eq(payments.customsJobId, job.id), eq(payments.status, 'succeeded')));
    for (const p of paid.reverse()) {
      if (toRefund <= 0) break;
      const done = await tx.execute<{ v: number }>(
        sql`SELECT coalesce(sum(amount_minor),0)::bigint AS v FROM refunds WHERE payment_id = ${p.id} AND status <> 'failed'`,
      );
      const amount = Math.min(p.amountMinor - Number(done.rows[0]!.v), toRefund);
      if (amount <= 0) continue;
      const key = `customs:${job.id}:${p.id}:${job.status}`;
      const r = await ctx.payments.refund({
        providerRef: p.providerRef,
        amountMinor: amount,
        currency: p.currency,
        idempotencyKey: key,
      });
      const res = await tx.execute<{ id: string }>(
        sql`INSERT INTO refunds (payment_id, shipment_id, amount_minor, currency, reason, status, provider_ref) VALUES (${p.id}, ${job.shipmentId}, ${amount}, ${p.currency}, 'customs', ${r.status}, ${r.refundRef}) RETURNING id`,
      );
      await post(
        tx,
        {
          kind: 'refund',
          refType: 'refund',
          refId: res.rows[0]!.id,
          idempotencyKey: `refund:${key}`,
          currency: p.currency,
        },
        [
          { account: 'customer_funds', orgId: p.orgId, amountMinor: amount },
          { account: 'psp_clearing', amountMinor: -amount },
        ],
      );
      await tx
        .update(customsJobs)
        .set({ fundedMinor: sql`${customsJobs.fundedMinor} - ${amount}` })
        .where(eq(customsJobs.id, job.id));
      toRefund -= amount;
    }
  });
});

export const customsAcceptSchema = z.object({
  /** Leave out to accept the listed fee (standard jobs); required for jobs that need a quote */
  feeMinor: z.number().int().positive().max(100_000_00).optional(),
  note: z.string().trim().max(2000).optional(),
});

/** Same rule as transport: the first qualified provider within the budget gets the job. */
export async function acceptCustomsJob(
  ctx: Ctx,
  session: SessionInfo,
  jobId: string,
  input: z.infer<typeof customsAcceptSchema>,
) {
  if (
    !session.org ||
    session.org.kind !== 'customs_provider' ||
    !session.role ||
    !['owner', 'admin', 'dispatcher'].includes(session.role)
  )
    throw forbidden();
  const providerOrgId = session.org.id;
  return ctx.db.transaction(async (tx) => {
    const [job] = await tx
      .select()
      .from(customsJobs)
      .where(eq(customsJobs.id, jobId))
      .for('update');
    if (!job) throw notFound();
    if (job.status === 'assigned' || job.status === 'completed')
      return { result: 'already_assigned' as const };
    if (job.status !== 'open' || job.expiresAt <= ctx.now())
      return { result: 'not_available' as const };
    const problems = await providerProblems(
      tx,
      providerOrgId,
      job,
      ctx.now().toISOString().slice(0, 10),
    );
    if (problems.length) return { result: 'not_eligible' as const, problems };
    if (job.mode === 'quote_required' && !input.feeMinor)
      throw badRequest('quote_required', 'This job needs your price');
    const fee = input.feeMinor ?? job.listedFeeMinor;
    const [s] = await tx.select().from(shipments).where(eq(shipments.id, job.shipmentId));
    const price = customsPrice(fee, s!);
    if (price.totalMinor <= job.fundedMinor) {
      await assign(ctx, tx, job, providerOrgId, fee, null);
      return { result: 'assigned' as const, feeMinor: fee };
    }
    const expiresAt = new Date(
      Math.min(ctx.now().getTime() + 4 * 3_600_000, job.expiresAt.getTime()),
    );
    await tx
      .update(customsQuotes)
      .set({ status: 'superseded' })
      .where(
        and(
          eq(customsQuotes.jobId, job.id),
          eq(customsQuotes.providerOrgId, providerOrgId),
          eq(customsQuotes.status, 'pending_customer'),
        ),
      );
    const [q] = await tx
      .insert(customsQuotes)
      .values({
        jobId: job.id,
        providerOrgId,
        feeMinor: fee,
        totalMinor: price.totalMinor,
        note: input.note ?? null,
        status: 'pending_customer',
        expiresAt,
        createdBy: session.user.id,
      })
      .returning();
    await notifyOrg(tx, job.orgId, 'offers.decide', {
      kind: 'customs.action_needed',
      shipmentId: job.shipmentId,
      dedupeKey: `customs-quote:${q!.id}`,
    });
    return { result: 'quote_pending' as const, quoteId: q!.id, expiresAt };
  });
}

async function assign(
  ctx: Ctx,
  tx: Tx,
  job: typeof customsJobs.$inferSelect,
  providerOrgId: string,
  fee: number,
  quoteId: string | null,
) {
  const [s] = await tx.select().from(shipments).where(eq(shipments.id, job.shipmentId));
  const price = customsPrice(fee, s!);
  const now = ctx.now();
  await tx
    .update(customsJobs)
    .set({
      status: 'assigned',
      providerOrgId,
      priceMinor: price.totalMinor,
      providerFeeMinor: fee,
      platformFeeMinor: price.platformFeeMinor,
      assignedAt: now,
    })
    .where(eq(customsJobs.id, job.id));
  if (quoteId)
    await tx.update(customsQuotes).set({ status: 'accepted' }).where(eq(customsQuotes.id, quoteId));
  await tx
    .update(customsQuotes)
    .set({ status: 'superseded' })
    .where(
      and(
        eq(customsQuotes.jobId, job.id),
        inArray(customsQuotes.status, ['pending_customer', 'approved']),
        sql`${customsQuotes.id} <> ${quoteId ?? '00000000-0000-0000-0000-000000000000'}`,
      ),
    );
  await tx
    .update(customsProcedures)
    .set({ handledByOrgId: providerOrgId, updatedAt: now })
    .where(inArray(customsProcedures.id, job.procedureIds));
  // The provider becomes the declarant for its procedures (it accepted the job: no separate confirmation)
  const [provider] = await tx
    .select()
    .from(organisations)
    .where(eq(organisations.id, providerOrgId));
  const procs = await tx
    .select()
    .from(customsProcedures)
    .where(inArray(customsProcedures.id, job.procedureIds));
  for (const p of procs) {
    const role: PartyRole | null =
      p.kind === 'export'
        ? 'export_declarant'
        : p.kind === 'import'
          ? 'import_declarant'
          : p.kind === 'transit'
            ? 'transit_principal'
            : p.kind === 'entry_safety_security'
              ? 'safety_security_filer'
              : p.kind === 'gb_gvms'
                ? 'movement_reference_party'
                : null;
    if (!role) continue;
    await tx
      .delete(customsParties)
      .where(and(eq(customsParties.shipmentId, job.shipmentId), eq(customsParties.role, role)));
    await tx.insert(customsParties).values({
      shipmentId: job.shipmentId,
      role,
      orgId: providerOrgId,
      name: provider!.name,
      email: null,
      acknowledgedAt: now,
      acknowledgedName: 'accepted on the platform',
      assignedBy: providerOrgId,
    });
  }
  await post(
    tx,
    {
      kind: 'customs_assignment',
      refType: 'customs_job',
      refId: job.id,
      idempotencyKey: `customs-assign:${job.id}`,
      currency: job.currency,
    },
    [
      { account: 'customer_funds', orgId: job.orgId, amountMinor: price.totalMinor },
      { account: 'customs_provider_payable', orgId: providerOrgId, amountMinor: -fee },
      { account: 'platform_revenue_deferred', amountMinor: -price.platformFeeMinor },
      { account: 'vat_payable', amountMinor: -price.vatMinor },
    ],
  );
  await tx.insert(carrierObligations).values({
    kind: 'customs',
    customsJobId: job.id,
    carrierOrgId: providerOrgId,
    amountMinor: fee,
    currency: job.currency,
    status: 'committed',
    funded: true,
    conditions:
      'Paid by the platform when the customs work is completed (all its procedures released or completed).',
  });
  await enqueue(
    tx,
    'refund_customs_excess',
    { jobId: job.id },
    { dedupeKey: `refund-customs:${job.id}:assigned` },
  );
  await enqueue(
    tx,
    'issue_customs_invoice',
    { jobId: job.id },
    { dedupeKey: `customs-invoice:${job.id}` },
  );
  await shipmentEvent(
    tx,
    job.shipmentId,
    'customs.provider_assigned',
    { userId: null, orgId: providerOrgId },
    { service: job.service },
  );
  await notifyOrg(tx, job.orgId, 'shipments.view', {
    kind: 'customs.provider_assigned',
    shipmentId: job.shipmentId,
    dedupeKey: `customs-assigned:${job.id}`,
  });
  await refreshPreparation(tx, job.shipmentId);
}

/** The customer approves a provider's quote above the budget: pays the difference, then it is assigned (if still open). */
export async function approveCustomsQuote(ctx: Ctx, session: SessionInfo, quoteId: string) {
  const [q] = await ctx.db.select().from(customsQuotes).where(eq(customsQuotes.id, quoteId));
  if (!q) throw notFound();
  const [job] = await ctx.db.select().from(customsJobs).where(eq(customsJobs.id, q.jobId));
  await shipperOf(ctx, session, job!.shipmentId);
  return ctx.db.transaction(async (tx) => {
    const [j] = await tx
      .select()
      .from(customsJobs)
      .where(eq(customsJobs.id, q.jobId))
      .for('update');
    const [quote] = await tx
      .select()
      .from(customsQuotes)
      .where(eq(customsQuotes.id, quoteId))
      .for('update');
    if (j!.status !== 'open')
      throw conflict('already_assigned', 'This customs job is no longer open');
    if (quote!.status !== 'pending_customer')
      throw conflict('offer_not_pending', `This quote is ${quote!.status}`);
    if (quote!.expiresAt <= ctx.now()) throw conflict('offer_expired', 'This quote has expired');
    const topUp = quote!.totalMinor - j!.fundedMinor;
    if (topUp <= 0) {
      await assign(ctx, tx, j!, quote!.providerOrgId, quote!.feeMinor, quote!.id);
      return { result: 'assigned' as const };
    }
    await tx
      .update(customsQuotes)
      .set({ status: 'approved', expiresAt: new Date(ctx.now().getTime() + 30 * 60_000) })
      .where(eq(customsQuotes.id, quoteId));
    const pay = await createPayment(ctx, {
      shipmentId: j!.shipmentId,
      orgId: j!.orgId,
      purpose: 'customs_top_up',
      amountMinor: topUp,
      currency: j!.currency,
    });
    await tx.insert(payments).values({ ...pay.row, customsJobId: j!.id });
    return { result: 'payment_required' as const, topUpMinor: topUp, payment: pay.clientAction };
  });
}

// ---------------------------------------------------------------- progress of a procedure

export const procedureUpdateSchema = z.object({
  status: z.enum([
    'DECLARATION_PREPARING',
    'DECLARATION_SUBMITTED',
    'DECLARATION_ACCEPTED',
    'BORDER_ACTION_REQUIRED',
    'BORDER_HOLD',
    'RELEASED',
    'PROCEDURE_COMPLETED',
  ]),
  reference: z.string().trim().min(3).max(60).optional(),
  referenceType: z.enum(REFERENCE_TYPES).optional(),
  note: z.string().trim().max(2000).optional(),
});

/**
 * The handler moves a procedure forward: the assigned customs provider, or (for the customer's own
 * broker or the responsible party) the customer entering what they were given. A submitted or later
 * declaration needs its reference (e.g. the MRN).
 */
export async function updateProcedure(
  ctx: Ctx,
  session: SessionInfo,
  procedureId: string,
  input: z.infer<typeof procedureUpdateSchema>,
) {
  const [p] = await ctx.db
    .select()
    .from(customsProcedures)
    .where(eq(customsProcedures.id, procedureId));
  if (!p) throw notFound();
  const { role } = await shipmentAccess(ctx, session, p.shipmentId);
  const isHandler =
    (role === 'customs' && p.handledByOrgId === session.org?.id) ||
    (role === 'shipper' && ['own_broker', 'responsible_party'].includes(p.arrangement ?? '')) ||
    role === 'platform';
  if (!isHandler) throw forbidden('Only the party handling this customs step can update it');
  const allowed = HANDLER_TRANSITIONS[p.status as ProcedureStatus] ?? [];
  if (!allowed.includes(input.status))
    throw conflict(
      'bad_transition',
      `From ${p.status} it can go to: ${allowed.join(', ') || 'nothing (prepare it first)'}`,
    );
  const reference = input.reference ?? p.reference;
  if (
    ['DECLARATION_SUBMITTED', 'DECLARATION_ACCEPTED', 'RELEASED', 'PROCEDURE_COMPLETED'].includes(
      input.status,
    ) &&
    !reference
  )
    throw badRequest('reference_required', 'Enter the declaration reference (e.g. MRN)');
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(customsProcedures)
      .set({
        status: input.status,
        reference: reference ?? null,
        referenceType: input.referenceType ?? p.referenceType,
        statusReason: input.note ?? null,
        updatedAt: ctx.now(),
      })
      .where(eq(customsProcedures.id, p.id));
    await shipmentEvent(
      tx,
      p.shipmentId,
      'customs.status',
      { userId: session.user.id, orgId: session.org?.id },
      { kind: p.kind, status: input.status, reference },
    );
    const [s] = await tx.select().from(shipments).where(eq(shipments.id, p.shipmentId));
    if (['BORDER_ACTION_REQUIRED', 'BORDER_HOLD'].includes(input.status)) {
      // Delays at the border: everyone involved is told; who pays extra costs follows the contract terms
      await notifyOrg(tx, s!.orgId, 'shipments.view', {
        kind: 'customs.action_needed',
        shipmentId: s!.id,
        dedupeKey: `customs-hold:${p.id}:${input.status}:${ctx.now().toISOString().slice(0, 13)}`,
      });
      const booking = await tx.execute<{ carrier_org_id: string }>(
        sql`SELECT carrier_org_id FROM bookings WHERE shipment_id = ${s!.id}`,
      );
      if (booking.rows[0])
        await notifyOrg(tx, booking.rows[0].carrier_org_id, 'loads.accept', {
          kind: 'customs.action_needed',
          shipmentId: s!.id,
          dedupeKey: `customs-hold-c:${p.id}:${input.status}:${ctx.now().toISOString().slice(0, 13)}`,
        });
    }
    // A provider's job is done when all its procedures are released or completed
    const jobs = await tx
      .select()
      .from(customsJobs)
      .where(and(eq(customsJobs.shipmentId, p.shipmentId), eq(customsJobs.status, 'assigned')));
    for (const j of jobs) {
      if (!j.procedureIds.includes(p.id)) continue;
      const procs = await tx
        .select()
        .from(customsProcedures)
        .where(inArray(customsProcedures.id, j.procedureIds));
      if (
        procs.every((x) =>
          ['RELEASED', 'PROCEDURE_COMPLETED'].includes(x.id === p.id ? input.status : x.status),
        )
      )
        await completeCustomsJob(ctx, tx, j);
    }
  });
}

async function completeCustomsJob(ctx: Ctx, tx: Tx, job: typeof customsJobs.$inferSelect) {
  await tx
    .update(customsJobs)
    .set({ status: 'completed', completedAt: ctx.now() })
    .where(eq(customsJobs.id, job.id));
  await post(
    tx,
    {
      kind: 'revenue_recognised',
      refType: 'customs_job',
      refId: job.id,
      idempotencyKey: `customs-revenue:${job.id}`,
      currency: job.currency,
    },
    [
      { account: 'platform_revenue_deferred', amountMinor: job.platformFeeMinor ?? 0 },
      { account: 'customs_revenue', amountMinor: -(job.platformFeeMinor ?? 0) },
    ],
  );
  const [o] = await tx
    .update(carrierObligations)
    .set({ status: 'payable', payableAt: ctx.now() })
    .where(
      and(eq(carrierObligations.customsJobId, job.id), eq(carrierObligations.status, 'committed')),
    )
    .returning();
  if (o)
    await enqueue(tx, 'carrier_payout', { obligationId: o.id }, { dedupeKey: `payout:${o.id}` });
  await shipmentEvent(
    tx,
    job.shipmentId,
    'customs.job_completed',
    { userId: null, orgId: job.providerOrgId },
    { service: job.service },
  );
}

// ---------------------------------------------------------------- documents

export const customsDocumentSchema = z.object({
  docType: z.enum(DOCUMENT_TYPES),
  contentType: z.string().max(100),
  data: z.string().min(4).max(21_000_000),
  reference: z.string().trim().max(100).optional(),
  validUntil: z.string().date().optional(),
  note: z.string().trim().max(1000).optional(),
});

/** Adds a document; a new upload of the same type becomes the current version. */
export async function uploadCustomsDocument(
  ctx: Ctx,
  session: SessionInfo,
  shipmentId: string,
  input: z.infer<typeof customsDocumentSchema>,
) {
  const { role } = await shipmentAccess(ctx, session, shipmentId);
  if (!['shipper', 'customs', 'platform'].includes(role))
    throw forbidden('Only the customer, its customs provider or support add customs documents');
  return ctx.db.transaction(async (tx) => {
    const file = await saveFile(ctx, tx, {
      orgId: session.org?.id ?? null,
      shipmentId,
      kind: 'document',
      contentType: input.contentType,
      data: Buffer.from(input.data.replace(/^data:[^,]+,/, ''), 'base64'),
      fileName: `${input.docType}.${input.contentType === 'application/pdf' ? 'pdf' : 'img'}`,
      uploadedBy: session.user.id,
    });
    const [last] = await tx
      .select({ v: sql<number>`coalesce(max(${customsDocuments.version}), 0)` })
      .from(customsDocuments)
      .where(
        and(
          eq(customsDocuments.shipmentId, shipmentId),
          eq(customsDocuments.docType, input.docType),
        ),
      );
    await tx
      .update(customsDocuments)
      .set({ status: 'superseded' })
      .where(
        and(
          eq(customsDocuments.shipmentId, shipmentId),
          eq(customsDocuments.docType, input.docType),
          eq(customsDocuments.status, 'current'),
        ),
      );
    const [doc] = await tx
      .insert(customsDocuments)
      .values({
        shipmentId,
        docType: input.docType,
        version: Number(last!.v) + 1,
        fileId: file.id,
        status: 'current',
        reference: input.reference ?? null,
        validUntil: input.validUntil ?? null,
        note: input.note ?? null,
        uploadedBy: session.user.id,
        uploadedByOrgId: session.org?.id ?? null,
      })
      .returning();
    await shipmentEvent(
      tx,
      shipmentId,
      'customs.document_added',
      { userId: session.user.id, orgId: session.org?.id },
      { docType: input.docType, version: doc!.version },
    );
    await refreshPreparation(tx, shipmentId);
    return doc!;
  });
}

// ---------------------------------------------------------------- views

const READABLE_REASON: Record<string, string> = {
  confirm_route: 'Confirm the route (it may leave the EU customs territory)',
  choose_arrangement: 'Choose who handles this customs step',
  waiting_for_provider: 'Waiting for a customs provider to accept',
};

function readable(reason: string | null): string | null {
  if (!reason) return null;
  if (reason.startsWith('party:')) return `Name the ${reason.slice(6).replaceAll('_', ' ')}`;
  if (reason.startsWith('document:')) return `Upload the ${reason.slice(9).replaceAll('_', ' ')}`;
  return READABLE_REASON[reason] ?? reason;
}

/** Everything about customs on a shipment, for the customer, its provider and support. */
export async function customsOverview(ctx: Ctx, session: SessionInfo, shipmentId: string) {
  const { role } = await shipmentAccess(ctx, session, shipmentId);
  if (!['shipper', 'customs', 'platform'].includes(role)) throw forbidden();
  const procs = await ctx.db
    .select()
    .from(customsProcedures)
    .where(eq(customsProcedures.shipmentId, shipmentId))
    .orderBy(customsProcedures.createdAt);
  const parties = await ctx.db
    .select()
    .from(customsParties)
    .where(eq(customsParties.shipmentId, shipmentId));
  const docs = await ctx.db
    .select()
    .from(customsDocuments)
    .where(eq(customsDocuments.shipmentId, shipmentId))
    .orderBy(customsDocuments.docType, customsDocuments.version);
  const jobs = await ctx.db
    .select()
    .from(customsJobs)
    .where(eq(customsJobs.shipmentId, shipmentId));
  const quotes = jobs.length
    ? await ctx.db
        .select({ q: customsQuotes, name: organisations.name })
        .from(customsQuotes)
        .innerJoin(organisations, eq(organisations.id, customsQuotes.providerOrgId))
        .where(
          inArray(
            customsQuotes.jobId,
            jobs.map((j) => j.id),
          ),
        )
    : [];
  const names = await ctx.db
    .select({ id: organisations.id, name: organisations.name })
    .from(organisations)
    .where(
      inArray(organisations.id, [
        ...new Set(jobs.map((j) => j.providerOrgId).filter((x): x is string => !!x)),
        '00000000-0000-0000-0000-000000000000',
      ]),
    );
  return {
    role,
    procedures: procs.map((p) => ({
      ...p,
      statusText: readable(p.statusReason),
      requiredRoles: requiredRoles(p.kind as ProcedureKind),
      requiredDocuments: requiredDocuments(p.kind as ProcedureKind),
      canSkip: p.certainty === 'possible',
    })),
    parties: parties.map(({ ackTokenHash: _h, ...p }) => ({ ...p, pending: !p.acknowledgedAt })),
    documents: docs,
    jobs: jobs.map((j) => ({
      id: j.id,
      service: j.service,
      country: j.country,
      status: j.status,
      mode: j.mode,
      budgetMinor: role === 'shipper' || role === 'platform' ? j.budgetMinor : undefined,
      priceMinor: role === 'shipper' || role === 'platform' ? j.priceMinor : undefined,
      providerFeeMinor: role === 'customs' ? j.providerFeeMinor : undefined,
      provider: names.find((n) => n.id === j.providerOrgId)?.name ?? null,
      quotes:
        role === 'shipper' || role === 'platform'
          ? quotes
              .filter((q) => q.q.jobId === j.id)
              .map((q) => ({
                id: q.q.id,
                provider: q.name,
                totalMinor: q.q.totalMinor,
                overBudgetMinor: q.q.totalMinor - j.budgetMinor,
                note: q.q.note,
                status: q.q.status,
                expiresAt: q.q.expiresAt,
              }))
          : [],
    })),
    readiness: borderReadiness(
      procs.map((p) => ({
        id: p.id,
        kind: p.kind as ProcedureKind,
        status: p.status as ProcedureStatus,
        reference: p.reference,
        referenceType: p.referenceType,
      })),
    ),
  };
}

/** For the driver at the border: is everything ready, which references to show, whom to call. No prices. */
export async function borderReadinessView(ctx: Ctx, session: SessionInfo, shipmentId: string) {
  await shipmentAccess(ctx, session, shipmentId);
  const procs = await ctx.db
    .select()
    .from(customsProcedures)
    .where(eq(customsProcedures.shipmentId, shipmentId));
  const r = borderReadiness(
    procs.map((p) => ({
      id: p.id,
      kind: p.kind as ProcedureKind,
      status: p.status as ProcedureStatus,
      reference: p.reference,
      referenceType: p.referenceType,
    })),
  );
  const handlerIds = [
    ...new Set(procs.map((p) => p.handledByOrgId).filter((x): x is string => !!x)),
  ];
  const contacts = handlerIds.length
    ? await ctx.db
        .select({ name: organisations.name, phone: customsProviderProfiles.contactPhone })
        .from(organisations)
        .leftJoin(customsProviderProfiles, eq(customsProviderProfiles.orgId, organisations.id))
        .where(inArray(organisations.id, handlerIds))
    : [];
  const KIND: Record<string, string> = {
    export: 'Export declaration',
    import: 'Import declaration',
    transit: 'Transit (NCTS)',
    entry_safety_security: 'Safety & security (entry)',
    gb_gvms: 'GVMS movement reference',
  };
  const WHY: Record<string, string> = {
    not_far_enough: 'not ready yet',
    hold: 'on hold at customs',
    action_required: 'customs need something',
    no_reference: 'reference missing',
  };
  return {
    required: r.required,
    ready: r.ready,
    missing: r.missing.map((m) => `${KIND[m.kind] ?? m.kind}: ${WHY[m.reason]}`),
    references: procs
      .filter((p) => p.reference)
      .map((p) => ({
        label: `${KIND[p.kind] ?? p.kind}${p.referenceType ? ` (${p.referenceType})` : ''}`,
        value: p.reference!,
      })),
    contacts: contacts.map((c) => ({ name: c.name, phone: c.phone ?? null })),
  };
}

// ---------------------------------------------------------------- providers

export const providerProfileSchema = z.object({
  countries: z.array(z.string().regex(/^[A-Z]{2}$/)).max(60),
  services: z
    .array(
      z.enum([
        'export_declaration',
        'import_declaration',
        'transit_declaration',
        'safety_security_filing',
        'gvms_reference',
        'fiscal_formalities',
        'classification',
        'origin_documents',
        'consultation',
      ]),
    )
    .max(20),
  prices: z.record(z.number().int().min(0).max(100_000_00)).default({}),
  workingHours: z.string().trim().max(200).nullable().optional(),
  dailyCapacity: z.number().int().min(1).max(10_000).default(20),
  contactPhone: z.string().trim().max(40).nullable().optional(),
  contactEmail: z.string().trim().email().nullable().optional(),
  active: z.boolean().default(true),
});

export async function setProviderProfile(
  ctx: Ctx,
  actor: Actor & { orgId: string },
  input: z.infer<typeof providerProfileSchema>,
) {
  const values = {
    ...input,
    workingHours: input.workingHours ?? null,
    contactPhone: input.contactPhone ?? null,
    contactEmail: input.contactEmail ?? null,
    updatedAt: ctx.now(),
  };
  await ctx.db
    .insert(customsProviderProfiles)
    .values({ orgId: actor.orgId, ...values })
    .onConflictDoUpdate({ target: customsProviderProfiles.orgId, set: values });
  await audit(ctx.db, actor, 'customs.profile_changed', { type: 'organisation', id: actor.orgId });
}

export async function providerProfile(ctx: Ctx, orgId: string) {
  const [p] = await ctx.db
    .select()
    .from(customsProviderProfiles)
    .where(eq(customsProviderProfiles.orgId, orgId));
  return p ?? null;
}

/** Open customs jobs this provider could take. Never shows the customer's budget. */
export async function openCustomsJobs(ctx: Ctx, providerOrgId: string) {
  const profile = await providerProfile(ctx, providerOrgId);
  if (!profile) return { jobs: [], problems: ['no_profile'] };
  const jobs = await ctx.db
    .select()
    .from(customsJobs)
    .where(
      and(
        eq(customsJobs.status, 'open'),
        sql`${customsJobs.expiresAt} > ${ctx.now().toISOString()}`,
      ),
    );
  const today = ctx.now().toISOString().slice(0, 10);
  const out = [];
  let blocking: string[] = [];
  for (const j of jobs) {
    const problems = await providerProblems(ctx.db, providerOrgId, j, today);
    if (problems.some((p) => p === 'country_not_served' || p === 'service_not_offered')) continue;
    blocking = problems;
    const locs = await ctx.db
      .select()
      .from(shipmentLocations)
      .where(eq(shipmentLocations.shipmentId, j.shipmentId));
    const [s] = await ctx.db.select().from(shipments).where(eq(shipments.id, j.shipmentId));
    const p = locs.find((l) => l.kind === 'pickup')!;
    const d = locs.find((l) => l.kind === 'delivery')!;
    const myQuote = await ctx.db
      .select()
      .from(customsQuotes)
      .where(and(eq(customsQuotes.jobId, j.id), eq(customsQuotes.providerOrgId, providerOrgId)));
    out.push({
      id: j.id,
      service: j.service,
      country: j.country,
      mode: j.mode,
      listedFeeMinor: j.mode === 'standard' ? j.listedFeeMinor : null,
      currency: j.currency,
      route: `${p.city} (${p.country}) → ${d.city} (${d.country})`,
      pickupFrom: p.windowStart,
      goods: (s!.cargo as { description: string; hsCode: string | null }).description,
      hsCode: (s!.cargo as { hsCode: string | null }).hsCode,
      declaredValueMinor: (s!.cargo as { declaredValueMinor: number | null }).declaredValueMinor,
      expiresAt: j.expiresAt,
      myQuote: myQuote.find((q) => q.status === 'pending_customer') ?? null,
    });
  }
  const profileProblems =
    jobs.length === 0
      ? await providerProblems(
          ctx.db,
          providerOrgId,
          { country: '', service: '' } as typeof customsJobs.$inferSelect,
          today,
        )
      : blocking;
  return {
    jobs: out,
    problems: profileProblems.filter(
      (p) => p !== 'country_not_served' && p !== 'service_not_offered',
    ),
  };
}

export async function myCustomsJobs(ctx: Ctx, providerOrgId: string) {
  const jobs = await ctx.db
    .select()
    .from(customsJobs)
    .where(eq(customsJobs.providerOrgId, providerOrgId))
    .orderBy(sql`${customsJobs.assignedAt} desc`)
    .limit(200);
  const out = [];
  for (const j of jobs) {
    const procs = await ctx.db
      .select()
      .from(customsProcedures)
      .where(inArray(customsProcedures.id, j.procedureIds));
    const locs = await ctx.db
      .select()
      .from(shipmentLocations)
      .where(eq(shipmentLocations.shipmentId, j.shipmentId));
    out.push({
      id: j.id,
      shipmentId: j.shipmentId,
      service: j.service,
      country: j.country,
      status: j.status,
      providerFeeMinor: j.providerFeeMinor,
      currency: j.currency,
      route: `${locs.find((l) => l.kind === 'pickup')?.city} → ${locs.find((l) => l.kind === 'delivery')?.city}`,
      procedures: procs.map((p) => ({
        id: p.id,
        kind: p.kind,
        status: p.status,
        reference: p.reference,
        referenceType: p.referenceType,
      })),
    });
  }
  return out;
}

registerJob('issue_customs_invoice', async (ctx, payload) => {
  const { jobId } = payload as { jobId: string };
  const { issueCustomsInvoice } = await import('./invoices');
  await issueCustomsInvoice(ctx, jobId);
});
