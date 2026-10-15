# Project Freight: conventions

- **What it is:** pan-European on-demand road freight marketplace. Working name only: everything visible takes the name from `BRAND_NAME` (`packages/shared/src/brand.ts`). Unrelated to any other project of the owner.
- **Owner is the founder, not a professional developer.** Explain in plain language. After each milestone report: what was built, what works, what was tested, what is unfinished, what needs a decision, what is next.
- **Keep the documents current** with every change: `IMPLEMENTATION_STATUS.md` (exact state), `DECISIONS.md` (every notable choice; ⚠ = needs the founder), `COMPLIANCE.md`, `SECURITY.md`, `DATABASE.md`, `ARCHITECTURE.md`, `ROADMAP.md`.
- **Never claim** something is tested or an integration works unless it was run. Simulated parts are labelled in code, UI and docs (test payments, straight-line routes, sample addresses).
- **Every visible text** through `t('key')` with the key in `apps/web/src/i18n/en.ts` and all 6 other languages (TypeScript and `i18n.test.ts` fail otherwise).
- **Money:** integer minor units + basis points (`packages/shared/src/money.ts`); prices only calculated on the server; keep payout / fee / VAT / total separate; customs duties never in our prices.
- **Booking:** all acceptance goes through `acceptLoad` (lock the shipment row, re-check eligibility, unique booking per shipment, idempotency key). Never book outside that path.
- **Ledger:** only through `post()` with an idempotency key; balanced; append-only (database triggers).
- **Jobs:** queue them with `enqueue(tx, …)` inside the transaction that needs them.
- **Outside services** behind `apps/api/src/adapters/` with a labelled fake. Never invent provider endpoints: check the official docs.
- **Never commit secrets.** `.env` is ignored; keep `.env.example` complete.
- Schema change → edit `apps/api/src/db/schema.ts`, `pnpm --filter @freight/api db:generate`, fix PostGIS types if drizzle quotes them, commit the migration.
- Checks before pushing: `pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm test` (needs `pnpm db:up`).
