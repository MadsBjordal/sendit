import { connect } from './client';
import { ensurePlatformAdmin, ensurePricing, openCountries } from './seed-lib';
import { runMigrations } from './migrate';

/**
 * Development seed: pricing defaults, a set of DEVELOPMENT countries and a platform admin.
 * Nothing here is real business data. Demo companies are created by registering in the web app.
 */
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set (copy .env.example to .env)');
await runMigrations(url);
const { db, close } = connect(url, 2);
await ensurePricing(db);
await openCountries(db, ['DE', 'NL', 'BE', 'FR', 'PL', 'CZ', 'AT', 'DK', 'SE', 'NO', 'IT', 'ES']);
const email = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com';
const password = process.env.SEED_ADMIN_PASSWORD ?? 'change-this-admin-password';
const admin = await ensurePlatformAdmin(db, email, password);
console.log('Seed done. Development countries opened: DE NL BE FR PL CZ AT DK SE NO IT ES');
if (admin.created) {
  console.log(`Platform admin: ${email} / ${password}`);
  console.log(`Two-step login secret (add it to an authenticator app): ${admin.mfaSecret}`);
} else console.log(`Platform admin ${email} already exists (its two-step secret is unchanged).`);
await close();
