/**
 * Money is kept as whole minor units (cents) in safe integers, never as floating point.
 * Percentages are basis points (1 bp = 0.01 %, 10 000 bp = 100 %), so every calculation is exact
 * integer arithmetic with one explicit rounding step (half away from zero).
 */
export type Currency =
  'EUR' | 'NOK' | 'SEK' | 'DKK' | 'PLN' | 'CZK' | 'HUF' | 'RON' | 'BGN' | 'CHF' | 'GBP';

export const CURRENCIES: Currency[] = [
  'EUR',
  'NOK',
  'SEK',
  'DKK',
  'PLN',
  'CZK',
  'HUF',
  'RON',
  'BGN',
  'CHF',
  'GBP',
];

export interface Money {
  /** Whole minor units, e.g. 57200 = €572.00 */
  amount: number;
  currency: Currency;
}

export const BP_ONE = 10_000;

export function assertMinor(n: number, what = 'amount'): number {
  if (!Number.isSafeInteger(n))
    throw new Error(`${what} must be a whole number of minor units, got ${n}`);
  return n;
}

/** Integer division rounded half away from zero. */
export function divRound(numerator: number, denominator: number): number {
  assertMinor(numerator, 'numerator');
  if (!Number.isSafeInteger(denominator) || denominator === 0) throw new Error('bad denominator');
  const sign = Math.sign(numerator) * Math.sign(denominator);
  const n = Math.abs(numerator);
  const d = Math.abs(denominator);
  const q = Math.floor(n / d);
  const r = n - q * d;
  return sign * (r * 2 >= d ? q + 1 : q);
}

/** Integer division rounded up (towards +infinity) for positive denominators. */
export function divCeil(numerator: number, denominator: number): number {
  assertMinor(numerator, 'numerator');
  if (!Number.isSafeInteger(denominator) || denominator <= 0) throw new Error('bad denominator');
  const q = Math.floor(numerator / denominator);
  return numerator - q * denominator === 0 ? q : q + 1;
}

/** amount × bp / 10 000, rounded half away from zero. */
export function applyBp(amount: number, bp: number): number {
  assertMinor(amount);
  assertMinor(bp, 'basis points');
  return divRound(amount * bp, BP_ONE);
}

export function money(amount: number, currency: Currency = 'EUR'): Money {
  return { amount: assertMinor(amount), currency };
}

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new Error(`currency mismatch ${a.currency}/${b.currency}`);
  return money(a.amount + b.amount, a.currency);
}

/** Parse a user-typed decimal like "572", "572.5" or "572,50" into minor units, exactly. */
export function parseMajor(text: string): number | null {
  const t = text.trim().replace(/\s/g, '').replace(',', '.');
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  const whole = Number(m[1]);
  const frac = Number((m[2] ?? '').padEnd(2, '0'));
  return whole * 100 + frac;
}

export function formatMoney(m: Money, locale = 'en'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: m.currency }).format(
    m.amount / 100,
  );
}
