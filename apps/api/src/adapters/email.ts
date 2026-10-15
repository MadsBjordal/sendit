import type { DbOrTx } from '../db/client';
import { emailOutbox } from '../db/schema';

export interface OutgoingEmail {
  to: string;
  template: string;
  subject: string;
  body: string;
}

/**
 * Email plug point. The "log" adapter records every email in email_outbox and the server log
 * instead of sending it; a real provider (EU-hosted) is added behind this interface.
 */
export interface EmailSender {
  send(db: DbOrTx, email: OutgoingEmail): Promise<void>;
}

export class LogEmailSender implements EmailSender {
  constructor(private log: (msg: string) => void = () => {}) {}
  async send(db: DbOrTx, email: OutgoingEmail): Promise<void> {
    await db.insert(emailOutbox).values({ ...email, provider: 'log' });
    this.log(`[email:log] to=${email.to} subject="${email.subject}"`);
  }
}
