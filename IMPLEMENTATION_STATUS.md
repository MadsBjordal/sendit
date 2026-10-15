# Implementation status

Updated: 2026-10-15 (milestone 1: foundation + core booking).

Legend: ✅ implemented and tested · 🟡 partly · ⛔ blocked (needs a decision or access) · ⬜ not started

## Phase 1: Foundation

| Module                                          | State | Notes                                                               |
| ----------------------------------------------- | ----- | ------------------------------------------------------------------- |
| Monorepo, TypeScript, lint, format, CI          | ✅    | GitHub Actions with PostGIS service                                 |
| Database + migrations (PostgreSQL 16 + PostGIS) | ✅    | Append-only + balancing triggers                                    |
| Registration, login, logout, sessions           | ✅    | Argon2id, lockout, same answer for unknown email                    |
| Email verification, password reset              | ✅    | Emails recorded in `email_outbox` and the log (no real sending yet) |
| Two-step login (TOTP) for platform staff        | ✅    | Required for every admin action                                     |
| Organisations, members, invitations, roles      | ✅    | Owner/admin/dispatcher/finance/member/driver                        |
| Rate limiting, CSRF, security headers           | ✅    |                                                                     |
| Design system + responsive shell                | ✅    | Tailwind; brand colours as variables                                |
| 7 languages                                     | 🟡    | Framework + all texts; translations AI-written, need native review  |

## Phase 2: Core marketplace

| Module                                                                                    | State | Notes                                                                  |
| ----------------------------------------------------------------------------------------- | ----- | ---------------------------------------------------------------------- |
| Booking screen (from/to/what/when/service/price/maximum)                                  | ✅    | Live server-side estimate, map, progressive details                    |
| Pricing engine (markup vs commission, tiers, countries, corridors, tolls, VAT)            | ✅    | Versioned config with snapshots per shipment; numbers are placeholders |
| Price ceiling enforcement                                                                 | ✅    |                                                                        |
| Carrier matching (PostGIS radius, widening rounds, real vehicle fit, countries, cabotage) | ✅    |                                                                        |
| Load board (filters, sort, details sheet)                                                 | ✅    | Uber-Freight-style layout                                              |
| Atomic first-acceptance booking + concurrency test                                        | ✅    |                                                                        |
| Above-maximum offers, approval with top-up, expiry, rejection, withdrawal                 | ✅    |                                                                        |
| Prepayment, signed webhooks, duplicates, failed payments, refunds                         | ✅    | **Test provider only**                                                 |
| Double-entry ledger, carrier obligation                                                   | ✅    |                                                                        |
| Cancellation before booking + refund; search expiry + refund                              | ✅    |                                                                        |
| Notifications                                                                             | 🟡    | In-app only (bell count); no email/push/SMS delivery                   |
| Customs detection on shipments                                                            | ✅    | Shown to customer and carrier; booking brokers is phase 5              |
| Admin: companies, documents, countries, pricing, shipments, ledger, audit                 | 🟡    | Pricing editing via API only (no form yet)                             |
| Saved addresses, repeat bookings, invoices                                                | ⬜    |                                                                        |

## Phase 3: Carrier operations

| Driver app (Expo), driver assignment, pickup/delivery confirmation, POD, tracking, messaging | ⬜ | |
| Document file upload (private storage) | ⬜ | Documents are entered as numbers only |

## Phase 4: Payments (real)

| Licensed provider integration, payouts, reconciliation, invoices, chargebacks | ⛔ | Needs D-009 and legal structure |

## Phase 5: Customs marketplace

| Broker registration exists (company kind) | 🟡 | |
| Procedures, responsibility matrix, broker matching, documents, border readiness | ⬜ | |

## Phase 6–7

| Fraud, disputes, support tickets, analytics + export, monitoring, return loads, partial loads | ⬜ | |

## Required tests from the brief (part 21)

| #     | Test                                                           | State                                                                            |
| ----- | -------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1     | Customer registration                                          | ✅                                                                               |
| 2     | Carrier verification                                           | ✅                                                                               |
| 3     | Shipment creation                                              | ✅                                                                               |
| 4     | Price calculation                                              | ✅                                                                               |
| 5     | Ceiling enforcement                                            | ✅                                                                               |
| 6     | First-qualified acceptance                                     | ✅                                                                               |
| 7     | Simultaneous acceptance                                        | ✅                                                                               |
| 8     | Above-ceiling approval                                         | ✅                                                                               |
| 9     | Expired above-ceiling offers                                   | ✅                                                                               |
| 10    | Failed payment                                                 | ✅                                                                               |
| 11    | Duplicate webhook                                              | ✅                                                                               |
| 12    | Carrier payout ledger                                          | ✅ (obligation + balances; actual payouts phase 4)                               |
| 13    | Invalid carrier licence                                        | ✅                                                                               |
| 14    | Insufficient vehicle capacity                                  | ✅                                                                               |
| 15    | Customs requirement detection                                  | ✅                                                                               |
| 16–18 | Customs broker assignment, missing documents, border readiness | ⬜ phase 5                                                                       |
| 19    | Unauthorised document access                                   | ⬜ (no document files yet)                                                       |
| 20    | Organisation data isolation                                    | ✅                                                                               |
| 21–22 | Pickup confirmation, proof of delivery                         | ⬜ phase 3                                                                       |
| 23    | Cancellation and refund                                        | ✅                                                                               |
| 24    | Dispute handling                                               | ⬜ phase 6                                                                       |
| 25    | Connectivity failure and recovery                              | 🟡 idempotent accept retry and webhook retry tested; driver offline mode phase 3 |
