# Compliance and legal gates

The software never treats this list as legal authorisation. Unsupported countries and regulated
services stay **switched off** (country configuration, disabled vehicle classes, no dangerous goods)
until each gate is closed by qualified advisers.

## Gates before live production (brief part 23)

| #   | Gate                                                                                                                                                                                                    | Who                         | State                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | -------------------------------------------- |
| 1   | Legal entity and contracting structure (where, which group structure)                                                                                                                                   | Founder + corporate counsel | Open                                         |
| 2   | Our role per jurisdiction: **freight forwarder / contractual carrier / intermediary**. Contracting with the shipper and guaranteeing carrier payment makes a "pure marketplace" classification unlikely | Transport counsel           | Open                                         |
| 3   | National freight and forwarding rules per active country (licences for forwarders where required, e.g. some countries license forwarding agents)                                                        | Transport counsel           | Open                                         |
| 4   | Insurance: freight forwarder's liability, CMR exposure if we are the contractual carrier, professional indemnity, cyber                                                                                 | Broker                      | Open                                         |
| 5   | Customer terms and carrier terms (incl. cancellation, waiting time, damage, liability limits under CMR Art. 23)                                                                                         | Counsel                     | Open                                         |
| 6   | **Carrier payment guarantee**: enforceable conditions (delivery verified, POD accepted, no dispute), timing (initiation vs arrival, business days)                                                      | Counsel + finance           | Draft text in `GUARANTEE_TERMS` (booking.ts) |
| 7   | Payment structure: licensed PSP, who holds funds, no unlicensed escrow/e-money activity, safeguarding                                                                                                   | Payments counsel + PSP      | Open (D-009)                                 |
| 8   | Chargeback and fraud controls (prepayment only for now; 3-D Secure; velocity limits)                                                                                                                    | Finance + PSP               | Partly (prepayment only)                     |
| 9   | Customs: we do not file declarations. Customs representatives/brokers must hold the authorisations they claim (direct/indirect representation)                                                          | Customs adviser             | Open                                         |
| 10  | GDPR: records of processing, DPAs with every processor, retention periods, data subject requests, DPIA for driver tracking                                                                              | DPO / privacy counsel       | Open                                         |
| 11  | Tax: VAT on transport services (B2B place of supply, reverse charge, domestic exceptions), invoicing rules, e-invoicing mandates per country                                                            | Tax adviser                 | Placeholder rule (D-017)                     |
| 12  | Review of every activated country and route                                                                                                                                                             | All above                   | Development countries only                   |

## What the software already does to stay on the safe side

- **No real money**: the test payment provider refuses to start in production.
- **No guarantee badge without funds**: obligations record `funded`; the badge shows only then.
- **No false customs certainty**: missing facts give "possible" or "manual check"; rules carry
  sources and effective dates (`packages/shared/src/customs.ts`, version `CUSTOMS_RULES_VERSION`).
- **No unsafe loads**: dangerous goods, flatbed and specialist bookings are disabled.
- **No unproven compliance**: cabotage needs the carrier's explicit confirmation; foreign non-EU
  vehicles are refused domestic jobs; documents must be approved by staff and valid through the job.
- **Sanctioned countries** (Russia, Belarus) cannot be activated.
- **Customs duties and import VAT** are not part of our prices and never become platform revenue.
- **Driver location privacy**: location only during an active job and only while the app is open,
  customer sees progress, not the driver's identity or history; positions deleted after 90 days.
- **Data subject requests**: people export their data and ask for erasure; erasure keeps financial
  records the law requires (D-028).
- **Invoices say DRAFT** until the legal entity's name, address and VAT number are set.

## Personal data held today

Users (name, email, password hash, language), company data, shipment contacts (name, phone),
IP address and user agent in sessions and audit logs, driver names/phones/licences, delivery
photos and signatures, positions during trips, bank details (IBAN, shown masked), support messages.
Retention periods are placeholders (gate 10, D-028).
