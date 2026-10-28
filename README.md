# Not Delivered in the Blue Truck

A local Stage 1 prototype for comparing a purchase on the whole picture —
price, shipping, estimated arrival, return window and return cost, warranty,
and seller rating — rather than sticker price alone.

Built by **Nio Innovations LLC** for the Meta Global AI Developer Hackathon.

> **Prototype honesty rule:** Everything merchant-related in this project is
> local sample data. The app makes no live retailer calls, shows no live
> prices, processes no payment, places no retailer order, sends no email, and
> creates no real return or carrier label. Checkout, confirmation, order
> history, countdowns, and labels are interface simulations stored only in
> the visitor's browser.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

Production check:

```bash
npm run build
npm run start
```

Stack: Next.js (App Router) + TypeScript and plain CSS. There are no runtime
dependencies beyond Next and React.

## What the prototype does

1. **Retail-style search** — a broad search such as “Bose headphones” lists
   matching models. A more specific search, or selecting a model, opens its
   comparison.
2. **Top-five comparison** — each product has six sample offers spanning
   Walmart, Best Buy, and eBay sellers; the top five are ranked and shown.
   Results show merchant/seller, condition, price, shipping, estimated
   arrival, return window, free vs buyer-paid returns, warranty, seller
   rating, total cost, and score.
3. **Recommendation** — offers are weighted by the shopper's selected
   priority: cheapest, fastest, or easiest returns. The explanation compares
   the winner with the cheapest-sticker offer in plain language.
4. **Agent activity panel** — every comparison shows the pipeline that
   produced it, step by step: interpret → route merchants through the
   policy gate → gather → verify/normalize → score → explain.
5. **Merchant policy gate panel** — the home view lists each merchant's
   gate outcome before any data moves: Walmart browsed under its Agentic
   Access Terms, Best Buy and eBay official-API only, Target
   authorized-channel only (never browsed).
6. **Guest cart and sandbox checkout** — no account or login. Payment fields
   are dummy fields, stay in the page, and are not transmitted or stored.
   If the cart contains a Walmart offer, checkout additionally requires
   the **Human Consent Gate** (below).
7. **Sample confirmation** — shows a generated confirmation number and
   “Ships from and sold by [seller].” No retailer order or email exists.
8. **Order history and live countdown** — sample orders persist in
   `localStorage`, with the return deadline and remaining time updating while
   the page is open.
9. **Prototype returns** — the shopper can choose UPS drop-off or UPS pickup
   and view/print a conspicuously labelled sample label. It is not a UPS
   label and must not be used for shipment.

### Human Consent Gate (Walmart)

Walmart's Agentic Access Terms require a human to approve every checkout:
agents never check out autonomously and never receive payment-card details.
The prototype implements that rule as product behavior. When the cart
contains a Walmart offer, the checkout form shows a distinct consent panel
— merchant, item, all-in total, and estimated arrival — and the guest must
affirmatively check **“I authorize this purchase”** before the sandbox
checkout can complete. Changing the cart voids the consent, and the
resulting sample order records that the gate was passed. Other merchants
keep the standard sandbox flow.

## Architecture

| Piece | Location |
|---|---|
| Brand configuration | `lib/config.ts` |
| Domain types and provenance | `lib/types.ts` |
| Local sample catalog/search | `lib/data.ts` |
| Scoring and explanation logic | `lib/scoring.ts` |
| Policy registry and adapter seams | `lib/adapters.ts` |
| Muse Spark pipeline + Meta Model API live path | `lib/agent.ts` |
| Product search API | `app/api/search/route.ts` |
| Comparison API | `app/api/decide/route.ts` |
| Policy-gate API | `app/api/policy-gate/route.ts` |
| Search → comparison → cart → orders UI | `components/ShoppingApp.tsx` |

### Policy-routed hybrid acquisition (future design)

Acquisition is designed as a **policy-routed hybrid**, not API-only:

| Route | Meaning |
|---|---|
| `api` | Official merchant/developer API. Preferred when a suitable API exists. |
| `browser` | Future backend-controlled browser extraction, only when the site's policy does not prohibit autonomous agents. |
| `disabled` | The route is not used, because the merchant is API-only or the route is explicitly prohibited. |

The browser gate is **prohibition-based, not permission-based**. A future
browser-adapter merchant does not need to affirmatively invite agents:
if its policy does not prohibit autonomous agents/automated access, the
browser route is permitted (`browser-permitted-unless-prohibited`). An
explicit prohibition is `excluded-prohibited`. Policy-silent sites are not
labelled excluded or unclear merely because they are silent.

An active CAPTCHA, block, or challenge is treated as a prohibition **in
practice for that browser session**: stop immediately and never evade it.

This prototype does **not** implement a browser crawler, scraping, browser
purchasing, CAPTCHA handling, login automation, or any live acquisition.

### Per-merchant policy registry

- **Walmart — `browser-allowed-under-terms` (merchant #1).** Walmart.com
  Terms of Use (updated Sep 21, 2026), §16.L "Authorized Agents," route
  agents into Walmart's **Agentic Access Terms**. The website tier allows
  an agent to browse and assist "as a person would" under binding
  conditions: self-identify when asked, never mask or forge origin, never
  defeat human-vs-software checks, never mimic human timing to evade
  detection, obtain the customer's explicit informed consent before
  acting, and present Walmart data accurately. Still prohibited on the
  website tier: scraping/bulk extraction, training AI/ML on site
  materials without written consent, and autonomous checkout — a **Human
  Consent Gate** is required before every checkout (implemented in this
  prototype's checkout), and agents never receive payment-card details.
  The Agent Gateway tier (MCP + registered Agent Credential, autonomous
  checkout within customer-set limits) is an invitation-only beta.
  Production route: browsing, with Walmart's normal returns process
  applying to agent purchases.
- **Best Buy — `api-only`.** Best Buy expressly restricts website automation
  outside authorized methods. Use only the official Best Buy APIs for a
  future live implementation.
- **eBay — `api-only`.** eBay expressly restricts website automation
  outside authorized methods. Use only the official eBay APIs for a future
  live search/comparison/handoff implementation.
- **Target — `authorized-channel-only`.** Target's Terms & Conditions
  (updated Mar 22, 2026) recognize agents only as *approved* Agentic
  Commerce Agents acting with a customer's explicit permission, through
  partner channels (e.g. Google UCP, OpenAI ACP); no public application
  exists to become an approved agent. Its general terms bar extraction of
  prices/listings. Target is therefore **not browsed, scraped, or queried
  through its internal "Redsky" API** — it appears in the policy-gate
  panel as the showcase of the gate working, and carries no offers.
- **Unknown/future merchants — `browser-permitted-unless-prohibited`** by
  default under Barath's rule, unless an official API is selected as the
  preferred route or an explicit prohibition makes the route
  `excluded-prohibited`.

### Provenance on every offer/result

The `OfferProvenance` type carries:

- source merchant;
- acquisition method (`sample` in this prototype; production methods are
  `api`, `browser`, or `disabled`);
- source URL (null for local sample records because nothing was retrieved);
- retrieved timestamp (null in sample mode);
- policy status and explanatory note.

Search summaries and decision responses also carry source merchants,
acquisition method, retrieval timestamp, and policy status. A live adapter
must populate the URL and timestamp for every retrieved record rather than
dropping provenance at the API boundary.

### Future browser adapter (design only)

`lib/adapters.ts` contains a disabled `BrowserAdapter` interface/stub. The
intended future design is:

1. Our backend creates and controls an isolated browser session.
2. Muse Spark, through the Meta Model API, interprets public page state,
   chooses allowed navigation actions, and extracts structured fields.
3. Results are normalized into the same `Product`/`Offer` model with full
   provenance.

Hard guardrails:

- self-identify honestly; never spoof a human;
- comply with applicable terms, robots directives, and technical controls;
- use conservative rate limits;
- never circumvent CAPTCHAs or bot controls;
- never bypass logins, paywalls, access controls, or geographic controls;
- never rotate identities or evade a block;
- treat an active challenge as a session-level prohibition and stop;
- mark only an explicit prohibition as `excluded-prohibited`.

### eBay design constraints

- **Display separation:** Public display of eBay Content may not be
  co-mingled indistinguishably with non-eBay content. This prototype keeps
  eBay offers in a visually distinct, labelled eBay module, separate from
  the Best Buy block. The component/data structure allows the eBay module
  to be isolated or removed without rewriting the Best Buy module.
- **Freshness:** Live eBay listing information is fresh for at most
  **6 hours**. A live adapter must re-query rather than serve stale cache.
- **No AI training on eBay Content:** Muse explanations may operate on our
  own comparison logic and parameter deltas. They must not train a model on
  eBay Content.
- **No native public-API checkout/orders/returns:** The public comparison
  APIs do not make the sandbox checkout/order/return flow real.
- **Authorized seller:** eBay provides no authorized-seller API flag. Any
  Phase 2 treatment may use only clearly labelled seller feedback and
  account-type proxies; it must never claim verified authorization from
  those proxies.

### Best Buy design constraints and API gaps

- **No ETA attribute:** The Best Buy Products API does not provide an
  estimated delivery date. In this prototype, Best Buy arrival is labelled
  as a **sample shipping-service estimate**. A future live UI must show a
  shipping-service-level value or a clearly labelled estimate from another
  permitted source and never imply the API supplied an ETA.
- **No return-policy attributes:** The Products API does not provide
  return-policy fields. Prototype Best Buy return values are labelled as a
  **curated retailer-policy sample**. A live implementation must maintain
  and label a curated policy entry rather than fabricating API data.
- **Handoff:** `addToCartUrl` is a handoff to BestBuy.com; it is not native
  checkout in this app. Links expire in **7 days**, and Best Buy content
  should be only temporarily cached.
- **No native public-API orders/returns:** The sandbox order and return
  flows remain simulations.

### Official API adapter seams (future)

#### eBay Browse API

Map official API responses into `Offer`, including price, shipping options,
estimated delivery window, return terms and return-shipping payer, seller
feedback, and the listing URL for provenance/handoff. Preserve the retrieved
timestamp and enforce the 6-hour freshness rule. Use an application token;
do not scrape eBay pages or automate website purchasing.

#### Best Buy Products API

Map official API responses into `Offer`, including price, condition/open-box
data where available, review metrics, and `addToCartUrl` for handoff. Do not
invent ETA or return-policy attributes: use labelled shipping-service /
estimate logic and the curated retailer-policy table. Cache temporarily and
respect the 7-day handoff-link expiry.

#### Muse Spark explanations

A future `/api/decide` implementation may send scored offers and parameter
deltas to Muse Spark through the Meta Model API for a natural-language
explanation. Scoring remains deterministic application logic. Muse output
must not change source facts, must preserve sample/live labelling, and must
not train on eBay Content.

## Deliberately not included

- Deployment or publication.
- GitHub repository creation/upload from this build task.
- Live merchant credentials or API calls.
- Scraping or a real browser crawler. Walmart sample records stand in for
  the future browsing route; no live Walmart browsing happens in this
  build, and Target is never browsed at all (authorized-channel only).
- Browser purchasing for any merchant — Walmart checkout always stops at
  the human consent gate, and even then completes only as a sandbox order.
- Real payment processing, retailer orders, fulfillment, emails, returns, or
  carrier labels.
- User accounts/logins (Stage 3 in the product plan).
- Authorized-seller claims (Phase 2).
- Facebook Marketplace and dedicated open-box/refurbished discovery
  (Phase 3; a few sample offers include open-box/refurbished conditions).
