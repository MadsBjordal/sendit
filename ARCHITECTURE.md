# Architecture

## Overview

```
 Browser (Next.js web app)          Driver app (Expo, apps/driver)
        │  same-origin /api (rewrite)          │ Bearer token
        ▼                                       ▼
 ┌──────────────────────────── API (Fastify, one process) ───────────────────────────┐
 │ routes/      auth · shipper · carrier · operations · customs · service · admin ·    │
 │              misc (health, settings, webhooks)                                      │
 │ services/    auth · shipments · booking · payments · ledger · trips · drivers ·     │
 │              payouts · invoices · reconciliation · customs · disputes · fraud ·     │
 │              support · privacy · analytics · returnLoads · jobs · notifications     │
 │ adapters/    payments + payouts (TEST) · email (log/SMTP) · routing (estimate) ·    │
 │              geocoder (samples) · storage (local folder)                             │
 └──────────────┬─────────────────────────────────────────────────────────────────────┘
                ▼
        PostgreSQL 16 + PostGIS  (data, ledger, job queue, audit)
```

A **modular monolith**: one deployable API with clear modules, one database. It can be split
later where load or teams require it; there is no reason to start with microservices.

## Modules

| Module                                                          | Responsibility                                                                                                                                                                    |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared`                                               | Pure rules with unit tests: `money` (integer cents, basis points), `pricing`, `vehicles` (fit), `customs` (territories, procedures), `schemas` (zod input validation), `statuses` |
| `services/auth`                                                 | Registration, Argon2id passwords, sessions (random token, only its hash stored), email verification, reset, invitations, TOTP for staff                                           |
| `services/shipments`                                            | Quote, create shipment (+ prepayment), customer views, cancel                                                                                                                     |
| `services/booking`                                              | Publishing, matching jobs, **the booking transaction**, offers, expiries, load board                                                                                              |
| `services/payments`                                             | Payment creation, signed webhooks (stored once per event), refunds                                                                                                                |
| `services/ledger`                                               | Double-entry ledger with idempotent transactions                                                                                                                                  |
| `services/admin`                                                | Company verification, documents, countries, pricing versions, overview, audit                                                                                                     |
| `services/jobs`                                                 | Retryable background jobs with back-off and dead-lettering                                                                                                                        |
| `services/trips`, `drivers`, `files`, `messages`                | Driver assignment, trip steps (arrived, collected, delivered), proof of delivery PDF, tracking and ETA, private files, messages per shipment                                      |
| `services/payouts`, `invoices`, `reconciliation`, `chargebacks` | Payouts after accepted delivery, invoices and payment statements without gaps, the finance check report, money taken back by the card network                                     |
| `services/customs`                                              | Procedures and their status machine, responsibility matrix, broker job board (first acceptance within budget, quotes), documents, border readiness                                |
| `services/disputes`, `fraud`, `support`, `privacy`, `analytics` | Dispute decisions with refund split, fraud alerts and payout holds, support tickets, data export/erasure and retention, reports with Excel/CSV                                    |
| `services/returnLoads`                                          | Return-load suggestions after a booked job; the carrier performance record                                                                                                        |
| `apps/driver`                                                   | Expo app for drivers: jobs, steps with photos and signature, an offline outbox that retries with the same idempotency keys                                                        |

## Booking transaction (first qualified acceptance wins)

`acceptLoad` in `services/booking.ts`, all in one database transaction:

1. Idempotency: the same `(carrier, idempotencyKey)` returns the stored answer.
2. `SELECT … FROM shipments WHERE id = $1 FOR UPDATE`: concurrent accepts queue here.
3. Status must be `searching` and not past its search time; otherwise **already assigned** / **not available**.
4. Eligibility re-checked: verified company, approved licence + insurance valid through the pickup
   window, the vehicle's real payload/space/equipment, operating countries, cabotage.
5. Final price calculated on the server from the payout with the shipment's pricing snapshot.
6. Within the maximum (and funded): insert booking (`bookings.shipment_id` is **UNIQUE**: a second
   line of defence), mark booked, supersede open offers, ledger entries, carrier obligation,
   queue the refund of the unused prepayment, notify. Above: create an offer for the customer.

The test `two carriers at the same moment` fires five acceptances at once against a real database.

## Above-maximum offers

Offer → customer approves → a **top-up payment** for the difference is created; the shipment stays
open to everyone. When the top-up's webhook arrives the booking is finalised in the same locked
transaction **only if the shipment is still open**; otherwise the top-up is refunded.

## Payment flow (MVP, prepaid)

1. Shipment created → payment for the customer's **maximum** at the provider.
2. Provider webhook `payment.succeeded` (signature checked, stored once) → ledger
   (`psp_clearing` ↑, `customer_funds` ↑) → shipment `searching`.
3. Booking → `customer_funds` ↓ total; `carrier_payable` ↑ payout; `platform_revenue_deferred` ↑ fee;
   `vat_payable` ↑ VAT; carrier obligation `committed` (funded).
4. Unused prepayment refunded by a job (provider idempotency key; ledger idempotency key).
5. Delivery accepted (customer confirms, or 48 h without a dispute) → obligation `payable`, deferred
   fee → `platform_revenue` → payout job (`carrier_payable` ↓, `psp_clearing` ↓); the provider later
   confirms arrival or failure by webhook (a failure puts the money back as owed and on hold).
6. A dispute holds the obligation; the decision posts the refund split (carrier deduction + platform share).
7. Customs work has its own budget payment, `customs_provider_payable` and `customs_revenue`.

Money that arrives for a cancelled payment is never ignored: it is booked and refunded.

## Customs workflow

`assessCustoms` (shared) gives procedures per territory (export, import, transit, safety & security,
GVMS, fiscal) with `required`/`possible` certainty and rule ids. Tables: `customs_procedures`
(one per procedure, own status machine NOT_REQUIRED … PROCEDURE_COMPLETED), `customs_parties`
(responsibility matrix, acknowledged by a link), `customs_jobs` + `customs_quotes` (brokers: first
acceptance within a separate customs budget, or a quote the customer approves), `customs_documents`
(versioned). Border readiness is worked out from these (`borderReadiness` in shared).

## Background jobs

`jobs` table, written in the same transaction as the change that needs them; picked with
`FOR UPDATE SKIP LOCKED`; exponential back-off; `dead` after max attempts (visible to admins).
Kinds: `match_shipment` (radius widened step by step), `expire_offer`, `expire_shipment`,
`refund_excess`, `notification_email`, `generate_pod`, `auto_accept_delivery`, `purge_tracking`,
`carrier_payout`, `issue_customer_invoice`, `issue_carrier_statement`, `issue_customs_invoice`,
`match_customs_job`, `expire_customs_job`, `refund_customs_excess`, `retention`. Notification delivery
can never change booking state. `/api/health` answers 503 when jobs are overdue.

## Hosting (recommendation, not yet deployed)

EU region (e.g. Azure West Europe / AWS eu-central-1 / Scaleway Paris). Start: one container for
the API (+ worker), one for the web app, managed PostgreSQL with PostGIS, managed secrets,
object storage (documents, photos) with private access, error tracking (Sentry EU), uptime checks.

Rough monthly cost at launch volume: managed PostgreSQL (2 vCPU, HA) €150–300; two small
containers €50–120; object storage + backups €10–30; email/SMS €20–100; monitoring €0–50;
truck routing/geocoding provider €200–1,000+ depending on volume. **≈ €450–1,600/month**,
excluding the payment provider's per-transaction fees.
