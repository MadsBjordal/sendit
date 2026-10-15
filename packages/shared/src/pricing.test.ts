import { describe, expect, it } from 'vitest';
import {
  customerPriceForPayout,
  DEFAULT_PRICING,
  estimate,
  maxPayoutWithin,
  type PricingConfig,
} from './pricing';
import { applyBp, divRound, parseMajor } from './money';

const crossBorder = { fromCountry: 'DE', toCountry: 'NL', customerCountry: 'DE' };

describe('money', () => {
  it('rounds half away from zero', () => {
    expect(divRound(5, 10)).toBe(1);
    expect(divRound(-5, 10)).toBe(-1);
    expect(divRound(4, 10)).toBe(0);
    expect(applyBp(52_000, 1_000)).toBe(5_200);
  });
  it('parses typed amounts exactly', () => {
    expect(parseMajor('572')).toBe(57_200);
    expect(parseMajor('572,5')).toBe(57_250);
    expect(parseMajor('0.10')).toBe(10);
    expect(parseMajor('1.234')).toBeNull();
    expect(parseMajor('abc')).toBeNull();
  });
});

describe('customer price', () => {
  it('matches the brief: payout €520 with a 10 % markup is €572', () => {
    const p = customerPriceForPayout(52_000, crossBorder, DEFAULT_PRICING);
    expect(p.platformFeeMinor).toBe(5_200);
    expect(p.netMinor).toBe(57_200);
    expect(p.vatMinor).toBe(0);
    expect(p.totalMinor).toBe(57_200);
  });

  it('treats a commission on price differently from a markup on payout', () => {
    const cfg: PricingConfig = {
      ...DEFAULT_PRICING,
      platformFee: { kind: 'commission_on_price', bp: 1_000, minimumMinor: 0 },
    };
    const p = customerPriceForPayout(52_000, crossBorder, cfg);
    // 520 / 0.9 = 577.777… → rounded up to 577.78
    expect(p.netMinor).toBe(57_778);
    expect(p.platformFeeMinor).toBe(5_778);
    expect(p.platformFeeMinor / p.netMinor).toBeGreaterThanOrEqual(0.1);
  });

  it('applies the minimum platform fee', () => {
    const p = customerPriceForPayout(5_000, crossBorder, DEFAULT_PRICING);
    expect(p.platformFeeMinor).toBe(DEFAULT_PRICING.platformFee.minimumMinor);
  });

  it('adds domestic VAT only for a domestic customer on a domestic trip', () => {
    const p = customerPriceForPayout(
      52_000,
      { fromCountry: 'DE', toCountry: 'DE', customerCountry: 'DE' },
      DEFAULT_PRICING,
    );
    expect(p.vatBp).toBe(1_900);
    expect(p.vatMinor).toBe(10_868);
    expect(p.totalMinor).toBe(57_200 + 10_868);
    const foreign = customerPriceForPayout(
      52_000,
      { fromCountry: 'DE', toCountry: 'DE', customerCountry: 'PL' },
      DEFAULT_PRICING,
    );
    expect(foreign.vatMinor).toBe(0);
  });

  it('refuses a non-positive or fractional payout', () => {
    expect(() => customerPriceForPayout(0, crossBorder, DEFAULT_PRICING)).toThrow();
    expect(() => customerPriceForPayout(10.5, crossBorder, DEFAULT_PRICING)).toThrow();
  });
});

describe('estimate', () => {
  it('gets dearer with each service level', () => {
    const base = {
      vehicleClass: 'curtainsider' as const,
      distanceKm: 600,
      fromCountry: 'DE',
      toCountry: 'NL',
    };
    const s = estimate({ ...base, serviceLevel: 'standard' }, crossBorder, DEFAULT_PRICING);
    const p = estimate({ ...base, serviceLevel: 'priority' }, crossBorder, DEFAULT_PRICING);
    const e = estimate({ ...base, serviceLevel: 'express' }, crossBorder, DEFAULT_PRICING);
    expect(s.customer.totalMinor).toBeLessThan(p.customer.totalMinor);
    expect(p.customer.totalMinor).toBeLessThan(e.customer.totalMinor);
    expect(s.carrier.totalMinor % 100).toBe(0);
    expect(s.indicative).toBe(true);
  });

  it('uses the vehicle minimum for very short trips', () => {
    const e = estimate(
      {
        vehicleClass: 'van_light',
        serviceLevel: 'standard',
        distanceKm: 3,
        fromCountry: 'NL',
        toCountry: 'NL',
      },
      crossBorder,
      DEFAULT_PRICING,
    );
    expect(e.carrier.totalMinor).toBe(9_000);
  });
});

describe('maxPayoutWithin', () => {
  it('finds the highest payout whose total fits the ceiling', () => {
    const payout = maxPayoutWithin(60_000, crossBorder, DEFAULT_PRICING);
    expect(
      customerPriceForPayout(payout, crossBorder, DEFAULT_PRICING).totalMinor,
    ).toBeLessThanOrEqual(60_000);
    expect(
      customerPriceForPayout(payout + 1, crossBorder, DEFAULT_PRICING).totalMinor,
    ).toBeGreaterThan(60_000);
  });
  it('is 0 when nothing fits', () => {
    expect(maxPayoutWithin(100, crossBorder, DEFAULT_PRICING)).toBe(0);
  });
});
