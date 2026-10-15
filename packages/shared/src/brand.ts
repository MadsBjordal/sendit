/**
 * The product name is not final. Everything people see takes the name from here,
 * so renaming the product is a change of one value (or the BRAND_NAME environment variable).
 */
export interface Brand {
  name: string;
  shortName: string;
  supportEmail: string;
}

export const DEFAULT_BRAND: Brand = {
  name: 'Project Freight',
  shortName: 'Freight',
  supportEmail: 'support@example.com',
};

export function brandFrom(env: Record<string, string | undefined>): Brand {
  return {
    name: env.BRAND_NAME || DEFAULT_BRAND.name,
    shortName: env.BRAND_SHORT_NAME || env.BRAND_NAME || DEFAULT_BRAND.shortName,
    supportEmail: env.BRAND_SUPPORT_EMAIL || DEFAULT_BRAND.supportEmail,
  };
}
