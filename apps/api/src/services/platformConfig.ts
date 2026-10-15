import { eq } from 'drizzle-orm';
import { COUNTRY_BY_CODE, DEFAULT_PRICING, type PricingConfig } from '@freight/shared';
import type { DbOrTx } from '../db/client';
import { countryConfiguration, pricingConfigurations } from '../db/schema';
import { badRequest } from '../lib/errors';

/** The active pricing configuration. The first call in a new database stores the defaults. */
export async function activePricing(db: DbOrTx): Promise<PricingConfig> {
  const [row] = await db
    .select()
    .from(pricingConfigurations)
    .where(eq(pricingConfigurations.active, true));
  if (row) return row.config as PricingConfig;
  await db
    .insert(pricingConfigurations)
    .values({
      version: DEFAULT_PRICING.version,
      config: DEFAULT_PRICING,
      active: true,
      note: 'Development defaults',
    })
    .onConflictDoNothing();
  const [again] = await db
    .select()
    .from(pricingConfigurations)
    .where(eq(pricingConfigurations.active, true));
  return (again?.config as PricingConfig) ?? DEFAULT_PRICING;
}

export interface CountryState {
  enabled: boolean;
  domesticEnabled: boolean;
  blocked?: string;
}

export async function countryState(db: DbOrTx, code: string): Promise<CountryState> {
  const info = COUNTRY_BY_CODE.get(code);
  if (!info) return { enabled: false, domesticEnabled: false, blocked: 'Unknown country' };
  if (info.blocked) return { enabled: false, domesticEnabled: false, blocked: info.blocked };
  const [row] = await db
    .select()
    .from(countryConfiguration)
    .where(eq(countryConfiguration.country, code));
  return { enabled: !!row?.enabled, domesticEnabled: !!row?.enabled && !!row?.domesticEnabled };
}

/** Throws unless a route from → to is open for business. */
export async function assertRouteOpen(db: DbOrTx, from: string, to: string) {
  const a = await countryState(db, from);
  const b = await countryState(db, to);
  for (const [code, s] of [
    [from, a],
    [to, b],
  ] as const) {
    if (s.blocked)
      throw badRequest(
        'country_blocked',
        `Transport to or from ${code} is not offered (${s.blocked})`,
      );
    if (!s.enabled) throw badRequest('country_not_available', `We do not operate in ${code} yet`);
  }
  if (from === to && !a.domesticEnabled)
    throw badRequest(
      'domestic_not_available',
      `Domestic transport inside ${from} is not offered yet`,
    );
}
