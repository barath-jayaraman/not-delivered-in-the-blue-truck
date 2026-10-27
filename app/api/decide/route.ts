import { NextResponse } from "next/server";
import { decide } from "@/lib/scoring";
import { PRODUCTS } from "@/lib/data";
import type { DecideRequest, Priority } from "@/lib/types";

/**
 * POST /api/decide
 * Body: { productId?: string, query?: string, budget?: number,
 *         needByDays: number, priority: Priority }
 *
 * Prototype: served by the local scoring engine (lib/scoring.ts) over sample
 * data only. Future live data must be supplied by policy-approved official
 * eBay Browse API and Best Buy Products API adapters (lib/adapters.ts). No
 * scraping or browser-automated purchasing belongs behind this route.
 *
 * Muse Spark seam: a future implementation may pass the scored offers and
 * parameter deltas to Muse to generate the explanation. It must operate on
 * our comparison logic and must not train on eBay Content.
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

  const result = decide({ query, productId, budget, needByDays, priority });
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
