export type Priority = "cheapest" | "fastest" | "returns";

export type Merchant =
  | "Walmart"
  | "Best Buy"
  | "eBay"
  | "Target"
  | "Steve Madden"
  | "Gymshark"
  | "Everlane"
  | "Monos"
  | "Allbirds"
  | "Kith"
  | "Misen"
  | "SKIMS"
  | "Fenty Beauty"
  | "Lord & Taylor"
  | "Stein Mart"
  | "Scandinavian Designs"
  | "Slumberland"
  | "Pier 1"
  | "Vitacost"
  | "ShopLC"
  | "The Lakeside Collection"
  | "LTD Commodities"
  | "SkyMall"
  | "Mast General Store"
  | "Kane's Furniture"
  | "Steinhafels"
  | "Schneiderman's Furniture"
  | "FYE"
  | "DTLR"
  | "Beach Camera"
  | "Turtle Beach"
  | "Evo"
  | "FAO Schwarz"
  | "Casper"
  | "Away"
  | "HexClad"
  | "Lodge Cast Iron"
  | "Rad Power Bikes"
  | "The Sill"
  | "Brookstone"
  | "Sharper Image"
  | "Peak Design"
  | "Woodcraft"
  | "Arhaus"
  | "Bonobos"
  | "Micro Center"
  | "Harbor Freight"
  | "Carter's"
  | "Mattress Firm";
/** "live" marks records retrieved from a merchant for this request (see lib/live-search.ts). */
export type DataMode = "sample" | "live";
export type ReturnCost = "free" | "buyer-paid" | "final-sale";

/** Production acquisition routes supported by the policy registry. */
export type AcquisitionMethod = "api" | "browser" | "disabled";
/** The local prototype adds `sample` so simulated records never claim retrieval. */
export type OfferAcquisitionMethod = AcquisitionMethod | "sample" | "browse";
export type OfferPolicyStatus =
  | "sample-only-api-route"
  | "sample-only-browser-route"
  | "sample-mixed-routes"
  | "api-only"
  | "browser-permitted-unless-prohibited"
  | "browser-allowed-under-terms"
  | "browse-allowed-agentic-access-terms"
  | "ucp-public-profile"
  | "authorized-channel-only"
  | "excluded-prohibited";

/** How the policy gate routes a merchant in production. */
export type PolicyGateRoute = "browser" | "api" | "ucp" | "authorized-channel-only";

export interface PolicyGateEntry {
  merchant: string;
  route: PolicyGateRoute;
  /** Short outcome label shown in the UI policy-gate panel. */
  outcomeLabel: string;
  /** One factual line explaining the outcome. */
  detail: string;
}

/** One narrated step of the Muse Spark agent pipeline (see lib/agent.ts). */
export interface AgentStep {
  id: "interpret" | "route" | "gather" | "verify" | "score" | "explain";
  title: string;
  /** What the app actually did in this step for this request. */
  detail: string;
  /** Which engine performed the step in this run. */
  engine: string;
  status: "done";
}

export interface AgentActivity {
  /**
   * `live` only when a Muse Spark call actually succeeded for this request;
   * `live-configured` when a key is configured but this request ran on the
   * local pipeline (live call failed, timed out, or was not attempted);
   * `local` when no key is configured at all.
   */
  mode: "local" | "live-configured" | "live";
  /** Whether META_MODEL_API_KEY is set server-side (the endpoint has a default). */
  liveConfigured: boolean;
  /** Pipeline steps that ran on Muse Spark for this request; empty unless mode is `live`. */
  liveSteps: AgentStep["id"][];
  /** Honest label for the panel header; never claims a live call happened. */
  modelLabel: string;
  steps: AgentStep[];
}

export interface OfferProvenance {
  sourceMerchant: Merchant;
  acquisitionMethod: OfferAcquisitionMethod;
  /** Null in sample mode; a future live record carries its source/listing URL. */
  sourceUrl: string | null;
  /** Null in sample mode because nothing was retrieved from a merchant. */
  retrievedAt: string | null;
  policyStatus: OfferPolicyStatus;
  policyNote: string;
}

export interface Offer {
  id: string;
  /** Marketplace/retailer used by this prototype. Live use is policy-gated. */
  merchant: Merchant;
  /** Seller display name, e.g. an eBay seller or Best Buy itself. */
  seller: string;
  /** Kept as a display seam for future merchant-specific channels. */
  channel: Merchant;
  condition: "New" | "Open-box" | "Certified refurbished" | "Refurbished";
  price: number;
  shippingCost: number; // 0 = free shipping
  deliveryDays: number; // sample estimate / service-level proxy in this prototype
  /** Be explicit about a key API gap: Best Buy does not supply an ETA attribute. */
  deliveryBasis:
    | "Sample seller delivery estimate"
    | "Sample shipping-service estimate"
    | "Sample page-displayed delivery estimate"
    | "Live page-displayed delivery estimate"
    | "Live API delivery estimate";
  returnWindowDays: number; // 0 when final sale
  returnCost: ReturnCost;
  /** eBay sample terms are seller terms; Best Buy values are a curated policy sample. */
  returnPolicySource: "Sample seller return terms" | "Curated retailer-policy sample";
  /**
   * Stated warranty period in months. 0 means the source stated NO
   * warranty period — an absence of data, displayed as "Not stated by
   * seller"; it must never be rendered or phrased as "no warranty".
   */
  warrantyMonths: number;
  /** Seller / retailer rating, 0–5 scale. */
  sellerRating: number;
  /** Sample-only listing label. This is deliberately not a live purchase URL. */
  sampleListingLabel: string;
  provenance: OfferProvenance;
  /**
   * The merchant's own purchasable item id for this offer (for UCP
   * stores, the catalog variant id), carried so the cart can start a
   * real checkout session for exactly the item that was priced. Null
   * for routes that check out on the merchant's own site instead.
   */
  checkoutItemId?: string | null;
}

export interface Product {
  id: string;
  name: string;
  brand: string;
  model: string;
  category: string;
  /** Aliases and lower-case search phrases. */
  keywords: string[];
  /**
   * Presentation metadata ONLY (name/brand/model/category/keywords, plus
   * the stored photo keyed by id). A Product carries NO offers, listings,
   * or prices: every price the app shows is fetched live in the request
   * that displays it (lib/live-search.ts).
   */
}

export interface ProductSummary {
  id: string;
  name: string;
  brand: string;
  model: string;
  category: string;
  offerCount: number;
  lowestPrice: number;
  highestPrice: number;
  fastestDeliveryDays: number;
  exactMatch: boolean;
  dataSource: DataMode;
  sourceMerchants: Merchant[];
  acquisitionMethod: OfferAcquisitionMethod;
  /** Live summaries link the first listing they were built from. */
  sourceUrl: string | null;
  /** When the listings behind this summary were retrieved (this request). */
  retrievedAt: string | null;
  policyStatus: OfferPolicyStatus;
  /** Image URL supplied by the merchant for live results. */
  imageUrl?: string | null;
}

export interface SearchResponse {
  query: string;
  products: ProductSummary[];
  dataSource: DataMode;
  policyGate: PolicyGateEntry[];
}

export interface ScoredOffer extends Offer {
  totalCost: number;
  score: number; // 0–100
  flags: string[];
}

export interface DecideRequest {
  query?: string;
  productId?: string;
  /** Set when the shopper picked a live-search result (see lib/live-search.ts). */
  liveGroupId?: string;
  budget?: number | null;
  needByDays: number;
  priority: Priority;
}

export interface DecideResponse {
  product: { id: string; name: string; category: string; imageUrl?: string | null };
  priority: Priority;
  needByDays: number;
  budget: number | null;
  offers: ScoredOffer[]; // top five, sorted best → worst
  recommendation: ScoredOffer;
  cheapestSticker: ScoredOffer;
  explanation: string;
  priceRange: { lowest: number; highest: number };
  fastestDeliveryDays: number;
  dataSource: DataMode;
  sourceMerchants: Merchant[];
  acquisitionMethod: OfferAcquisitionMethod;
  /** Null for sample decisions; the retrieval time for live decisions. */
  retrievedAt: string | null;
  policyStatus: OfferPolicyStatus;
  policyGate: PolicyGateEntry[];
  agentActivity: AgentActivity;
  /**
   * Present only when a live merchant offer was merged into this response
   * (see lib/adapters/walmart-browse.ts and lib/adapters/ebay-api.ts). The
   * live offers themselves are flagged individually through their
   * provenance. The flat fields describe the first live merchant merged;
   * `merchants` lists every live merchant present in the response.
   */
  liveData?: {
    merchant: string;
    retrievedAt: string;
    sourceUrl: string;
    offerIds: string[];
    merchants?: {
      merchant: string;
      retrievedAt: string;
      sourceUrl: string;
      offerIds: string[];
    }[];
  };
}

export interface CartItem {
  productId: string;
  productName: string;
  /** Merchant-supplied image for live-search products; null for catalog items. */
  imageUrl?: string | null;
  offerId: string;
  merchant: Merchant;
  seller: string;
  condition: Offer["condition"];
  price: number;
  shippingCost: number;
  totalCost: number;
  deliveryDays: number;
  returnWindowDays: number;
  returnCost: ReturnCost;
  quantity: number;
  /** Merchant item id for in-app checkout (UCP stores); null otherwise. */
  checkoutItemId?: string | null;
  /** The listing's own page at the merchant — the handoff destination. */
  sourceUrl?: string | null;
  policyStatus: OfferPolicyStatus;
}

/* ------------------------------------------------------------------ */
/* Real checkout (UCP stores)                                          */
/* ------------------------------------------------------------------ */

/** One totals line exactly as the selling store's checkout returned it. */
export interface CheckoutTotalLine {
  /** The store's own totals type, e.g. "subtotal", "shipping", "tax", "total". */
  type: string;
  /** Major-unit amount (e.g. dollars), converted from the store's minor units. */
  amount: number;
  /** The store's own display label for the line. */
  displayText: string;
}

export interface CheckoutLineItemSummary {
  title: string;
  quantity: number;
  /** Major-unit unit price as the store's checkout returned it. */
  price: number;
}

/**
 * A live checkout session at ONE UCP store, created in the request that
 * displays it. Every figure is the store's own response; nothing here
 * is stored server-side — the browser carries the session id and asks
 * the server to re-read the session from the store when it needs it.
 */
export interface CheckoutSessionSummary {
  merchant: Merchant;
  checkoutId: string;
  /** Session status string exactly as the store reported it. */
  status: string;
  currency: string;
  totals: CheckoutTotalLine[];
  items: CheckoutLineItemSummary[];
  /**
   * The store's own hosted continuation for this session (its payment
   * step, served by the store's declared payment handlers). Null when
   * the store returned none.
   */
  continueUrl: string | null;
  expiresAt: string | null;
  /** Buyer-actionable messages the store returned, verbatim. */
  messages: { code: string; content: string; severity: string }[];
  /** The store's own policy pages, as linked from its checkout session. */
  policyLinks: { type: string; title: string; url: string }[];
  /** True when the store accepted the guest's delivery destination. */
  destinationAccepted: boolean;
}

/**
 * A real order, confirmed by the selling store's own checkout system.
 * Every field is copied from the store's response — this app never
 * synthesizes an order, a confirmation number, or a status.
 */
export interface StoreOrder {
  merchant: Merchant;
  /** The store's checkout session id that produced this order. */
  checkoutId: string;
  /** Order id exactly as the store returned it. */
  orderId: string;
  /** The store's order page / permalink, when it returned one. */
  orderUrl: string | null;
  /** Status string exactly as the store reported it, when it gave one. */
  status: string | null;
  items: CheckoutLineItemSummary[];
  totals: CheckoutTotalLine[];
  currency: string;
  buyerEmail: string;
  /** When this app observed the store's confirmation (retrieval time). */
  confirmedAt: string;
}
