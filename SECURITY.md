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
| Audit              | Logins, failures, registrations, verification decisions, bookings, offer decisions, country and pricing changes                                                                                      |

## To do before production

- Content Security Policy for the web app; HSTS at the edge.
- Private object storage with short-lived signed URLs for documents and photos (+ access tests).
- Secret manager (Key Vault / Secrets Manager) and key rotation runbook.
- Dependency scanning (Dependabot/Renovate + `pnpm audit` in CI) and container image scanning.
- Shared rate-limit store (Redis) once there is more than one API instance.
- Backups with tested restores (point-in-time recovery on the managed database).
- Data retention jobs and data subject request workflow (export/delete with legal holds).
- External penetration test before launch.

## Reporting

Security issues: contact the founder directly (address to be set up: security@<domain>).
