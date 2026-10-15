import type { Config } from '../config';
import type { Ctx } from '../context';
import { connect } from '../db/client';
import { LogEmailSender } from '../adapters/email';
import { DevSampleGeocoder } from '../adapters/geocoder';
import { TestPaymentProvider } from '../adapters/payments';
import { EstimateRouting } from '../adapters/routing';

export function makeContext(
  config: Config,
  log: Ctx['log'] = console,
): Ctx & { close(): Promise<void> } {
  const database = connect(config.databaseUrl);
  return {
    db: database.db,
    config,
    payments: new TestPaymentProvider(config.paymentWebhookSecret),
    email: new LogEmailSender((m) => log.info(m)),
    routing: new EstimateRouting(),
    geocoder: new DevSampleGeocoder(),
    log,
    now: () => new Date(),
    close: () => database.close(),
  };
}
