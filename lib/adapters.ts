import type {
  AcquisitionMethod,
  Merchant,
  Offer,
  OfferProvenance,
  PolicyGateEntry,
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
 * eBay and Best Buy are API-route only. Their websites must not be scraped
 * and no browser-automated purchasing is implemented for them.
 *
 * Walmart is the browsed merchant: its Terms of Use (updated Sep 21, 2026),
 * §16.L "Authorized Agents," route agents into Walmart's Agentic Access
 * Terms. The website tier allows an agent to browse and assist "as a person
 * would" under binding conditions (self-identify when asked, never mask
 * origin or defeat human checks, never mimic human timing, obtain the
 * customer's explicit informed consent before acting, present data
 * accurately). Scraping/bulk extraction, AI/ML training on site materials,
 * and autonomous checkout remain prohibited — a Human Consent Gate is
 * required before every checkout (implemented in the UI for Walmart
 * offers). The Agent Gateway MCP tier is invitation-only beta.
 *
 * Target is authorized-channel only: its terms recognize only approved
 * Agentic Commerce Agents (partner channels such as UCP/ACP, no public
 * application) and bar extraction of prices/listings. Target is never
 * browsed or scraped here, and its internal "Redsky" API is not used.
 *
 * Live acquisition lives in lib/live-search.ts (search) and the adapters
 * under lib/adapters/ (eBay Buy Browse API; Walmart search-page fetch).
 * No stored listings or prices are ever served: every figure is fetched
 * in the request that displays it.
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
  | "browser-allowed-under-terms"
  | "authorized-channel-only"
  | "excluded-prohibited";

export interface MerchantPolicy {
  merchant: Merchant | string;
  allowedAcquisitionMethods: AcquisitionMethod[];
  preferredAcquisitionMethod: AcquisitionMethod;
  status: MerchantPolicyStatus;
  rationale: string;
  /** Browser purchasing is never enabled by this generic policy model. */
  browserPurchasingAllowed: false;
  /** True when the merchant's terms require a human to approve checkout. */
  consentGateRequired: boolean;
}

export const MERCHANT_POLICY_REGISTRY: MerchantPolicy[] = [
  {
    merchant: "Walmart",
    allowedAcquisitionMethods: ["browser"],
    preferredAcquisitionMethod: "browser",
    status: "browser-allowed-under-terms",
    rationale:
      "Walmart's Agentic Access Terms (Terms of Use §16.L, updated Sep 21, 2026) allow an agent to browse the website tier and assist under conditions: self-identify when asked, no origin masking, no defeating human checks, no human-timing mimicry, explicit customer consent before acting, accurate data presentation. Scraping/bulk extraction and autonomous checkout remain prohibited; a Human Consent Gate is required before every checkout.",
    browserPurchasingAllowed: false,
    consentGateRequired: true,
  },
  {
    merchant: "Best Buy",
    allowedAcquisitionMethods: ["api"],
    preferredAcquisitionMethod: "api",
    status: "api-only",
    rationale:
      "Best Buy expressly restricts website automation outside authorized methods, so the browser route is disabled and the official API route is used.",
    browserPurchasingAllowed: false,
    consentGateRequired: false,
  },
  {
    merchant: "eBay",
    allowedAcquisitionMethods: ["api"],
    preferredAcquisitionMethod: "api",
    status: "api-only",
    rationale:
      "eBay expressly restricts website automation outside authorized methods, so the browser route is disabled and the official API route is used.",
    browserPurchasingAllowed: false,
    consentGateRequired: false,
  },
  {
    merchant: "Target",
    allowedAcquisitionMethods: [],
    preferredAcquisitionMethod: "disabled",
    status: "authorized-channel-only",
    rationale:
      "Target's terms recognize only approved Agentic Commerce Agents acting with a customer's explicit permission (partner channels such as UCP/ACP; no public application exists) and bar data extraction/scraping of listings and prices. Target is not browsed, scraped, or queried through any unofficial API.",
    browserPurchasingAllowed: false,
    consentGateRequired: false,
  },
];

/** Compact gate outcomes for the UI policy-gate panel and API responses. */
export function getPolicyGateEntries(): PolicyGateEntry[] {
  const presentation: Record<
    string,
    { route: PolicyGateEntry["route"]; outcomeLabel: string; detail: string }
  > = {
    Walmart: {
      route: "browser",
      outcomeLabel: "Browsing allowed — Agentic Access Terms",
      detail:
        "Website tier (Terms of Use §16.L): the agent may browse and assist under conditions — no scraping or bulk extraction, and a human consent gate before every checkout.",
    },
    "Best Buy": {
      route: "api",
      outcomeLabel: "Official API",
      detail:
        "Site terms restrict automation outside authorized methods, so data comes only through the official Best Buy Products API.",
    },
    eBay: {
      route: "api",
      outcomeLabel: "Official API",
      detail:
        "Automation is restricted outside authorized methods, so data comes only through the official eBay APIs — displayed in a separate module with a 6-hour freshness rule.",
    },
    Target: {
      route: "authorized-channel-only",
      outcomeLabel: "Authorized-channel only — not browsed",
      detail:
        "Target admits only approved Agentic Commerce Agents through partner channels (approval-gated, no public application), so the gate does not browse or scrape Target.",
    },
  };
  return MERCHANT_POLICY_REGISTRY.map((policy) => {
    const entry = presentation[policy.merchant];
    return {
      merchant: policy.merchant,
      route: entry?.route ?? "api",
      outcomeLabel: entry?.outcomeLabel ?? policy.status,
      detail: entry?.detail ?? policy.rationale,
    };
  });
}

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
      consentGateRequired: false,
    }
  );
}

/** Merchants whose offers require the Human Consent Gate before checkout. */
export function requiresConsentGate(merchant: Merchant | string): boolean {
  return getMerchantPolicy(merchant).consentGateRequired;
}

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
