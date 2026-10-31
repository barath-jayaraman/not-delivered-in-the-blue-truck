/**
 * BRAND CONFIG — single source of truth for all branding.
 * Components must use these values rather than hard-coding brand strings.
 */
export const BRAND = {
  name: "Not Delivered in the Blue Truck",
  tagline: "Compare the whole buying decision — not just the sticker price.",
  company: "Nio Innovations LLC",
  /** Short descriptor used under the hero headline. */
  blurb:
    "Search once, compare live offers from Walmart and eBay sellers — fetched the moment you search — and see price, shipping, arrival time, returns, warranty, and seller rating together.",
  /** Honesty note — prices are live at fetch time; fulfillment is simulated. */
  betaNote:
    "Prototype checkout: every price shown was fetched live when you searched or compared, and prices can change at any time. Checkout, orders, and return labels are simulated — no payment is charged, no retailer order is placed, and no real return is created.",
} as const;
