import { applyBp, BP_ONE, divCeil, divRound, type Currency } from './money';
import type { VehicleClass } from './vehicles';

/**
 * The pricing engine. Kept as separate concepts, never mixed:
 *  - carrier payout:          what the carrier is paid (CARRIER_OFFERED_PAYOUT)
 *  - platform fee:            the platform's gross margin on the transport (PLATFORM_GROSS_MARGIN)
 *  - net price:               payout + platform fee, before tax
 *  - tax:                     VAT on the net price where it applies
 *  - total:                   what the customer pays (ESTIMATED_ / FINAL_CUSTOMER_PRICE)
 * Customs service fees and customs duties/taxes are never part of these numbers.
 *
 * Markup and commission are different things and both are supported:
 *  - markup_on_payout 1000 bp:     fee = 10 % of the payout       (payout 520 → fee 52, net 572)
 *  - commission_on_price 1000 bp:  fee = 10 % of the net price    (payout 520 → net 577.78, fee 57.78)
 */
export type ServiceLevel = 'standard' | 'priority' | 'express';
export const SERVICE_LEVELS: ServiceLevel[] = ['standard', 'priority', 'express'];

export interface VehicleRate {
  /** Fixed part of the carrier cost (loading, positioning) */
  baseMinor: number;
  /** Per estimated road km */
  perKmMinor: number;
  /** Lowest carrier cost for this vehicle */
  minimumMinor: number;
}

export interface ServiceLevelRule {
  /** Multiplier on the carrier cost, 10 000 = × 1.00 */
  factorBp: number;
  /** How long the request stays open before it expires without a carrier (minutes) */
  searchMinutes: number;
  /** Radius around the pickup to look for vehicles first, km; widened step by step */
  initialRadiusKm: number;
  maxRadiusKm: number;
  /** Earliest pickup this level may be booked for, minutes from now (an operational target, not a promise) */
  pickupLeadMinutes: number;
}

export type PlatformFeeRule =
  | { kind: 'markup_on_payout'; bp: number; minimumMinor: number }
  | { kind: 'commission_on_price'; bp: number; minimumMinor: number };

export interface PricingConfig {
  version: string;
  currency: Currency;
  vehicles: Record<VehicleClass, VehicleRate>;
  serviceLevels: Record<ServiceLevel, ServiceLevelRule>;
  /** Multiplier per country of the pickup and of the delivery (average of both is used), 10 000 = × 1 */
  countryFactorBp: Record<string, number>;
  /** Extra fixed cost for a corridor such as "DE-NO" (ferries, bridges), carrier side */
  corridorSurchargeMinor: Record<string, number>;
  /** Road tolls estimated per km by vehicle size: light (vans) or heavy */
  tollPerKmMinor: { light: number; heavy: number };
  /** Empty kilometres expected to reach the pickup, as a share of the trip */
  emptyKmBp: number;
  platformFee: PlatformFeeRule;
  /**
   * VAT on the transport. Cross-border B2B transport is normally reverse charged and domestic
   * transport carries the country's VAT, but this MUST be confirmed by a tax adviser before launch.
   */
  vatBpByCountry: Record<string, number>;
}

export const HEAVY_CLASSES: VehicleClass[] = [
  'rigid_truck',
  'curtainsider',
  'articulated',
  'refrigerated',
  'flatbed',
  'specialist',
];

export interface EstimateInput {
  vehicleClass: VehicleClass;
  serviceLevel: ServiceLevel;
  distanceKm: number;
  fromCountry: string;
  toCountry: string;
}

export interface CarrierCostBreakdown {
  baseMinor: number;
  distanceMinor: number;
  emptyKmMinor: number;
  tollsMinor: number;
  corridorMinor: number;
  serviceLevelMinor: number;
  countryMinor: number;
  totalMinor: number;
}

/** What a carrier is likely to need for the trip: the payout we list to carriers. */
export function estimateCarrierPayout(
  input: EstimateInput,
  cfg: PricingConfig,
): CarrierCostBreakdown {
  const rate = cfg.vehicles[input.vehicleClass];
  const km = Math.max(0, Math.round(input.distanceKm));
  const baseMinor = rate.baseMinor;
  const distanceMinor = km * rate.perKmMinor;
  const emptyKmMinor = applyBp(distanceMinor, cfg.emptyKmBp);
  const tollRate = HEAVY_CLASSES.includes(input.vehicleClass)
    ? cfg.tollPerKmMinor.heavy
    : cfg.tollPerKmMinor.light;
  const tollsMinor = km * tollRate;
  const corridorMinor =
    cfg.corridorSurchargeMinor[`${input.fromCountry}-${input.toCountry}`] ??
    cfg.corridorSurchargeMinor[`${input.toCountry}-${input.fromCountry}`] ??
    0;
  let subtotal = Math.max(
    rate.minimumMinor,
    baseMinor + distanceMinor + emptyKmMinor + tollsMinor + corridorMinor,
  );
  const level = cfg.serviceLevels[input.serviceLevel];
  const serviceLevelMinor = applyBp(subtotal, level.factorBp - BP_ONE);
  subtotal += serviceLevelMinor;
  const fromF = cfg.countryFactorBp[input.fromCountry] ?? BP_ONE;
  const toF = cfg.countryFactorBp[input.toCountry] ?? BP_ONE;
  const countryBp = Math.round((fromF + toF) / 2);
  const countryMinor = applyBp(subtotal, countryBp - BP_ONE);
  subtotal += countryMinor;
  // Carriers see round numbers: up to the next whole euro
  const totalMinor = divCeil(subtotal, 100) * 100;
  return {
    baseMinor,
    distanceMinor,
    emptyKmMinor,
    tollsMinor,
    corridorMinor,
    serviceLevelMinor,
    countryMinor,
    totalMinor,
  };
}

export interface TaxContext {
  fromCountry: string;
  toCountry: string;
  /** Country the customer company is established in */
  customerCountry: string;
}

export interface TaxDecision {
  vatBp: number;
  basis: 'domestic' | 'reverse_charge_assumed';
  note: string;
}

/**
 * Simplified VAT rule, flagged for tax review (COMPLIANCE.md): domestic transport for a customer
 * established in that country carries the country's VAT; everything else is treated as B2B reverse
 * charge with no VAT on our invoice.
 */
export function taxFor(ctx: TaxContext, cfg: PricingConfig): TaxDecision {
  if (ctx.fromCountry === ctx.toCountry && ctx.customerCountry === ctx.fromCountry) {
    const vatBp = cfg.vatBpByCountry[ctx.fromCountry];
    if (vatBp != null)
      return { vatBp, basis: 'domestic', note: `Domestic transport: ${ctx.fromCountry} VAT` };
  }
  return {
    vatBp: 0,
    basis: 'reverse_charge_assumed',
    note: 'B2B reverse charge assumed (to be confirmed by tax adviser)',
  };
}

export interface CustomerPrice {
  currency: Currency;
  payoutMinor: number;
  platformFeeMinor: number;
  netMinor: number;
  vatBp: number;
  vatMinor: number;
  totalMinor: number;
  pricingVersion: string;
  taxBasis: TaxDecision['basis'];
}

/** The customer's total for a given carrier payout. All prices are calculated on the server with this. */
export function customerPriceForPayout(
  payoutMinor: number,
  tax: TaxContext,
  cfg: PricingConfig,
): CustomerPrice {
  if (!Number.isSafeInteger(payoutMinor) || payoutMinor <= 0)
    throw new Error('payout must be a positive whole amount');
  const fee = cfg.platformFee;
  let platformFeeMinor: number;
  if (fee.kind === 'markup_on_payout') {
    platformFeeMinor = applyBp(payoutMinor, fee.bp);
  } else {
    // net = payout / (1 - commission); rounded up so the platform never earns less than its rate
    const net = divCeil(payoutMinor * BP_ONE, BP_ONE - fee.bp);
    platformFeeMinor = net - payoutMinor;
  }
  platformFeeMinor = Math.max(fee.minimumMinor, platformFeeMinor);
  const netMinor = payoutMinor + platformFeeMinor;
  const t = taxFor(tax, cfg);
  const vatMinor = applyBp(netMinor, t.vatBp);
  return {
    currency: cfg.currency,
    payoutMinor,
    platformFeeMinor,
    netMinor,
    vatBp: t.vatBp,
    vatMinor,
    totalMinor: netMinor + vatMinor,
    pricingVersion: cfg.version,
    taxBasis: t.basis,
  };
}

/**
 * The highest payout whose customer total stays within a ceiling. Used to list a payout to carriers
 * when the customer's maximum is below the estimate. Never shown to carriers as "the customer's maximum".
 */
export function maxPayoutWithin(ceilingMinor: number, tax: TaxContext, cfg: PricingConfig): number {
  // Monotonic in payout: binary search over whole euros, then cents
  let lo = 0;
  let hi = ceilingMinor;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (mid > 0 && customerPriceForPayout(mid, tax, cfg).totalMinor <= ceilingMinor) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export interface Estimate {
  vehicleClass: VehicleClass;
  serviceLevel: ServiceLevel;
  distanceKm: number;
  carrier: CarrierCostBreakdown;
  customer: CustomerPrice;
  /** True while the platform has too few real bookings on this corridor to call it a market price */
  indicative: boolean;
}

export function estimate(input: EstimateInput, tax: TaxContext, cfg: PricingConfig): Estimate {
  const carrier = estimateCarrierPayout(input, cfg);
  return {
    vehicleClass: input.vehicleClass,
    serviceLevel: input.serviceLevel,
    distanceKm: input.distanceKm,
    carrier,
    customer: customerPriceForPayout(carrier.totalMinor, tax, cfg),
    indicative: true,
  };
}

/** How much a price is above a ceiling, for the "above your maximum" screen. */
export function overCeiling(
  totalMinor: number,
  ceilingMinor: number,
): { overMinor: number; overBp: number } {
  const overMinor = totalMinor - ceilingMinor;
  return { overMinor, overBp: ceilingMinor > 0 ? divRound(overMinor * BP_ONE, ceilingMinor) : 0 };
}

/**
 * Development defaults. Every number here is a placeholder to be replaced from real carrier
 * quotes before launch; the admin can change them (pricing_configuration, versioned).
 */
export const DEFAULT_PRICING: PricingConfig = {
  version: 'dev-2026-10-15',
  currency: 'EUR',
  vehicles: {
    van_light: { baseMinor: 4_000, perKmMinor: 55, minimumMinor: 9_000 },
    van_large: { baseMinor: 5_000, perKmMinor: 70, minimumMinor: 12_000 },
    box_truck: { baseMinor: 8_000, perKmMinor: 95, minimumMinor: 18_000 },
    rigid_truck: { baseMinor: 10_000, perKmMinor: 115, minimumMinor: 25_000 },
    curtainsider: { baseMinor: 12_000, perKmMinor: 135, minimumMinor: 35_000 },
    articulated: { baseMinor: 12_000, perKmMinor: 135, minimumMinor: 35_000 },
    refrigerated: { baseMinor: 15_000, perKmMinor: 165, minimumMinor: 42_000 },
    flatbed: { baseMinor: 14_000, perKmMinor: 150, minimumMinor: 40_000 },
    specialist: { baseMinor: 30_000, perKmMinor: 250, minimumMinor: 80_000 },
  },
  serviceLevels: {
    standard: {
      factorBp: 10_000,
      searchMinutes: 48 * 60,
      initialRadiusKm: 150,
      maxRadiusKm: 600,
      pickupLeadMinutes: 24 * 60,
    },
    priority: {
      factorBp: 11_500,
      searchMinutes: 12 * 60,
      initialRadiusKm: 100,
      maxRadiusKm: 400,
      pickupLeadMinutes: 8 * 60,
    },
    express: {
      factorBp: 14_000,
      searchMinutes: 2 * 60,
      initialRadiusKm: 60,
      maxRadiusKm: 200,
      pickupLeadMinutes: 2 * 60,
    },
  },
  countryFactorBp: {
    NO: 13_000,
    CH: 13_500,
    GB: 11_500,
    DK: 11_500,
    SE: 11_000,
    PL: 9_000,
    CZ: 9_200,
    RO: 8_800,
    BG: 8_600,
    HU: 9_000,
  },
  corridorSurchargeMinor: {
    'DE-NO': 12_000,
    'DK-NO': 9_000,
    'FR-GB': 25_000,
    'NL-GB': 30_000,
    'BE-GB': 25_000,
    'DE-SE': 8_000,
    'PL-SE': 15_000,
  },
  tollPerKmMinor: { light: 2, heavy: 18 },
  emptyKmBp: 1_500,
  platformFee: { kind: 'markup_on_payout', bp: 1_000, minimumMinor: 1_500 },
  vatBpByCountry: {
    AT: 2000,
    BE: 2100,
    BG: 2000,
    HR: 2500,
    CY: 1900,
    CZ: 2100,
    DK: 2500,
    EE: 2400,
    FI: 2550,
    FR: 2000,
    DE: 1900,
    GR: 2400,
    HU: 2700,
    IE: 2300,
    IT: 2200,
    LV: 2100,
    LT: 2100,
    LU: 1700,
    MT: 1800,
    NL: 2100,
    PL: 2300,
    PT: 2300,
    RO: 2100,
    SK: 2300,
    SI: 2200,
    ES: 2100,
    SE: 2500,
    NO: 2500,
    CH: 810,
    GB: 2000,
  },
};
