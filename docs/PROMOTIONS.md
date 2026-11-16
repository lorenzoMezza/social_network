# Reach and promotions of events

How far away an event is seen, how an organizer pays to show it farther, how the
money moves, and why it is built this way. The contract is in API.md (Events,
Promotions); the code in `app/promotions.py` and `app/stores.py` (server),
`src/features/promotions/` and `src/components/ui/Slider.js` (app).

## The rules in one place

| | |
|---|---|
| Free reach of an event | 100–800 m, in steps of 50 m (the editor's "Who sees it"), 800 m by default |
| Flash events | always 800 m, never promoted (they are about here and now) |
| Promoted reach | 1 km to 10 km, on fixed radii (below) |
| Who sees an event | people within its reach (the app has no distance filter: it asks for 10 km around and each event's reach decides) |
| On the map | like every event: as far as the map is in sight (its fog, about 700 m), promoted or not, its beam as big as its crowd says. Only its colour differs: gold, whatever its organizer chose, and nothing else is gold (`sponsored`; API.md, Theme) |
| Nearby list | the **2 nearest** sponsored events first, under "Sponsored"; other sponsored events keep their place in the list, marked "Sponsored"; a search shows only what matches, nothing placed above it |
| Marking | every sponsored event says "Sponsored" in the list, on its map card and on its page, with who pays and how far it is shown |

## Prices

The price is **a day of promotion**, and what it buys is time: from the moment it starts,
24 hours at a time, never past the event's end.

    daily    = tierPrice(radius) × (1 − durationDiscount(days)) × zoneFactor
    days     = days from the promotion's start to the event's end, rounded up
    at most  = daily × time left (at least 6 hours)

| Radius | A day |
|---|---|
| ≤ 1 km | €0.99 |
| ≤ 1.5 km | €1.99 |
| ≤ 2 km | €2.99 |
| ≤ 3 km | €4.99 |
| ≤ 4 km | €6.99 |
| ≤ 5 km | €8.99 |
| ≤ 7.5 km | €10.99 |
| ≤ 10 km | €12.99 |

- **The slider stops only on these radii.** A price buys the farthest radius it allows:
  nobody pays €2.99 for 1.6 km when the same money buys 2 km.
- **Duration discount** (by how long it would run): 2–3 days −10%, 4–7 days −20%, 8 days
  or more −30%.
- **Zone factor: 1 everywhere, and never above 1.** No place costs more than the list
  (no surge pricing in busy areas). The hook stays in `promotions.ZONE_FACTOR` in case a
  *lower* price where few events are is ever wanted.
- The daily price is fixed when the promotion starts: a new price list never changes a
  running promotion. It only rises if the event gets shorter (it loses the discount of the
  days it no longer has, from the next charge). The app sends the price it showed (`daily`); a different one
  answers 409 `price_changed` and nothing is charged.

## Paying and getting it back

The stores cannot charge automatically every day (in-app purchases are single
payments or subscriptions, the shortest one week), so the organizer has a **wallet of
promotion credits** (1 credit = €0.01):

1. **Top-up**: a consumable in-app purchase of a credit pack (€0.99, 1.99, 4.99, 9.99,
   19.99, 49.99, 99.99, each worth exactly its price in credits: no bonus credits, no
   odd amounts to push a bigger pack). The promote sheet offers **one** pack, the
   smallest that covers all the time left, so promoting is a single purchase.
2. **The first 24 hours** are charged from the wallet when the promotion starts (less if
   the event ends sooner, but never less than 6 hours' worth).
3. **Each next 24 hours** are charged when the last ones run out (the server's janitor,
   once a minute); the last stretch costs only up to the event's end.
4. **What the wallet cannot pay pauses the promotion**: the event goes back to its free
   reach and its organizer sees "Promotion paused"; the next top-up resumes it at once, for
   24 hours from then.
5. **Stopping** charges nothing more, and gives nothing back: the promotion goes on being
   shown until the time paid runs out. If stopping gave the rest back, anyone could buy only
   their peak hours by stopping right after them.
6. **Cancelling the event gives back the time not used**, in credits, at once: that time
   can no longer be given. The first 6 hours are always paid, otherwise promoting for an
   hour and cancelling would buy the best hour for almost nothing. Stopped first and
   cancelled later, the rest still comes back. Once only, never more than was paid.
7. **Changing the radius** with time still paid: wider costs the difference for the time left,
   narrower costs nothing (no refund) and is cheaper from the next charge; going back
   to a radius already paid costs nothing more.
8. **Moving the event**: what was paid is a time and stays the time it was; moving an event
   on stretches nothing. If the event now ends before that time does, what falls past
   the new end comes back.
9. **Not refunded**: an event taken down by moderation (no reward for breaking the rules)
   and the time already gone. Credits go back as credits, never as money: the money
   only ever moves through the stores. A store refund of a purchase already spent can
   leave the balance negative.
10. **Credits never expire** (an App Store rule for purchased currency, and fair) and
   are not transferable; left-over credits stay for the next promotion. Deleting the
   account deletes the wallet (the dialog says so); its purchases stay known (without the account) so a
   receipt is never credited twice.

## Payments: App Store and Google Play rules

Promoting an event is a digital service used inside the app, so it must be sold with
the stores' in-app purchase: App Store Review Guidelines 3.1.1 (in-app purchase for
digital goods and features, including "boosts"; purchased credits may not expire) and
Google Play's Payments policy (Play Billing for digital goods and services). External
payment links or other processors are allowed only in some storefronts (the US, the EU
under the DMA, user choice billing in some countries), each with its own entitlement and
commission; the app does not use them (one flow everywhere). Prices shown in the sheet
for the packs come from the store, in the user's currency; credits and daily prices are
in euros (the app's market). If other markets come, show credit amounts in the
storefront's currency too.

What the app does (`PromotionsProvider.js`, with `expo-iap`):
- Connects to the store when someone is signed in, loads the packs' localized prices,
  and listens for purchases.
- Buys with `appAccountToken` (iOS) / `obfuscatedAccountId` (Android) set to the
  wallet's `accountToken`: the store puts it in the receipt, and the server credits a
  purchase only to the account that made it.
- Sends every purchase to the server (`POST /me/wallet/purchases`) and **finishes
  (consumes) it only after the server credited it**. A purchase interrupted anywhere
  (app closed, no network, payment pending, Ask to Buy) is listed again by the store at
  the next start and sent again; the server credits each transaction once.
- Without a store (simulator, emulator without a Play account) a development server
  takes test top-ups (`platform: "dev"`, only with `DEV_TOOLS=1`); the sheet says so.
- Development data: each new demo area (seed.py) has three sponsored events of demo
  organizers (1.5, 3 and 5 km), to see the two nearest on top of the list.

What the server does (`stores.py`), never trusting the app:
- **Apple**: the purchase token is the StoreKit 2 signed transaction (JWS). Its
  certificate chain must end at Apple Root CA - G3 (`APPLE_ROOT_CA`, the DER file from
  apple.com/certificateauthority), the leaf must carry the extension
  `1.2.840.113635.100.6.11.1` and the intermediate `1.2.840.113635.100.6.2.1` (without this
  any certificate under Apple's root would do, as a developer's), the signature must hold, and bundle id, type
  (Consumable), appAccountToken, environment (Sandbox only with `APPLE_ALLOW_SANDBOX=1`)
  and revocation are checked.
- **Google**: a purchase of a licence-testing account (`purchaseType` 0) pays nothing and is
  refused unless `GOOGLE_ALLOW_TEST_PURCHASES=1`, on a test server only. The token is looked up with the Play Developer API
  (`purchases.products.get`, a service account in `GOOGLE_SERVICE_ACCOUNT_FILE`); paid
  state and obfuscatedExternalAccountId are checked; the order id is the transaction id.
- **Refunds**: App Store Server Notifications V2 (`POST /v1/store/apple/notifications`,
  REFUND / REVOKE) and Play real-time developer notifications (a Pub/Sub push to
  `POST /v1/store/google/notifications?secret=…`, voided purchases) take the credits
  back. The balance may go below zero: then nothing is paid until a top-up covers it.
- Not configured: that store's purchases answer 503 `unavailable`; nothing is ever
  credited unchecked.

## Setting the stores up (once, before release)

App Store Connect:
1. Agreements, Tax and Banking: the Paid Apps agreement signed.
2. In-App Purchases: seven **Consumable** products with the ids of `CREDIT_PACKS`
   (`promo.credits.099` … `promo.credits.9999`) at the matching prices, with a name and
   description ("Promotion credits, €4.99"), a review screenshot of the promote sheet.
3. App Store Server Notifications: version 2, production and sandbox URL
   `https://<api>/v1/store/apple/notifications`.
4. Server: `APPLE_BUNDLE_ID`, `APPLE_ROOT_CA`; sandbox testers in Users and Access
   (and `APPLE_ALLOW_SANDBOX=1` on the test server only). Locally, a StoreKit
   configuration file in Xcode tests purchases on the simulator.

Google Play Console:
1. A payments profile; the app uploaded once to a testing track with the BILLING
   permission (the `expo-iap` config plugin adds it).
2. Monetize › In-app products: the same seven ids, **managed products**, consumed by
   the app after the server credits them.
3. A service account with "View financial data" and "Manage orders" in Users and
   permissions: its JSON key in `GOOGLE_SERVICE_ACCOUNT_FILE`; `GOOGLE_PACKAGE_NAME`.
4. Monetization setup › Real-time developer notifications: a Pub/Sub topic with a push
   subscription to `https://<api>/v1/store/google/notifications?secret=<GOOGLE_RTDN_SECRET>`.
5. License testers, to buy without being charged.

The app needs a new native build (`make build`) since `expo-iap` is a native module.

## Why it is built this way

- **Unobtrusive for everyone else.** Promotions never break through a person's own
  choices: their category and time filters always apply, a search is never interleaved with ads,
  at most two sponsored events sit above the list and they are always the nearest
  (relevance over budget), the map shows them like every event, only within sight and only in another
  colour (gold), never bigger or farther. Sponsored events are
  always marked, with who pays and how far, as the EU Digital Services Act (art. 26)
  asks of ads.
- **Unobtrusive for organizers.** Nothing about money is in the event editor (only the
  free "Who sees it"); "Promote your event" is one quiet row on the event's own page,
  among its details. No prompts, banners or reminders to promote.
- **Fair, not a money grab.** Fixed public prices, no area surcharge, discount for long
  promotions, the price buys its farthest radius, 24 hours at a time, stop any time, time
  not used back when the event is cancelled, credits that never expire, packs worth
  exactly their price.
- **Safe.** Every purchase verified with the store, credited once, bound to its
  account; refunds reversed; the app finishes a purchase only when the server has it.

## Production notes

- The janitor's charges become a scheduled job (keyed by `paid_until`); each charge, each
  refund and the wallet balance change in one transaction, with the promotion's and the
  wallet's rows locked, so a charge and a cancellation at the same moment cannot both win.
- Wallet entries are an append-only ledger; the balance is their sum (kept on the row
  for speed, checked against the ledger).
- The stores are the merchant of record (they collect VAT and pay the developer); the
  ledger is for support and for users (`GET /me/wallet`, the data export).
- Legal pack (legal/): terms section 5-bis and privacy policy, drafts for the lawyer.
