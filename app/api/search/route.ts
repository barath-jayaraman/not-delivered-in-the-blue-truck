import { NextResponse } from "next/server";
import { searchProducts, summarizeProduct } from "@/lib/data";
import { getPolicyGateEntries } from "@/lib/adapters";
import type { SearchResponse } from "@/lib/types";

/**
 * GET /api/search?q=...
 *
 * Prototype search over the local sample catalog only. Future live search
 * must go through policy-approved official merchant adapters in
 * lib/adapters.ts; this route must never scrape retailer websites.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q")?.trim() ?? "";
  if (!query) {
    return NextResponse.json({ error: "Enter a product to search for." }, { status: 400 });
  }

  const ranked = searchProducts(query);
  const response: SearchResponse = {
    query,
    products: ranked.map(summarizeProduct),
    dataSource: "sample",
    policyGate: getPolicyGateEntries(),
  };
  return NextResponse.json(response);
}
