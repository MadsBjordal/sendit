import { newToken } from '../lib/crypto';

/**
 * Plug point for sending money to carriers (through the same licensed payment provider). Only the
 * TEST provider exists: it moves no money and is refused in production (config.ts).
 */
export interface PayoutProvider {
  readonly name: string;
  createPayout(input: {
    amountMinor: number;
    currency: string;
    iban: string;
    holderName: string;
    reference: string;
    idempotencyKey: string;
  }): Promise<{ payoutRef: string; status: 'pending' | 'paid' }>;
}

export class TestPayoutProvider implements PayoutProvider {
  readonly name = 'test';
  async createPayout(): Promise<{ payoutRef: string; status: 'pending' }> {
    // A real provider confirms arrival later by webhook (payout.paid / payout.failed)
    return { payoutRef: `testpayout_${newToken(10)}`, status: 'pending' };
  }
}
