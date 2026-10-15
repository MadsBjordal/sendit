# Product requirements (summary)

The full brief is the founder's master build prompt. This file keeps the rules that decide behaviour.

## Non-negotiable rules

1. **On-demand requests**: the customer requests transport through a booking screen with a live estimate; carriers are searched for automatically.
2. **Service levels** Standard / Priority / Express change search radius, search time, notice needed and price; they are not delivery guarantees.
3. **Customer maximum**: total including platform charges and VAT; private; customs services budgeted separately.
4. **First qualified acceptance wins**: no auction, no bidding window, no approval when within the maximum; decided by an atomic server transaction.
5. **Above the maximum**: an offer the customer may approve; others can still win meanwhile; approval applies to that offer only.
6. **Platform-guaranteed carrier payment**: customers pay the platform, the platform pays carriers, backed by collected funds.
7. **Customs coordination** without claiming authorisations we do not hold.
8. **Europe-wide, configurable**: nothing is enabled that cannot be supported legally and operationally.

## Users

Shippers (web), carriers (web + driver app), customs providers (portal), platform staff (admin).

## Screens (milestone 1)

| Who           | Screen                                                                                                 | Purpose                                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Everyone      | Home, register (choose shipper/carrier/broker), login, verify email, reset password, accept invitation | Accounts                                                                                                                                          |
| Shipper       | **Request transport**                                                                                  | From, To, What, When, Service, live Price, Maximum, Request; more details folded away                                                             |
| Shipper       | Test checkout                                                                                          | Stands in for the provider's payment page                                                                                                         |
| Shipper       | Shipments, Shipment detail                                                                             | Live search progress, offers to approve/reject, booking, customs, history, cancel                                                                 |
| Carrier       | **Find loads**                                                                                         | Cards with payout, €/km, timeline, distance to pickup; filters; details sheet with map, schedule, vehicle choice, Accept / Ask a different payout |
| Carrier       | My jobs                                                                                                | Booked jobs with full addresses, payout and guarantee terms; open offers                                                                          |
| Carrier       | Fleet, Verification                                                                                    | Vehicles with real capacity, operating countries; licences and insurance                                                                          |
| All companies | Team                                                                                                   | Members, roles, invitations                                                                                                                       |
| Staff         | Administration                                                                                         | Companies + documents, shipments, countries, ledger, audit                                                                                        |

## Navigation model

One top bar; items depend on the company type. Mobile: menu button. The carrier experience follows
the Uber Freight carrier app layout the founder shared (loads list → details → accept / ask price;
later: assign drivers with deadhead, performance, dedicated lanes).

## Later screens (phases 3–7)

Driver app (today's job, pickup/delivery confirmation with photos and signature, border readiness,
offline), assign drivers, tracking map, messages, invoices and payouts, customs broker portal,
customs responsibility matrix, disputes, support, analytics with CSV/Excel export, saved
addresses and repeat bookings, return-load suggestions, dedicated lanes.
