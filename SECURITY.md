# Security

## In place

| Area               | How                                                                                                                                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Passwords          | Argon2id (19 MiB, t=2), minimum 12 characters, lockout after 10 failures for 15 min, same answer for unknown email and wrong password                                                                |
| Sessions           | 256-bit random token in an HttpOnly, SameSite=Lax cookie (Secure in production); only the SHA-256 hash is stored; 30 days (12 h for staff); revoked on logout and on password reset                  |
| Staff              | Two-step login (TOTP) required for every admin action; per-role permissions (`PLATFORM_PERMISSIONS`)                                                                                                 |
| CSRF               | State-changing requests with the cookie need the `x-requested-with` header (a cross-site page cannot add it without CORS, which is not enabled)                                                      |
| Authorisation      | Checked on the server for every request: organisation kind, role permission, and the row's organisation. Another organisation's data answers **404**, never revealing it exists                      |
| Commercial secrecy | Carriers never receive the customer's maximum, total, name or address before booking; customers never receive the carrier's payout or other customers' data (tests check this)                       |
| Input              | Every request body validated with zod; SQL only through parameterised queries (Drizzle / `sql` template)                                                                                             |
| Rate limiting      | 300 requests/min per address; 10/min on login, registration and token endpoints                                                                                                                      |
| Webhooks           | HMAC-SHA256 signature over the raw body, constant-time compare; each event stored once (unique provider event id)                                                                                    |
| Money integrity    | Integer cents; ledger transactions must balance (database trigger); ledger, events and audit logs are append-only (database triggers); idempotency keys for acceptances, ledger postings and refunds |
| Headers            | nosniff, DENY framing, strict referrer policy, permissions policy                                                                                                                                    |
| Secrets            | Only in `.env` (ignored by git); `.env.example` lists them; production refuses weak/default webhook secret and the test payment provider                                                             |
| Audit              | Logins, failures, registrations, verification decisions, bookings, offer decisions, country and pricing changes, bank-detail changes (masked IBAN), dispute, fraud and privacy decisions             |
| Files              | Private; served only after the same access check as the shipment (other companies get 404); uploads checked by their real content (image/PDF), size-limited, hashed                                  |
| Payout fraud       | Payouts held 48 h after bank details change until an admin clears the alert; shared IBANs flagged                                                                                                    |
| Mobile             | Bearer token for the driver app; CORS only for listed origins and never with cookies                                                                                                                 |
| Headers / CSP      | CSP and HSTS in production builds (inline scripts still allowed, D-027)                                                                                                                              |
| Dependencies       | `pnpm audit` in CI (high and above fails), Dependabot weekly                                                                                                                                         |

## To do before production

- CSP with nonces instead of `'unsafe-inline'` (D-027).
- Cloud object storage with short-lived signed URLs (access checks are tested already, on the local folder).
- Secret manager (Key Vault / Secrets Manager) and key rotation runbook.
- Container image scanning.
- Shared rate-limit store (Redis) once there is more than one API instance.
- Backups with tested restores (point-in-time recovery on the managed database).
- Final retention periods (the job exists, periods are placeholders: D-028).
- External penetration test before launch.

## Reporting

Security issues: contact the founder directly (address to be set up: security@<domain>).
