import { NextResponse } from "next/server";
import { searchProducts, summarizeProduct, type RankedProduct } from "@/lib/data";
import { getPolicyGateEntries } from "@/lib/adapters";
import { getMetaModelConfig, interpretQuery } from "@/lib/agent";
import type { SearchResponse } from "@/lib/types";

/**
 * GET /api/search?q=...
 *
 * Prototype search over the local sample catalog only. Future live search
 * must go through policy-approved official merchant adapters in
 * lib/adapters.ts; this route must never scrape retailer websites.
 *
 * When META_MODEL_API_KEY is configured server-side, Muse Spark first
 * interprets the shopper's raw query (lib/agent.ts) and its terms drive the
 * local catalog match — unless the local matcher already found an exact
 * match. Any live failure falls back to the local match, unchanged. Muse
 * interprets only; it never supplies products, prices, or offers.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q")?.trim() ?? "";
  if (!query) {
    return NextResponse.json({ error: "Enter a product to search for." }, { status: 400 });
  }

  let ranked: RankedProduct[] = searchProducts(query);

  if (getMetaModelConfig().liveConfigured && !ranked.some((r) => r.exactMatch)) {
    const interpretation = await interpretQuery(query);
    if (interpretation) {
      const candidates = [
        interpretation.canonicalQuery,
        [interpretation.brand, ...interpretation.modelKeywords]
          .filter(Boolean)
          .join(" "),
        interpretation.modelKeywords.join(" "),
      ];
      for (const candidate of candidates) {
        const trimmed = candidate.trim();
        if (!trimmed) continue;
        const liveRanked = searchProducts(trimmed);
        if (liveRanked.length > 0) {
          ranked = liveRanked;
          break;
        }
      }
    }
  }

  const response: SearchResponse = {
    query,
    products: ranked.map(summarizeProduct),
    dataSource: "sample",
    policyGate: getPolicyGateEntries(),
  };
  return NextResponse.json(response);
}
