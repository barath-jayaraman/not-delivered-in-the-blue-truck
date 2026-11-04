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
  /** Honesty note — prices are live at fetch time; buying finishes at the store. */
  betaNote:
    "Every price shown was fetched live when you searched or compared, and prices can change at any time. When you buy, you check out on the selling store's own site — for many stores we load your items into that store's cart first — and the store takes payment through its own payment provider and fulfills your order.",
} as const;
