import type { Currency } from './money';

/**
 * Countries the platform knows about. Knowing a country does NOT make it available:
 * which countries are open for business is configured per environment (country_configuration)
 * and must only be switched on after legal and operational review (see COMPLIANCE.md).
 */
export interface CountryInfo {
  code: string; // ISO 3166-1 alpha-2
  name: string;
  currency: Currency;
  eu: boolean;
  /** Never offered (sanctions or no legal basis). Cannot be activated from the admin screen. */
  blocked?: string;
}

export const COUNTRIES: CountryInfo[] = [
  { code: 'AT', name: 'Austria', currency: 'EUR', eu: true },
  { code: 'BE', name: 'Belgium', currency: 'EUR', eu: true },
  { code: 'BG', name: 'Bulgaria', currency: 'BGN', eu: true },
  { code: 'HR', name: 'Croatia', currency: 'EUR', eu: true },
  { code: 'CY', name: 'Cyprus', currency: 'EUR', eu: true },
  { code: 'CZ', name: 'Czechia', currency: 'CZK', eu: true },
  { code: 'DK', name: 'Denmark', currency: 'DKK', eu: true },
  { code: 'EE', name: 'Estonia', currency: 'EUR', eu: true },
  { code: 'FI', name: 'Finland', currency: 'EUR', eu: true },
  { code: 'FR', name: 'France', currency: 'EUR', eu: true },
  { code: 'DE', name: 'Germany', currency: 'EUR', eu: true },
  { code: 'GR', name: 'Greece', currency: 'EUR', eu: true },
  { code: 'HU', name: 'Hungary', currency: 'HUF', eu: true },
  { code: 'IE', name: 'Ireland', currency: 'EUR', eu: true },
  { code: 'IT', name: 'Italy', currency: 'EUR', eu: true },
  { code: 'LV', name: 'Latvia', currency: 'EUR', eu: true },
  { code: 'LT', name: 'Lithuania', currency: 'EUR', eu: true },
  { code: 'LU', name: 'Luxembourg', currency: 'EUR', eu: true },
  { code: 'MT', name: 'Malta', currency: 'EUR', eu: true },
  { code: 'NL', name: 'Netherlands', currency: 'EUR', eu: true },
  { code: 'PL', name: 'Poland', currency: 'PLN', eu: true },
  { code: 'PT', name: 'Portugal', currency: 'EUR', eu: true },
  { code: 'RO', name: 'Romania', currency: 'RON', eu: true },
  { code: 'SK', name: 'Slovakia', currency: 'EUR', eu: true },
  { code: 'SI', name: 'Slovenia', currency: 'EUR', eu: true },
  { code: 'ES', name: 'Spain', currency: 'EUR', eu: true },
  { code: 'SE', name: 'Sweden', currency: 'SEK', eu: true },
  { code: 'MC', name: 'Monaco', currency: 'EUR', eu: false },
  { code: 'SM', name: 'San Marino', currency: 'EUR', eu: false },
  { code: 'AD', name: 'Andorra', currency: 'EUR', eu: false },
  { code: 'NO', name: 'Norway', currency: 'NOK', eu: false },
  { code: 'IS', name: 'Iceland', currency: 'EUR', eu: false },
  { code: 'CH', name: 'Switzerland', currency: 'CHF', eu: false },
  { code: 'LI', name: 'Liechtenstein', currency: 'CHF', eu: false },
  { code: 'GB', name: 'United Kingdom', currency: 'GBP', eu: false },
  { code: 'TR', name: 'Türkiye', currency: 'EUR', eu: false },
  { code: 'RS', name: 'Serbia', currency: 'EUR', eu: false },
  { code: 'BA', name: 'Bosnia and Herzegovina', currency: 'EUR', eu: false },
  { code: 'ME', name: 'Montenegro', currency: 'EUR', eu: false },
  { code: 'MK', name: 'North Macedonia', currency: 'EUR', eu: false },
  { code: 'AL', name: 'Albania', currency: 'EUR', eu: false },
  { code: 'XK', name: 'Kosovo', currency: 'EUR', eu: false },
  { code: 'MD', name: 'Moldova', currency: 'EUR', eu: false },
  { code: 'UA', name: 'Ukraine', currency: 'EUR', eu: false },
  {
    code: 'RU',
    name: 'Russia',
    currency: 'EUR',
    eu: false,
    blocked: 'EU sanctions on road transport',
  },
  {
    code: 'BY',
    name: 'Belarus',
    currency: 'EUR',
    eu: false,
    blocked: 'EU sanctions on road transport',
  },
];

export const COUNTRY_BY_CODE = new Map(COUNTRIES.map((c) => [c.code, c]));

export function countryName(code: string): string {
  return COUNTRY_BY_CODE.get(code)?.name ?? code;
}
