export type Priority = "cheapest" | "fastest" | "returns";

export type Merchant = "eBay" | "Best Buy";
export type DataMode = "sample";
export type ReturnCost = "free" | "buyer-paid" | "final-sale";

/** Production acquisition routes supported by the policy registry. */
export type AcquisitionMethod = "api" | "browser" | "disabled";
/** The local prototype adds `sample` so simulated records never claim retrieval. */
export type OfferAcquisitionMethod = AcquisitionMethod | "sample";
export type OfferPolicyStatus =
  | "sample-only-api-route"
  | "api-only"
  | "browser-permitted-unless-prohibited"
  | "excluded-prohibited";

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
  deliveryBasis: "Sample seller delivery estimate" | "Sample shipping-service estimate";
  returnWindowDays: number; // 0 when final sale
  returnCost: ReturnCost;
  /** eBay sample terms are seller terms; Best Buy values are a curated policy sample. */
  returnPolicySource: "Sample seller return terms" | "Curated retailer-policy sample";
  warrantyMonths: number;
  /** Seller / retailer rating, 0–5 scale. */
  sellerRating: number;
  /** Sample-only listing label. This is deliberately not a live purchase URL. */
  sampleListingLabel: string;
  provenance: OfferProvenance;
}

export interface Product {
  id: string;
  name: string;
  brand: string;
  model: string;
  category: string;
  /** Aliases and lower-case search phrases. */
  keywords: string[];
  offers: Offer[];
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
  sourceUrl: null;
  retrievedAt: null;
  policyStatus: OfferPolicyStatus;
}

export interface SearchResponse {
  query: string;
  products: ProductSummary[];
  dataSource: DataMode;
}

export interface ScoredOffer extends Offer {
  totalCost: number;
  score: number; // 0–100
  flags: string[];
}

export interface DecideRequest {
  query?: string;
  productId?: string;
  budget?: number | null;
  needByDays: number;
  priority: Priority;
}

export interface DecideResponse {
  product: { id: string; name: string; category: string };
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
  retrievedAt: null;
  policyStatus: OfferPolicyStatus;
}

export interface CartItem {
  productId: string;
  productName: string;
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
}

export type ReturnMethod = "UPS drop-off" | "UPS pickup";

export interface PrototypeReturn {
  method: ReturnMethod;
  requestedAt: string;
  labelNumber: string;
  status: "Sample return label created";
}

export interface PrototypeOrder {
  confirmationNumber: string;
  productId: string;
  productName: string;
  offerId: string;
  merchant: Merchant;
  seller: string;
  condition: Offer["condition"];
  quantity: number;
  price: number;
  shippingCost: number;
  totalCost: number;
  deliveryDays: number;
  estimatedArrival: string;
  purchasedAt: string;
  returnWindowDays: number;
  returnCost: ReturnCost;
  returnDeadline: string | null;
  guestName: string;
  guestEmail: string;
  status: "Sample order confirmed" | "Sample return initiated";
  returnRequest?: PrototypeReturn;
  dataSource: DataMode;
}
