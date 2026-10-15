/**
 * Customs detection. Works with CUSTOMS TERRITORIES, not EU membership: Norway and Switzerland are
 * outside the EU customs union, Monaco is inside it, Northern Ireland follows EU customs rules for
 * goods, Ceuta/Melilla and Heligoland are outside the EU customs territory although in EU countries.
 *
 * The answer is never more certain than the information it has: unknown goods status or an
 * unknown route through third countries gives "possible", not "no".
 *
 * Rules are versioned data with sources and effective dates (CUSTOMS_RULES_VERSION). They are a
 * screening aid for planning and must be reviewed by a customs professional (COMPLIANCE.md).
 */

export const CUSTOMS_RULES_VERSION = '2026-10-15';

export type CustomsTerritory =
  | 'EU' // Union customs territory (incl. Monaco and San Marino by customs union agreements)
  | 'NO'
  | 'CH' // Switzerland + Liechtenstein (+ Büsingen, Campione is EU since 2020)
  | 'GB' // Great Britain (England, Scotland, Wales)
  | 'XI' // Northern Ireland: UK, but EU customs rules for goods under the Windsor Framework
  | 'IS'
  | 'TR' // Customs union with the EU for industrial goods only: treated as a separate territory
  | 'AD'
  | 'OUTSIDE_EU_SPECIAL' // Ceuta, Melilla, Heligoland, Livigno, Gibraltar…
  | 'OTHER'; // other European third countries (RS, BA, ME, MK, AL, XK, MD, UA)

export interface RuleSource {
  title: string;
  url: string;
}

export interface TerritoryRule {
  id: string;
  /** ISO country, optionally restricted to postcodes starting with one of these */
  country: string;
  postcodePrefixes?: string[];
  territory: CustomsTerritory;
  /** Inside the EU customs territory but outside the EU VAT area: fiscal formalities still apply */
  outsideVatArea?: boolean;
  effectiveFrom: string;
  effectiveTo?: string;
  note: string;
  source: RuleSource;
}

const UCC: RuleSource = {
  title: 'Union Customs Code, Regulation (EU) No 952/2013, Article 4 (customs territory)',
  url: 'https://eur-lex.europa.eu/eli/reg/2013/952/oj',
};
const VAT_DIR: RuleSource = {
  title: 'VAT Directive 2006/112/EC, Article 6 (territories outside the VAT area)',
  url: 'https://eur-lex.europa.eu/eli/dir/2006/112/oj',
};
const WINDSOR: RuleSource = {
  title: 'Windsor Framework (Protocol on Ireland/Northern Ireland)',
  url: 'https://www.gov.uk/government/collections/the-windsor-framework',
};

const EU_COUNTRIES = [
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HU',
  'IE',
  'IT',
  'LV',
  'LT',
  'LU',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SK',
  'SI',
  'ES',
  'SE',
];

/** Specific rules first (postcode), then country defaults. The first matching, effective rule wins. */
export const TERRITORY_RULES: TerritoryRule[] = [
  {
    id: 'es-ceuta',
    country: 'ES',
    postcodePrefixes: ['51'],
    territory: 'OUTSIDE_EU_SPECIAL',
    effectiveFrom: '1986-01-01',
    note: 'Ceuta is outside the EU customs territory',
    source: UCC,
  },
  {
    id: 'es-melilla',
    country: 'ES',
    postcodePrefixes: ['52'],
    territory: 'OUTSIDE_EU_SPECIAL',
    effectiveFrom: '1986-01-01',
    note: 'Melilla is outside the EU customs territory',
    source: UCC,
  },
  {
    id: 'es-canarias',
    country: 'ES',
    postcodePrefixes: ['35', '38'],
    territory: 'EU',
    outsideVatArea: true,
    effectiveFrom: '1993-01-01',
    note: 'Canary Islands: EU customs territory, outside the EU VAT area',
    source: VAT_DIR,
  },
  {
    id: 'de-heligoland',
    country: 'DE',
    postcodePrefixes: ['27498'],
    territory: 'OUTSIDE_EU_SPECIAL',
    effectiveFrom: '1994-01-01',
    note: 'Heligoland is outside the EU customs territory',
    source: UCC,
  },
  {
    id: 'de-busingen',
    country: 'DE',
    postcodePrefixes: ['78266'],
    territory: 'CH',
    effectiveFrom: '1994-01-01',
    note: 'Büsingen am Hochrhein is in the Swiss customs territory',
    source: UCC,
  },
  {
    id: 'it-livigno',
    country: 'IT',
    postcodePrefixes: ['23041'],
    territory: 'OUTSIDE_EU_SPECIAL',
    effectiveFrom: '1994-01-01',
    note: 'Livigno is outside the EU customs territory',
    source: UCC,
  },
  {
    id: 'fi-aland',
    country: 'FI',
    postcodePrefixes: ['22'],
    territory: 'EU',
    outsideVatArea: true,
    effectiveFrom: '1995-01-01',
    note: 'Åland: EU customs territory, outside the EU VAT area',
    source: VAT_DIR,
  },
  {
    id: 'gr-athos',
    country: 'GR',
    postcodePrefixes: ['63086', '63087'],
    territory: 'EU',
    outsideVatArea: true,
    effectiveFrom: '1994-01-01',
    note: 'Mount Athos: outside the EU VAT area',
    source: VAT_DIR,
  },
  {
    id: 'gb-ni',
    country: 'GB',
    postcodePrefixes: ['BT'],
    territory: 'XI',
    effectiveFrom: '2021-01-01',
    note: 'Northern Ireland follows EU customs rules for goods (Windsor Framework)',
    source: WINDSOR,
  },
  ...EU_COUNTRIES.map((c): TerritoryRule => ({
    id: `eu-${c.toLowerCase()}`,
    country: c,
    territory: 'EU',
    effectiveFrom: '1994-01-01',
    note: 'EU customs territory',
    source: UCC,
  })),
  {
    id: 'mc',
    country: 'MC',
    territory: 'EU',
    effectiveFrom: '1994-01-01',
    note: 'Monaco is part of the EU customs territory',
    source: UCC,
  },
  {
    id: 'sm',
    country: 'SM',
    territory: 'EU',
    outsideVatArea: true,
    effectiveFrom: '2002-04-01',
    note: 'San Marino: customs union with the EU; outside the EU VAT area',
    source: UCC,
  },
  {
    id: 'ad',
    country: 'AD',
    territory: 'AD',
    effectiveFrom: '1991-01-01',
    note: 'Andorra: customs union with the EU only for industrial goods: treated as a separate territory',
    source: UCC,
  },
  {
    id: 'no',
    country: 'NO',
    territory: 'NO',
    effectiveFrom: '1994-01-01',
    note: 'Norway: EEA, outside the EU customs union',
    source: { title: 'Norwegian Customs (Tolletaten)', url: 'https://www.toll.no/en/' },
  },
  {
    id: 'is',
    country: 'IS',
    territory: 'IS',
    effectiveFrom: '1994-01-01',
    note: 'Iceland: EEA, outside the EU customs union',
    source: UCC,
  },
  {
    id: 'ch',
    country: 'CH',
    territory: 'CH',
    effectiveFrom: '1994-01-01',
    note: 'Switzerland: outside the EU customs union',
    source: {
      title: 'Federal Office for Customs and Border Security (FOCBS)',
      url: 'https://www.bazg.admin.ch/bazg/en/home.html',
    },
  },
  {
    id: 'li',
    country: 'LI',
    territory: 'CH',
    effectiveFrom: '1994-01-01',
    note: 'Liechtenstein is in the Swiss customs territory',
    source: UCC,
  },
  {
    id: 'gb',
    country: 'GB',
    territory: 'GB',
    effectiveFrom: '2021-01-01',
    note: 'Great Britain: outside the EU customs union since 1 January 2021',
    source: {
      title: 'HMRC: moving goods to and from the EU',
      url: 'https://www.gov.uk/guidance/moving-goods-to-and-from-the-eu',
    },
  },
  {
    id: 'tr',
    country: 'TR',
    territory: 'TR',
    effectiveFrom: '1996-01-01',
    note: 'Türkiye: customs union for industrial goods only; declarations still required',
    source: UCC,
  },
  ...['RS', 'BA', 'ME', 'MK', 'AL', 'XK', 'MD', 'UA'].map((c): TerritoryRule => ({
    id: `other-${c.toLowerCase()}`,
    country: c,
    territory: 'OTHER',
    effectiveFrom: '1994-01-01',
    note: 'Outside the EU customs union',
    source: UCC,
  })),
];

export interface PlaceForCustoms {
  country: string;
  postcode?: string | null;
}

export interface TerritoryMatch {
  territory: CustomsTerritory | null;
  outsideVatArea: boolean;
  rule: TerritoryRule | null;
}

function normalisePostcode(p: string | null | undefined): string {
  return (p ?? '').toUpperCase().replace(/\s|-/g, '');
}

export function territoryOf(
  place: PlaceForCustoms,
  onDate = new Date().toISOString().slice(0, 10),
): TerritoryMatch {
  const pc = normalisePostcode(place.postcode);
  for (const r of TERRITORY_RULES) {
    if (r.country !== place.country) continue;
    if (r.effectiveFrom > onDate || (r.effectiveTo && r.effectiveTo < onDate)) continue;
    if (r.postcodePrefixes && !r.postcodePrefixes.some((p) => pc.startsWith(p))) continue;
    return { territory: r.territory, outsideVatArea: !!r.outsideVatArea, rule: r };
  }
  return { territory: null, outsideVatArea: false, rule: null };
}

export type GoodsStatus = 'union' | 'non_union' | 'unknown';

export type ProcedureKind =
  | 'export' // export declaration in the territory goods leave
  | 'import' // import declaration in the territory goods enter
  | 'transit' // transit procedure (NCTS/T1/T2) through or within a territory
  | 'entry_safety_security' // e.g. ICS2 entry summary into the EU, UK safety & security
  | 'gb_gvms' // UK Goods Vehicle Movement Service reference for the crossing
  | 'fiscal' // VAT formalities between EU VAT area and special territories
  | 'check_route'; // the route may cross another customs territory: needs confirmation

export interface CustomsProcedure {
  kind: ProcedureKind;
  territory: CustomsTerritory | null;
  /** 'required' = follows from the facts; 'possible' = depends on facts we do not have yet */
  certainty: 'required' | 'possible';
  reason: string;
  ruleIds: string[];
}

export type CustomsAssessment =
  | { result: 'not_required'; procedures: []; notes: string[]; rulesVersion: string }
  | {
      result: 'required' | 'possible';
      procedures: CustomsProcedure[];
      notes: string[];
      rulesVersion: string;
    }
  | { result: 'unknown'; procedures: []; notes: string[]; rulesVersion: string };

export interface CustomsInput {
  from: PlaceForCustoms;
  to: PlaceForCustoms;
  /** Countries the route passes through (from a truck-routing provider), null when unknown */
  transitCountries: string[] | null;
  goodsStatus: GoodsStatus;
  onDate?: string;
}

/**
 * Pairs of EU countries whose usual road route can leave the EU customs territory
 * (e.g. through Switzerland, the Western Balkans or by a non-EU ferry). With no transit
 * information, such a route is "possible" customs and must be confirmed.
 */
const MAY_TRANSIT_NON_EU: Array<[string[], string[], string]> = [
  [['DE', 'FR', 'BE', 'NL', 'LU', 'DK', 'SE'], ['IT'], 'May pass through Switzerland'],
  [['AT', 'SI', 'HR', 'HU', 'RO'], ['GR', 'BG'], 'May pass through Serbia or North Macedonia'],
  [['HR'], ['HR'], 'Dubrovnik area: may pass through Bosnia and Herzegovina (Neum)'],
  [['SE', 'FI'], ['SE', 'FI'], 'May pass through Norway'],
];

export function assessCustoms(input: CustomsInput): CustomsAssessment {
  const onDate = input.onDate ?? new Date().toISOString().slice(0, 10);
  const from = territoryOf(input.from, onDate);
  const to = territoryOf(input.to, onDate);
  const notes: string[] = [];
  if (!from.territory || !to.territory) {
    return {
      result: 'unknown',
      procedures: [],
      notes: [
        `No customs rule for ${!from.territory ? input.from.country : input.to.country}: manual review needed`,
      ],
      rulesVersion: CUSTOMS_RULES_VERSION,
    };
  }
  const ids = (m: TerritoryMatch) => (m.rule ? [m.rule.id] : []);
  const procedures: CustomsProcedure[] = [];

  if (from.territory !== to.territory) {
    procedures.push({
      kind: 'export',
      territory: from.territory,
      certainty: 'required',
      reason: `Goods leave the ${from.territory} customs territory`,
      ruleIds: ids(from),
    });
    procedures.push({
      kind: 'import',
      territory: to.territory,
      certainty: 'required',
      reason: `Goods enter the ${to.territory} customs territory`,
      ruleIds: ids(to),
    });
    if (to.territory === 'EU' || to.territory === 'XI')
      procedures.push({
        kind: 'entry_safety_security',
        territory: to.territory,
        certainty: 'required',
        reason: 'Entry summary declaration (ICS2) for goods entering the EU customs territory',
        ruleIds: ids(to),
      });
    if (to.territory === 'GB')
      procedures.push({
        kind: 'entry_safety_security',
        territory: 'GB',
        certainty: 'required',
        reason: 'UK safety and security declaration for goods entering Great Britain',
        ruleIds: ids(to),
      });
    if (from.territory === 'GB' || to.territory === 'GB')
      procedures.push({
        kind: 'gb_gvms',
        territory: 'GB',
        certainty: 'possible',
        reason: 'A Goods Movement Reference (GVMS) is needed at GVMS-enabled crossings',
        ruleIds: ['gb'],
      });
    // Crossing another territory between two non-adjacent ones (e.g. NO → IT through the EU, or EU → EU via CH)
    if (
      input.transitCountries === null &&
      from.territory !== 'EU' &&
      to.territory !== 'EU' &&
      from.territory !== to.territory
    )
      procedures.push({
        kind: 'transit',
        territory: 'EU',
        certainty: 'possible',
        reason: 'The route probably crosses the EU: a transit procedure (NCTS) may be used',
        ruleIds: [],
      });
  } else if (from.territory === 'EU') {
    // Inside the EU customs territory
    if (input.goodsStatus === 'non_union')
      procedures.push({
        kind: 'transit',
        territory: 'EU',
        certainty: 'required',
        reason: 'Non-Union goods moving inside the EU need a transit procedure (T1)',
        ruleIds: ids(from),
      });
    else if (input.goodsStatus === 'unknown')
      notes.push(
        'Customs status of the goods unknown: if they are not in free circulation in the EU, a transit procedure is needed.',
      );
    if (from.outsideVatArea !== to.outsideVatArea)
      procedures.push({
        kind: 'fiscal',
        territory: 'EU',
        certainty: 'required',
        reason:
          'Movement between the EU VAT area and a territory outside it needs fiscal (VAT) formalities',
        ruleIds: [...ids(from), ...ids(to)],
      });
    const transit = input.transitCountries;
    if (transit) {
      for (const c of transit) {
        const t = territoryOf({ country: c }, onDate);
        if (t.territory && t.territory !== 'EU') {
          procedures.push({
            kind: 'transit',
            territory: t.territory,
            certainty: 'required',
            reason: `The route passes through ${c} (outside the EU customs territory): T2 transit or export/import`,
            ruleIds: ids(t),
          });
        }
      }
    } else {
      for (const [a, b, why] of MAY_TRANSIT_NON_EU) {
        const fc = input.from.country;
        const tc = input.to.country;
        if ((a.includes(fc) && b.includes(tc)) || (a.includes(tc) && b.includes(fc))) {
          if (fc === tc && a.length > 1) continue; // same-country rule only for the explicit pairs
          procedures.push({
            kind: 'check_route',
            territory: null,
            certainty: 'possible',
            reason: `${why}: confirm the route or use a transit procedure`,
            ruleIds: [],
          });
          break;
        }
      }
    }
  } else if (input.transitCountries) {
    // Same non-EU territory at both ends (e.g. GB → GB) but via another territory
    for (const c of input.transitCountries) {
      const t = territoryOf({ country: c }, onDate);
      if (t.territory && t.territory !== from.territory)
        procedures.push({
          kind: 'transit',
          territory: t.territory,
          certainty: 'required',
          reason: `The route passes through ${c}`,
          ruleIds: ids(t),
        });
    }
  }

  if (procedures.length === 0) {
    if (from.territory === 'EU' && input.goodsStatus === 'unknown')
      return { result: 'possible', procedures: [], notes, rulesVersion: CUSTOMS_RULES_VERSION };
    return { result: 'not_required', procedures: [], notes, rulesVersion: CUSTOMS_RULES_VERSION };
  }
  const result = procedures.some((p) => p.certainty === 'required') ? 'required' : 'possible';
  return { result, procedures, notes, rulesVersion: CUSTOMS_RULES_VERSION };
}
