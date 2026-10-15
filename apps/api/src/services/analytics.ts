import { sql, type SQL } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import type { Ctx } from '../context';

/**
 * Platform analytics for a period (and optionally a country). Gross freight value (what customers
 * pay for transport) is reported separately from platform revenue (our fees): they are never mixed.
 * Payment costs are estimated from the configured provider rate until real settlement data exists.
 */
export interface AnalyticsQuery {
  from: string;
  to: string;
  country?: string;
}

const PSP_BP = 140; // 1.4 % estimated card/transfer cost
const PSP_FIXED_MINOR = 25;

export async function analytics(ctx: Ctx, q: AnalyticsQuery) {
  const from = new Date(q.from).toISOString();
  const to = new Date(new Date(q.to).getTime() + 86_400_000).toISOString();
  const country: SQL = q.country
    ? sql`AND EXISTS (SELECT 1 FROM shipment_locations l WHERE l.shipment_id = s.id AND l.country = ${q.country})`
    : sql``;
  const one = async (s: SQL) => (await ctx.db.execute<Record<string, unknown>>(s)).rows[0] ?? {};
  const many = async (s: SQL) => (await ctx.db.execute<Record<string, unknown>>(s)).rows;
  const n = (v: unknown) => Number(v ?? 0);

  const totals = await one(sql`
    SELECT count(*)::int AS requests,
      count(*) FILTER (WHERE s.status IN ('booked','in_transit','delivered','completed','disputed'))::int AS booked,
      count(*) FILTER (WHERE s.status = 'completed')::int AS completed,
      count(*) FILTER (WHERE s.status = 'expired')::int AS expired,
      count(*) FILTER (WHERE s.status = 'cancelled')::int AS cancelled,
      avg(extract(epoch FROM s.booked_at - s.published_at) / 60) FILTER (WHERE s.booked_at IS NOT NULL)::float AS avg_acceptance_minutes
    FROM shipments s WHERE s.created_at >= ${from} AND s.created_at < ${to} ${country}`);
  const money = await one(sql`
    SELECT coalesce(sum(b.total_minor), 0)::bigint AS gross_freight_value,
      coalesce(sum(b.net_minor), 0)::bigint AS net_freight_value,
      coalesce(sum(b.payout_minor), 0)::bigint AS carrier_payouts,
      coalesce(sum(b.platform_fee_minor), 0)::bigint AS platform_fees_booked,
      coalesce(avg(b.payout_minor), 0)::float AS avg_payout,
      coalesce(avg(b.total_minor), 0)::float AS avg_customer_price,
      count(*)::int AS bookings
    FROM bookings b JOIN shipments s ON s.id = b.shipment_id WHERE b.created_at >= ${from} AND b.created_at < ${to} ${country}`);
  const revenue = await one(sql`
    SELECT coalesce(-sum(e.amount_minor) FILTER (WHERE a.code = 'platform_revenue'), 0)::bigint AS platform_revenue,
      coalesce(-sum(e.amount_minor) FILTER (WHERE a.code = 'customs_revenue'), 0)::bigint AS customs_revenue
    FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE e.created_at >= ${from} AND e.created_at < ${to}`);
  const paymentsRow = await one(sql`
    SELECT count(*)::int AS payments, coalesce(sum(amount_minor), 0)::bigint AS paid_in
    FROM payments WHERE status = 'succeeded' AND updated_at >= ${from} AND updated_at < ${to}`);
  const risk = await one(sql`
    SELECT coalesce(sum(e.amount_minor) FILTER (WHERE a.code = 'chargeback_receivable'), 0)::bigint AS chargeback_exposure
    FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id`);
  const chargebacks = await one(
    sql`SELECT count(*)::int AS n, coalesce(sum((details->>'amountMinor')::bigint), 0)::bigint AS amount FROM fraud_alerts WHERE kind = 'chargeback' AND created_at >= ${from} AND created_at < ${to}`,
  );
  const onTime = await one(sql`
    SELECT count(*) FILTER (WHERE s.delivered_at <= l.window_end)::int AS on_time, count(*)::int AS delivered
    FROM shipments s JOIN shipment_locations l ON l.shipment_id = s.id AND l.kind = 'delivery'
    WHERE s.delivered_at IS NOT NULL AND s.delivered_at >= ${from} AND s.delivered_at < ${to} ${country}`);
  const carriers = await one(sql`
    SELECT (SELECT count(*) FROM organisations WHERE kind = 'carrier' AND status = 'verified')::int AS verified,
      (SELECT count(DISTINCT carrier_org_id) FROM bookings WHERE created_at >= ${from} AND created_at < ${to})::int AS active`);
  const shippers = await one(sql`
    SELECT count(*)::int AS shippers, count(*) FILTER (WHERE n > 1)::int AS returning
    FROM (SELECT org_id, count(*) AS n FROM shipments s WHERE s.created_at >= ${from} AND s.created_at < ${to} GROUP BY org_id) x`);
  const customs = await one(sql`
    SELECT count(*)::int AS jobs, avg(extract(epoch FROM assigned_at - created_at) / 60) FILTER (WHERE assigned_at IS NOT NULL)::float AS avg_response_minutes
    FROM customs_jobs WHERE created_at >= ${from} AND created_at < ${to}`);
  const borderDelays = await one(
    sql`SELECT count(*)::int AS n FROM shipment_events WHERE kind = 'customs.status' AND data->>'status' IN ('BORDER_HOLD','BORDER_ACTION_REQUIRED') AND created_at >= ${from} AND created_at < ${to}`,
  );
  const claims = await one(
    sql`SELECT count(*)::int AS n FROM disputes WHERE created_at >= ${from} AND created_at < ${to}`,
  );
  const tickets = await one(
    sql`SELECT count(*)::int AS n FROM support_tickets WHERE created_at >= ${from} AND created_at < ${to}`,
  );
  const byCorridor = await many(sql`
    SELECT p.country || '-' || d.country AS corridor, count(*)::int AS shipments, coalesce(sum(b.total_minor), 0)::bigint AS gross_freight_value
    FROM shipments s JOIN shipment_locations p ON p.shipment_id = s.id AND p.kind = 'pickup' JOIN shipment_locations d ON d.shipment_id = s.id AND d.kind = 'delivery'
    LEFT JOIN bookings b ON b.shipment_id = s.id
    WHERE s.created_at >= ${from} AND s.created_at < ${to} ${country} GROUP BY 1 ORDER BY 2 DESC LIMIT 50`);
  const byCountry = await many(sql`
    SELECT l.country, count(DISTINCT s.id)::int AS shipments FROM shipments s JOIN shipment_locations l ON l.shipment_id = s.id
    WHERE s.created_at >= ${from} AND s.created_at < ${to} ${country} GROUP BY 1 ORDER BY 2 DESC`);
  const byLevel = await many(sql`
    SELECT s.service_level, count(*)::int AS shipments, count(b.id)::int AS booked FROM shipments s LEFT JOIN bookings b ON b.shipment_id = s.id
    WHERE s.created_at >= ${from} AND s.created_at < ${to} ${country} GROUP BY 1 ORDER BY 1`);

  const paymentCosts =
    Math.round((n(paymentsRow.paid_in) * PSP_BP) / 10_000) +
    n(paymentsRow.payments) * PSP_FIXED_MINOR;
  const platformRevenue = n(revenue.platform_revenue) + n(revenue.customs_revenue);
  const decided = n(totals.booked) + n(totals.expired);
  return {
    period: { from: q.from, to: q.to, country: q.country ?? null },
    shipments: {
      requests: n(totals.requests),
      booked: n(totals.booked),
      completed: n(totals.completed),
      expired: n(totals.expired),
      cancelled: n(totals.cancelled),
      assignmentSuccessRate: decided ? n(totals.booked) / decided : null,
      avgAcceptanceMinutes:
        totals.avg_acceptance_minutes == null ? null : Math.round(n(totals.avg_acceptance_minutes)),
      onTimeDeliveryRate: n(onTime.delivered) ? n(onTime.on_time) / n(onTime.delivered) : null,
    },
    money: {
      currency: 'EUR',
      grossFreightValueMinor: n(money.gross_freight_value),
      carrierPayoutsMinor: n(money.carrier_payouts),
      avgCarrierPayoutMinor: Math.round(n(money.avg_payout)),
      avgCustomerPriceMinor: Math.round(n(money.avg_customer_price)),
      platformFeesBookedMinor: n(money.platform_fees_booked),
      marketplaceRevenueMinor: n(revenue.platform_revenue),
      customsServiceRevenueMinor: n(revenue.customs_revenue),
      estimatedPaymentCostsMinor: paymentCosts,
      contributionMarginMinor: platformRevenue - paymentCosts,
      chargebacks: { count: n(chargebacks.n), amountMinor: n(chargebacks.amount) },
      customerDefaultExposureMinor: n(risk.chargeback_exposure),
    },
    marketplace: {
      verifiedCarriers: n(carriers.verified),
      activeCarriers: n(carriers.active),
      carrierActivationRate: n(carriers.verified)
        ? n(carriers.active) / n(carriers.verified)
        : null,
      shippers: n(shippers.shippers),
      returningShippers: n(shippers.returning),
      shipperRetentionRate: n(shippers.shippers)
        ? n(shippers.returning) / n(shippers.shippers)
        : null,
    },
    customs: {
      jobs: n(customs.jobs),
      avgProviderResponseMinutes:
        customs.avg_response_minutes == null ? null : Math.round(n(customs.avg_response_minutes)),
      borderDelays: n(borderDelays.n),
    },
    service: { claims: n(claims.n), supportTickets: n(tickets.n) },
    byCorridor: byCorridor.map((r) => ({
      corridor: String(r.corridor),
      shipments: n(r.shipments),
      grossFreightValueMinor: n(r.gross_freight_value),
    })),
    byCountry: byCountry.map((r) => ({ country: String(r.country), shipments: n(r.shipments) })),
    byServiceLevel: byLevel.map((r) => ({
      serviceLevel: String(r.service_level),
      shipments: n(r.shipments),
      booked: n(r.booked),
    })),
  };
}

type Report = Awaited<ReturnType<typeof analytics>>;

function rows(r: Report): Array<[string, string | number | null]> {
  const flat: Array<[string, string | number | null]> = [];
  const walk = (prefix: string, o: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === 'object' && !Array.isArray(v))
        walk(`${prefix}${k}.`, v as Record<string, unknown>);
      else if (!Array.isArray(v)) flat.push([`${prefix}${k}`, v as string | number | null]);
    }
  };
  walk('', {
    period: r.period,
    shipments: r.shipments,
    money: r.money,
    marketplace: r.marketplace,
    customs: r.customs,
    service: r.service,
  });
  return flat;
}

/** CSV: one metric per line, then the corridor table. Amounts in cents (minor units). */
export function analyticsCsv(r: Report): string {
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    // Leading = + - @ would run as a formula in spreadsheet programs
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const lines = [
    'metric,value',
    ...rows(r).map(([k, v]) => `${esc(k)},${esc(v)}`),
    '',
    'corridor,shipments,gross_freight_value_minor',
    ...r.byCorridor.map((c) => `${esc(c.corridor)},${c.shipments},${c.grossFreightValueMinor}`),
  ];
  return lines.join('\n') + '\n';
}

export async function analyticsXlsx(r: Report): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const summary = wb.addWorksheet('Summary');
  summary.addRow(['Metric', 'Value']).font = { bold: true };
  for (const [k, v] of rows(r)) summary.addRow([k, v]);
  summary.getColumn(1).width = 42;
  const corridors = wb.addWorksheet('Corridors');
  corridors.addRow(['Corridor', 'Shipments', 'Gross freight value (EUR)']).font = { bold: true };
  for (const c of r.byCorridor)
    corridors.addRow([c.corridor, c.shipments, c.grossFreightValueMinor / 100]);
  const countries = wb.addWorksheet('Countries');
  countries.addRow(['Country', 'Shipments']).font = { bold: true };
  for (const c of r.byCountry) countries.addRow([c.country, c.shipments]);
  const levels = wb.addWorksheet('Service levels');
  levels.addRow(['Service level', 'Shipments', 'Booked']).font = { bold: true };
  for (const l of r.byServiceLevel) levels.addRow([l.serviceLevel, l.shipments, l.booked]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
