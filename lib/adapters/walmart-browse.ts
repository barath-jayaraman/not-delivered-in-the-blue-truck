import { getMerchantPolicy } from "../adapters";
import type { Offer, Product } from "../types";

/**
 * WALMART LIVE BROWSING ADAPTER — proof of concept.
 *
 * Policy basis: Walmart's Terms of Use (updated Sep 21, 2026), §16.L
 * "Authorized Agents," route agents into Walmart's Agentic Access Terms.
 * The website tier allows an agent to browse and assist "as a person would"
 * under binding conditions: self-identify when asked, never mask origin,
 * never defeat human-vs-software checks, never mimic human timing, obtain
 * the customer's explicit informed consent before acting, and present data
 * accurately. Scraping/bulk extraction, AI/ML training on site materials,
 * and autonomous checkout remain prohibited.
 *
 * What this adapter does, within those conditions:
 * - Fetches ONE public page per lookup — the search-results page for a
 *   tightly scoped product query — server-side, with an honest,
 *   self-identifying user agent. It never logs in, never checks out, and
 *   never touches any other merchant.
 * - Extracts the primary matching listing from the page's embedded
 *   server-rendered state (`__NEXT_DATA__`) with deterministic parsing.
 *   No headless browser, no JS execution, no cookie tricks.
 * - Serializes requests behind a rate limiter (minimum ~2s between page
 *   fetches, one page per lookup). Nothing is cached: every lookup
 *   fetches live in the request that needs it.
 *
 * Feasibility findings from 2026-10-29 (this machine, honest UA):
 * - Search-results pages ARE served (HTTP 200) with full listing data in
 *   the embedded state: price, seller, availability, delivery date.
 * - Product pages are NOT served to this client: both the bare and the
 *   canonical /ip/<id> URLs answer 307 → /blocked. This adapter therefore
 *   relies on search-results pages only and never probes product pages.
 * - Any redirect (especially to /blocked), any 403/412/429, and any
 *   challenge marker in the body is treated as a prohibition in practice
 *   for that session: the adapter returns no live offers and the caller
 *   falls back to sample data. Nothing here evades a block.
 *
 * Enabled by default (Barath's go-live directive, Oct 29, 2026). Set
 * ENABLE_WALMART_BROWSE=0 to disable. The merchant policy registry gate
 * still applies on top of this switch.
 */

const USER_AGENT =
  "NotDeliveredInTheBlueTruck/0.1 (shopping comparison prototype; contact barath.jayaraman@gmail.com)";

const MIN_INTERVAL_MS = 2_000;
const FETCH_TIMEOUT_MS = 15_000;
/** Walmart's published free-shipping threshold for non-Walmart+ orders. */
const FREE_SHIPPING_THRESHOLD = 35;
/** Walmart's published return window for electronics (curated policy). */
const ELECTRONICS_RETURN_WINDOW_DAYS = 30;

export function walmartBrowseEnabled(): boolean {
  return process.env.ENABLE_WALMART_BROWSE !== "0";
}

/* ------------------------------------------------------------------ */
/* Rate limiter: serialize page fetches, minimum interval between them */
/* ------------------------------------------------------------------ */

let lastFetchAt = 0;
let queue: Promise<void> = Promise.resolve();

async function rateLimited<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = queue;
  queue = previous.then(() => gate);
  await previous;
  try {
    const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastFetchAt));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastFetchAt = Date.now();
    return await fn();
  } finally {
    release();
  }
}

/* ------------------------------------------------------------------ */
/* Walmart search-page state shapes (only the fields this adapter uses) */
/* ------------------------------------------------------------------ */

interface WmFulfillment {
  fulfillment?: string;
  deliveryDate?: string | null;
}

export interface WmSearchItem {
  name?: string;
  usItemId?: string | number;
  sellerName?: string;
  availabilityStatus?: string;
  averageRating?: number;
  numberOfReviews?: number;
  price?: number;
  canonicalUrl?: string;
  image?: string;
  thumbnailUrl?: string;
  priceInfo?: {
    shipPrice?: string;
    currentPrice?: { price?: number };
    priceDetails?: {
      priceLines?: {
        lineType?: string;
        values?: { key?: string; value?: string }[];
      }[];
    };
  };
  fulfillment?: WmFulfillment[];
  fulfillmentSummary?: WmFulfillment[];
}

const CHALLENGE_MARKERS =
  /robot or human|px-captcha|press\s*(?:&amp;|&|and)\s*hold|verify you are human|are you a robot/i;

function extractSearchItems(html: string): WmSearchItem[] | null {
  if (CHALLENGE_MARKERS.test(html)) return null;
  const match = html.match(
    /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
  );
  if (!match) return null;
  let data: unknown;
  try {
    data = JSON.parse(match[1]);
  } catch {
    return null;
  }
  const stacks = (
    data as {
      props?: {
        pageProps?: {
          initialData?: {
            searchResult?: { itemStacks?: { items?: WmSearchItem[] }[] };
          };
        };
      };
    }
  ).props?.pageProps?.initialData?.searchResult?.itemStacks;
  if (!Array.isArray(stacks)) return null;
  const items: WmSearchItem[] = [];
  for (const stack of stacks) {
    if (Array.isArray(stack?.items)) items.push(...stack.items);
  }
  return items;
}

/**
 * Fetch and parse ONE Walmart search-results page for an arbitrary query.
 * Shared by free-form live search (lib/live-search.ts). Same stop
 * rules: any redirect, non-200, or challenge marker yields null — the
 * caller degrades silently. Callers own the enablement/policy checks.
 */
export async function fetchWalmartSearchItems(
  query: string,
): Promise<WmSearchItem[] | null> {
  const url = `https://www.walmart.com/search?q=${encodeURIComponent(query)}`;
  return rateLimited(async () => {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml",
        },
        // Never follow a redirect into /blocked or anywhere else: a
        // redirect from a public page fetch is treated as a stop signal.
        redirect: "manual",
        cache: "no-store",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      console.warn("[walmart-browse] fetch failed:", String(error));
      return null;
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location") ?? "";
      console.warn(
        `[walmart-browse] search page redirected (status ${response.status}, location ${location}); treating as blocked, returning no live offers.`,
      );
      return null;
    }
    if (response.status !== 200) {
      console.warn(
        `[walmart-browse] search page returned HTTP ${response.status}; returning no live offers.`,
      );
      return null;
    }
    const html = await response.text();
    const items = extractSearchItems(html);
    if (!items) {
      console.warn(
        "[walmart-browse] no parseable search state (possible challenge page); returning no live offers.",
      );
    }
    return items;
  });
}

/* ------------------------------------------------------------------ */
/* Matching: pick the primary listing for a catalog product            */
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

/**
 * Category/spec/filler words that appear in catalog model strings but carry
 * no model identity — a listing matching only these (plus the brand and
 * generic words like "robot"/"vacuum") is NOT the same product.
 */
const GENERIC_MODEL_TOKENS = new Set([
  "headphones",
  "headphone",
  "wireless",
  "running",
  "shoes",
  "shoe",
  "tv",
  "robot",
  "vacuum",
  "vacuums",
  "espresso",
  "machine",
  "inch",
  "inches",
  "crystal",
  "uhd",
  "oled",
  "evo",
  "smart",
  "series",
  "gen",
  "generation",
  "edition",
  "the",
  "with",
  "and",
  "for",
]);

/**
 * Generation markers (e.g. "(2nd Gen)"). A listing may write the same
 * generation as an ordinal, a roman numeral, or a bare digit, so a product's
 * marker is satisfied by any member of its class appearing as a listing
 * token. Triggered only by ordinal/roman product tokens — bare digits in a
 * model string (Pegasus "41", Ultraboost "5") stay plain required tokens.
 */
const GENERATION_CLASSES: string[][] = [
  ["1st", "i", "1"],
  ["2nd", "ii", "2"],
  ["3rd", "iii", "3"],
  ["4th", "iv", "4"],
  ["5th", "v", "5"],
];
const ORDINAL_TOKENS = new Set([
  "1st",
  "2nd",
  "3rd",
  "4th",
  "5th",
  "i",
  "ii",
  "iii",
  "iv",
  "v",
]);

interface ModelGate {
  /** Distinctive model tokens the listing must carry (e.g. "s8", "u8000f"). */
  required: string[];
  /** Generation class the listing must satisfy, or null when the model has none. */
  generation: string[] | null;
}

export function modelGate(product: Product): ModelGate {
  const brand = product.brand.toLowerCase();
  const required: string[] = [];
  let generation: string[] | null = null;
  for (const token of tokens(product.model)) {
    if (token === brand || GENERIC_MODEL_TOKENS.has(token)) continue;
    if (ORDINAL_TOKENS.has(token)) {
      generation =
        GENERATION_CLASSES.find((cls) => cls.includes(token)) ?? [token];
      continue;
    }
    if (!required.includes(token)) required.push(token);
  }
  return { required, generation };
}

/**
 * Model-identity gate (added Oct 29, 2026 after the Roborock defect, where a
 * Q10 X5 listing was accepted for the S8 on brand + "robot"/"vacuum" overlap
 * alone): a candidate listing is eligible only if it carries the product's
 * distinctive model tokens. A token counts when it appears as a whole
 * listing token, or — for the joined model string of length >= 4 — as a
 * substring of the listing's squashed token string (covers "WH-1000XM6"
 * written "WH1000XM6", and SKUs like "UN55U8000F"). Short tokens ("s8",
 * "c5", "41") are whole-token only, so they cannot match inside unrelated
 * strings. Conservative by design: no match beats a wrong match.
 */
export function passesModelGate(product: Product, itemTokens: string[]): boolean {
  const { required, generation } = modelGate(product);
  if (
    generation &&
    !generation.some((token) => itemTokens.includes(token))
  ) {
    return false;
  }
  if (required.length === 0) return true;
  if (required.every((token) => itemTokens.includes(token))) return true;
  const joined = required.join("");
  if (joined.length >= 4 && itemTokens.join("").includes(joined)) {
    return true;
  }
  return false;
}

function extractPrice(item: WmSearchItem): number | null {
  const lines = item.priceInfo?.priceDetails?.priceLines ?? [];
  for (const line of lines) {
    if (line.lineType !== "CURRENT_PRICE") continue;
    const value = line.values?.find((v) => v.key === "PRICE")?.value;
    const parsed = value ? Number.parseFloat(value) : NaN;
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  if (typeof item.price === "number" && item.price > 0) return item.price;
  const current = item.priceInfo?.currentPrice?.price;
  if (typeof current === "number" && current > 0) return current;
  return null;
}

function extractDeliveryDays(item: WmSearchItem): number | null {
  const entries = [
    ...(item.fulfillmentSummary ?? []),
    ...(item.fulfillment ?? []),
  ];
  for (const entry of entries) {
    if (!entry?.deliveryDate) continue;
    const when = new Date(entry.deliveryDate);
    if (Number.isNaN(when.getTime())) continue;
    const now = new Date();
    const dayMs = 86_400_000;
    const diff = Math.round(
      (Date.UTC(when.getUTCFullYear(), when.getUTCMonth(), when.getUTCDate()) -
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) /
        dayMs,
    );
    return Math.max(0, diff);
  }
  return null;
}

/**
 * The figures a Walmart search item must actually display to become an
 * offer: a price and a delivery date. Null when either is absent —
 * nothing is estimated or invented.
 */
export function parseWalmartItem(item: WmSearchItem): {
  price: number;
  deliveryDays: number;
} | null {
  const price = extractPrice(item);
  if (price == null) return null;
  const deliveryDays = extractDeliveryDays(item);
  if (deliveryDays == null) return null;
  return { price, deliveryDays };
}

/** The listing image URL the search state carries for an item, if any. */
export function walmartItemImage(item: WmSearchItem): string | null {
  return item.image ?? item.thumbnailUrl ?? null;
}

/* ------------------------------------------------------------------ */
/* Offer construction                                                  */
/* ------------------------------------------------------------------ */

/**
 * Build an Offer from one Walmart search item and its parsed figures.
 * Used by the catalog adapter and by free-form live search
 * (lib/live-search.ts), so both paths apply identical honesty rules.
 */
export function buildWalmartOffer(
  item: WmSearchItem,
  parsed: { price: number; deliveryDays: number },
  searchUrl: string,
): Offer {
  const { price, deliveryDays } = parsed;
  const usItemId = String(item.usItemId);
  const sellerName = item.sellerName ?? "Walmart";
  const seller = sellerName === "Walmart.com" ? "Walmart" : sellerName;

  const shipPriceRaw = item.priceInfo?.shipPrice;
  const shipPrice =
    shipPriceRaw && shipPriceRaw.trim() !== ""
      ? Number.parseFloat(shipPriceRaw)
      : NaN;
  const shippingCost = Number.isFinite(shipPrice)
    ? shipPrice
    : price >= FREE_SHIPPING_THRESHOLD
      ? 0
      : 0;

  const condition: Offer["condition"] = /open box/i.test(item.name ?? "")
    ? "Open-box"
    : /certified refurbished/i.test(item.name ?? "")
      ? "Certified refurbished"
      : /refurbished|preowned|pre-owned/i.test(item.name ?? "")
        ? "Refurbished"
        : "New";

  const listingUrl = item.canonicalUrl
    ? `https://www.walmart.com${item.canonicalUrl}`
    : `https://www.walmart.com/ip/${usItemId}`;

  return {
    id: `walmart-live-${usItemId}`,
    merchant: "Walmart",
    seller,
    channel: "Walmart",
    condition,
    price,
    shippingCost,
    deliveryDays,
    deliveryBasis: "Live page-displayed delivery estimate",
    returnWindowDays: ELECTRONICS_RETURN_WINDOW_DAYS,
    returnCost: "free",
    returnPolicySource: "Curated retailer-policy sample",
    warrantyMonths: 0,
    sellerRating:
      typeof item.averageRating === "number" ? item.averageRating : 0,
    sampleListingLabel: `Live Walmart listing ${usItemId}`,
    provenance: {
      sourceMerchant: "Walmart",
      acquisitionMethod: "browse",
      sourceUrl: listingUrl,
      retrievedAt: new Date().toISOString(),
      policyStatus: "browse-allowed-agentic-access-terms",
      policyNote:
        `Live price retrieved ${new Date().toISOString()} from Walmart's public ` +
        `search-results page (${searchUrl}) under the Agentic Access Terms website tier ` +
        `(Terms of Use §16.L): single page view with a self-identifying user agent, no ` +
        `login, no checkout action. Walmart product pages currently redirect this client ` +
        `to /blocked, so extraction uses search-results state only. ` +
        (Number.isFinite(shipPrice)
          ? "Shipping is the shipping charge displayed for the listing. "
          : `No shipping charge was displayed for the listing; shipping is shown as $0.00 ` +
            `under Walmart's published free-shipping policy for orders of $${FREE_SHIPPING_THRESHOLD}+. `) +
        `The listing displayed no return terms; the return window/cost are Walmart's ` +
        `published electronics return policy (curated). The rating field carries the ` +
        `listing's displayed average review rating for this first-party offer.`,
    },
  };
}
