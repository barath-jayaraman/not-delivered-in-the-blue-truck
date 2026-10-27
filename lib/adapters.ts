import { PRODUCTS } from "./data";
import type {
  AcquisitionMethod,
  Merchant,
  Offer,
  OfferProvenance,
  Product,
} from "./types";

/**
 * POLICY-ROUTED HYBRID DATA ACQUISITION
 *
 * Data acquisition is not API-only by design. Each merchant gets a policy
 * record first, and the router may use only an allowed method:
 *
 * - `api`: an official merchant/developer API. This is preferred whenever a
 *   suitable API exists.
 * - `browser`: a future backend-controlled browser adapter for a merchant
 *   whose policy does not prohibit autonomous-agent access. The gate is
 *   prohibition-based, not permission-based: policy silence does not make a
 *   site excluded or “unclear.” An explicit prohibition excludes the route.
 *   An active CAPTCHA/block/challenge is a prohibition in practice for that
 *   session: stop immediately and never evade it.
 * - `disabled`: the route is not used because the merchant is API-only or
 *   because an explicit prohibition applies.
 *
 * eBay and Best Buy are API-route only in this prototype. Their websites must
 * not be scraped and no browser-automated purchasing is implemented for them.
 * The current adapters return local sample records only and make no calls.
 *
 * Every live result must preserve OfferProvenance: source merchant,
 * acquisition method, source URL, retrieved timestamp, and policy status.
 *
 * eBay live-adapter constraints:
 * - Keep eBay Content in a visually distinct labelled module; do not blend it
 *   indistinguishably with non-eBay content.
 * - Listing freshness is at most 6 hours; re-query instead of using stale
 *   cache.
 * - Never train AI models on eBay Content. Muse explanations operate on our
 *   own comparison logic and deltas.
 * - No authorized-seller API flag exists; Phase 2 may use only labelled
 *   seller feedback/account-type proxies.
 *
 * Best Buy live-adapter constraints:
 * - Products API has no estimated-delivery-date attribute. Show a shipping
 *   service-level value or clearly labelled estimate, never an API ETA.
 * - Products API has no return-policy attributes. Use a labelled curated
 *   retailer-policy entry.
 * - addToCartUrl is a BestBuy.com handoff, expires in 7 days, and content
 *   should only be temporarily cached.
 *
 * Neither public API provides native checkout, orders, or returns. Sandbox
 * prototype checkout/order/return screens must not imply real fulfillment.
 */
export type MerchantPolicyStatus =
  | "api-only"
  | "browser-permitted-unless-prohibited"
  | "excluded-prohibited";

export interface MerchantPolicy {
  merchant: Merchant | string;
  allowedAcquisitionMethods: AcquisitionMethod[];
  preferredAcquisitionMethod: AcquisitionMethod;
  status: MerchantPolicyStatus;
  rationale: string;
  /** Browser purchasing is never enabled by this generic policy model. */
  browserPurchasingAllowed: false;
}

export const MERCHANT_POLICY_REGISTRY: MerchantPolicy[] = [
  {
    merchant: "eBay",
    allowedAcquisitionMethods: ["api"],
    preferredAcquisitionMethod: "api",
    status: "api-only",
    rationale:
      "eBay expressly restricts website automation outside authorized methods, so the browser route is disabled and the official API route is used.",
    browserPurchasingAllowed: false,
  },
  {
    merchant: "Best Buy",
    allowedAcquisitionMethods: ["api"],
    preferredAcquisitionMethod: "api",
    status: "api-only",
    rationale:
      "Best Buy expressly restricts website automation outside authorized methods, so the browser route is disabled and the official API route is used.",
    browserPurchasingAllowed: false,
  },
];

export function getMerchantPolicy(merchant: Merchant | string): MerchantPolicy {
  return (
    MERCHANT_POLICY_REGISTRY.find((policy) => policy.merchant === merchant) ?? {
      merchant,
      allowedAcquisitionMethods: ["browser"],
      preferredAcquisitionMethod: "browser",
      status: "browser-permitted-unless-prohibited",
      rationale:
        "Default prohibition-based rule: if no explicit prohibition is found, the browser route is permitted. An explicit prohibition changes the status to excluded-prohibited; an active challenge stops that session.",
      browserPurchasingAllowed: false,
    }
  );
}

export interface MerchantAdapter {
  merchant: Merchant;
  mode: "sample" | "live";
  acquisitionMethod: AcquisitionMethod;
  policy: MerchantPolicy;
  searchProducts(query: string): Promise<Product[]>;
  getOffers(productId: string): Promise<Offer[]>;
}

abstract class SampleMerchantAdapter implements MerchantAdapter {
  abstract merchant: Merchant;
  readonly mode = "sample" as const;
  readonly acquisitionMethod = "api" as const;

  get policy(): MerchantPolicy {
    return getMerchantPolicy(this.merchant);
  }

  async searchProducts(query: string): Promise<Product[]> {
    const normalized = query.toLowerCase();
    return PRODUCTS.filter(
      (product) =>
        product.offers.some((offer) => offer.merchant === this.merchant) &&
        [product.name, product.brand, product.model, product.category, ...product.keywords]
          .join(" ")
          .toLowerCase()
          .includes(normalized),
    );
  }

  async getOffers(productId: string): Promise<Offer[]> {
    return (
      PRODUCTS.find((product) => product.id === productId)?.offers.filter(
        (offer) => offer.merchant === this.merchant,
      ) ?? []
    );
  }
}

/** Future implementation target: official eBay Browse API only. */
export class SampleEbayAdapter extends SampleMerchantAdapter {
  readonly merchant = "eBay" as const;
}

/** Future implementation target: official Best Buy Products API only. */
export class SampleBestBuyAdapter extends SampleMerchantAdapter {
  readonly merchant = "Best Buy" as const;
}

export const merchantAdapters: MerchantAdapter[] = [
  new SampleEbayAdapter(),
  new SampleBestBuyAdapter(),
];

/**
 * FUTURE BROWSER ADAPTER — interface/stub only. Do not implement a crawler in
 * this prototype.
 *
 * Intended architecture for a merchant whose policy does not prohibit
 * autonomous-agent access (no affirmative permission is required):
 * 1. Our backend creates and controls an isolated browser session.
 * 2. Muse Spark, called through the Meta Model API, interprets public page
 *    state, chooses allowed navigation actions, and extracts structured
 *    product/comparison fields.
 * 3. The adapter returns offers with complete provenance (merchant, method,
 *    source URL, retrieved timestamp, and policy status).
 *
 * Hard guardrails:
 * - Self-identify the automated browser honestly; do not spoof a human.
 * - Obey applicable terms, robots directives, and technical controls.
 * - Apply conservative rate limits.
 * - Treat an active CAPTCHA, block, or challenge as a prohibition in
 *   practice for that session: stop immediately and never evade it.
 * - Never circumvent CAPTCHAs or other bot controls.
 * - Never bypass a login, paywall, access control, or geographic control.
 * - Never rotate identity or use another evasion technique to regain access.
 * - If an explicit prohibition is found, mark the route
 *   `excluded-prohibited`; policy silence alone is never marked excluded.
 */
export interface BrowserExtractionRequest {
  merchant: string;
  startUrl: string;
  query: string;
  policy: MerchantPolicy;
}

export interface BrowserAdapter {
  readonly acquisitionMethod: "browser";
  readonly enabled: false;
  extractOffers(
    request: BrowserExtractionRequest,
  ): Promise<{ offers: Offer[]; provenance: OfferProvenance[] }>;
}

/** Disabled stub proving the seam exists without performing browsing. */
export const disabledBrowserAdapter: BrowserAdapter = {
  acquisitionMethod: "browser",
  enabled: false,
  async extractOffers() {
    throw new Error(
      "Browser acquisition is not implemented in this prototype. Future use follows the prohibition-based policy gate and session challenge guardrails.",
    );
  },
};

/**
 * Muse Spark seam: future explanation generation should accept scored offers
 * and their deltas and return a plain-language explanation using this shape.
 * It must not alter offer facts, imply sample data is live, or train on eBay
 * Content.
 */
export interface ExplanationInput {
  productName: string;
  priority: string;
  recommendationSeller: string;
  cheapestStickerSeller: string;
  facts: string[];
  dataSource: "sample" | "live";
  provenance: OfferProvenance[];
}
