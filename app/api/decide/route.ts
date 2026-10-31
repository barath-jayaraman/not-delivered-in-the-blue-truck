import { NextResponse } from "next/server";
import { decideWithAgent } from "@/lib/decide-live";
import { PRODUCTS } from "@/lib/data";
import type { DecideRequest, Priority } from "@/lib/types";

/**
 * POST /api/decide
 * Body: { productId?: string, query?: string, budget?: number,
 *         needByDays: number, priority: Priority }
 *
 * Served by lib/decide-live.ts: EVERY comparison is built from offers
 * fetched live in this request (eBay Buy Browse API + Walmart
 * search-page fetch, per the policy gate in lib/adapters.ts). No stored
 * listings or prices are ever served; when live sources return nothing
 * for the selection, the answer is the honest empty state below. Target
 * is authorized-channel only and is never browsed. No scraping or
 * browser-automated purchasing belongs behind this route.
 *
 * Muse Spark: when META_MODEL_API_KEY is configured server-side, Muse
 * Spark interprets the shopper's query and writes the recommendation
 * explanation via the Meta Model API; scoring stays deterministic and
 * local, live failures fall back silently, and the agent-activity
 * payload reports mode "live" only for steps that actually ran live on
 * this request. Muse must not train on eBay Content.
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
  const liveGroupId =
    typeof body.liveGroupId === "string" ? body.liveGroupId.trim() : "";
  if (!query && !productId && !liveGroupId) {
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

  const result = await decideWithAgent({
    query,
    productId,
    liveGroupId: liveGroupId || undefined,
    budget,
    needByDays,
    priority,
  });
  if (!result) {
    return NextResponse.json(
      {
        error: "No live offers could be gathered for that selection right now.",
        suggestions: PRODUCTS.map((p) => p.name),
      },
      { status: 404 },
    );
  }
  return NextResponse.json(result);
}
