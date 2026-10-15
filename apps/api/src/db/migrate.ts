import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { connect } from './client';

const folder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

/** Runs every migration not yet applied. PostGIS must exist before the first one. */
export async function runMigrations(url: string): Promise<void> {
  const database = connect(url, 1);
  try {
    await database.pool.query('CREATE EXTENSION IF NOT EXISTS postgis');
    await migrate(database.db, { migrationsFolder: folder });
  } finally {
    await database.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set (copy .env.example to .env)');
  await runMigrations(url);
  console.log('Migrations done');
}
