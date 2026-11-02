import { NextResponse } from "next/server";
import {
  checkoutStoreFor,
  createStoreCartLink,
  createStoreCheckout,
  getStoreCheckoutStatus,
  type CheckoutAddressInput,
  type CheckoutBuyerInput,
  type CheckoutItemInput,
} from "@/lib/adapters/ucp-checkout";
import type { StoreOrder } from "@/lib/types";

/** Live UCP checkout calls can take tens of seconds. */
export const maxDuration = 60;

/**
 * POST /api/checkout — real, CODE-GATED checkout at UCP stores.
 *
 * Barath's rule (Nov 2, 2026): in-app checkout exists, but completing
 * it requires an access code, so random visitors cannot buy. The code
 * is validated HERE, server-side, against the CHECKOUT_ACCESS_CODE
 * environment variable; it is never shipped to the browser. When the
 * variable is unset the gate fails CLOSED (503) — a deployment without
 * a configured code cannot check anyone out.
 *
 * Actions:
 * - "start": { accessCode, merchant, items: [{ itemId, quantity }],
 *   buyer: { name, email, phone }, address: { street, extended?, city,
 *   region, postal } } → creates a live checkout session at the store
 *   (lib/adapters/ucp-checkout.ts) and returns the store's own session
 *   summary, including its hosted payment continuation. Guest details
 *   pass through to the store in this request and are stored nowhere.
 * - "status": { accessCode, merchant, checkoutId, buyerEmail } →
 *   re-reads the session from the store; returns a StoreOrder ONLY
 *   when the store itself returns an order for the session.
 * - "cartlink": { accessCode, merchant, items } → Path B: creates an
 *   items-only session at the store (NO buyer details are collected
 *   or sent) and returns the store's own continuation URL, which
 *   lands the buyer on the store's site with the items already in
 *   its cart to enter details and pay there. Same code gate.
 *
 * This app never receives a card number: payment is taken by the
 * store's own declared payment handlers on the store's continuation.
 * eBay, Walmart, and the browsing-route stores are not served here at
 * all — they check out on their own sites via the listing link.
 */

function gateError(): NextResponse | null {
  const expected = process.env.CHECKOUT_ACCESS_CODE?.trim();
  if (!expected) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Checkout is invite-only and is not configured on this deployment yet.",
      },
      { status: 503 },
    );
  }
  return null;
}

function codeAccepted(candidate: unknown): boolean {
  const expected = process.env.CHECKOUT_ACCESS_CODE?.trim();
  return (
    typeof expected === "string" &&
    expected.length > 0 &&
    typeof candidate === "string" &&
    candidate.length > 0 &&
    candidate === expected
  );
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const POSTAL_RE = /^\d{5}(-\d{4})?$/;
const REGION_RE = /^[A-Za-z]{2}$/;

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

  const unconfigured = gateError();
  if (unconfigured) return unconfigured;
  if (!codeAccepted(body.accessCode)) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Checkout is currently invite-only. Enter a valid access code to check out.",
      },
      { status: 403 },
    );
  }

  const merchant = cleanString(body.merchant, 80);
  const store = checkoutStoreFor(merchant);
  if (!store) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "That store does not check out inside this app — use the link to buy it on the store's own site.",
      },
      { status: 400 },
    );
  }
  const fallbackUrl = `https://${store.profileHost}/`;

  if (body.action === "status") {
    const checkoutId = cleanString(body.checkoutId, 300);
    const buyerEmail = cleanString(body.buyerEmail, 200);
    if (!checkoutId || !EMAIL_RE.test(buyerEmail)) {
      return NextResponse.json(
        { ok: false, error: "That checkout session cannot be re-read.", fallbackUrl },
        { status: 400 },
      );
    }
    const result = await getStoreCheckoutStatus(store, checkoutId);
    if (!result.ok) {
      if ("notFound" in result && result.notFound) {
        /* The store answered: its API cannot re-read this session
         * (Shopify-backed stores behave this way for live sessions).
         * That is neither a confirmation nor an outage — say exactly
         * that, and never invent an order. */
        return NextResponse.json({
          ok: true,
          session: null,
          order: null,
          note:
            `${store.merchant} doesn't provide a live status read for checkout sessions, ` +
            `so this app can't confirm the order here. If you completed payment on ` +
            `${store.merchant}'s page, ${store.merchant} emails your order confirmation ` +
            `to the guest email you used.`,
        });
      }
      return NextResponse.json(
        { ok: false, error: result.error, fallbackUrl },
        { status: 502 },
      );
    }
    let order: StoreOrder | null = null;
    if (result.order) {
      order = {
        merchant: store.merchant,
        checkoutId,
        orderId: result.order.id,
        orderUrl: result.order.url,
        status: result.order.status ?? result.session.status ?? null,
        items: result.session.items,
        totals: result.session.totals,
        currency: result.session.currency,
        buyerEmail,
        confirmedAt: new Date().toISOString(),
      };
    }
    return NextResponse.json({ ok: true, session: result.session, order });
  }

  if (body.action !== "start" && body.action !== "cartlink") {
    return NextResponse.json(
      { ok: false, error: "Unknown checkout action.", fallbackUrl },
      { status: 400 },
    );
  }

  /* ----- validate the items payload (shared by start + cartlink) ----- */
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

  /* ----- Path B: pre-loaded cart at the store, buyer finishes there ----- */
  if (body.action === "cartlink") {
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

  const rawBuyer = (body.buyer ?? {}) as Record<string, unknown>;
  const fullName = cleanString(rawBuyer.name, 120);
  const email = cleanString(rawBuyer.email, 200);
  const phone = cleanString(rawBuyer.phone, 32);
  const [firstName, ...rest] = fullName.split(/\s+/).filter(Boolean);
  const buyer: CheckoutBuyerInput = {
    firstName: firstName ?? "",
    lastName: rest.join(" ") || firstName || "",
    email,
    phone,
  };
  if (!buyer.firstName || !EMAIL_RE.test(email) || phone.length < 5) {
    return NextResponse.json(
      {
        ok: false,
        error: "Enter the guest's name, a valid email, and a phone number.",
        fallbackUrl,
      },
      { status: 400 },
    );
  }

  const rawAddress = (body.address ?? {}) as Record<string, unknown>;
  const address: CheckoutAddressInput = {
    street: cleanString(rawAddress.street, 200),
    extended: cleanString(rawAddress.extended, 200) || undefined,
    city: cleanString(rawAddress.city, 100),
    region: cleanString(rawAddress.region, 2).toUpperCase(),
    postal: cleanString(rawAddress.postal, 10),
    country: "US",
  };
  if (
    !address.street ||
    !address.city ||
    !REGION_RE.test(address.region) ||
    !POSTAL_RE.test(address.postal)
  ) {
    return NextResponse.json(
      {
        ok: false,
        error: "Enter a complete US delivery address (street, city, state, ZIP).",
        fallbackUrl,
      },
      { status: 400 },
    );
  }

  const result = await createStoreCheckout(store, items, buyer, address);
  if (!result.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: result.error,
        storeMessages: result.storeMessages,
        fallbackUrl,
      },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true, session: result.session });
}
