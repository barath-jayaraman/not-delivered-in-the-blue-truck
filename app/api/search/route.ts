import { NextResponse } from "next/server";
import { getPolicyGateEntries } from "@/lib/adapters";
import { getMetaModelConfig, interpretQuery } from "@/lib/agent";
import { normalizeSearch } from "@/lib/data";
import { searchLiveProducts } from "@/lib/live-search";
import type { SearchResponse } from "@/lib/types";

/** The live fan-out is deadline-bounded per store; allow ample window. */
export const maxDuration = 60;

/**
 * How long Muse's query interpretation may take before /api/search
 * stops waiting for it and serves the raw-query live search instead
 * (Nov 2, 2026 — search-speed work). Interpretation used to run
 * serially BEFORE the search, adding its full latency (measured
 * ~2–4s) to every request. Now the live search on the shopper's raw
 * query starts immediately and interpretation runs alongside it; when
 * Muse answers inside this budget with a genuinely different
 * canonical phrase, the search re-runs on that phrase (the first pass
 * has warmed the stores' handshake state, so the re-run is mostly
 * single live catalog calls). When it does not answer in time — or
 * its phrase matches the raw query — the raw results stand, exactly
 * the fallback a failed interpretation has always produced.
 */
const SEARCH_INTERPRET_BUDGET_MS = 2_500;

/**
 * GET /api/search?q=...
 *
 * EVERY query goes LIVE, at request time (Barath's rule, Oct 31, 2026 —
 * no stored listings or prices anywhere). The search runs over the
 * sources the policy gate allows — the eBay Buy Browse API, a Walmart
 * search-results page fetch under the Agentic Access Terms, each
 * assortment-matching UCP store's published catalog, and each
 * assortment-matching browsing-route store's search-results page
 * (terms silent on automated access; prohibition-based gate) —
 * via lib/live-search.ts. Listings are grouped by model identity
 * (different models never merge), flagged dataSource "live", and carry
 * per-listing provenance with this request's retrieval time. When the
 * live sources find nothing (or are unavailable), the honest answer is
 * an empty product list — never stored or sample data.
 *
 * When META_MODEL_API_KEY is configured server-side, Muse Spark
 * interprets the shopper's raw query (lib/agent.ts) CONCURRENTLY with
 * the live search (see SEARCH_INTERPRET_BUDGET_MS above) and its
 * canonical phrase drives the search when it lands in time. Muse
 * interprets only; it never supplies products, prices, or offers.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q")?.trim() ?? "";
  if (!query) {
    return NextResponse.json({ error: "Enter a product to search for." }, { status: 400 });
  }

  // The live search on the raw query starts NOW — interpretation no
  // longer gates it. The no-op catch only guards against an unhandled
  // rejection if the interpreted path below throws first; the promise
  // itself is still awaited (and its rejection handled) where used.
  const rawSearch = searchLiveProducts(query);
  rawSearch.catch(() => {});

  let summaries: SearchResponse["products"] | null = null;
  if (getMetaModelConfig().liveConfigured) {
    const interpretation = await interpretQuery(
      query,
      SEARCH_INTERPRET_BUDGET_MS,
    );
    const canonical = interpretation?.canonicalQuery.trim();
    if (canonical && normalizeSearch(canonical) !== normalizeSearch(query)) {
      try {
        ({ summaries } = await searchLiveProducts(canonical));
      } catch {
        // Interpreted search failed; fall through to the raw results.
        summaries = null;
      }
    }
  }
  if (summaries === null) {
    try {
      ({ summaries } = await rawSearch);
    } catch {
      // Live search degrades silently to the honest empty state.
      summaries = [];
    }
  }

  const response: SearchResponse = {
    query,
    products: summaries,
    dataSource: "live",
    policyGate: getPolicyGateEntries(),
  };
  return NextResponse.json(response);
}
