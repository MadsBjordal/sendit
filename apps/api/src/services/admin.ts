import { and, desc, eq, sql } from 'drizzle-orm';
import { COUNTRIES, type PricingConfig, type PlatformRole } from '@freight/shared';
import type { Ctx } from '../context';
import {
  auditLogs,
  countryConfiguration,
  jobs,
  organisations,
  pricingConfigurations,
  shipments,
  verificationDocuments,
} from '../db/schema';
import { badRequest, conflict, notFound } from '../lib/errors';
import { audit, type Actor } from './audit';

/** What each platform staff role may do. Every admin route checks one of these. */
export const PLATFORM_PERMISSIONS: Record<PlatformRole, string[]> = {
  platform_admin: [
    'orgs.review',
    'countries.manage',
    'pricing.manage',
    'shipments.view',
    'finance.view',
    'audit.view',
    'jobs.view',
    'disputes.resolve',
    'fraud.review',
    'privacy.handle',
    'support.reply',
    'analytics.view',
  ],
  platform_ops: [
    'orgs.review',
    'shipments.view',
    'jobs.view',
    'disputes.resolve',
    'fraud.review',
    'support.reply',
    'analytics.view',
  ],
  platform_finance: ['finance.view', 'shipments.view', 'fraud.review', 'analytics.view'],
  platform_support: ['shipments.view', 'support.reply', 'disputes.resolve'],
};

export function platformCan(role: string | null, permission: string): boolean {
  return !!role && (PLATFORM_PERMISSIONS[role as PlatformRole] ?? []).includes(permission);
}

export async function listOrganisations(ctx: Ctx, status?: string) {
  const rows = await ctx.db
    .select()
    .from(organisations)
    .where(status ? eq(organisations.status, status) : sql`${organisations.kind} <> 'platform'`)
    .orderBy(desc(organisations.createdAt))
    .limit(500);
  const docs = await ctx.db
    .select()
    .from(verificationDocuments)
    .orderBy(desc(verificationDocuments.createdAt));
  return rows.map((o) => ({ ...o, documents: docs.filter((d) => d.orgId === o.id) }));
}

export async function decideOrganisation(
  ctx: Ctx,
  actor: Actor & { userId: string },
  orgId: string,
  decision: 'verified' | 'rejected' | 'suspended',
  note: string | null,
) {
  const [o] = await ctx.db.select().from(organisations).where(eq(organisations.id, orgId));
  if (!o || o.kind === 'platform') throw notFound();
  if (decision !== 'verified' && !note)
    throw badRequest('note_required', 'Say why (the company sees this)');
  await ctx.db
    .update(organisations)
    .set({
      status: decision,
      statusNote: note,
      verifiedAt: decision === 'verified' ? ctx.now() : o.verifiedAt,
      verifiedBy: decision === 'verified' ? actor.userId : o.verifiedBy,
    })
    .where(eq(organisations.id, orgId));
  await audit(ctx.db, actor, `org.${decision}`, { type: 'organisation', id: orgId }, { note });
}

export async function reviewDocument(
  ctx: Ctx,
  actor: Actor & { userId: string },
  documentId: string,
  decision: 'approved' | 'rejected',
  note: string | null,
) {
  const [d] = await ctx.db
    .select()
    .from(verificationDocuments)
    .where(eq(verificationDocuments.id, documentId));
  if (!d) throw notFound();
  if (d.status !== 'pending') throw conflict('already_reviewed', `Already ${d.status}`);
  if (decision === 'rejected' && !note)
    throw badRequest('note_required', 'Say why it was rejected');
  await ctx.db
    .update(verificationDocuments)
    .set({ status: decision, reviewNote: note, reviewedBy: actor.userId, reviewedAt: ctx.now() })
    .where(eq(verificationDocuments.id, documentId));
  await audit(
    ctx.db,
    actor,
    `verification.document_${decision}`,
    { type: 'verification_document', id: documentId },
    { kind: d.kind, note },
  );
}

export async function listCountries(ctx: Ctx) {
  const rows = await ctx.db.select().from(countryConfiguration);
  return COUNTRIES.map((c) => {
    const r = rows.find((x) => x.country === c.code);
    return {
      ...c,
      enabled: !!r?.enabled && !c.blocked,
      domesticEnabled: !!r?.domesticEnabled && !c.blocked,
      note: r?.note ?? null,
      updatedAt: r?.updatedAt ?? null,
    };
  });
}

export async function setCountry(
  ctx: Ctx,
  actor: Actor & { userId: string },
  code: string,
  input: { enabled: boolean; domesticEnabled: boolean; note: string | null },
) {
  const info = COUNTRIES.find((c) => c.code === code);
  if (!info) throw notFound();
  if (info.blocked && (input.enabled || input.domesticEnabled))
    throw conflict('country_blocked', `${info.name} cannot be activated: ${info.blocked}`);
  await ctx.db
    .insert(countryConfiguration)
    .values({ country: code, ...input, updatedBy: actor.userId, updatedAt: ctx.now() })
    .onConflictDoUpdate({
      target: countryConfiguration.country,
      set: { ...input, updatedBy: actor.userId, updatedAt: ctx.now() },
    });
  await audit(ctx.db, actor, 'country.changed', { type: 'country', id: code }, input);
}

export async function listPricing(ctx: Ctx) {
  return ctx.db.select().from(pricingConfigurations).orderBy(desc(pricingConfigurations.createdAt));
}

function checkPricing(cfg: PricingConfig) {
  const fee = cfg.platformFee;
  if (!fee || !['markup_on_payout', 'commission_on_price'].includes(fee.kind))
    throw badRequest(
      'bad_pricing',
      'platformFee.kind must be markup_on_payout or commission_on_price',
    );
  if (fee.kind === 'commission_on_price' && (fee.bp <= 0 || fee.bp >= 10_000))
    throw badRequest('bad_pricing', 'A commission must be between 0 and 100 %');
  for (const [k, v] of Object.entries(cfg.vehicles ?? {}))
    if (
      !Number.isSafeInteger(v.baseMinor) ||
      !Number.isSafeInteger(v.perKmMinor) ||
      !Number.isSafeInteger(v.minimumMinor)
    )
      throw badRequest('bad_pricing', `Vehicle ${k}: amounts must be whole cents`);
  for (const lvl of ['standard', 'priority', 'express'] as const)
    if (!cfg.serviceLevels?.[lvl]) throw badRequest('bad_pricing', `Missing service level ${lvl}`);
}

/** A new pricing version. Old versions are kept: every shipment stores the version it was priced with. */
export async function createPricing(
  ctx: Ctx,
  actor: Actor & { userId: string },
  cfg: PricingConfig,
  activate: boolean,
  note: string | null,
) {
  checkPricing(cfg);
  await ctx.db.transaction(async (tx) => {
    const [exists] = await tx
      .select({ id: pricingConfigurations.id })
      .from(pricingConfigurations)
      .where(eq(pricingConfigurations.version, cfg.version));
    if (exists) throw conflict('version_exists', 'Choose a new version name');
    if (activate)
      await tx
        .update(pricingConfigurations)
        .set({ active: false })
        .where(eq(pricingConfigurations.active, true));
    await tx.insert(pricingConfigurations).values({
      version: cfg.version,
      config: cfg,
      active: activate,
      note,
      createdBy: actor.userId,
    });
    await audit(tx, actor, 'pricing.created', { type: 'pricing', id: cfg.version }, { activate });
  });
}

export async function activatePricing(
  ctx: Ctx,
  actor: Actor & { userId: string },
  version: string,
) {
  await ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(pricingConfigurations)
      .where(eq(pricingConfigurations.version, version));
    if (!row) throw notFound();
    await tx
      .update(pricingConfigurations)
      .set({ active: false })
      .where(eq(pricingConfigurations.active, true));
    await tx
      .update(pricingConfigurations)
      .set({ active: true })
      .where(eq(pricingConfigurations.version, version));
    await audit(tx, actor, 'pricing.activated', { type: 'pricing', id: version });
  });
}

export async function shipmentsOverview(ctx: Ctx) {
  const byStatus = await ctx.db
    .select({ status: shipments.status, n: sql<number>`count(*)::int` })
    .from(shipments)
    .groupBy(shipments.status);
  const recent = await ctx.db
    .select({
      id: shipments.id,
      number: shipments.number,
      status: shipments.status,
      serviceLevel: shipments.serviceLevel,
      org: organisations.name,
      maxPriceMinor: shipments.maxPriceMinor,
      createdAt: shipments.createdAt,
    })
    .from(shipments)
    .innerJoin(organisations, eq(organisations.id, shipments.orgId))
    .orderBy(desc(shipments.createdAt))
    .limit(100);
  return { byStatus, recent };
}

/** Ledger balances per account and currency: the reconciliation starting point. */
export async function ledgerSummary(ctx: Ctx) {
  const res = await ctx.db.execute<{ code: string; currency: string; total: number }>(sql`
    SELECT a.code, a.currency, sum(e.amount_minor)::bigint AS total
    FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
    GROUP BY a.code, a.currency ORDER BY a.code`);
  return res.rows.map((r) => ({ ...r, total: Number(r.total) }));
}

export async function auditTrail(ctx: Ctx, limit = 200) {
  return ctx.db.select().from(auditLogs).orderBy(desc(auditLogs.id)).limit(limit);
}

export async function problemJobs(ctx: Ctx) {
  return ctx.db
    .select()
    .from(jobs)
    .where(
      and(sql`${jobs.status} = 'dead' OR (${jobs.status} = 'queued' AND ${jobs.attempts} > 0)`),
    )
    .orderBy(desc(jobs.id))
    .limit(100);
}
