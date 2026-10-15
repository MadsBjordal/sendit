import { brandFrom, type Brand } from '@freight/shared';

export interface Config {
  env: 'development' | 'test' | 'production';
  databaseUrl: string;
  port: number;
  publicUrl: string;
  brand: Brand;
  paymentProvider: 'test';
  paymentWebhookSecret: string;
  emailProvider: 'log' | 'smtp';
  smtpUrl: string | null;
  emailFrom: string;
  routingProvider: 'estimate';
  fileStorageDir: string;
  corsOrigins: string[];
  /** The platform's legal entity on invoices (until set, invoices are marked DRAFT) */
  legalEntity: { name: string; address: string; vatNumber: string | null; complete: boolean };
  /** Hours the customer has to confirm or dispute a delivery before it is accepted automatically */
  deliveryAcceptHours: number;
  /** Days tracking positions are kept */
  trackingRetentionDays: number;
  /** Run the background job worker inside this process */
  runWorker: boolean;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const mode = (
    env.NODE_ENV === 'production' ? 'production' : env.NODE_ENV === 'test' ? 'test' : 'development'
  ) as Config['env'];
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set (copy .env.example to .env)');
  const paymentProvider = env.PAYMENT_PROVIDER ?? 'test';
  if (paymentProvider !== 'test')
    throw new Error(`PAYMENT_PROVIDER=${paymentProvider} is not implemented yet`);
  if (mode === 'production' && paymentProvider === 'test')
    throw new Error('The simulated test payment provider cannot run in production');
  const secret = env.PAYMENT_WEBHOOK_SECRET ?? '';
  if (mode === 'production' && secret.length < 32)
    throw new Error('PAYMENT_WEBHOOK_SECRET must be a long random value in production');
  return {
    env: mode,
    databaseUrl,
    port: Number(env.API_PORT ?? 4000),
    publicUrl: env.PUBLIC_URL ?? 'http://localhost:3000',
    brand: brandFrom(env),
    paymentProvider: 'test',
    paymentWebhookSecret: secret || 'dev-webhook-secret',
    emailProvider: env.EMAIL_PROVIDER === 'smtp' ? 'smtp' : 'log',
    smtpUrl: env.SMTP_URL ?? null,
    emailFrom: env.EMAIL_FROM ?? `${env.BRAND_NAME || 'Project Freight'} <no-reply@example.com>`,
    routingProvider: 'estimate',
    fileStorageDir: env.FILE_STORAGE_DIR ?? './data/files',
    legalEntity: {
      name:
        env.LEGAL_ENTITY_NAME || `${env.BRAND_NAME || 'Project Freight'} (legal entity not set)`,
      address: env.LEGAL_ENTITY_ADDRESS || '',
      vatNumber: env.LEGAL_ENTITY_VAT || null,
      complete: !!(env.LEGAL_ENTITY_NAME && env.LEGAL_ENTITY_ADDRESS && env.LEGAL_ENTITY_VAT),
    },
    corsOrigins: (env.CORS_ORIGINS ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
    deliveryAcceptHours: Number(env.DELIVERY_ACCEPT_HOURS ?? 48),
    trackingRetentionDays: Number(env.TRACKING_RETENTION_DAYS ?? 90),
    runWorker: env.RUN_WORKER !== 'false',
  };
}
