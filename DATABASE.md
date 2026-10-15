# Database

PostgreSQL 16 with PostGIS. Schema in `apps/api/src/db/schema.ts`; migrations in `apps/api/drizzle/`
(generated with `pnpm --filter @freight/api db:generate`, plus hand-written rules in `0001_ledger_rules.sql`).
The API runs pending migrations when it starts.

## Tables

**Identity**: `organisations` (kind shipper/carrier/customs_provider/platform, status, operating
countries) · `users` (email unique case-insensitively, Argon2id hash, staff role, TOTP) ·
`memberships` (user × organisation × role) · `invitations` · `sessions` (token hash) ·
`user_tokens` (email verification, password reset) · `email_outbox` · `verification_documents`.

**Configuration**: `country_configuration` (open / domestic) · `pricing_configurations` (versioned
JSON, exactly one active) · `feature_flags`.

**Fleet**: `vehicles` (real payload and cargo space, equipment, `base_location geography(Point)` with a GiST index).

**Freight**: `shipments` (status, cargo summary, route, **pricing snapshot**, estimate, listed payout,
**max_price_minor** (private), funded amount, customs assessment, search state) ·
`shipment_locations` (pickup/delivery with `point geography`) · `cargo_lines` · `price_snapshots`
(estimate, every acceptance, booking) · `offers` (above-maximum) · `bookings` (**UNIQUE shipment_id**) ·
`accept_attempts` (idempotency, UNIQUE carrier × key) · `shipment_events` (append-only history).

**Money**: `payments` (purpose prepayment/top-up) · `payment_provider_events` (UNIQUE provider × event id) ·
`refunds` · `ledger_accounts` · `ledger_transactions` (UNIQUE idempotency key) · `ledger_entries`
(signed amounts, append-only, balanced per transaction at commit) · `carrier_obligations` (UNIQUE booking).

**Platform**: `jobs` (queue; partial unique dedupe key) · `notifications` (UNIQUE user × dedupe key) · `audit_logs` (append-only).

## Separation of state

Shipment state (`shipments.status`), offer state, payment state and ledger are separate; customs
procedures will get their own tables and states (phase 5) rather than extra shipment statuses.

## Rules enforced by the database

- Append-only: `ledger_entries`, `ledger_transactions`, `shipment_events`, `audit_logs`.
- Ledger transaction balances per currency (deferred constraint trigger).
- `bookings.shipment_id` unique; `bookings` net = payout + fee and total = net + VAT.
- Status check constraints on shipments, offers, memberships, organisations.
- Positive payment amounts, non-negative funded amount, positive maximum.

## Money columns

All `*_minor` columns are `bigint` whole cents (`minor` helper), read as safe JavaScript integers.
