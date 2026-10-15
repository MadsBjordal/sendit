import { describe, expect, it } from 'vitest';
import { assessCustoms, territoryOf } from './customs';

const at = (country: string, postcode?: string) => ({ country, postcode });

describe('territories', () => {
  it('uses customs territories, not EU membership', () => {
    expect(territoryOf(at('MC')).territory).toBe('EU');
    expect(territoryOf(at('NO')).territory).toBe('NO');
    expect(territoryOf(at('LI')).territory).toBe('CH');
    expect(territoryOf(at('GB', 'BT1 1AA')).territory).toBe('XI');
    expect(territoryOf(at('GB', 'SW1A 1AA')).territory).toBe('GB');
    expect(territoryOf(at('ES', '51001')).territory).toBe('OUTSIDE_EU_SPECIAL');
    expect(territoryOf(at('DE', '78266')).territory).toBe('CH');
  });
  it('knows special VAT territories', () => {
    const canarias = territoryOf(at('ES', '35001'));
    expect(canarias.territory).toBe('EU');
    expect(canarias.outsideVatArea).toBe(true);
  });
  it('respects the effective date', () => {
    expect(territoryOf(at('GB'), '2019-06-01').territory).toBe(null);
  });
});

describe('assessCustoms', () => {
  it('EU to EU with Union goods and a known EU-only route needs nothing', () => {
    const a = assessCustoms({
      from: at('DE'),
      to: at('PL'),
      transitCountries: ['DE', 'PL'],
      goodsStatus: 'union',
    });
    expect(a.result).toBe('not_required');
  });
  it('EU to EU with unknown goods status is only "possible", never a confident no', () => {
    expect(
      assessCustoms({
        from: at('DE'),
        to: at('PL'),
        transitCountries: null,
        goodsStatus: 'unknown',
      }).result,
    ).toBe('possible');
  });
  it('Germany to Norway needs an EU export and a Norwegian import', () => {
    const a = assessCustoms({
      from: at('DE'),
      to: at('NO'),
      transitCountries: null,
      goodsStatus: 'union',
    });
    expect(a.result).toBe('required');
    expect(a.procedures.map((p) => `${p.kind}:${p.territory}`)).toEqual(['export:EU', 'import:NO']);
  });
  it('Norway to Germany also needs the EU entry summary (ICS2)', () => {
    const a = assessCustoms({
      from: at('NO'),
      to: at('DE'),
      transitCountries: null,
      goodsStatus: 'unknown',
    });
    expect(a.procedures.map((p) => p.kind)).toEqual(['export', 'import', 'entry_safety_security']);
  });
  it('Great Britain routes include GVMS', () => {
    const a = assessCustoms({
      from: at('NL'),
      to: at('GB', 'M1 1AA'),
      transitCountries: null,
      goodsStatus: 'union',
    });
    expect(a.procedures.map((p) => p.kind)).toContain('gb_gvms');
  });
  it('Northern Ireland from Ireland is inside EU rules for goods', () => {
    const a = assessCustoms({
      from: at('IE'),
      to: at('GB', 'BT7 1NN'),
      transitCountries: null,
      goodsStatus: 'union',
    });
    expect(a.procedures.map((p) => p.kind)).toEqual(['export', 'import', 'entry_safety_security']);
    expect(a.procedures[1]?.territory).toBe('XI');
  });
  it('Germany to Italy may pass Switzerland: flagged to confirm', () => {
    const a = assessCustoms({
      from: at('DE'),
      to: at('IT'),
      transitCountries: null,
      goodsStatus: 'union',
    });
    expect(a.result).toBe('possible');
    expect(a.procedures[0]?.kind).toBe('check_route');
  });
  it('a known route through Switzerland requires transit', () => {
    const a = assessCustoms({
      from: at('DE'),
      to: at('IT'),
      transitCountries: ['DE', 'CH', 'IT'],
      goodsStatus: 'union',
    });
    expect(a.result).toBe('required');
    expect(a.procedures[0]).toMatchObject({ kind: 'transit', territory: 'CH' });
  });
  it('non-Union goods inside the EU need transit', () => {
    const a = assessCustoms({
      from: at('NL'),
      to: at('DE'),
      transitCountries: ['NL', 'DE'],
      goodsStatus: 'non_union',
    });
    expect(a.procedures[0]).toMatchObject({ kind: 'transit', certainty: 'required' });
  });
  it('mainland Spain to the Canary Islands needs fiscal formalities', () => {
    const a = assessCustoms({
      from: at('ES', '28001'),
      to: at('ES', '35001'),
      transitCountries: [],
      goodsStatus: 'union',
    });
    expect(a.procedures.map((p) => p.kind)).toEqual(['fiscal']);
  });
  it('an unknown country gives "unknown"', () => {
    expect(
      assessCustoms({ from: at('DE'), to: at('US'), transitCountries: null, goodsStatus: 'union' })
        .result,
    ).toBe('unknown');
  });
});
