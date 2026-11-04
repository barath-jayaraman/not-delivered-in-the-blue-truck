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
    "Search once, compare live offers from eBay sellers, Walmart, UCP stores like Steve Madden, Monos, Gymshark, and Everlane, and browsing-route stores like Micro Center, Harbor Freight, Carter's, and Mattress Firm — fetched the moment you search — and see price, shipping, arrival time, returns, warranty, and seller rating together.",
  /** Honesty note — prices are live at fetch time; checkout is real. */
  betaNote:
    "Every price shown was fetched live when you searched or compared, and prices can change at any time. Checkout at UCP stores is real: the selling store takes payment through its own payment provider and fulfills the order. eBay, Walmart, and browsing-route stores complete purchases on their own sites.",
} as const;
