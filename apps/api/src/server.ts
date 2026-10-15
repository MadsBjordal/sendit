import { buildApp } from './app';
import { loadConfig } from './config';
import { runMigrations } from './db/migrate';
import { makeContext } from './services/index';
import { enqueue, startWorker } from './services/jobs';

const config = loadConfig();
await runMigrations(config.databaseUrl);
const ctx = makeContext(config);
const app = await buildApp(ctx, { logger: config.env !== 'test' });
// Daily clean-up of old driver positions (privacy)
await enqueue(ctx.db, 'purge_tracking', {}, { dedupeKey: 'purge_tracking' });
await enqueue(ctx.db, 'retention', {}, { dedupeKey: 'retention' });
const stopWorker = config.runWorker ? startWorker(ctx) : () => {};
await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(
  `${config.brand.name} API on http://localhost:${config.port} (docs: /api/docs, payments: ${config.paymentProvider} — no real money)`,
);

for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, async () => {
    stopWorker();
    await app.close();
    await ctx.close();
    process.exit(0);
  });
