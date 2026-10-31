import { NextResponse } from "next/server";
import { getPolicyGateEntries } from "@/lib/adapters";
import { getMetaModelConfig, interpretQuery } from "@/lib/agent";
import { searchLiveProducts } from "@/lib/live-search";
import type { SearchResponse } from "@/lib/types";

/**
 * GET /api/search?q=...
 *
 * EVERY query goes LIVE, at request time (Barath's rule, Oct 31, 2026 —
 * no stored listings or prices anywhere). The search runs over the two
 * sources the policy gate allows — the eBay Buy Browse API and one
 * Walmart search-results page fetch under the Agentic Access Terms —
 * via lib/live-search.ts. Listings are grouped by model identity
 * (different models never merge), flagged dataSource "live", and carry
 * per-listing provenance with this request's retrieval time. When the
 * live sources find nothing (or are unavailable), the honest answer is
 * an empty product list — never stored or sample data.
 *
 * When META_MODEL_API_KEY is configured server-side, Muse Spark first
 * interprets the shopper's raw query (lib/agent.ts) and its canonical
 * phrase drives the live search. Muse interprets only; it never
 * supplies products, prices, or offers.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q")?.trim() ?? "";
  if (!query) {
    return NextResponse.json({ error: "Enter a product to search for." }, { status: 400 });
  }

  let liveQuery = query;
  if (getMetaModelConfig().liveConfigured) {
    const interpretation = await interpretQuery(query);
    if (interpretation?.canonicalQuery.trim()) {
      liveQuery = interpretation.canonicalQuery.trim();
    }
  }

  let summaries: SearchResponse["products"] = [];
  try {
    ({ summaries } = await searchLiveProducts(liveQuery));
  } catch {
    // Live search degrades silently to the honest empty state.
    summaries = [];
  }

  const response: SearchResponse = {
    query,
    products: summaries,
    dataSource: "live",
    policyGate: getPolicyGateEntries(),
  };
  return NextResponse.json(response);
}
