import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { ledgerAccounts, ledgerEntries, ledgerTransactions } from '../db/schema';

/**
 * Double-entry ledger. Amounts: debit positive, credit negative; each transaction sums to zero
 * (the database refuses it otherwise). Accounts:
 *   psp_clearing (asset)               money held at the payment provider
 *   customer_funds (liability, per org) prepaid money not yet used for a booking
 *   carrier_payable (liability, per org) what we owe carriers
 *   platform_revenue_deferred (liability) our fee on booked, not yet completed transport
 *   vat_payable (liability)            VAT charged to customers
 */
export type AccountCode =
  | 'psp_clearing'
  | 'customer_funds'
  | 'carrier_payable'
  | 'platform_revenue_deferred'
  | 'platform_revenue'
  | 'vat_payable'
  | 'chargeback_receivable'
  | 'customs_provider_payable'
  | 'customs_revenue';

export interface LedgerLine {
  account: AccountCode;
  orgId?: string | null;
  amountMinor: number;
}

async function accountId(
  db: DbOrTx,
  code: AccountCode,
  orgId: string | null,
  currency: string,
): Promise<string> {
  const where = and(
    eq(ledgerAccounts.code, code),
    orgId ? eq(ledgerAccounts.orgId, orgId) : isNull(ledgerAccounts.orgId),
    eq(ledgerAccounts.currency, currency),
  );
  const found = await db.select({ id: ledgerAccounts.id }).from(ledgerAccounts).where(where);
  if (found[0]) return found[0].id;
  await db.insert(ledgerAccounts).values({ code, orgId, currency }).onConflictDoNothing();
  const again = await db.select({ id: ledgerAccounts.id }).from(ledgerAccounts).where(where);
  return again[0]!.id;
}

/**
 * Books a transaction once: a second call with the same idempotency key does nothing and
 * returns false.
 */
export async function post(
  db: DbOrTx,
  tx: {
    kind: string;
    refType: string;
    refId: string;
    idempotencyKey: string;
    memo?: string;
    currency: string;
  },
  lines: LedgerLine[],
): Promise<boolean> {
  const nonZero = lines.filter((l) => l.amountMinor !== 0);
  const sum = nonZero.reduce((s, l) => s + l.amountMinor, 0);
  if (sum !== 0) throw new Error(`ledger transaction ${tx.kind} does not balance (${sum})`);
  const inserted = await db
    .insert(ledgerTransactions)
    .values({
      kind: tx.kind,
      refType: tx.refType,
      refId: tx.refId,
      idempotencyKey: tx.idempotencyKey,
      memo: tx.memo ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: ledgerTransactions.id });
  const row = inserted[0];
  if (!row) return false;
  for (const l of nonZero) {
    const account = await accountId(db, l.account, l.orgId ?? null, tx.currency);
    await db.insert(ledgerEntries).values({
      transactionId: row.id,
      accountId: account,
      amountMinor: l.amountMinor,
      currency: tx.currency,
    });
  }
  return true;
}

/** Balance as the account holder sees it: liabilities positive when we owe money. */
export async function balance(
  db: DbOrTx,
  code: AccountCode,
  orgId: string | null,
  currency: string,
): Promise<number> {
  const res = await db.execute<{ total: string | null }>(sql`
    SELECT sum(e.amount_minor) AS total FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
    WHERE a.code = ${code} AND a.currency = ${currency}
      AND ${orgId ? sql`a.org_id = ${orgId}` : sql`a.org_id IS NULL`}`);
  const raw = Number(res.rows[0]?.total ?? 0);
  return code === 'psp_clearing' || code === 'chargeback_receivable' || raw === 0 ? raw : -raw;
}
