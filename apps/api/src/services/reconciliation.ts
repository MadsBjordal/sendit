import { sql } from 'drizzle-orm';
import type { Ctx } from '../context';

/**
 * Compares the ledger with the operational records it should match. Every line is a check that
 * must be zero; anything else is listed for the finance team. Bank statements from the payment
 * provider are the next layer (provider settlement reports, once a real provider is connected).
 */
export async function reconciliation(ctx: Ctx) {
  const q = async (s: ReturnType<typeof sql>) =>
    (await ctx.db.execute<Record<string, unknown>>(s)).rows;
  const ledger = await q(sql`
    SELECT a.code, a.currency, sum(e.amount_minor)::bigint AS total
    FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id GROUP BY a.code, a.currency`);
  const bal = (code: string, currency = 'EUR') =>
    Number(ledger.find((r) => r.code === code && r.currency === currency)?.total ?? 0);

  const [paid] = await q(
    sql`SELECT coalesce(sum(amount_minor), 0)::bigint AS v FROM payments WHERE status = 'succeeded' AND currency = 'EUR'`,
  );
  const [refunded] = await q(
    sql`SELECT coalesce(sum(amount_minor), 0)::bigint AS v FROM refunds WHERE status <> 'failed' AND currency = 'EUR'`,
  );
  const [paidOut] = await q(
    sql`SELECT coalesce(sum(amount_minor), 0)::bigint AS v FROM payouts WHERE status IN ('pending', 'paid') AND currency = 'EUR'`,
  );
  const [owed] =
    await q(sql`SELECT coalesce(sum(o.amount_minor), 0)::bigint AS v FROM carrier_obligations o
    WHERE o.status IN ('committed', 'payable', 'on_hold', 'disputed') AND o.currency = 'EUR'
      AND NOT EXISTS (SELECT 1 FROM payouts p WHERE p.obligation_id = o.id AND p.status IN ('pending', 'paid'))`);
  const [held] = await q(sql`
    SELECT coalesce(sum(s.funded_minor - coalesce(b.total_minor, 0)), 0)::bigint AS v
    FROM shipments s LEFT JOIN bookings b ON b.shipment_id = s.id WHERE s.currency = 'EUR'`);
  const [chargebacks] = await q(
    sql`SELECT coalesce(sum(e.amount_minor), 0)::bigint AS v FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.code = 'chargeback_receivable' AND a.currency = 'EUR'`,
  );

  const checks = [
    {
      check: 'Money at the provider = payments − refunds − payouts − chargebacks',
      ledger: bal('psp_clearing'),
      expected: Number(paid!.v) - Number(refunded!.v) - Number(paidOut!.v) - Number(chargebacks!.v),
    },
    {
      check: 'Owed to carriers = open obligations without a payout on its way',
      ledger: -bal('carrier_payable'),
      expected: Number(owed!.v),
    },
    {
      check: 'Customer money held = paid in − used by bookings − refunded',
      ledger: -bal('customer_funds'),
      expected: Number(held!.v),
    },
  ].map((c) => ({ ...c, difference: c.ledger - c.expected, ok: c.ledger === c.expected }));

  const missingBookingTx = await q(sql`
    SELECT b.id FROM bookings b LEFT JOIN ledger_transactions t ON t.idempotency_key = 'booking:' || b.id WHERE t.id IS NULL LIMIT 50`);
  const missingPaymentTx = await q(sql`
    SELECT p.id FROM payments p LEFT JOIN ledger_transactions t ON t.idempotency_key = 'payment:' || p.id || ':received'
    WHERE p.status = 'succeeded' AND t.id IS NULL LIMIT 50`);
  const unbalanced = await q(sql`
    SELECT transaction_id FROM ledger_entries GROUP BY transaction_id, currency HAVING sum(amount_minor) <> 0 LIMIT 50`);

  return {
    currency: 'EUR',
    checks,
    problems: {
      bookingsWithoutLedger: missingBookingTx.map((r) => r.id),
      paymentsWithoutLedger: missingPaymentTx.map((r) => r.id),
      unbalancedTransactions: unbalanced.map((r) => r.transaction_id),
    },
    allOk:
      checks.every((c) => c.ok) &&
      missingBookingTx.length === 0 &&
      missingPaymentTx.length === 0 &&
      unbalanced.length === 0,
    balances: ledger.map((r) => ({ code: r.code, currency: r.currency, total: Number(r.total) })),
  };
}
