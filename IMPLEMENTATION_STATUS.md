# Implementation status

Updated: 2026-10-15 (milestones 1–7 built; everything runs locally with simulated outside services).

Legend: ✅ implemented and tested · 🟡 partly · ⛔ blocked (needs a decision or access) · ⬜ not started

**Simulated (labelled in code, screens and here):** payments and payouts (test provider, no real
money), routes (straight line × 1.25, not truck routing), address search (sample addresses only),
email (written to the log unless `EMAIL_PROVIDER=smtp`), file storage (a local folder).

Tests that ran: shared rules 38, web 7, API integration 76 (real PostgreSQL + PostGIS), driver-app
unit tests (outbox, signature PNG). Browser walk-throughs of the shipper → carrier → driver →
delivery flow were run on the built apps during milestones 2–6.

## Phase 1: Foundation

| Module                                          | State | Notes                                                               |
| ----------------------------------------------- | ----- | ------------------------------------------------------------------- |
| Monorepo, TypeScript, lint, format, CI          | ✅    | GitHub Actions with PostGIS service, `pnpm audit`, driver-app job   |
| Database + migrations (PostgreSQL 16 + PostGIS) | ✅    | 10 migrations; append-only and balancing triggers                   |
| Registration, login, logout, sessions           | ✅    | Argon2id, lockout, same answer for unknown email                    |
| Email verification, password reset and change   | ✅    | Change in Settings needs the current password; other sessions end   |
| Two-step login (TOTP) for platform staff        | ✅    | Required for every admin action                                     |
| Organisations, members, invitations, roles      | ✅    | Owner/admin/dispatcher/finance/member/driver                        |
| Rate limiting, CSRF, security headers, CSP      | ✅    | CSP still allows inline scripts (Next.js needs them, see SECURITY)  |
| Design system + responsive shell                | ✅    | Tailwind; brand colours as variables                                |
| 7 languages                                     | 🟡    | All texts in all 7; translations AI-written, need native review (⚠) |

## Phase 2: Core marketplace

| Module                                                                                    | State | Notes                                               |
| ----------------------------------------------------------------------------------------- | ----- | --------------------------------------------------- |
| Booking screen (from/to/what/when/service/price/maximum)                                  | ✅    | Live server-side estimate, map, progressive details |
| Pricing engine (markup vs commission, tiers, countries, corridors, tolls, VAT)            | ✅    | Versioned; numbers are placeholders (⚠ D-011)       |
| Price ceiling enforcement                                                                 | ✅    |                                                     |
| Carrier matching (PostGIS radius, widening rounds, real vehicle fit, countries, cabotage) | ✅    |                                                     |
| Load board (filters, sort, details sheet)                                                 | ✅    | Uber-Freight-style layout                           |
| Atomic first-acceptance booking + concurrency test                                        | ✅    |                                                     |
| Above-maximum offers, approval with top-up, expiry, rejection, withdrawal                 | ✅    |                                                     |
| Prepayment, signed webhooks, duplicates, failed payments, refunds                         | ✅    | **Test provider only**                              |
| Double-entry ledger, carrier obligation                                                   | ✅    |                                                     |
| Cancellation before booking + refund; search expiry + refund                              | ✅    | Cancelling a booked shipment online: ⚠ D-019        |
| Notifications: in-app centre + emails, per-person settings                                | ✅    | No SMS or push yet                                  |
| Saved places, book again, admin pricing form                                              | ✅    |                                                     |

## Phase 3: Carrier operations

| Module                                                                  | State | Notes                                                                |
| ----------------------------------------------------------------------- | ----- | -------------------------------------------------------------------- |
| Drivers (invite, licence, link to a login), assign driver with empty km | ✅    |                                                                      |
| Trip steps: arrived, collected (photos, seal, count), delivered (sign)  | ✅    | Wrong order refused; every step stored append-only                   |
| Proof of delivery PDF, customer accepts or disputes, auto-accept 48 h   | ✅    |                                                                      |
| Tracking during the trip only, ETA, customer sees progress              | ✅    | Positions deleted after 90 days                                      |
| Messages per shipment (customer ↔ carrier ↔ driver), unread counts      | ✅    |                                                                      |
| Private file storage with access checks                                 | 🟡    | Local folder; cloud storage with signed links before production      |
| Driver app (Expo): jobs, steps, photos, signature, offline outbox       | 🟡    | Tested as a web build; **not yet run on a real phone or in a store** |
| Return-load suggestions for carriers                                    | ✅    | Milestone 7                                                          |
| Carrier performance page (on time, tracking, claims)                    | ✅    | Milestone 7                                                          |

## Phase 4: Payments

| Module                                                             | State | Notes                                                    |
| ------------------------------------------------------------------ | ----- | -------------------------------------------------------- |
| Payouts to carriers and customs providers (IBAN check, retries)    | ✅    | **Test payout provider**; real provider blocked on D-009 |
| Invoices, carrier payment statements, customs invoices (no gaps)   | ✅    | Say DRAFT until the legal entity is set in `.env`        |
| Reconciliation report (ledger vs payments, refunds, payouts, owed) | ✅    | Admin → Finance                                          |
| Chargebacks (money taken back, recorded, flagged)                  | ✅    | Simulated events                                         |
| Real licensed payment provider                                     | ⛔    | D-009                                                    |

## Phase 5: Customs marketplace

| Module                                                                     | State | Notes                                      |
| -------------------------------------------------------------------------- | ----- | ------------------------------------------ |
| Procedures per shipment with their own status machine                      | ✅    |                                            |
| Responsibility matrix with acknowledgement by link                         | ✅    |                                            |
| Customs broker profiles, job board, first acceptance within budget, quotes | ✅    |                                            |
| Versioned customs documents, required-document lists                       | ✅    |                                            |
| Border readiness for driver and carrier                                    | ✅    |                                            |
| Customs rules reviewed by a customs professional                           | ⛔    | Required before launch (COMPLIANCE gate 9) |

## Phase 6: Production readiness

| Module                                                            | State | Notes                                           |
| ----------------------------------------------------------------- | ----- | ----------------------------------------------- |
| Disputes (customer opens, support decides refund split)           | ✅    | Split rules: ⚠ D-026                            |
| Fraud rules (new bank details hold, shared IBAN, failed payments) | ✅    | ⚠ D-025                                         |
| Support tickets with replies                                      | ✅    |                                                 |
| GDPR: data export, erasure requests, retention job                | ✅    | Retention periods are placeholders (⚠ gate 10)  |
| Analytics with Excel/CSV export                                   | ✅    |                                                 |
| Health check (fails when jobs are overdue), Dependabot            | ✅    | No hosting, error tracking or uptime checks yet |
| Penetration test, load test, hosting                              | ⬜    | Before launch                                   |

## Phase 7: Expansion

| Module                                                                                      | State |
| ------------------------------------------------------------------------------------------- | ----- |
| Return loads, carrier performance                                                           | ✅    |
| Partial loads (several shipments on one truck), dedicated lanes, telematics, enterprise API | ⬜    |

## Required tests from the brief (part 21)

| #   | Test                              | State                                                                               |
| --- | --------------------------------- | ----------------------------------------------------------------------------------- |
| 1   | Customer registration             | ✅                                                                                  |
| 2   | Carrier verification              | ✅                                                                                  |
| 3   | Shipment creation                 | ✅                                                                                  |
| 4   | Price calculation                 | ✅                                                                                  |
| 5   | Ceiling enforcement               | ✅                                                                                  |
| 6   | First-qualified acceptance        | ✅                                                                                  |
| 7   | Simultaneous acceptance           | ✅                                                                                  |
| 8   | Above-ceiling approval            | ✅                                                                                  |
| 9   | Expired above-ceiling offers      | ✅                                                                                  |
| 10  | Failed payment                    | ✅                                                                                  |
| 11  | Duplicate webhook                 | ✅                                                                                  |
| 12  | Carrier payout ledger             | ✅                                                                                  |
| 13  | Invalid carrier licence           | ✅                                                                                  |
| 14  | Insufficient vehicle capacity     | ✅                                                                                  |
| 15  | Customs requirement detection     | ✅                                                                                  |
| 16  | Customs broker assignment         | ✅                                                                                  |
| 17  | Missing customs documents         | ✅                                                                                  |
| 18  | Border readiness                  | ✅                                                                                  |
| 19  | Unauthorised document access      | ✅                                                                                  |
| 20  | Organisation data isolation       | ✅                                                                                  |
| 21  | Pickup confirmation               | ✅                                                                                  |
| 22  | Proof of delivery                 | ✅                                                                                  |
| 23  | Cancellation and refund           | ✅                                                                                  |
| 24  | Dispute handling                  | ✅                                                                                  |
| 25  | Connectivity failure and recovery | ✅ server side (idempotent retries); driver outbox unit-tested, not on a real phone |
