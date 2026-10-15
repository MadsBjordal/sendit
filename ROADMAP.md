# Roadmap

Each milestone ends with: what was built, what works, what was tested, what is unfinished, what needs a decision.

| Phase                  | Content                                                                                                                                                           | Acceptance criteria                                                                              | State                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| 1 Foundation           | Repo, DB, auth, companies, roles, design system, CI                                                                                                               | Register/login/verify/reset/invite tested; CI green                                              | ✅                                                                  |
| 2 Core marketplace     | Booking screen, pricing, ceilings, matching, first-acceptance booking, offers, prepayment (test), refunds, ledger, load board, admin basics                       | End-to-end booking locally; concurrency test; required tests 1–15, 20, 23                        | ✅                                                                  |
| 2b Polish              | Saved addresses, repeat booking, pricing form in admin, email delivery (EU provider), notification centre                                                         | Customer can rebook in < 30 s                                                                    | ✅                                                                  |
| 3 Carrier operations   | Driver app (Expo), assign drivers (deadhead), pickup/delivery confirmation, photos, signature, POD PDF, CMR data, tracking + ETA, messaging, private file storage | Driver completes a job offline-tolerant; POD accepted → obligation payable; tests 19, 21, 22, 25 | ✅ (app not yet on a real phone)                                    |
| 4 Payments             | Real PSP (D-009), payouts, invoices/credit notes, reconciliation, chargebacks                                                                                     | Payout within target after verified delivery in sandbox; reconciliation report balances          | 🟡 built on a test provider; real one blocked on D-009              |
| 5 Customs              | Procedures per shipment, responsibility matrix with acknowledgement, broker portal and matching, documents, border readiness for drivers                          | Tests 16–18                                                                                      | ✅                                                                  |
| 6 Production readiness | Disputes, support, fraud rules, monitoring, CSP, pen test, load test, analytics + export, GDPR workflows                                                          | Gates in COMPLIANCE.md closed for launch countries                                               | 🟡 software done; pen test, load test, hosting and legal gates open |
| 7 Expansion            | More countries/vehicles, return loads, partial loads, telematics, enterprise API, dedicated lanes, carrier performance                                            | Per-feature                                                                                      | 🟡 return loads + performance done                                  |

## Next steps

1. Your answers to the ⚠ items in `DECISIONS.md`.
2. Choose the payment provider (D-009) and connect its sandbox; then truck routing (D-010) and address search.
3. Run the driver app on a real Android phone; publish test builds.
4. Hosting in an EU region, error tracking, backups, then a penetration test and load test.
5. Partial loads, dedicated lanes, telematics, enterprise API.

**Minimum end-to-end proof of the marketplace model** = phase 2 (done locally, simulated money) + phase 3 POD + phase 4 real payout in the PSP sandbox.
