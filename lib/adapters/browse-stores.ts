import { getMerchantPolicy } from "../adapters";
import { normalizeSearch } from "../data";
import type { Merchant, Offer } from "../types";

/**
 * BROWSING-ROUTE STORE ADAPTERS — assortment-routed first-party stores
 * whose terms are SILENT on automated access and whose public
 * search-results pages are served to an honest server fetch.
 *
 * Policy basis (the prohibition-based gate in lib/adapters.ts): policy
 * silence does not exclude a merchant; an express prohibition does, and
 * an active CAPTCHA/block/challenge is a prohibition in practice for
 * that session — stop immediately, never evade. Each store below was
 * admitted only after BOTH checks, re-run live on Nov 1, 2026:
 *
 * - Terms read in full at the URL in the store's registry rationale —
 *   no robot/spider/scraper/data-mining/automated-access prohibition
 *   found (Micro Center, Harbor Freight, Carter's, Mattress Firm).
 * - One honest search-results fetch (this adapter's exact user agent)
 *   returned HTTP 200 with real priced listings in the page's own
 *   server-rendered markup or embedded state. Mattress Firm's card
 *   price was additionally cross-checked against the product page's
 *   own JSON price for the same item (Chime 10" Hybrid, $824.99 —
 *   identical), confirming the card figure is the selling price.
 *
 * Stores from the same sweep that did NOT clear this bar are not here:
 * Ulta Beauty (terms now expressly bar "any collection and use of any
 * product listings, descriptions, or prices" and "any use of data
 * mining, robots, or similar data gathering and extraction tools" —
 * excluded-prohibited), Belk and Gap/Old Navy (search results load
 * client-side; the server fetch carries no listings or prices), and
 * Price Chopper / Northeast Grocery (Instacart storefront serves a
 * shell for search; listings load client-side).
 *
 * What this adapter does, per store, within those conditions:
 * - Fetches ONE public page per lookup — the store's search-results
 *   page for the shopper's query — server-side, with an honest,
 *   self-identifying user agent. No login, no checkout, no product-page
 *   crawling: listings come from the search page only.
 * - Extracts listings deterministically from the page's own markup /
 *   embedded state (Micro Center's product-card data attributes,
 *   Harbor Freight's Apollo search state, Carter's embedded search
 *   payload, Mattress Firm's product cards). No headless browser, no
 *   JS execution, no cookie tricks.
 * - Serializes each HOST's page fetches behind its own rate limiter
 *   (minimum ~1.5s between one store's fetches; different stores run
 *   in parallel). Nothing is cached: every lookup fetches live in the
 *   request that needs it.
 * - Any non-200, any redirect into a blocked path, and any challenge
 *   marker in the body yields NO offers for that store in that request.
 *   The benign reCAPTCHA footer widget some stores ship site-wide is
 *   not an active challenge; the markers below match challenge pages,
 *   not widget scripts.
 *
 * Offer honesty (same pattern as the UCP adapter): the price is the
 * figure the page itself displayed. Fields the search page does not
 * state — shipping charge, delivery estimate, return terms, warranty —
 * use the labelled curated/service estimates disclosed in every
 * offer's provenance note; nothing is presented as the merchant's
 * stated policy.
 *
 * Enabled by default. Set ENABLE_BROWSE_STORES=0 to disable. The
 * merchant policy registry gate still applies on top of this switch.
 */

const USER_AGENT =
  "NotDeliveredInTheBlueTruck/0.1 (shopping comparison prototype; contact barath.jayaraman@gmail.com)";

const MIN_INTERVAL_MS = 1_500;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_PRODUCTS_PER_STORE = 12;
const MAX_BROWSE_STORES_PER_QUERY = 3;
/** Standard ground service estimate used when a page states no delivery time (as in the UCP adapter). */
const SERVICE_DELIVERY_DAYS = 5;
/** Conservative curated return pattern used when a page states no return terms (as in the UCP adapter). */
const CURATED_RETURN_WINDOW_DAYS = 30;

export function browseStoresEnabled(): boolean {
  return process.env.ENABLE_BROWSE_STORES !== "0";
}

/* ------------------------------------------------------------------ */
/* Rate limiter: PER-HOST serialization, minimum interval between a   */
/* host's own page fetches. Each store keeps its own queue and its    */
/* own ~1.5s spacing — the politeness constraint is per merchant —    */
/* while DIFFERENT stores' pages fetch in parallel (Nov 2, 2026 —     */
/* search-speed work: one shared cross-host queue previously         */
/* serialized every browsing-route store behind every other, so a     */
/* three-store query paid three full page fetches back to back).      */
/* ------------------------------------------------------------------ */

interface HostLimiter {
  lastFetchAt: number;
  queue: Promise<void>;
}

const hostLimiters = new Map<string, HostLimiter>();

function limiterFor(host: string): HostLimiter {
  let limiter = hostLimiters.get(host);
  if (!limiter) {
    limiter = { lastFetchAt: 0, queue: Promise.resolve() };
    hostLimiters.set(host, limiter);
  }
  return limiter;
}

async function rateLimited<T>(host: string, fn: () => Promise<T>): Promise<T> {
  const limiter = limiterFor(host);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = limiter.queue;
  limiter.queue = previous.then(() => gate);
  await previous;
  try {
    const wait = Math.max(
      0,
      MIN_INTERVAL_MS - (Date.now() - limiter.lastFetchAt),
    );
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    limiter.lastFetchAt = Date.now();
    return await fn();
  } finally {
    release();
  }
}

/* ------------------------------------------------------------------ */
/* Page fetch with stop-on-block discipline                            */
/* ------------------------------------------------------------------ */

const CHALLENGE_MARKERS =
  /robot or human|px-captcha|press\s*(?:&amp;|&|and)\s*hold|verify you are human|are you a robot|kasada|access denied/i;

async function fetchBrowsePage(url: string): Promise<string | null> {
  let host = "unknown";
  try {
    host = new URL(url).host;
  } catch {
    /* keep the shared fallback bucket for an unparseable URL */
  }
  return rateLimited(host, async () => {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml",
        },
        redirect: "follow",
        cache: "no-store",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      console.warn("[browse-stores] fetch failed:", url, String(error));
      return null;
    }
    if (response.status !== 200) {
      console.warn(
        `[browse-stores] ${url} returned HTTP ${response.status}; returning no live offers.`,
      );
      return null;
    }
    if (/\/blocked\b/i.test(response.url)) {
      console.warn(
        `[browse-stores] ${url} landed on a blocked path (${response.url}); returning no live offers.`,
      );
      return null;
    }
    const html = await response.text();
    if (CHALLENGE_MARKERS.test(html)) {
      console.warn(
        `[browse-stores] ${url} served a challenge page; returning no live offers.`,
      );
      return null;
    }
    return html;
  });
}

/* ------------------------------------------------------------------ */
/* Parsing helpers                                                     */
/* ------------------------------------------------------------------ */

function decodeEntities(text: string): string {
  const decodeOnce = (value: string): string =>
    value
      .replace(/&quot;/g, '"')
      .replace(/&#0?34;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&");
  // Some stores double-encode attribute values (&amp;quot;), so decode
  // until stable.
  let out = text;
  for (let i = 0; i < 3; i++) {
    const next = decodeOnce(out);
    if (next === out) break;
    out = next;
  }
  return out.trim();
}

function attr(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return match ? match[1] : null;
}

/** Balanced-scan a JSON object/array starting at `start` (which must be "{" or "["); returns the exact substring or null. */
function scanJson(text: string, start: number): string | null {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseJson(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Store registry                                                      */
/* ------------------------------------------------------------------ */

export interface BrowseProduct {
  title: string;
  /** The price the search page itself displayed for this listing. */
  price: number;
  /** Product page URL when the search page states it; null otherwise. */
  url: string | null;
  imageUrl: string | null;
  /** Stable per-product key (store SKU/id) used in the offer id. */
  productKey: string;
  /** Product rating the page displayed (first-party listings), when stated. */
  rating?: number | null;
  condition?: Offer["condition"];
}

export interface BrowseStore {
  merchant: Merchant;
  category: string;
  /** Normalized phrases that name this store/brand in a query. */
  brandAliases: string[];
  /** Normalized assortment phrases that route a query to this store. */
  keywords: string[];
  /** The store's terms page, read in full for the policy gate. */
  termsUrl: string;
  searchUrl: (query: string) => string;
  parse: (html: string) => BrowseProduct[];
}

/* ---------------- Micro Center: server-rendered product cards ------ */

function parseMicroCenter(html: string): BrowseProduct[] {
  const products: BrowseProduct[] = [];
  const seen = new Set<string>();
  const anchorRe = /<a\b[^>]*\bclass="[^"]*productClickItemV2[^"]*"[^>]*>/g;
  let match: RegExpExecArray | null;
  while ((match = anchorRe.exec(html)) !== null) {
    const tag = match[0];
    const id = attr(tag, "data-id");
    const name = attr(tag, "data-name");
    const priceRaw = attr(tag, "data-price");
    const href = attr(tag, "href");
    if (!id || !name || !priceRaw || seen.has(id)) continue;
    const price = Number.parseFloat(priceRaw);
    if (!Number.isFinite(price) || price <= 0) continue;
    seen.add(id);
    const brand = attr(tag, "data-brand") ?? "";
    const decoded = decodeEntities(name);
    const title =
      brand && !decoded.toLowerCase().startsWith(brand.toLowerCase())
        ? `${brand} ${decoded}`
        : decoded;
    const after = html.slice(match.index + tag.length, match.index + tag.length + 900);
    const img = after.match(/<img[^>]+src="([^"]+)"/);
    products.push({
      title,
      price,
      url: href ? `https://www.microcenter.com${href}` : null,
      imageUrl: img ? img[1] : null,
      productKey: id,
      condition: /open box/i.test(title)
        ? "Open-box"
        : /refurbished/i.test(title)
          ? "Refurbished"
          : "New",
    });
    if (products.length >= MAX_PRODUCTS_PER_STORE) break;
  }
  return products;
}

/* ---------------- Harbor Freight: Apollo search state --------------- */

interface HfEntity {
  __typename?: string;
  name?: string;
  sku?: string | number;
  id?: string | number;
  Brand?: string;
  canonical_url?: string;
  price_range?: {
    minimum_price?: { final_price?: { value?: number } };
  };
  small_image?: { url?: string };
}

function titleCaseBrand(brand: string): string {
  return brand === brand.toUpperCase()
    ? brand
        .toLowerCase()
        .replace(/\b\w/g, (c) => c.toUpperCase())
    : brand;
}

function parseHarborFreight(html: string): BrowseProduct[] {
  const marker = html.indexOf("__APOLLO_STATE__");
  if (marker < 0) return [];
  const start = html.indexOf("{", marker);
  if (start < 0) return [];
  const state = parseJson(scanJson(html, start)) as
    | Record<string, HfEntity>
    | null;
  if (!state || typeof state !== "object") return [];

  const entities = new Map<string, HfEntity>();
  for (const [key, value] of Object.entries(state)) {
    if (
      value &&
      (value.__typename === "SimpleProduct" ||
        value.__typename === "ConfigurableProduct")
    ) {
      entities.set(key, value);
    }
  }
  if (!entities.size) return [];

  // Result order: the search result list's __ref sequence (the object
  // carrying items + page_info, possibly nested under ROOT_QUERY).
  // Fall back to state order when not found.
  let orderedKeys: string[] = [];
  const findItems = (node: unknown, depth: number): void => {
    if (orderedKeys.length || depth < 0 || !node || typeof node !== "object") {
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) findItems(child, depth - 1);
      return;
    }
    const record = node as Record<string, unknown>;
    if (
      Array.isArray(record.items) &&
      record.page_info &&
      typeof record.page_info === "object"
    ) {
      orderedKeys = (record.items as { __ref?: string }[])
        .map((item) => item?.__ref)
        .filter((ref): ref is string => typeof ref === "string");
      return;
    }
    for (const child of Object.values(record)) findItems(child, depth - 1);
  };
  findItems(state, 4);
  if (!orderedKeys.length) orderedKeys = [...entities.keys()];

  const products: BrowseProduct[] = [];
  const seen = new Set<string>();
  for (const key of orderedKeys) {
    const entity = entities.get(key);
    if (!entity || seen.has(key)) continue;
    seen.add(key);
    const price = entity.price_range?.minimum_price?.final_price?.value;
    if (typeof entity.name !== "string" || !entity.name) continue;
    if (typeof price !== "number" || price <= 0) continue;
    const brand = typeof entity.Brand === "string" ? entity.Brand : "";
    const title =
      brand && !entity.name.toLowerCase().startsWith(brand.toLowerCase())
        ? `${titleCaseBrand(brand)} ${entity.name}`
        : entity.name;
    products.push({
      title,
      price,
      url: entity.canonical_url
        ? `https://www.harborfreight.com/${entity.canonical_url}`
        : null,
      imageUrl: entity.small_image?.url ?? null,
      productKey: String(entity.sku ?? entity.id ?? key),
    });
    if (products.length >= MAX_PRODUCTS_PER_STORE) break;
  }
  return products;
}

/* ---------------- Carter's: embedded search payload ----------------- */

function parseCarters(html: string): BrowseProduct[] {
  const marker = html.indexOf('"details":[');
  if (marker < 0) return [];
  const start = html.indexOf("[", marker);
  if (start < 0) return [];
  const details = parseJson(scanJson(html, start)) as
    | { name?: string; img?: string; price?: number }[]
    | null;
  if (!Array.isArray(details)) return [];

  // Product-id -> product path, from the rendered tiles' anchors.
  const urlById = new Map<string, string>();
  const anchorRe = /href="(\/p\/[^"]*?\/V_([A-Z0-9]+))"/g;
  let anchor: RegExpExecArray | null;
  while ((anchor = anchorRe.exec(html)) !== null) {
    if (!urlById.has(anchor[2])) urlById.set(anchor[2], anchor[1]);
  }

  const products: BrowseProduct[] = [];
  const seen = new Set<string>();
  for (const entry of details) {
    if (!entry || typeof entry.name !== "string" || !entry.name) continue;
    if (typeof entry.price !== "number" || entry.price <= 0) continue;
    const imgFile =
      typeof entry.img === "string"
        ? (entry.img.split("/").pop() ?? "").replace(/\.\w+$/, "")
        : "";
    const productKey = imgFile || entry.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    if (seen.has(productKey)) continue;
    seen.add(productKey);
    const path = imgFile ? urlById.get(imgFile) : undefined;
    products.push({
      // Carter's is a first-party brand store: prefix the brand so
      // grouping identity carries it (as with UCP first-party stores).
      title: entry.name.toLowerCase().startsWith("carter")
        ? entry.name
        : `Carter's ${entry.name}`,
      price: entry.price,
      url: path ? `https://www.carters.com${path}` : null,
      imageUrl: typeof entry.img === "string" ? entry.img : null,
      productKey,
    });
    if (products.length >= MAX_PRODUCTS_PER_STORE) break;
  }
  return products;
}

/* ---------------- Mattress Firm: server-rendered product cards ------ */

function parseMattressFirm(html: string): BrowseProduct[] {
  const products: BrowseProduct[] = [];
  const cardRe =
    /<a href="(https:\/\/www\.mattressfirm\.com\/[^"]+?\.p)(?:\?[^"]*)?" class="ProductCard_link[^"]*">\s*<header class="[^"]*ProductCard_productName[^"]*">([^<]+)<\/header>/g;
  let match: RegExpExecArray | null;
  while ((match = cardRe.exec(html)) !== null) {
    const [, url, rawName] = match;
    // This card's segment ends where the next card's name begins, so a
    // card without a price can never borrow the next card's figure.
    const rest = html.slice(match.index + match[0].length);
    const nextCard = rest.indexOf("ProductCard_productName");
    const segment = nextCard >= 0 ? rest.slice(0, nextCard) : rest.slice(0, 6000);
    const priceBlock = segment.indexOf('data-testid="plp-product-price"');
    if (priceBlock < 0) continue;
    const block = segment.slice(priceBlock, priceBlock + 800);
    const sale = block.match(/Sale price \$([0-9,]+\.[0-9]{2})/);
    const regular = block.match(/Original price \$([0-9,]+\.[0-9]{2})/);
    const priceRaw = (sale ?? regular)?.[1];
    if (!priceRaw) continue;
    const price = Number.parseFloat(priceRaw.replace(/,/g, ""));
    if (!Number.isFinite(price) || price <= 0) continue;
    const ratingMatch = segment.match(
      /aria-label="([0-9]+(?:\.[0-9]+)?) star and [0-9]+ reviews"/,
    );
    products.push({
      title: decodeEntities(rawName),
      price,
      url,
      imageUrl: null,
      productKey:
        url.split("/").pop()?.replace(/\.p$/, "") ??
        rawName.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      rating: ratingMatch ? Number.parseFloat(ratingMatch[1]) : null,
    });
    if (products.length >= MAX_PRODUCTS_PER_STORE) break;
  }
  return products;
}

export const BROWSE_STORES: BrowseStore[] = [
  {
    merchant: "Micro Center",
    category: "Electronics",
    brandAliases: ["micro center", "microcenter"],
    keywords: [
      "laptop", "laptops", "notebook", "notebooks", "computer", "computers",
      "desktop", "pc", "monitor", "monitors", "graphics card", "gpu",
      "motherboard", "processor", "ssd", "hard drive", "printer",
      "printers", "tablet", "tablets", "keyboard", "mouse", "router",
    ],
    termsUrl:
      "https://www.microcenter.com/site/customer-support/terms-conditions-site.aspx",
    searchUrl: (query) =>
      `https://www.microcenter.com/search/search_results.aspx?Ntt=${encodeURIComponent(query)}`,
    parse: parseMicroCenter,
  },
  {
    merchant: "Harbor Freight",
    category: "Tools",
    brandAliases: ["harbor freight"],
    keywords: [
      "drill", "drills", "driver", "saw", "saws", "wrench", "wrenches",
      "socket", "tool", "tools", "toolbox", "compressor", "generator",
      "grinder", "sander", "jack", "power tools", "air tools",
    ],
    termsUrl: "https://www.harborfreight.com/terms-and-conditions",
    searchUrl: (query) =>
      `https://www.harborfreight.com/search?q=${encodeURIComponent(query)}`,
    parse: parseHarborFreight,
  },
  {
    merchant: "Carter's",
    category: "Baby & Kids",
    brandAliases: ["carter's", "carters", "carter"],
    keywords: [
      "bodysuit", "bodysuits", "onesie", "onesies", "baby clothes",
      "baby clothing", "toddler", "kids clothes", "baby pajamas",
      "newborn",
    ],
    termsUrl: "https://www.carters.com/disclaimer.html",
    searchUrl: (query) =>
      `https://www.carters.com/search?q=${encodeURIComponent(query)}`,
    parse: parseCarters,
  },
  {
    merchant: "Mattress Firm",
    category: "Mattresses",
    brandAliases: ["mattress firm"],
    keywords: [
      "mattress", "mattresses", "memory foam", "box spring",
      "adjustable base", "hybrid mattress",
    ],
    termsUrl: "https://www.mattressfirm.com/terms.html",
    searchUrl: (query) =>
      `https://www.mattressfirm.com/search?q=${encodeURIComponent(query)}`,
    parse: parseMattressFirm,
  },
];

/**
 * Route a shopper query to the browsing-route stores whose assortment
 * it matches: a brand mention always routes to that store; otherwise
 * assortment keywords decide. Stores the policy registry does not
 * clear for the browsing route are never selected.
 */
export function selectBrowseStores(query: string): BrowseStore[] {
  if (!browseStoresEnabled()) return [];
  const normalized = ` ${normalizeSearch(query)} `;
  const matches = (phrase: string) => normalized.includes(` ${phrase} `);
  const eligible = BROWSE_STORES.filter((store) => {
    const policy = getMerchantPolicy(store.merchant);
    return (
      policy.status === "browser-permitted-unless-prohibited" &&
      policy.allowedAcquisitionMethods.includes("browser")
    );
  });
  const byBrand = eligible.filter((store) =>
    store.brandAliases.some(matches),
  );
  const byKeyword = eligible.filter(
    (store) =>
      !byBrand.includes(store) && store.keywords.some(matches),
  );
  return [...byBrand, ...byKeyword].slice(0, MAX_BROWSE_STORES_PER_QUERY);
}

/* ------------------------------------------------------------------ */
/* Live search + offer construction                                    */
/* ------------------------------------------------------------------ */

/**
 * Run one store's public search page live for this query and extract
 * its listings. Any failure — fetch, block, challenge, parse — yields
 * an empty list for that store; nothing is estimated or backfilled.
 */
export async function searchBrowseStore(
  store: BrowseStore,
  query: string,
): Promise<BrowseProduct[]> {
  const url = store.searchUrl(query);
  const html = await fetchBrowsePage(url);
  if (!html) return [];
  try {
    return store.parse(html);
  } catch (error) {
    console.warn(
      `[browse-stores] ${store.merchant} parse failed:`,
      String(error),
    );
    return [];
  }
}

/**
 * Build an Offer from one live browsing-route listing. The price is
 * the figure the search page itself displayed; fields the page does
 * not state use the labelled curated/service estimates documented at
 * the top of this file and disclosed again in the provenance note.
 */
export function buildBrowseOffer(
  store: BrowseStore,
  product: BrowseProduct,
  retrievedAt: string,
  searchUrl: string,
): Offer {
  return {
    id: `browse-${store.merchant.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${product.productKey}`,
    merchant: store.merchant,
    seller: store.merchant,
    channel: store.merchant,
    condition: product.condition ?? "New",
    price: product.price,
    shippingCost: 0,
    deliveryDays: SERVICE_DELIVERY_DAYS,
    deliveryBasis: "Sample shipping-service estimate",
    returnWindowDays: CURATED_RETURN_WINDOW_DAYS,
    returnCost: "buyer-paid",
    returnPolicySource: "Curated retailer-policy sample",
    warrantyMonths: 0,
    sellerRating: product.rating ?? 0,
    sampleListingLabel: `Live ${store.merchant} listing ${product.productKey}`,
    provenance: {
      sourceMerchant: store.merchant,
      acquisitionMethod: "browse",
      sourceUrl: product.url ?? searchUrl,
      retrievedAt,
      policyStatus: "browser-permitted-unless-prohibited",
      policyNote:
        `Live price retrieved ${retrievedAt} from ${store.merchant}'s public search-results ` +
        `page (${searchUrl}) — a single page fetch with a self-identifying user agent, no ` +
        `login, no checkout action. Policy basis: ${store.merchant}'s terms (${store.termsUrl}, ` +
        `read in full Nov 1, 2026) contain no prohibition on automated access; under this ` +
        `app's prohibition-based policy gate, policy silence permits the browsing route, and ` +
        `any active block or challenge stops it — none was encountered for this retrieval. ` +
        `The price is the figure the page itself displayed for this listing. The search page ` +
        `did not state a shipping charge (shipping is set by the merchant at checkout and is ` +
        `not included in the total), a delivery estimate (a ${SERVICE_DELIVERY_DAYS}-day ` +
        `standard ground service estimate is used for scoring), return terms (a conservative ` +
        `curated ${CURATED_RETURN_WINDOW_DAYS}-day buyer-paid pattern is shown, not the ` +
        `merchant's stated policy), or a warranty period` +
        (product.rating != null
          ? `. The rating field carries the product rating the page displayed for this ` +
            `first-party listing. `
          : `. `) +
        `Nothing here is stored: the price was fetched in this request.`,
    },
  };
}
