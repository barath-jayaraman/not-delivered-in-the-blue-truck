import { getMerchantPolicy } from "./adapters";
import {
  buildEbayOffer,
  ebayApiEnabled,
  parseEbayListing,
  searchEbayItems,
  type EbayItemSummary,
} from "./adapters/ebay-api";
import {
  buildWalmartOffer,
  fetchWalmartSearchItems,
  parseWalmartItem,
  walmartBrowseEnabled,
  walmartItemImage,
  type WmSearchItem,
} from "./adapters/walmart-browse";
import { normalizeSearch } from "./data";
import type { Merchant, Offer, ProductSummary } from "./types";

/**
 * FREE-FORM LIVE SEARCH — the app's ONLY search path.
 *
 * Every query goes live, at request time, to the two sources the policy
 * gate allows:
 *
 * - eBay, through the official Buy Browse API (lib/adapters/ebay-api.ts);
 * - Walmart, through ONE public search-results page fetch under the
 *   Agentic Access Terms website tier (lib/adapters/walmart-browse.ts) —
 *   self-identifying agent, serialized rate limiting, stop-on-block; a
 *   redirect/challenge simply yields no Walmart results for that search.
 *
 * NO STORED LISTINGS OR PRICES ANYWHERE (Barath's rule, Oct 31, 2026):
 * nothing in this module — or anywhere in the app — keeps search results
 * or prices between requests. The only memoization is in-flight dedupe:
 * concurrent identical queries share the single fetch already running
 * for them, and the entry is dropped the moment it settles. A decide
 * request re-fetches live rather than reusing a search's offers, so a
 * comparison is always built from listings retrieved in that request.
 *
 * Listings from both sources are grouped into distinct products with the
 * model-token discipline: a group is keyed by the brand plus the listing
 * title's distinctive model tokens (category words, filler, condition
 * words, and color/variant words removed), so different models — Px8 vs
 * Px8 S2 vs Px7 — NEVER merge into one result, and the same model from
 * both merchants lands in one group. Accessory listings (cases, earpads,
 * chargers…) are excluded unless the shopper searched for the accessory
 * itself.
 *
 * Every figure on an offer is the listing's own, under the exact field
 * rules of the underlying adapters: unstated shipping or delivery means
 * the listing is skipped, never guessed.
 */

const MAX_GROUPS = 10;
const MAX_OFFERS_PER_GROUP = 6;
const MAX_EBAY_OFFERS_PER_GROUP = 4;
const MAX_WALMART_OFFERS_PER_GROUP = 2;

/* ------------------------------------------------------------------ */
/* Text utilities                                                      */
/* ------------------------------------------------------------------ */

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

const QUERY_STOP_WORDS = new Set(["the", "a", "an", "for", "with", "in", "on"]);

/**
 * Words that carry no model identity: category nouns, marketing filler,
 * condition words, and unit words. A listing matching a product only on
 * these words is not the same product.
 */
const FILLER_TOKENS = new Set([
  "headphones", "headphone", "earbuds", "earbud", "earphones", "earphone",
  "wireless", "bluetooth", "noise", "cancelling", "canceling", "cancellation",
  "over", "ear", "on", "in", "with", "and", "the", "for", "of", "by",
  "tv", "television", "shoes", "shoe", "sneakers", "sneaker", "running",
  "vacuum", "vacuums", "robot", "espresso", "machine", "coffee", "maker",
  "inch", "inches", "in", "cm", "mm", "gb", "tb", "hz", "smart", "series",
  "gen", "generation", "edition", "new", "sealed", "genuine", "authentic",
  "oem", "original", "official", "premium", "free",
  "shipping", "fast", "refurbished", "certified", "preowned", "pre", "owned",
  "used", "open", "box", "like", "men", "mens", "women", "womens", "unisex",
  "size", "pack", "bundle", "set", "kit", "only", "sale", "buy", "get",
]);

/** Color/finish words: variants of the same product, not different models. */
const COLOR_TOKENS = new Set([
  "black", "white", "blue", "red", "green", "silver", "gold", "grey",
  "gray", "pink", "purple", "orange", "yellow", "brown", "tan", "cream",
  "midnight", "lunar", "eclipse", "onyx", "ivory", "charcoal", "navy",
  "beige", "olive", "burgundy", "teal", "coral", "smoke", "sandstone",
]);

/** Accessory markers: the listing is an add-on, not the product itself. */
const ACCESSORY_TOKENS = new Set([
  "case", "cover", "cushion", "cushions", "earpads", "earpad", "replacement",
  "charger", "charging", "cord", "cable", "adapter", "skin", "decal",
  "protector", "stand", "holder", "sleeve", "strap", "tips", "tip",
  "filter", "filters", "brush", "mop", "pads",
]);

/* ------------------------------------------------------------------ */
/* Brand detection                                                     */
/* ------------------------------------------------------------------ */

/** [alias phrase, canonical display name] — matched on title text. */
const KNOWN_BRANDS: [string, string][] = [
  ["bowers and wilkins", "Bowers & Wilkins"],
  ["b and w", "Bowers & Wilkins"],
  ["bang and olufsen", "Bang & Olufsen"],
  ["audio technica", "Audio-Technica"],
  ["sennheiser", "Sennheiser"],
  ["soundcore", "Soundcore"],
  ["skullcandy", "Skullcandy"],
  ["hamilton beach", "Hamilton Beach"],
  ["black and decker", "Black+Decker"],
  ["kitchenaid", "KitchenAid"],
  ["cuisinart", "Cuisinart"],
  ["roborock", "Roborock"],
  ["breville", "Breville"],
  ["keurig", "Keurig"],
  ["samsung", "Samsung"],
  ["hisense", "Hisense"],
  ["logitech", "Logitech"],
  ["microsoft", "Microsoft"],
  ["patagonia", "Patagonia"],
  ["fisher price", "Fisher-Price"],
  ["under armour", "Under Armour"],
  ["new balance", "New Balance"],
  ["beats", "Beats"],
  ["bose", "Bose"],
  ["sony", "Sony"],
  ["jbl", "JBL"],
  ["jabra", "Jabra"],
  ["anker", "Anker"],
  ["marshall", "Marshall"],
  ["focal", "Focal"],
  ["dyson", "Dyson"],
  ["shark", "Shark"],
  ["ninja", "Ninja"],
  ["apple", "Apple"],
  ["google", "Google"],
  ["amazon", "Amazon"],
  ["nike", "Nike"],
  ["adidas", "Adidas"],
  ["asics", "Asics"],
  ["puma", "Puma"],
  ["reebok", "Reebok"],
  ["vizio", "Vizio"],
  ["tcl", "TCL"],
  ["lg", "LG"],
  ["dell", "Dell"],
  ["hp", "HP"],
  ["lenovo", "Lenovo"],
  ["asus", "Asus"],
  ["acer", "Acer"],
  ["razer", "Razer"],
  ["corsair", "Corsair"],
  ["philips", "Philips"],
  ["grado", "Grado"],
  ["instant", "Instant"],
  ["stanley", "Stanley"],
  ["yeti", "YETI"],
  ["lego", "LEGO"],
  ["hasbro", "Hasbro"],
  ["mattel", "Mattel"],
];

function detectBrand(titleTokens: string[]): {
  brand: string;
  brandTokens: string[];
} {
  const joined = ` ${titleTokens.join(" ")} `;
  for (const [alias, display] of KNOWN_BRANDS) {
    if (joined.includes(` ${alias} `)) {
      return { brand: display, brandTokens: tokens(alias) };
    }
  }
  return { brand: "", brandTokens: [] };
}

/* ------------------------------------------------------------------ */
/* Grouping                                                            */
/* ------------------------------------------------------------------ */

export interface LiveProductGroup {
  id: string;
  name: string;
  brand: string;
  model: string;
  category: string;
  imageUrl: string | null;
  offers: Offer[];
  merchants: Merchant[];
  retrievedAt: string;
  query: string;
}

interface Candidate {
  offer: Offer;
  title: string;
  imageUrl: string | null;
}

function distinctiveTokens(
  titleTokens: string[],
  brandTokens: string[],
): string[] {
  const brandSet = new Set(brandTokens);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of titleTokens) {
    if (brandSet.has(token)) continue;
    if (FILLER_TOKENS.has(token) || COLOR_TOKENS.has(token)) continue;
    if (!seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
  }
  return out;
}

function guessCategory(text: string): string {
  const t = ` ${text.toLowerCase()} `;
  if (/headphone|earbud|earphone/.test(t)) return "Headphones";
  if (/\btv\b|television|oled|qled/.test(t)) return "TVs";
  if (/shoe|sneaker|running/.test(t)) return "Running shoes";
  if (/vacuum|roomba|roborock/.test(t)) return "Robot vacuums";
  if (/espresso|coffee/.test(t)) return "Coffee makers";
  return "General";
}

function groupKey(brand: string, distinctive: string[]): string {
  return `${brand.toLowerCase()}|${[...distinctive].sort().join(" ")}`;
}

function groupId(key: string): string {
  const slug = key
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `live-${slug || "product"}`;
}

function groupListings(
  query: string,
  candidates: Candidate[],
): LiveProductGroup[] {
  const queryTokens = new Set(
    tokens(query).filter((t) => !QUERY_STOP_WORDS.has(t)),
  );
  const groups = new Map<
    string,
    {
      key: string;
      brand: string;
      distinctive: string[];
      entries: Candidate[];
    }
  >();

  for (const candidate of candidates) {
    const titleTokens = tokens(candidate.title);
    // Accessory listings are not the product — unless the shopper
    // searched for the accessory itself.
    const accessory = titleTokens.some((t) => ACCESSORY_TOKENS.has(t));
    if (
      accessory &&
      !titleTokens.some((t) => ACCESSORY_TOKENS.has(t) && queryTokens.has(t))
    ) {
      continue;
    }
    const { brand, brandTokens } = detectBrand(titleTokens);
    const distinctive = distinctiveTokens(titleTokens, brandTokens);
    // Relevance: the listing must share at least one token with the query.
    if (!titleTokens.some((t) => queryTokens.has(t))) continue;
    const key = groupKey(brand, distinctive);
    const existing = groups.get(key);
    if (existing) {
      existing.entries.push(candidate);
    } else {
      groups.set(key, { key, brand, distinctive, entries: [candidate] });
    }
  }

  const built: LiveProductGroup[] = [];
  for (const group of groups.values()) {
    // Per-merchant caps keep one marketplace from flooding the table.
    const ebay = group.entries
      .filter((e) => e.offer.merchant === "eBay")
      .sort((a, b) => a.offer.price - b.offer.price)
      .slice(0, MAX_EBAY_OFFERS_PER_GROUP);
    const walmart = group.entries
      .filter((e) => e.offer.merchant === "Walmart")
      .sort((a, b) => a.offer.price - b.offer.price)
      .slice(0, MAX_WALMART_OFFERS_PER_GROUP);
    const kept = [...walmart, ...ebay]
      .sort((a, b) => a.offer.price - b.offer.price)
      .slice(0, MAX_OFFERS_PER_GROUP);
    if (!kept.length) continue;

    const offers = kept.map((e) => e.offer);
    // Display name: the shortest listing title that still carries every
    // distinctive model token — the cleanest rendering of the product.
    const distinctiveSet = new Set(group.distinctive);
    const nameCandidate =
      kept
        .filter((e) =>
          [...distinctiveSet].every((t) => tokens(e.title).includes(t)),
        )
        .sort((a, b) => a.title.length - b.title.length)[0] ?? kept[0];
    const name = nameCandidate.title.slice(0, 110);
    const brand = group.brand;
    const model = brand
      ? name.replace(new RegExp(`^${brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`, "i"), "")
      : name;
    const imageUrl =
      kept.find((e) => e.imageUrl)?.imageUrl ?? null;
    const retrievedAt = offers
      .map((o) => o.provenance.retrievedAt ?? "")
      .sort()
      .at(-1) as string;

    built.push({
      id: groupId(group.key),
      name,
      brand,
      model: model || name,
      category: guessCategory(`${query} ${name}`),
      imageUrl,
      offers,
      merchants: [...new Set(offers.map((o) => o.merchant))],
      retrievedAt,
      query,
    });
  }

  // Two-merchant groups first (the comparison story), then more offers,
  // then lower from-price.
  built.sort((a, b) => {
    const bothA = a.merchants.length > 1 ? 0 : 1;
    const bothB = b.merchants.length > 1 ? 0 : 1;
    if (bothA !== bothB) return bothA - bothB;
    if (b.offers.length !== a.offers.length) return b.offers.length - a.offers.length;
    return (
      Math.min(...a.offers.map((o) => o.price)) -
      Math.min(...b.offers.map((o) => o.price))
    );
  });
  return built.slice(0, MAX_GROUPS);
}

function summarizeGroup(group: LiveProductGroup, query: string): ProductSummary {
  const prices = group.offers.map((o) => o.price);
  const first = group.offers[0];
  return {
    id: group.id,
    name: group.name,
    brand: group.brand,
    model: group.model,
    category: group.category,
    offerCount: group.offers.length,
    lowestPrice: Math.min(...prices),
    highestPrice: Math.max(...prices),
    fastestDeliveryDays: Math.min(...group.offers.map((o) => o.deliveryDays)),
    exactMatch: normalizeSearch(group.name).includes(normalizeSearch(query)),
    dataSource: "live",
    sourceMerchants: group.merchants,
    acquisitionMethod: first.provenance.acquisitionMethod,
    sourceUrl: first.provenance.sourceUrl,
    retrievedAt: group.retrievedAt,
    policyStatus: first.provenance.policyStatus,
    imageUrl: group.imageUrl,
  };
}

/* ------------------------------------------------------------------ */
/* Source collection                                                   */
/* ------------------------------------------------------------------ */

async function collectEbayCandidates(query: string): Promise<Candidate[]> {
  if (!ebayApiEnabled()) return [];
  const policy = getMerchantPolicy("eBay");
  if (
    policy.status !== "api-only" ||
    !policy.allowedAcquisitionMethods.includes("api")
  ) {
    return [];
  }
  const items: EbayItemSummary[] = await searchEbayItems(query, 20);
  const retrievedAt = new Date().toISOString();
  const candidates: Candidate[] = [];
  for (const item of items) {
    if (!item.title || !item.itemId || !item.itemWebUrl) continue;
    const parsed = parseEbayListing(item);
    if (!parsed) continue;
    candidates.push({
      offer: buildEbayOffer(item, parsed, retrievedAt),
      title: item.title,
      imageUrl: item.image?.imageUrl ?? item.thumbnailImages?.[0]?.imageUrl ?? null,
    });
  }
  return candidates;
}

async function collectWalmartCandidates(
  query: string,
): Promise<Candidate[]> {
  if (!walmartBrowseEnabled()) return [];
  const policy = getMerchantPolicy("Walmart");
  if (
    policy.status !== "browser-allowed-under-terms" ||
    !policy.allowedAcquisitionMethods.includes("browser")
  ) {
    return [];
  }
  const items: WmSearchItem[] | null = await fetchWalmartSearchItems(query);
  if (!items) return [];
  const searchUrl = `https://www.walmart.com/search?q=${encodeURIComponent(query)}`;
  const candidates: Candidate[] = [];
  for (const item of items) {
    if (!item.name || item.usItemId == null) continue;
    if (item.availabilityStatus && item.availabilityStatus !== "IN_STOCK") {
      continue;
    }
    const parsed = parseWalmartItem(item);
    if (!parsed) continue;
    candidates.push({
      offer: buildWalmartOffer(item, parsed, searchUrl),
      title: item.name,
      imageUrl: walmartItemImage(item),
    });
  }
  return candidates;
}

/* ------------------------------------------------------------------ */
/* Public search — live every time, in-flight dedupe only              */
/* ------------------------------------------------------------------ */

export interface LiveSearchResult {
  summaries: ProductSummary[];
  groups: LiveProductGroup[];
}

/**
 * In-flight dedupe ONLY: while one live fetch for a normalized query is
 * running, concurrent identical queries share it. The entry is deleted
 * the moment the fetch settles — no result or price is retained between
 * requests, ever.
 */
const inflight = new Map<string, Promise<LiveSearchResult>>();

async function runLiveSearch(query: string): Promise<LiveSearchResult> {
  const [ebayResult, walmartResult] = await Promise.allSettled([
    collectEbayCandidates(query),
    collectWalmartCandidates(query),
  ]);
  const candidates = [
    ...(ebayResult.status === "fulfilled" ? ebayResult.value : []),
    ...(walmartResult.status === "fulfilled" ? walmartResult.value : []),
  ];
  const groups = groupListings(query, candidates);
  const summaries = groups.map((group) => summarizeGroup(group, query));
  return { summaries, groups };
}

/**
 * Run a live search for any query. Either source failing degrades
 * silently to the other; both failing (or nothing honestly matching)
 * returns an empty list. Never throws, never serves stored data.
 */
export function searchLiveProducts(query: string): Promise<LiveSearchResult> {
  const key = normalizeSearch(query);
  const existing = inflight.get(key);
  if (existing) return existing;
  const promise = runLiveSearch(query).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}

/**
 * Pick the group in a FRESH live result that corresponds to a known
 * product's metadata (lib/data.ts): same brand, and every distinctive
 * model token of the product present in the group's identity. Different
 * models never substitute for each other — no match means the caller
 * shows the honest empty state for that product.
 */
export function pickGroupForProduct(
  groups: LiveProductGroup[],
  product: { brand: string; model: string },
): LiveProductGroup | null {
  const brand = product.brand.toLowerCase();
  const distinctive = tokens(product.model).filter(
    (t) =>
      t !== brand &&
      !FILLER_TOKENS.has(t) &&
      !COLOR_TOKENS.has(t) &&
      !QUERY_STOP_WORDS.has(t),
  );
  const candidates = groups.filter((group) => {
    if (group.brand.toLowerCase() !== brand) return false;
    const groupTokens = new Set(tokens(`${group.brand} ${group.model} ${group.name}`));
    return distinctive.every((t) => groupTokens.has(t));
  });
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];
  // Several models can share the distinctive tokens once filler words are
  // removed (QuietComfort Headphones vs QuietComfort Earbuds — "headphones"
  // is filler). Break the tie on form factor: when the product's model
  // names one, the group must name the same one.
  const FORM_FACTORS = ["headphones", "earbuds", "earbud", "speaker", "soundbar"];
  const modelTokens = new Set(tokens(product.model));
  const wanted = FORM_FACTORS.find((f) => modelTokens.has(f));
  if (wanted) {
    const sameForm = candidates.filter((group) =>
      tokens(group.name).includes(wanted),
    );
    if (sameForm.length) return sameForm[0];
  }
  return candidates[0];
}
