import type { Config } from '../config';
import type { Ctx } from '../context';
import { connect } from '../db/client';
import { LogEmailSender, SmtpEmailSender } from '../adapters/email';
import { DevSampleGeocoder } from '../adapters/geocoder';
import { TestPaymentProvider } from '../adapters/payments';
import { EstimateRouting } from '../adapters/routing';
import { LocalDiskStorage, MemoryStorage } from '../adapters/storage';
import { TestPayoutProvider } from '../adapters/payouts';

export function makeContext(
  config: Config,
  log: Ctx['log'] = console,
): Ctx & { close(): Promise<void> } {
  const database = connect(config.databaseUrl);
  return {
    db: database.db,
    config,
    payments: new TestPaymentProvider(config.paymentWebhookSecret),
    email:
      config.emailProvider === 'smtp' && config.smtpUrl
        ? new SmtpEmailSender(config.smtpUrl, config.emailFrom)
        : new LogEmailSender((m) => log.info(m)),
    routing: new EstimateRouting(),
    geocoder: new DevSampleGeocoder(),
    payouts: new TestPayoutProvider(),
    storage:
      config.env === 'test' ? new MemoryStorage() : new LocalDiskStorage(config.fileStorageDir),
    log,
    now: () => new Date(),
    close: () => database.close(),
  };
}
