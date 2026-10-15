import { eq, sql } from 'drizzle-orm';
import type { Db } from './client';
import { countryConfiguration, memberships, organisations, users } from './schema';
import { hashPassword } from '../services/auth';
import { newTotpSecret } from '../lib/crypto';
import { activePricing } from '../services/platformConfig';

/** Creates (or returns) a platform administrator with two-step login already set up. */
export async function ensurePlatformAdmin(
  db: Db,
  email: string,
  password: string,
  name = 'Platform admin',
) {
  const [existing] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${email.toLowerCase()}`);
  if (existing) return { id: existing.id, mfaSecret: existing.mfaSecret!, created: false };
  let [platform] = await db.select().from(organisations).where(eq(organisations.kind, 'platform'));
  if (!platform)
    [platform] = await db
      .insert(organisations)
      .values({
        kind: 'platform',
        name: 'Platform operator',
        country: 'NL',
        status: 'verified',
        verifiedAt: new Date(),
      })
      .returning();
  const mfaSecret = newTotpSecret();
  const [u] = await db
    .insert(users)
    .values({
      email,
      name,
      passwordHash: await hashPassword(password),
      emailVerifiedAt: new Date(),
      platformRole: 'platform_admin',
      mfaSecret,
      mfaEnabled: true,
    })
    .returning();
  await db.insert(memberships).values({ orgId: platform!.id, userId: u!.id, role: 'owner' });
  return { id: u!.id, mfaSecret, created: true };
}

/** Opens countries for business. Development and tests only; production countries are opened by an admin after review. */
export async function openCountries(db: Db, codes: string[], domestic = true) {
  for (const country of codes)
    await db
      .insert(countryConfiguration)
      .values({ country, enabled: true, domesticEnabled: domestic, note: 'development' })
      .onConflictDoUpdate({
        target: countryConfiguration.country,
        set: { enabled: true, domesticEnabled: domestic },
      });
}

export async function ensurePricing(db: Db) {
  await activePricing(db);
}
