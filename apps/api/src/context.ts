import type { Config } from './config';
import type { Db } from './db/client';
import type { EmailSender } from './adapters/email';
import type { Geocoder } from './adapters/geocoder';
import type { PaymentProvider, TestPaymentProvider } from './adapters/payments';
import type { RoutingProvider } from './adapters/routing';
import type { FileStorage } from './adapters/storage';

/** Everything a service needs, passed in (so tests can swap the clock or an adapter). */
export interface Ctx {
  db: Db;
  config: Config;
  payments: PaymentProvider & Partial<Pick<TestPaymentProvider, 'makeWebhook'>>;
  email: EmailSender;
  routing: RoutingProvider;
  geocoder: Geocoder;
  storage: FileStorage;
  log: { info(msg: string): void; warn(msg: string): void; error(msg: string | object): void };
  now(): Date;
}
