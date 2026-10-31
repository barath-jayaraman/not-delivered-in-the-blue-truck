import { getMerchantPolicy } from "../adapters";
import type { Offer } from "../types";

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
 *   keyset supplied at runtime via EBAY_CLIENT_ID / EBAY_CLIENT_SECRET
 *   (or the eBay_App_ID / eBay_Cert_ID aliases — see the credential
 *   resolver below). The application token is cached in memory until
 *   shortly before expiry. Neither the secret nor the token is ever
 *   logged.
 * - Searches item summaries (Buy Browse API, EBAY_US marketplace) and
 *   returns them raw; grouping listings into distinct products — with
 *   the model-token discipline that keeps different models apart — lives
 *   in lib/live-search.ts, which also builds the offers via this
 *   adapter's mapping below.
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
 *   hours. This adapter caches nothing — every lookup is fetched live in
 *   the request that displays it. (The OAuth application token is auth
 *   state, not listing data, and is the only thing held in memory.)
 * - eBay Content is never used to train AI models. The live explanation
 *   pipeline (lib/agent.ts) reasons only over our own scored deltas.
 * - eBay offers stay clearly identified as eBay: merchant/channel are
 *   "eBay", the seller names the eBay seller, and provenance records the
 *   API route and the listing URL — never blended as another merchant.
 * - No authorized-seller flag is inferred; seller feedback is shown only
 *   as the labelled rating it is.
 *
 * Enabled whenever both credentials resolve and ENABLE_EBAY_API is not
 * explicitly "0" (see the enablement rule below). With no keys the
 * adapter is a no-op. Any failure — no keys, auth rejection, network,
 * parse — returns no live offers and the caller falls back to sample
 * data. Never throws.
 */

const TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const SEARCH_URL = "https://api.ebay.com/buy/browse/v1/item_summary/search";
const BROWSE_SCOPE = "https://api.ebay.com/oauth/api_scope";
const FETCH_TIMEOUT_MS = 15_000;
/** Far inside eBay's 6-hour display-freshness limit for listing data. */
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

/**
 * Credential aliases + enablement rule (changed 2026-10-30):
 *
 * Barath added the production keyset to Vercel under eBay's own labels
 * from the developer portal — `eBay_App_ID` and `eBay_Cert_ID` — and
 * Vercel env names are case-sensitive, so the adapter resolves the
 * canonical EBAY_CLIENT_ID / EBAY_CLIENT_SECRET first and falls back to
 * those aliases. He never has to re-paste the values under new names.
 *
 * Enablement follows the same spirit: the adapter used to require an
 * explicit ENABLE_EBAY_API=1 that was never added, which silently kept
 * production on sample data. Now the presence of both keys IS the opt-in
 * (nobody sets production eBay keys by accident); ENABLE_EBAY_API="0"
 * remains as an explicit kill switch, and any other value — including
 * unset — leaves the adapter enabled when both keys resolve.
 */
function firstSetEnv(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (value && value.trim()) return value;
  }
  return undefined;
}

export function resolveEbayCredentials(): {
  clientId: string;
  clientSecret: string;
} | null {
  const clientId = firstSetEnv(
    process.env.EBAY_CLIENT_ID,
    process.env.eBay_App_ID,
  );
  const clientSecret = firstSetEnv(
    process.env.EBAY_CLIENT_SECRET,
    process.env.eBay_Cert_ID,
  );
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function ebayCredentialsConfigured(): boolean {
  return resolveEbayCredentials() !== null;
}

export function ebayApiEnabled(): boolean {
  return (
    process.env.ENABLE_EBAY_API !== "0" && ebayCredentialsConfigured()
  );
}

/* ------------------------------------------------------------------ */
/* OAuth client-credentials: application token, cached until expiry    */
/* ------------------------------------------------------------------ */

let tokenCache: { accessToken: string; expiresAt: number } | null = null;
let tokenInFlight: Promise<string | null> | null = null;

async function requestApplicationToken(): Promise<string | null> {
  const credentials = resolveEbayCredentials();
  if (!credentials) return null;
  const { clientId, clientSecret } = credentials;

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

export interface EbayItemSummary {
  itemId?: string;
  legacyItemId?: string;
  title?: string;
  condition?: string;
  price?: EbayMoney;
  itemWebUrl?: string;
  image?: { imageUrl?: string };
  thumbnailImages?: { imageUrl?: string }[];
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

/**
 * Apply the adapter's field rules to one listing: USD price present,
 * shipping charge STATED by the listing (free shipping is an explicit
 * $0.00), and an estimable delivery date. Returns null when any figure
 * would have to be guessed — such listings are skipped, never invented.
 */
export function parseEbayListing(item: EbayItemSummary): {
  price: number;
  shippingCost: number;
  deliveryDays: number;
} | null {
  const price = parseMoney(item.price);
  if (price == null || price <= 0) return null;
  const shippingOption = item.shippingOptions?.[0];
  const shippingCost = parseMoney(shippingOption?.shippingCost);
  if (shippingCost == null) return null;
  const deliveryDays =
    daysUntil(shippingOption?.maxEstimatedDeliveryDate) ??
    daysUntil(item.estimatedDeliveryDate?.maximumEstimatedDeliveryDate);
  if (deliveryDays == null) return null;
  return { price, shippingCost, deliveryDays };
}

/** Map an eBay condition string onto the codebase's offer conditions. */
export function mapEbayCondition(raw: string | undefined): Offer["condition"] {
  const condition = (raw ?? "").toLowerCase();
  if (condition.startsWith("new")) return "New";
  if (condition.includes("certified refurbished")) return "Certified refurbished";
  if (condition.includes("open box") || condition.includes("open-box")) return "Open-box";
  return "Refurbished";
}

/* ------------------------------------------------------------------ */
/* Offer construction                                                  */
/* ------------------------------------------------------------------ */

/**
 * Build an Offer from one listing and its parsed figures. Used by the
 * catalog adapter (primary NEW listing) and by free-form live search
 * (lib/live-search.ts), so both paths apply identical honesty rules.
 */
export function buildEbayOffer(
  item: EbayItemSummary,
  parsed: { price: number; shippingCost: number; deliveryDays: number },
  retrievedAt: string,
): Offer {
  const { price, shippingCost, deliveryDays } = parsed;
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
    condition: mapEbayCondition(item.condition),
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
/* Raw Browse API search (shared by the catalog adapter + live search) */
/* ------------------------------------------------------------------ */

/**
 * One Buy Browse item-summary search (EBAY_US). Returns the raw summaries
 * (possibly empty) — [] also on disabled credentials, auth rejection,
 * network failure, or a non-200 response. Results are NEVER cached:
 * every call fetches live in the request that needs the data. Never
 * throws, never logs credentials or tokens.
 */
export async function searchEbayItems(
  query: string,
  limit = 20,
): Promise<EbayItemSummary[]> {
  if (!ebayApiEnabled()) return [];

  const token = await getApplicationToken();
  if (!token) return [];

  const url = `${SEARCH_URL}?q=${encodeURIComponent(query)}&limit=${limit}`;
  let items: EbayItemSummary[] = [];
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
    items = [];
  }

  return items;
}
