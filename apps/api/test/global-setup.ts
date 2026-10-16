import pg from 'pg';
import { runMigrations } from '../src/db/migrate';

export const TEST_DB =
  process.env.TEST_DATABASE_URL ?? 'postgres://freight:freight@localhost:5434/freight_test';

/** Starts every test run from an empty, freshly migrated test database. */
export default async function setup() {
  const client = new pg.Client({ connectionString: TEST_DB });
  await client.connect();
  await client.query(
    'DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;',
  );
  await client.end();
  await runMigrations(TEST_DB);
}
