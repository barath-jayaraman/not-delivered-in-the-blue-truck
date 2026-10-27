import type { Merchant, Offer, Product, ProductSummary } from "./types";

/**
 * SAMPLE CATALOG — local prototype data only.
 *
 * Merchants are intentionally limited to eBay and Best Buy. These records do
 * not come from live APIs, are not live prices, and must always be displayed
 * as sample data. Future live adapters must return this same Product/Offer
 * shape only after the applicable retailer's API and automation terms pass
 * the policy gate documented in README.md and lib/adapters.ts.
 */

type OfferSpec = [
  merchant: Merchant,
  seller: string,
  condition: Offer["condition"],
  price: number,
  shippingCost: number,
  deliveryDays: number,
  returnWindowDays: number,
  returnCost: Offer["returnCost"],
  warrantyMonths: number,
  sellerRating: number,
];

function makeOffers(productId: string, specs: OfferSpec[]): Offer[] {
  return specs.map((spec, index) => ({
    id: `${productId}-offer-${index + 1}`,
    merchant: spec[0],
    seller: spec[1],
    channel: spec[0],
    condition: spec[2],
    price: spec[3],
    shippingCost: spec[4],
    deliveryDays: spec[5],
    deliveryBasis:
      spec[0] === "Best Buy"
        ? "Sample shipping-service estimate"
        : "Sample seller delivery estimate",
    returnWindowDays: spec[6],
    returnCost: spec[7],
    returnPolicySource:
      spec[0] === "Best Buy"
        ? "Curated retailer-policy sample"
        : "Sample seller return terms",
    warrantyMonths: spec[8],
    sellerRating: spec[9],
    sampleListingLabel: `Sample ${spec[0]} listing ${index + 1}`,
    provenance: {
      sourceMerchant: spec[0],
      acquisitionMethod: "sample",
      sourceUrl: null,
      retrievedAt: null,
      policyStatus: "sample-only-api-route",
      policyNote:
        "Local sample record. Production route for this merchant is official API only; no scraping or browser purchasing.",
    },
  }));
}

function product(
  id: string,
  brand: string,
  model: string,
  category: string,
  keywords: string[],
  specs: OfferSpec[],
): Product {
  return {
    id,
    brand,
    model,
    name: `${brand} ${model}`,
    category,
    keywords,
    offers: makeOffers(id, specs),
  };
}

export const PRODUCTS: Product[] = [
  product(
    "bose-qc-ultra-2",
    "Bose",
    "QuietComfort Ultra Headphones (2nd Gen)",
    "Headphones",
    [
      "bose headphones",
      "bose qc ultra",
      "bose headphones ultra two",
      "bose quietcomfort ultra 2",
      "quietcomfort ultra",
      "ultra two",
      "ultra 2",
      "noise cancelling headphones",
    ],
    [
      ["Best Buy", "Best Buy", "New", 379.99, 0, 2, 15, "free", 12, 4.8],
      ["eBay", "Audio Empire (eBay Top Rated Plus)", "New", 339.0, 0, 3, 60, "free", 12, 4.9],
      ["Best Buy", "Best Buy", "Open-box", 329.99, 0, 3, 15, "free", 12, 4.8],
      ["eBay", "Sound Deals Direct (eBay)", "New", 319.95, 9.99, 6, 30, "buyer-paid", 0, 4.5],
      ["eBay", "Bose Certified Refurbished (eBay)", "Certified refurbished", 299.0, 0, 5, 30, "free", 24, 4.8],
    ],
  ),
  product(
    "bose-qc-headphones",
    "Bose",
    "QuietComfort Headphones",
    "Headphones",
    ["bose headphones", "bose quietcomfort", "quietcomfort headphones", "noise cancelling headphones"],
    [
      ["Best Buy", "Best Buy", "New", 249.99, 0, 2, 15, "free", 12, 4.8],
      ["eBay", "Audio Empire (eBay Top Rated Plus)", "New", 219.0, 0, 4, 60, "free", 12, 4.9],
      ["Best Buy", "Best Buy", "Open-box", 199.99, 0, 3, 15, "free", 12, 4.8],
      ["eBay", "Everyday Audio (eBay)", "New", 189.95, 7.99, 6, 30, "buyer-paid", 0, 4.4],
      ["eBay", "Bose Certified Refurbished (eBay)", "Certified refurbished", 174.0, 0, 5, 30, "free", 24, 4.8],
    ],
  ),
  product(
    "sony-xm6",
    "Sony",
    "WH-1000XM6 Wireless Headphones",
    "Headphones",
    ["sony headphones", "wh-1000xm6", "xm6", "noise cancelling headphones", "wireless headphones"],
    [
      ["Best Buy", "Best Buy", "New", 399.99, 0, 2, 15, "free", 12, 4.8],
      ["eBay", "Audio Empire (eBay Top Rated Plus)", "New", 359.0, 0, 3, 60, "free", 12, 4.9],
      ["Best Buy", "Best Buy", "Open-box", 339.99, 0, 4, 15, "free", 12, 4.8],
      ["eBay", "Headphone House (eBay)", "New", 329.0, 12.0, 7, 14, "buyer-paid", 0, 4.3],
      ["eBay", "Renewed Sound (eBay)", "Refurbished", 289.0, 0, 5, 30, "free", 12, 4.6],
    ],
  ),
  product(
    "nike-pegasus-41",
    "Nike",
    "Pegasus 41 Running Shoes",
    "Running shoes",
    ["nike running shoes", "pegasus 41", "running shoes", "running shoe"],
    [
      ["Best Buy", "Best Buy", "New", 139.99, 0, 3, 15, "free", 0, 4.6],
      ["eBay", "Run Fast Store (eBay Top Rated Plus)", "New", 119.0, 0, 4, 60, "free", 0, 4.9],
      ["eBay", "Stride Supply (eBay)", "New", 109.95, 6.99, 5, 30, "free", 0, 4.7],
      ["Best Buy", "Best Buy", "Open-box", 104.99, 0, 4, 15, "free", 0, 4.6],
      ["eBay", "Last Pair Outlet (eBay)", "New", 94.99, 8.5, 8, 0, "final-sale", 0, 4.1],
    ],
  ),
  product(
    "adidas-ultraboost-5",
    "Adidas",
    "Ultraboost 5 Running Shoes",
    "Running shoes",
    ["adidas running shoes", "ultraboost 5", "running shoes", "running shoe"],
    [
      ["Best Buy", "Best Buy", "New", 189.99, 0, 3, 15, "free", 0, 4.6],
      ["eBay", "Run Fast Store (eBay Top Rated Plus)", "New", 164.0, 0, 4, 60, "free", 0, 4.9],
      ["Best Buy", "Best Buy", "Open-box", 149.99, 0, 4, 15, "free", 0, 4.6],
      ["eBay", "Sole Market (eBay)", "New", 139.95, 9.99, 7, 30, "buyer-paid", 0, 4.4],
      ["eBay", "Renewed Kicks (eBay)", "Refurbished", 119.0, 0, 6, 30, "free", 0, 4.5],
    ],
  ),
  product(
    "samsung-u8000f-55",
    "Samsung",
    "55-inch Crystal UHD U8000F TV",
    "TVs",
    ["samsung tv", "55 inch tv", "55-inch tv", "4k tv", "crystal uhd", "u8000f"],
    [
      ["Best Buy", "Best Buy", "New", 429.99, 0, 2, 15, "free", 12, 4.8],
      ["eBay", "Home Theater Hub (eBay Top Rated Plus)", "New", 399.0, 0, 4, 60, "free", 12, 4.9],
      ["Best Buy", "Best Buy", "Open-box", 359.99, 0, 3, 15, "free", 12, 4.8],
      ["eBay", "Screen Deals (eBay)", "New", 379.0, 49.0, 6, 30, "buyer-paid", 24, 4.7],
      ["eBay", "Samsung Certified Refurbished (eBay)", "Certified refurbished", 339.0, 0, 5, 30, "free", 24, 4.8],
    ],
  ),
  product(
    "lg-c5-55",
    "LG",
    "55-inch OLED evo C5 TV",
    "TVs",
    ["lg tv", "55 inch tv", "55-inch tv", "oled tv", "evo c5", "4k tv"],
    [
      ["Best Buy", "Best Buy", "New", 1099.99, 0, 2, 15, "free", 12, 4.8],
      ["eBay", "Home Theater Hub (eBay Top Rated Plus)", "New", 999.0, 0, 4, 60, "free", 12, 4.9],
      ["Best Buy", "Best Buy", "Open-box", 899.99, 0, 3, 15, "free", 12, 4.8],
      ["eBay", "Panel Pros (eBay)", "New", 949.0, 79.0, 7, 30, "buyer-paid", 12, 4.5],
      ["eBay", "LG Certified Refurbished (eBay)", "Certified refurbished", 849.0, 0, 6, 30, "free", 24, 4.7],
    ],
  ),
  product(
    "roborock-s8",
    "Roborock",
    "S8 Robot Vacuum",
    "Robot vacuums",
    ["roborock s8", "robot vacuum", "robot vacuums", "vacuum"],
    [
      ["Best Buy", "Best Buy", "New", 459.99, 0, 2, 15, "free", 12, 4.8],
      ["eBay", "Clean Home Store (eBay Top Rated Plus)", "New", 399.0, 0, 4, 60, "free", 12, 4.9],
      ["Best Buy", "Best Buy", "Open-box", 369.99, 0, 3, 15, "free", 12, 4.8],
      ["eBay", "Gadget Grotto (eBay)", "New", 349.99, 15.99, 8, 14, "buyer-paid", 0, 4.1],
      ["eBay", "Roborock Certified Refurbished (eBay)", "Certified refurbished", 319.0, 0, 5, 30, "free", 24, 4.8],
    ],
  ),
  product(
    "breville-barista-express-impress",
    "Breville",
    "Barista Express Impress Espresso Machine",
    "Coffee makers",
    ["breville espresso", "barista express impress", "coffee maker", "espresso machine", "coffee machine"],
    [
      ["Best Buy", "Best Buy", "New", 749.99, 0, 2, 15, "free", 12, 4.8],
      ["eBay", "Kitchen Kings (eBay Top Rated Plus)", "New", 679.0, 0, 5, 60, "free", 12, 4.9],
      ["Best Buy", "Best Buy", "Open-box", 599.99, 0, 3, 15, "free", 12, 4.8],
      ["eBay", "Espresso Outlet (eBay)", "New", 629.0, 24.99, 7, 30, "buyer-paid", 6, 4.4],
      ["eBay", "Breville Certified Refurbished (eBay)", "Certified refurbished", 499.0, 0, 6, 30, "free", 24, 4.8],
    ],
  ),
];

const STOP_WORDS = new Set(["the", "a", "an", "for", "with", "inch"]);

export function normalizeSearch(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function searchableText(product: Product): string {
  return normalizeSearch(
    [product.name, product.brand, product.model, product.category, ...product.keywords].join(" "),
  );
}

export interface RankedProduct {
  product: Product;
  relevance: number;
  exactMatch: boolean;
}

/** Rank products for retail-style search. Broad queries can return models. */
export function rankProducts(query: string): RankedProduct[] {
  const normalizedQuery = normalizeSearch(query);
  if (!normalizedQuery) return [];
  const queryTokens = normalizedQuery
    .split(" ")
    .filter((token) => token && !STOP_WORDS.has(token));
  if (queryTokens.length === 0) return [];

  return PRODUCTS.map((product) => {
    const text = searchableText(product);
    const textTokens = new Set(text.split(" "));
    const exactPhrases = [product.name, ...product.keywords].map(normalizeSearch);
    const exactMatch = exactPhrases.some(
      (phrase) => phrase === normalizedQuery || normalizedQuery.includes(phrase),
    );
    const matchedTokens = queryTokens.filter((token) => textTokens.has(token));
    let relevance = matchedTokens.length * 10;
    if (exactMatch) relevance += 100;
    if (text.includes(normalizedQuery)) relevance += 35;
    if (product.brand.toLowerCase() === queryTokens[0]) relevance += 5;

    // Multi-word searches need enough overlap to avoid incidental matches.
    const minimumMatched =
      queryTokens.length <= 2 ? queryTokens.length : Math.ceil(queryTokens.length * 0.6);
    return {
      product,
      relevance: matchedTokens.length >= minimumMatched ? relevance : 0,
      exactMatch,
    };
  })
    .filter((entry) => entry.relevance > 0)
    .sort((a, b) => b.relevance - a.relevance || a.product.name.localeCompare(b.product.name));
}

export function searchProducts(query: string): RankedProduct[] {
  return rankProducts(query);
}

export function summarizeProduct(entry: RankedProduct): ProductSummary {
  const { product } = entry;
  const prices = product.offers.map((offer) => offer.price);
  return {
    id: product.id,
    name: product.name,
    brand: product.brand,
    model: product.model,
    category: product.category,
    offerCount: product.offers.length,
    lowestPrice: Math.min(...prices),
    highestPrice: Math.max(...prices),
    fastestDeliveryDays: Math.min(...product.offers.map((offer) => offer.deliveryDays)),
    exactMatch: entry.exactMatch,
    dataSource: "sample",
    sourceMerchants: [...new Set(product.offers.map((offer) => offer.merchant))],
    acquisitionMethod: "sample",
    sourceUrl: null,
    retrievedAt: null,
    policyStatus: "sample-only-api-route",
  };
}

export function getProductById(productId: string): Product | null {
  return PRODUCTS.find((product) => product.id === productId) ?? null;
}

/** Compatibility helper for the decision engine. */
export function findProduct(query: string): Product | null {
  return rankProducts(query)[0]?.product ?? null;
}
