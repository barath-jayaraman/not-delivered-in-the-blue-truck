import { NextResponse } from "next/server";
import { decideWithAgent } from "@/lib/decide-live";
import { PRODUCTS } from "@/lib/data";
import type { DecideRequest, Priority } from "@/lib/types";

/**
 * POST /api/decide
 * Body: { productId?: string, query?: string, budget?: number,
 *         needByDays: number, priority: Priority }
 *
 * Prototype: served by the local scoring engine (lib/scoring.ts) over sample
 * data only. Future live data must arrive through the route the policy gate
 * allows per merchant (lib/adapters.ts): Walmart via browsing under its
 * Agentic Access Terms, Best Buy/eBay via their official APIs. Target is
 * authorized-channel only and is never browsed. No scraping or
 * browser-automated purchasing belongs behind this route.
 *
 * Muse Spark: served by lib/decide-live.ts. When META_MODEL_API_KEY is
 * configured server-side, Muse Spark interprets the shopper's query and
 * writes the recommendation explanation via the Meta Model API; scoring
 * stays deterministic and local, live failures fall back silently, and the
 * agent-activity payload reports mode "live" only for steps that actually
 * ran live on this request. Muse must not train on eBay Content.
 */
export async function POST(request: Request) {
  let body: Partial<DecideRequest>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const query = typeof body.query === "string" ? body.query.trim() : "";
  const productId = typeof body.productId === "string" ? body.productId.trim() : "";
  if (!query && !productId) {
    return NextResponse.json(
      { error: "Select a product or tell us what you want to buy." },
      { status: 400 },
    );
  }

  const priority: Priority =
    body.priority === "fastest" || body.priority === "returns"
      ? body.priority
      : "cheapest";
  const needByDays =
    typeof body.needByDays === "number" && body.needByDays > 0
      ? Math.min(30, Math.round(body.needByDays))
      : 7;
  const budget =
    typeof body.budget === "number" && body.budget > 0 ? body.budget : null;

  const result = await decideWithAgent({ query, productId, budget, needByDays, priority });
  if (!result) {
    return NextResponse.json(
      {
        error: "No sample prototype product matches that selection yet.",
        suggestions: PRODUCTS.map((p) => p.name),
      },
      { status: 404 },
    );
  }
  return NextResponse.json(result);
}
