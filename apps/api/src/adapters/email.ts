import { createTransport, type Transporter } from 'nodemailer';
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

/**
 * Sends through any SMTP service (e.g. an EU-hosted transactional email provider) given SMTP_URL,
 * such as smtps://user:password@smtp.example.com:465. Every email is also recorded in email_outbox.
 * Not yet run against a real provider (no credentials in development).
 */
export class SmtpEmailSender implements EmailSender {
  private transport: Transporter;
  constructor(
    url: string,
    private from: string,
  ) {
    this.transport = createTransport(url);
  }
  async send(db: DbOrTx, email: OutgoingEmail): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: email.to,
      subject: email.subject,
      text: email.body,
    });
    await db.insert(emailOutbox).values({ ...email, provider: 'smtp', sentAt: new Date() });
  }
}
