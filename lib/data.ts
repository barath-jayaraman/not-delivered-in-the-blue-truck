import type { Product } from "./types";

/**
 * KNOWN-PRODUCT PRESENTATION METADATA — names, brands, models,
 * categories, and search aliases for products the app has photos and
 * curated presentation for. This module carries NO offers, NO listings,
 * and NO prices, by design (Barath's rule, Oct 31, 2026): every price the
 * app displays is fetched live — from the eBay Buy Browse API and a
 * Walmart search-page fetch — in the very request that displays it
 * (lib/live-search.ts). Nothing here can be shown to a shopper as a
 * price, and no comparison is ever built from stored data.
 *
 * The metadata serves two honest purposes: resolving a shopper's pick of
 * a known product into the live search phrase for that exact model, and
 * the stored product photos keyed by id (lib/images.ts).
 */

function product(
  id: string,
  brand: string,
  model: string,
  category: string,
  keywords: string[],
): Product {
  return { id, brand, model, name: `${brand} ${model}`, category, keywords };
}

export const PRODUCTS: Product[] = [
  product("bose-qc-ultra-2", "Bose", "QuietComfort Ultra Headphones (2nd Gen)", "Headphones", [
    "bose headphones",
    "bose qc ultra",
    "bose headphones ultra two",
    "bose quietcomfort ultra 2",
    "quietcomfort ultra",
    "ultra two",
    "ultra 2",
    "noise cancelling headphones",
  ]),
  product("bose-qc-headphones", "Bose", "QuietComfort Headphones", "Headphones", [
    "bose headphones",
    "bose quietcomfort",
    "quietcomfort headphones",
    "noise cancelling headphones",
  ]),
  product("sony-xm6", "Sony", "WH-1000XM6 Wireless Headphones", "Headphones", [
    "sony headphones",
    "wh-1000xm6",
    "xm6",
    "noise cancelling headphones",
    "wireless headphones",
  ]),
  product("nike-pegasus-41", "Nike", "Pegasus 41 Running Shoes", "Running shoes", [
    "nike running shoes",
    "pegasus 41",
    "running shoes",
    "running shoe",
  ]),
  product("adidas-ultraboost-5", "Adidas", "Ultraboost 5 Running Shoes", "Running shoes", [
    "adidas running shoes",
    "ultraboost 5",
    "running shoes",
    "running shoe",
  ]),
  product("samsung-u8000f-55", "Samsung", "55-inch Crystal UHD U8000F TV", "TVs", [
    "samsung tv",
    "55 inch tv",
    "55-inch tv",
    "4k tv",
    "crystal uhd",
    "u8000f",
  ]),
  product("lg-c5-55", "LG", "55-inch OLED evo C5 TV", "TVs", [
    "lg tv",
    "55 inch tv",
    "55-inch tv",
    "oled tv",
    "evo c5",
    "4k tv",
  ]),
  product("roborock-s8", "Roborock", "S8 Robot Vacuum", "Robot vacuums", [
    "roborock s8",
    "robot vacuum",
    "robot vacuums",
    "vacuum",
  ]),
  product("breville-barista-express-impress", "Breville", "Barista Express Impress Espresso Machine", "Coffee makers", [
    "breville espresso",
    "barista express impress",
    "coffee maker",
    "espresso machine",
    "coffee machine",
  ]),
];

export function normalizeSearch(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP_WORDS = new Set(["the", "a", "an", "for", "with", "in", "on", "by"]);

function searchableText(product: Product): string {
  return normalizeSearch(
    [product.name, product.brand, product.model, product.category, ...product.keywords].join(" "),
  );
}

/** Look up known-product metadata by id; null for anything else. */
export function getProductById(productId: string): Product | null {
  return PRODUCTS.find((product) => product.id === productId) ?? null;
}

/**
 * Resolve free text to the best-matching known product's metadata (used
 * to turn a shopper's words into the live search phrase for an exact
 * model). Matching only; the result carries no prices or offers.
 */
export function findProduct(query: string): Product | null {
  const normalizedQuery = normalizeSearch(query);
  if (!normalizedQuery) return null;
  const queryTokens = normalizedQuery
    .split(" ")
    .filter((token) => token && !STOP_WORDS.has(token));
  if (queryTokens.length === 0) return null;

  let best: { product: Product; relevance: number } | null = null;
  for (const product of PRODUCTS) {
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
    const minimumMatched =
      queryTokens.length <= 2 ? queryTokens.length : Math.ceil(queryTokens.length * 0.6);
    if (matchedTokens.length < minimumMatched) relevance = 0;
    if (relevance > 0 && (!best || relevance > best.relevance)) {
      best = { product, relevance };
    }
  }
  return best?.product ?? null;
}
