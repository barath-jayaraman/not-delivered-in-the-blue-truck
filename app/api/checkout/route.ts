import { NextResponse } from "next/server";
import {
  checkoutStoreFor,
  createStoreCartLink,
  type CheckoutItemInput,
} from "@/lib/adapters/ucp-checkout";

/** Live UCP cart calls can take tens of seconds. */
export const maxDuration = 60;

/**
 * POST /api/checkout — store checkout ONLY (Barath, Nov 3, 2026).
 *
 * For the hackathon release there is no in-app checkout and no
 * access code: this site collects no buyer or payment information.
 * The single action, "cartlink", asks the store to pre-load a cart
 * with the buyer's chosen items (item ids and quantities ONLY — no
 * personal details are collected or sent) and returns the store's
 * own continuation URL, which lands the buyer on the store's site
 * with the items already in its cart, to enter details and pay
 * there. The earlier in-app checkout (buyer details taken here,
 * payment on the store's hosted step) was removed for this release
 * and may return in the full release.
 *
 * This app never receives a card number. eBay, Walmart, and the
 * browsing-route stores are not served here at all — they check out
 * on their own sites via the listing link.
 */

function cleanString(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body." },
      { status: 400 },
    );
  }

  const merchant = cleanString(body.merchant, 80);
  const store = checkoutStoreFor(merchant);
  if (!store) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "That store does not offer a pre-loaded cart here — use the link to buy it on the store's own site.",
      },
      { status: 400 },
    );
  }
  const fallbackUrl = `https://${store.profileHost}/`;

  if (body.action !== "cartlink") {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Checkout happens at the store — request a pre-loaded cart link instead.",
        fallbackUrl,
      },
      { status: 400 },
    );
  }

  /* ----- validate the items payload ----- */
  const rawItems = Array.isArray(body.items) ? body.items : [];
  const byItem = new Map<string, number>();
  for (const raw of rawItems.slice(0, 10)) {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const itemId = cleanString(entry.itemId, 200);
    const quantity =
      typeof entry.quantity === "number" && Number.isFinite(entry.quantity)
        ? Math.max(1, Math.min(10, Math.round(entry.quantity)))
        : 0;
    if (!itemId || quantity === 0) continue;
    byItem.set(itemId, Math.min(10, (byItem.get(itemId) ?? 0) + quantity));
  }
  const items: CheckoutItemInput[] = [...byItem.entries()].map(
    ([itemId, quantity]) => ({ itemId, quantity }),
  );
  if (items.length === 0) {
    return NextResponse.json(
      { ok: false, error: "No purchasable items were supplied.", fallbackUrl },
      { status: 400 },
    );
  }

  /* ----- pre-loaded cart at the store; the buyer finishes there ----- */
  const link = await createStoreCartLink(store, items);
  if (!link.ok) {
    return NextResponse.json(
      { ok: false, error: link.error, fallbackUrl },
      { status: 502 },
    );
  }
  return NextResponse.json({
    ok: true,
    continueUrl: link.continueUrl,
    session: link.session,
  });
}
