import { getMerchantPolicy } from "../adapters";
import type { Offer, Product } from "../types";

/**
 * EBAY LIVE API ADAPTER — official eBay Buy Browse API only.
 *
 * Policy basis: eBay is API-ONLY in the merchant policy registry
 * (lib/adapters.ts). Its website must not be scraped and no
 * browser-automated purchasing is implemented for it; data comes only
 * through the official eBay APIs.
 *
 * What this adapter does:
 * - Authenticates with the OAuth client-credentials flow against
 *   https://api.ebay.com/identity/v1/oauth2/token using the production
 *   keyset supplied at runtime via EBAY_CLIENT_ID / EBAY_CLIENT_SECRET.
 *   The application token is cached in memory until shortly before expiry.
 *   Neither the secret nor the token is ever logged.
 * - Searches item summaries (Buy Browse API, EBAY_US marketplace) for the
 *   catalog product's "<brand> <model>" and picks the best-matching NEW
 *   listing with deterministic token-overlap matching, the same approach
 *   as the Walmart browse adapter. Accessories and other variants are
 *   penalized, never selected silently.
 * - Maps ONLY fields the listing itself carries into the Offer shape.
 *   Shipping is taken from the listing's first shipping option; a listing
 *   whose shipping charge is not stated is skipped rather than guessed
 *   (a listing states free shipping as an explicit $0.00 charge).
 *   Delivery days come from the latest date of the listing's estimated
 *   delivery range. Return terms are used when the summary carries them;
 *   Browse item summaries normally do not, so the curated retailer-policy
 *   pattern fills them and the offer's policyNote says so plainly.
 *
 * eBay developer-agreement obligations honored here:
 * - Listing data freshness: eBay Content may be displayed for at most 6
 *   hours. This adapter caches a lookup for at most 5 minutes.
 * - eBay Content is never used to train AI models. The live explanation
 *   pipeline (lib/agent.ts) reasons only over our own scored deltas.
 * - eBay offers stay clearly identified as eBay: merchant/channel are
 *   "eBay", the seller names the eBay seller, and provenance records the
 *   API route and the listing URL — never blended as another merchant.
 * - No authorized-seller flag is inferred; seller feedback is shown only
 *   as the labelled rating it is.
 *
 * Enabled only when ENABLE_EBAY_API=1 AND both key env vars are set
 * (default off / no-op). Any failure — no keys, auth rejection, network,
 * parse — returns no live offers and the caller falls back to sample
 * data. Never throws.
 */

const TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const SEARCH_URL = "https://api.ebay.com/buy/browse/v1/item_summary/search";
const BROWSE_SCOPE = "https://api.ebay.com/oauth/api_scope";
const FETCH_TIMEOUT_MS = 15_000;
/** Far inside eBay's 6-hour display-freshness limit for listing data. */
const CACHE_TTL_MS = 5 * 60_000;
/** Refresh the application token this long before its stated expiry. */
const TOKEN_EXPIRY_BUFFER_MS = 60_000;
/**
 * Curated retailer-policy pattern for eBay when a listing's summary does
 * not carry return terms (the normal Browse API case): a 30-day window
 * with free returns, the terms eBay Top Rated Plus sellers must offer.
 * Always labelled as curated in the offer, never presented as
 * listing-specific terms.
 */
const CURATED_RETURN_WINDOW_DAYS = 30;

export function ebayCredentialsConfigured(): boolean {
  return Boolean(
    process.env.EBAY_CLIENT_ID && process.env.EBAY_CLIENT_SECRET,
  );
}

export function ebayApiEnabled(): boolean {
  return process.env.ENABLE_EBAY_API === "1" && ebayCredentialsConfigured();
}

/* ------------------------------------------------------------------ */
/* OAuth client-credentials: application token, cached until expiry    */
/* ------------------------------------------------------------------ */

let tokenCache: { accessToken: string; expiresAt: number } | null = null;
let tokenInFlight: Promise<string | null> | null = null;

async function requestApplicationToken(): Promise<string | null> {
  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: BROWSE_SCOPE,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    // Log only the error class/message — never headers or credentials.
    console.warn("[ebay-api] token request failed:", String(error));
    return null;
  }
  if (response.status !== 200) {
    console.warn(
      `[ebay-api] token request returned HTTP ${response.status}; returning no live offers.`,
    );
    return null;
  }
  let payload: { access_token?: string; expires_in?: number };
  try {
    payload = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
    };
  } catch {
    console.warn("[ebay-api] token response was not parseable JSON.");
    return null;
  }
  if (!payload.access_token) {
    console.warn("[ebay-api] token response carried no access token.");
    return null;
  }
  const expiresInMs = (payload.expires_in ?? 7200) * 1000;
  tokenCache = {
    accessToken: payload.access_token,
    expiresAt: Date.now() + Math.max(0, expiresInMs - TOKEN_EXPIRY_BUFFER_MS),
  };
  return tokenCache.accessToken;
}

async function getApplicationToken(): Promise<string | null> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) {
    return tokenCache.accessToken;
  }
  if (!tokenInFlight) {
    tokenInFlight = requestApplicationToken().finally(() => {
      tokenInFlight = null;
    });
  }
  return tokenInFlight;
}

/* ------------------------------------------------------------------ */
/* Browse API item-summary shapes (only the fields this adapter uses)  */
/* ------------------------------------------------------------------ */

interface EbayMoney {
  value?: string;
  currency?: string;
}

interface EbayShippingOption {
  shippingCostType?: string;
  shippingCost?: EbayMoney;
  minEstimatedDeliveryDate?: string;
  maxEstimatedDeliveryDate?: string;
}

interface EbayItemSummary {
  itemId?: string;
  legacyItemId?: string;
  title?: string;
  condition?: string;
  price?: EbayMoney;
  itemWebUrl?: string;
  topRatedBuyingExperience?: boolean;
  seller?: {
    username?: string;
    feedbackPercentage?: string;
    feedbackScore?: number;
  };
  shippingOptions?: EbayShippingOption[];
  /** Present on some responses at item level; summaries usually omit it. */
  estimatedDeliveryDate?: {
    minimumEstimatedDeliveryDate?: string;
    maximumEstimatedDeliveryDate?: string;
  };
  /** Browse summaries normally omit return terms; the full item has them. */
  returnTerms?: {
    returnsAccepted?: boolean;
    returnPeriod?: { value?: number; unit?: string };
    returnShippingCostPayer?: string;
  };
}

/* ------------------------------------------------------------------ */
/* Matching: pick the primary NEW listing for a catalog product        */
/* ------------------------------------------------------------------ */

/** Tokens that mark a *different* variant/accessory when the product name lacks them. */
const QUALIFIER_TOKENS = new Set([
  "ultra",
  "earbuds",
  "earbud",
  "ii",
  "case",
  "cover",
  "cushion",
  "cushions",
  "earpads",
  "replacement",
  "charger",
  "charging",
  "cord",
  "adapter",
  "skin",
  "decal",
  "protector",
  "stand",
  "holder",
  "sleeve",
  "open",
  "box",
  "preowned",
  "used",
]);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function parseMoney(money: EbayMoney | undefined): number | null {
  if (!money?.value) return null;
  if (money.currency && money.currency !== "USD") return null;
  const parsed = Number.parseFloat(money.value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** Days from today (UTC calendar days) until an ISO date, or null. */
function daysUntil(iso: string | undefined): number | null {
  if (!iso) return null;
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return null;
  const now = new Date();
  const dayMs = 86_400_000;
  const diff = Math.round(
    (Date.UTC(when.getUTCFullYear(), when.getUTCMonth(), when.getUTCDate()) -
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) /
      dayMs,
  );
  return Math.max(0, diff);
}

interface PickedListing {
  item: EbayItemSummary;
  price: number;
  shippingCost: number;
  deliveryDays: number;
}

function pickPrimaryItem(
  product: Product,
  items: EbayItemSummary[],
): PickedListing | null {
  const productTokens = new Set(tokens(product.name));
  let best: (PickedListing & { score: number }) | null = null;

  for (const item of items) {
    if (!item.title || !item.itemId || !item.itemWebUrl) continue;

    // NEW items only: refurbished / open-box / pre-owned listings are a
    // different offer class and are never substituted silently.
    const condition = (item.condition ?? "").toLowerCase();
    if (!condition.startsWith("new")) continue;

    const itemTokens = tokens(item.title);
    if (!itemTokens.includes(product.brand.toLowerCase())) continue;
    const overlap = [...productTokens].filter((t) => itemTokens.includes(t));
    if (overlap.length < Math.min(2, productTokens.size)) continue;

    const price = parseMoney(item.price);
    if (price == null || price <= 0) continue;

    // Shipping: only what the listing states. Free shipping is an
    // explicit $0.00 charge in the payload; an unstated charge means the
    // listing is skipped, never guessed.
    const shippingOption = item.shippingOptions?.[0];
    const shippingCost = parseMoney(shippingOption?.shippingCost);
    if (shippingCost == null) continue;

    // Delivery: the latest date of the listing's estimated range.
    const deliveryDays =
      daysUntil(shippingOption?.maxEstimatedDeliveryDate) ??
      daysUntil(item.estimatedDeliveryDate?.maximumEstimatedDeliveryDate);
    if (deliveryDays == null) continue;

    let score = overlap.length * 10;
    for (const token of itemTokens) {
      if (QUALIFIER_TOKENS.has(token) && !productTokens.has(token)) {
        score -= 3;
      }
    }
    if (item.topRatedBuyingExperience) score += 2;
    score += Math.min(item.seller?.feedbackScore ?? 0, 5000) / 5000;

    if (!best || score > best.score) {
      best = { item, price, shippingCost, deliveryDays, score };
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Offer construction                                                  */
/* ------------------------------------------------------------------ */

function toOffer(picked: PickedListing, retrievedAt: string): Offer {
  const { item, price, shippingCost, deliveryDays } = picked;
  const username = item.seller?.username ?? "eBay seller";
  const seller = item.topRatedBuyingExperience
    ? `${username} (eBay Top Rated Plus)`
    : username;

  // feedbackPercentage is a 0–100 value ("99.8"); Offer.sellerRating is
  // the codebase's 0–5 scale, so map proportionally (99.8% → 4.99).
  const feedbackPercentage = item.seller?.feedbackPercentage
    ? Number.parseFloat(item.seller.feedbackPercentage)
    : NaN;
  const sellerRating = Number.isFinite(feedbackPercentage)
    ? Math.max(0, Math.min(5, feedbackPercentage / 20))
    : 0;

  // Return terms: use the listing's own when the summary carries them;
  // otherwise the curated retailer-policy pattern, disclosed in the note.
  let returnWindowDays = CURATED_RETURN_WINDOW_DAYS;
  let returnCost: Offer["returnCost"] = "free";
  let returnPolicySource: Offer["returnPolicySource"] =
    "Curated retailer-policy sample";
  let returnsNote =
    `The Browse API summary carried no return terms for this listing, so the return ` +
    `window/cost are the curated eBay pattern (${CURATED_RETURN_WINDOW_DAYS}-day window, ` +
    `free returns — the terms Top Rated Plus sellers must offer), not listing-specific terms. `;
  const terms = item.returnTerms;
  if (terms && typeof terms.returnsAccepted === "boolean") {
    returnPolicySource = "Sample seller return terms";
    if (!terms.returnsAccepted) {
      returnWindowDays = 0;
      returnCost = "final-sale";
      returnsNote =
        "The listing states returns are not accepted (final sale). ";
    } else {
      const period = terms.returnPeriod?.value;
      if (typeof period === "number" && period > 0) {
        returnWindowDays = period;
      }
      returnCost =
        terms.returnShippingCostPayer === "BUYER" ? "buyer-paid" : "free";
      returnsNote =
        "Return terms are the listing's own, as returned by the Browse API. ";
    }
  }

  const safeItemId = (item.legacyItemId ?? item.itemId ?? "listing").replace(
    /[^a-zA-Z0-9]+/g,
    "-",
  );

  return {
    id: `ebay-live-${safeItemId}`,
    merchant: "eBay",
    seller,
    channel: "eBay",
    condition: "New",
    price,
    shippingCost,
    deliveryDays,
    deliveryBasis: "Live API delivery estimate",
    returnWindowDays,
    returnCost,
    returnPolicySource,
    warrantyMonths: 0,
    sellerRating,
    sampleListingLabel: `Live eBay listing ${item.legacyItemId ?? item.itemId}`,
    provenance: {
      sourceMerchant: "eBay",
      acquisitionMethod: "api",
      sourceUrl: item.itemWebUrl ?? null,
      retrievedAt,
      policyStatus: "api-only",
      policyNote:
        `Live listing retrieved ${retrievedAt} through the official eBay Buy Browse API ` +
        `(EBAY_US), the only route the policy gate allows for eBay — no scraping, no ` +
        `browser automation. Price and shipping are the listing's own figures; delivery ` +
        `is the latest date of the listing's estimated delivery range. ` +
        returnsNote +
        `Listing data is re-fetched within minutes, well inside eBay's 6-hour display ` +
        `freshness limit, and is never used to train AI models. No warranty period is ` +
        `stated by the listing, so none is claimed.`,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Public entry point                                                  */
/* ------------------------------------------------------------------ */

const cache = new Map<string, { fetchedAt: number; offers: Offer[] }>();

/**
 * Fetch the primary live eBay offer for a catalog product, or [] when the
 * API route is disabled, the policy gate does not allow it, credentials
 * are missing, auth/search fails, or no NEW listing matches honestly.
 * Never throws.
 */
export async function fetchLiveEbayOffers(
  product: Product,
): Promise<Offer[]> {
  if (!ebayApiEnabled()) return [];

  const policy = getMerchantPolicy("eBay");
  if (
    policy.status !== "api-only" ||
    !policy.allowedAcquisitionMethods.includes("api")
  ) {
    console.warn(
      `[ebay-api] policy gate does not allow the API route for eBay (status ${policy.status}); returning no live offers.`,
    );
    return [];
  }

  const query = `${product.brand} ${product.model}`;
  const cached = cache.get(query);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.offers;
  }

  const token = await getApplicationToken();
  if (!token) {
    cache.set(query, { fetchedAt: Date.now(), offers: [] });
    return [];
  }

  const url = `${SEARCH_URL}?q=${encodeURIComponent(query)}&limit=10`;
  let items: EbayItemSummary[] | null = null;
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
        Accept: "application/json",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
      // A rejected token must not be replayed from cache.
      tokenCache = null;
      console.warn(
        `[ebay-api] search returned HTTP ${response.status}; returning no live offers.`,
      );
    } else if (response.status !== 200) {
      console.warn(
        `[ebay-api] search returned HTTP ${response.status}; returning no live offers.`,
      );
    } else {
      const payload = (await response.json()) as {
        itemSummaries?: EbayItemSummary[];
      };
      items = Array.isArray(payload.itemSummaries)
        ? payload.itemSummaries
        : [];
    }
  } catch (error) {
    console.warn("[ebay-api] search request failed:", String(error));
    items = null;
  }

  const offers: Offer[] = [];
  if (items) {
    const picked = pickPrimaryItem(product, items);
    if (picked) offers.push(toOffer(picked, new Date().toISOString()));
  }
  cache.set(query, { fetchedAt: Date.now(), offers });
  return offers;
}
