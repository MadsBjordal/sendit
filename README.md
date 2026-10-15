# Project Freight (working name)

A pan-European on-demand road freight platform: shippers request transport as easily as a taxi,
the first qualified carrier that accepts within the shipper's maximum gets the job, and the
platform pays the carrier. **The name is temporary**: change `BRAND_NAME` in `.env` (and the
colours in `apps/web/src/app/globals.css`) to rebrand.

> Development version. Payments are **simulated** (no real money), distances are **straight-line
> estimates** (no truck routing), and address search knows only **sample addresses**. See
> `IMPLEMENTATION_STATUS.md` for exactly what works.

## What is in the repository

| Folder            | What it is                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `packages/shared` | Business rules used everywhere: money, pricing, vehicle fit, customs detection, input checks |
| `apps/api`        | The server (Fastify + PostgreSQL/PostGIS): accounts, shipments, booking, payments, admin     |
| `apps/web`        | The website (Next.js): customer booking, carrier load board, administration; 7 languages     |

Documents: `ARCHITECTURE.md`, `PRODUCT_REQUIREMENTS.md`, `DATABASE.md`, `SECURITY.md`,
`COMPLIANCE.md`, `ROADMAP.md`, `DECISIONS.md`, `IMPLEMENTATION_STATUS.md`.

## Running it on your computer

You need: **Node.js 22**, **pnpm 9** (`npm install -g pnpm`), and **Docker Desktop** (for the database).

```bash
git clone https://github.com/MadsBjordal/sendit.git
cd sendit
copy .env.example .env        # Windows (macOS/Linux: cp .env.example .env)
pnpm install
pnpm db:up                    # starts PostgreSQL + PostGIS in Docker
pnpm db:setup                 # creates the tables, opens development countries, creates an admin
pnpm dev                      # API on http://localhost:4000, website on http://localhost:3000
```

`pnpm db:setup` prints the platform admin's login and a **two-step login key**. Add that key to an
authenticator app (Google Authenticator, Microsoft Authenticator, 1Password …) to log in at `/admin`.

API documentation (OpenAPI): http://localhost:4000/api/docs

## Trying the main flow by hand

1. Open http://localhost:3000 → **I need to ship** → register a shipper company.
2. Emails are not sent in development: they are printed in the API window. Open the
   confirmation link from there.
3. **Request transport**: search "Hamburg" and "Rotterdam", 4 pallets, keep the suggested maximum,
   press **Request transport**, then **Simulate a successful payment**.
4. In a private browser window register a **carrier** (**I have trucks**). Add documents under
   **Verification**, a vehicle under **Fleet** (usual location e.g. "Hamburg") and tick the countries.
5. Log in as the admin at `/admin` → **Companies** → approve the documents and **Verify** the carrier.
6. As the carrier open **Find loads**: the shipment is there with its payout. **Accept** it, and
   the shipper's page shows **Carrier booked** and the refund of the unused prepayment.
7. Try **Ask for a different payout** with a higher amount: the shipper sees an offer to approve.

## Checks

```bash
pnpm test        # unit + integration tests (needs the database from pnpm db:up)
pnpm typecheck
pnpm lint
pnpm format
```

The integration tests use a separate database `freight_test` and empty it themselves.
