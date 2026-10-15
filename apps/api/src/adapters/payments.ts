import { newToken, hmacSha256, safeEqual } from '../lib/crypto';

/**
 * The plug point for a licensed payment service provider (PSP). The platform never holds card
 * data and never treats a payment as received until the provider's signed webhook says so.
 *
 * Only the TEST provider exists today: it moves no real money and is refused in production
 * (config.ts). A real provider (see DECISIONS.md D-009) will implement the same interface.
 */
export interface CreatePaymentResult {
  providerRef: string;
  /** What the customer's browser needs to complete payment (for the test provider: our own test page) */
  clientAction: { kind: 'test_checkout'; paymentRef: string };
}

export interface ProviderEvent {
  id: string;
  type:
    | 'payment.succeeded'
    | 'payment.failed'
    | 'refund.succeeded'
    | 'payout.paid'
    | 'payout.failed'
    | 'dispute.created'
    | 'dispute.closed';
  data: { providerRef: string; amountMinor: number; currency: string; reason?: string };
}

export interface PaymentProvider {
  readonly name: string;
  createPayment(input: {
    amountMinor: number;
    currency: string;
    description: string;
    idempotencyKey: string;
  }): Promise<CreatePaymentResult>;
  refund(input: {
    providerRef: string;
    amountMinor: number;
    currency: string;
    idempotencyKey: string;
  }): Promise<{ refundRef: string; status: 'succeeded' | 'pending' }>;
  /** Checks the webhook signature and returns the event, or null when it is not genuine */
  parseWebhook(rawBody: string, signature: string | undefined): ProviderEvent | null;
}

export class TestPaymentProvider implements PaymentProvider {
  readonly name = 'test';
  constructor(private secret: string) {}

  async createPayment(): Promise<CreatePaymentResult> {
    const providerRef = `testpay_${newToken(12)}`;
    return { providerRef, clientAction: { kind: 'test_checkout', paymentRef: providerRef } };
  }

  async refund(input: {
    providerRef: string;
  }): Promise<{ refundRef: string; status: 'succeeded' }> {
    return { refundRef: `testrefund_${input.providerRef}_${newToken(6)}`, status: 'succeeded' };
  }

  sign(rawBody: string): string {
    return hmacSha256(this.secret, rawBody);
  }

  /** Builds a signed webhook as the provider would send it (used by the test checkout and tests) */
  makeWebhook(event: ProviderEvent): { body: string; signature: string } {
    const body = JSON.stringify(event);
    return { body, signature: this.sign(body) };
  }

  parseWebhook(rawBody: string, signature: string | undefined): ProviderEvent | null {
    if (!signature || !safeEqual(this.sign(rawBody), signature)) return null;
    try {
      const e = JSON.parse(rawBody) as ProviderEvent;
      if (typeof e.id !== 'string' || typeof e.type !== 'string' || !e.data) return null;
      return e;
    } catch {
      return null;
    }
  }
}
