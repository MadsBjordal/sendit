# Architecture

## Overview

```
 Browser (Next.js web app)          Driver app (Expo, phase 3)
        │  same-origin /api (rewrite)          │ Bearer token
        ▼                                       ▼
 ┌──────────────────────────── API (Fastify, one process) ───────────────────────────┐
 │ routes/      auth · shipper · carrier · admin · webhooks                           │
 │ services/    auth · shipments · booking · payments · ledger · carriers · admin     │
 │              jobs (queue in PostgreSQL) · notifications · audit                     │
 │ adapters/    payments (TEST only) · email (log) · routing (estimate) · geocoder     │
 └──────────────┬─────────────────────────────────────────────────────────────────────┘
                ▼
        PostgreSQL 16 + PostGIS  (data, ledger, job queue, audit)
```

A **modular monolith**: one deployable API with clear modules, one database. It can be split
later where load or teams require it; there is no reason to start with microservices.

## Modules

| Module               | Responsibility                                                                                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared`    | Pure rules with unit tests: `money` (integer cents, basis points), `pricing`, `vehicles` (fit), `customs` (territories, procedures), `schemas` (zod input validation), `statuses` |
| `services/auth`      | Registration, Argon2id passwords, sessions (random token, only its hash stored), email verification, reset, invitations, TOTP for staff                                           |
| `services/shipments` | Quote, create shipment (+ prepayment), customer views, cancel                                                                                                                     |
| `services/booking`   | Publishing, matching jobs, **the booking transaction**, offers, expiries, load board                                                                                              |
| `services/payments`  | Payment creation, signed webhooks (stored once per event), refunds                                                                                                                |
| `services/ledger`    | Double-entry ledger with idempotent transactions                                                                                                                                  |
| `services/admin`     | Company verification, documents, countries, pricing versions, overview, audit                                                                                                     |
| `services/jobs`      | Retryable background jobs with back-off and dead-lettering                                                                                                                        |

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
5. Phase 3–4: delivery verified → obligation `payable` → payout (`carrier_payable` ↓, `psp_clearing` ↓);
   deferred fee → `platform_revenue`.

Money that arrives for a cancelled payment is never ignored: it is booked and refunded.

## Customs workflow (phase 5 design)

`assessCustoms` (shared) gives procedures per territory (export, import, transit, safety & security,
GVMS, fiscal) with `required`/`possible` certainty and rule ids. Planned tables: `customs_procedures`
(one per procedure, own status machine NOT_REQUIRED … PROCEDURE_COMPLETED), `customs_parties`
(responsibility matrix with acknowledgement), `customs_assignments` (brokers, first-acceptance within
a separate customs budget, or quote), `customs_documents` (versioned), `border_readiness_checks`.

## Background jobs

`jobs` table, written in the same transaction as the change that needs them; picked with
`FOR UPDATE SKIP LOCKED`; exponential back-off; `dead` after max attempts (visible to admins).
Kinds: `match_shipment` (radius widened step by step), `expire_offer`, `expire_shipment`,
`refund_excess`. Notification delivery can never change booking state.

## Hosting (recommendation, not yet deployed)

EU region (e.g. Azure West Europe / AWS eu-central-1 / Scaleway Paris). Start: one container for
the API (+ worker), one for the web app, managed PostgreSQL with PostGIS, managed secrets,
object storage (documents, photos) with private access, error tracking (Sentry EU), uptime checks.

Rough monthly cost at launch volume: managed PostgreSQL (2 vCPU, HA) €150–300; two small
containers €50–120; object storage + backups €10–30; email/SMS €20–100; monitoring €0–50;
truck routing/geocoding provider €200–1,000+ depending on volume. **≈ €450–1,600/month**,
excluding the payment provider's per-transaction fees.
