import { getMerchantPolicy } from "../adapters";
import {
  AGENT_PROFILE,
  findUcpStore,
  mcpPost,
  moneyFromMinor,
  readProfileEndpoint,
  type UcpStore,
} from "./ucp";
import type {
  CheckoutLineItemSummary,
  CheckoutSessionSummary,
  CheckoutTotalLine,
} from "../types";

/**
 * UCP LIVE CHECKOUT — real checkout sessions at UCP stores, over the
 * same published profiles the catalog reads use (lib/adapters/ucp.ts).
 *
 * Barath's rule (Nov 2, 2026): checkout is REAL but CODE-GATED. The
 * access-code check lives in app/api/checkout/route.ts and runs before
 * anything here is called; this module only ever runs for a buyer who
 * presented a valid code.
 *
 * Protocol discipline mirrors the catalog adapter: read the store's
 * live /.well-known/ucp profile, MCP initialize handshake, tools/list
 * discovery — the checkout tools are found in the server's OWN tool
 * list by capability pattern (create/update/get + checkout), never by
 * hardcoded name — then the calls themselves.
 *
 * Verified live against Monos (Nov 2, 2026): create returns a real
 * session (status "requires_escalation", the store's own totals
 * including tax, an expiry, its policy links, and a continue_url);
 * update accepts the buyer's delivery destination in the flat
 * destination shape and recomputes tax; the store's checkout declares
 * payment handlers dev.shopify.card and dev.shopify.shop_pay, and its
 * messages include extension_interaction_required — Monos requires a
 * buyer interaction at its own hosted step to finish. Accordingly:
 *
 * - PAYMENT: this app never collects, transmits, or stores a card
 *   number. Payment instruments are minted only by the merchant's own
 *   declared payment handlers, on the merchant's own hosted
 *   continuation (the session's continue_url). The buyer's final pay
 *   step happens there; this app then re-reads the session from the
 *   store and reports only the order the store itself returns.
 * - STATUS READS: where a store's get tool returns the session, an
 *   order is reported only when the store itself returns one.
 *   Shopify-backed stores currently answer checkout_not_found for
 *   live sessions (verified at Monos, Nov 2, 2026); the route then
 *   says so plainly instead of dressing a non-answer up as either a
 *   confirmation or an outage.
 * - BUYER CONSENT: the protocol carries buyer consent in the checkout
 *   payload (buyer.consent, per-purpose keys the merchant defines;
 *   omission leaves the merchant's defaults unchanged per its schema).
 *   The buyer-facing consent step is the explicit agreement shown in
 *   our UI before a session is created, next to the merchant's own
 *   policy links, which the session response returns and we surface.
 * - NOTHING IS STORED server-side: guest details pass through to the
 *   store's session in the request that creates it; later reads carry
 *   only the store's session id. A store that fails at any step yields
 *   an honest failure — never a fabricated order or confirmation.
 */

const HANDSHAKE_TIMEOUT_MS = 15_000;
const CHECKOUT_TIMEOUT_MS = 45_000;
const MCP_PROTOCOL_VERSION = "2025-06-18";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface CheckoutItemInput {
  /** The merchant's purchasable item id (catalog variant gid). */
  itemId: string;
  quantity: number;
}

export interface CheckoutBuyerInput {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

export interface CheckoutAddressInput {
  street: string;
  extended?: string;
  city: string;
  region: string;
  postal: string;
  country: string;
}

export interface StoreOrderRef {
  id: string;
  url: string | null;
  status: string | null;
}

export type StartCheckoutResult =
  | { ok: true; session: CheckoutSessionSummary }
  | { ok: false; error: string; storeMessages: CheckoutSessionSummary["messages"] };

export type CheckoutStatusResult =
  | { ok: true; session: CheckoutSessionSummary; order: StoreOrderRef | null }
  | { ok: false; error: string }
  /**
   * The store answered, but its get tool cannot re-read this session
   * (Shopify's UCP servers return checkout_not_found for live
   * escalation-required sessions — verified live at Monos, Nov 2,
   * 2026, seconds after a successful create + update in the same
   * session). Not an outage and not a lost order: the session lives on
   * the store's hosted checkout, which this API cannot read back.
   */
  | { ok: false; notFound: true; error: string };

/** A UCP store is checkout-eligible only under the same policy check
 *  the catalog routing applies. */
export function checkoutStoreFor(merchant: string): UcpStore | null {
  const store = findUcpStore(merchant);
  if (!store) return null;
  const policy = getMerchantPolicy(store.merchant);
  if (
    policy.status !== "ucp-authorized-channel" ||
    !policy.allowedAcquisitionMethods.includes("api")
  ) {
    return null;
  }
  return store;
}

/* ------------------------------------------------------------------ */
/* Session plumbing                                                    */
/* ------------------------------------------------------------------ */

interface DiscoveredTools {
  create?: McpTool;
  update?: McpTool;
  get?: McpTool;
}

interface McpTool {
  name: string;
  inputSchema?: { properties?: Record<string, unknown> };
}

interface OpenSession {
  endpoint: string;
  sessionId: string | null;
  tools: DiscoveredTools;
}

async function openCheckoutSession(store: UcpStore): Promise<OpenSession | null> {
  try {
    const { endpoint } = await readProfileEndpoint(store);

    const initializeOnce = () =>
      mcpPost(
        endpoint,
        null,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: {
              name: "NotDeliveredInTheBlueTruck UCP checkout client",
              version: "0.1.0",
            },
          },
        },
        HANDSHAKE_TIMEOUT_MS,
      );
    let sessionId: string | null = null;
    try {
      let init;
      try {
        init = await initializeOnce();
      } catch (error) {
        if ((error as Error)?.name !== "AbortError") throw error;
        await sleep(2_000);
        init = await initializeOnce();
      }
      sessionId = init.sessionId;
      if (init.message?.result) {
        try {
          await mcpPost(
            endpoint,
            sessionId,
            { jsonrpc: "2.0", method: "notifications/initialized" },
            HANDSHAKE_TIMEOUT_MS,
          );
        } catch {
          /* fire-and-forget */
        }
      }
    } catch {
      /* stateless fallback, as in the catalog adapter */
    }

    const list = await mcpPost(
      endpoint,
      sessionId,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      HANDSHAKE_TIMEOUT_MS,
    );
    sessionId = list.sessionId ?? sessionId;
    const tools = (
      list.message?.result as { tools?: McpTool[] } | undefined
    )?.tools;
    if (!Array.isArray(tools)) return null;

    // Discovery by capability pattern from the server's own list.
    const byCapability = (verb: RegExp) =>
      tools.find((t) => verb.test(t.name) && /checkout/i.test(t.name));
    return {
      endpoint,
      sessionId,
      tools: {
        create: byCapability(/create/i),
        update: byCapability(/update/i),
        get: byCapability(/get/i),
      },
    };
  } catch (error) {
    console.warn(
      `[ucp-checkout] ${store.merchant} session open failed:`,
      String(error),
    );
    return null;
  }
}

function unwrapToolResult(result: Record<string, unknown>): Record<string, unknown> | null {
  const structured = result?.structuredContent as Record<string, unknown> | undefined;
  if (structured) return structured;
  for (const block of (result?.content as { type?: string; text?: string }[]) ?? []) {
    if (block?.type === "text" && typeof block.text === "string") {
      try {
        return JSON.parse(block.text) as Record<string, unknown>;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

let rpcId = 10;

async function callCheckoutTool(
  session: OpenSession,
  tool: McpTool,
  args: Record<string, unknown>,
): Promise<{ payload: Record<string, unknown> | null; isError: boolean }> {
  const call = await mcpPost(
    session.endpoint,
    session.sessionId,
    {
      jsonrpc: "2.0",
      id: ++rpcId,
      method: "tools/call",
      params: { name: tool.name, arguments: args },
    },
    CHECKOUT_TIMEOUT_MS,
  );
  if (!call.message?.result || call.message.error) {
    return { payload: null, isError: true };
  }
  const payload = unwrapToolResult(call.message.result);
  return {
    payload,
    isError: (call.message.result as { isError?: boolean }).isError === true,
  };
}

/* ------------------------------------------------------------------ */
/* Response normalization — only what the store returned               */
/* ------------------------------------------------------------------ */

interface RawCheckout {
  id?: string;
  status?: string;
  currency?: string;
  continue_url?: string;
  expires_at?: string;
  totals?: { type?: string; amount?: number; display_text?: string; displayText?: string }[];
  line_items?: {
    id?: string;
    quantity?: number;
    item?: { id?: string; title?: string; price?: number };
  }[];
  links?: { type?: string; title?: string; url?: string }[];
  messages?: { code?: string; content?: string; severity?: string }[];
  order?: { id?: string; status?: string; permalink_url?: string; permalink?: string; url?: string };
  checkout?: RawCheckout;
}

function asCheckout(payload: Record<string, unknown> | null): RawCheckout | null {
  if (!payload) return null;
  const raw = payload as RawCheckout;
  return raw.checkout && typeof raw.checkout === "object" ? raw.checkout : raw;
}

function normalizeTotals(raw: RawCheckout, currency: string): CheckoutTotalLine[] {
  if (!Array.isArray(raw.totals)) return [];
  return raw.totals
    .filter((t) => typeof t?.amount === "number" && typeof t?.type === "string")
    .map((t) => ({
      type: t.type as string,
      amount: moneyFromMinor(t.amount as number, currency),
      displayText: t.display_text ?? t.displayText ?? (t.type as string),
    }));
}

function normalizeItems(raw: RawCheckout, currency: string): CheckoutLineItemSummary[] {
  if (!Array.isArray(raw.line_items)) return [];
  return raw.line_items.map((li) => ({
    title: li?.item?.title ?? "Item",
    quantity: typeof li?.quantity === "number" ? li.quantity : 1,
    price:
      typeof li?.item?.price === "number"
        ? moneyFromMinor(li.item.price, currency)
        : 0,
  }));
}

function normalizeMessages(raw: RawCheckout): CheckoutSessionSummary["messages"] {
  if (!Array.isArray(raw.messages)) return [];
  return raw.messages
    .filter((m) => typeof m?.content === "string")
    .slice(0, 6)
    .map((m) => ({
      code: m.code ?? "",
      content: m.content as string,
      severity: m.severity ?? "",
    }));
}

function normalizeSummary(
  store: UcpStore,
  raw: RawCheckout,
  destinationAccepted: boolean,
): CheckoutSessionSummary {
  const currency = typeof raw.currency === "string" ? raw.currency : "USD";
  return {
    merchant: store.merchant,
    checkoutId: typeof raw.id === "string" ? raw.id : "",
    status: typeof raw.status === "string" ? raw.status : "",
    currency,
    totals: normalizeTotals(raw, currency),
    items: normalizeItems(raw, currency),
    continueUrl: typeof raw.continue_url === "string" ? raw.continue_url : null,
    expiresAt: typeof raw.expires_at === "string" ? raw.expires_at : null,
    messages: normalizeMessages(raw),
    policyLinks: Array.isArray(raw.links)
      ? raw.links
          .filter((l) => typeof l?.url === "string")
          .map((l) => ({
            type: l.type ?? "",
            title: l.title ?? l.type ?? "Policy",
            url: l.url as string,
          }))
      : [],
    destinationAccepted,
  };
}

function extractOrder(raw: RawCheckout): StoreOrderRef | null {
  const order = raw.order;
  if (!order || typeof order.id !== "string" || !order.id) return null;
  return {
    id: order.id,
    url: order.permalink_url ?? order.permalink ?? order.url ?? null,
    status: typeof order.status === "string" ? order.status : null,
  };
}

/* ------------------------------------------------------------------ */
/* Create a session, then pass the delivery destination                */
/* ------------------------------------------------------------------ */

export async function createStoreCheckout(
  store: UcpStore,
  items: CheckoutItemInput[],
  buyer: CheckoutBuyerInput,
  address: CheckoutAddressInput,
): Promise<StartCheckoutResult> {
  const session = await openCheckoutSession(store);
  if (!session) {
    return {
      ok: false,
      error: `${store.merchant} could not be reached to start checkout.`,
      storeMessages: [],
    };
  }
  const createTool = session.tools.create;
  if (!createTool) {
    return {
      ok: false,
      error: `${store.merchant} does not offer checkout through its published UCP profile.`,
      storeMessages: [],
    };
  }

  const meta = { "ucp-agent": { profile: AGENT_PROFILE } };
  const createProps = createTool.inputSchema?.properties ?? {};
  const checkoutPayload: Record<string, unknown> = {
    line_items: items.map((item) => ({
      item: { id: item.itemId },
      quantity: item.quantity,
    })),
    buyer: { email: buyer.email, phone_number: buyer.phone },
    context: {
      address_country: address.country,
      address_region: address.region,
      postal_code: address.postal,
      currency: "USD",
    },
  };
  const createArgs: Record<string, unknown> = { meta };
  if ("checkout" in createProps) createArgs.checkout = checkoutPayload;
  else Object.assign(createArgs, checkoutPayload);

  let created: RawCheckout | null = null;
  try {
    const res = await callCheckoutTool(session, createTool, createArgs);
    created = asCheckout(res.payload);
    if (res.isError || !created || typeof created.id !== "string") {
      return {
        ok: false,
        error: `${store.merchant} could not create a checkout session for these items.`,
        storeMessages: created ? normalizeMessages(created) : [],
      };
    }
  } catch (error) {
    console.warn(`[ucp-checkout] ${store.merchant} create failed:`, String(error));
    return {
      ok: false,
      error: `${store.merchant} could not create a checkout session for these items.`,
      storeMessages: [],
    };
  }

  /* Pass the delivery destination: flat address fields on the shipping
   * method's destination (the shape the store's own validation names),
   * with the line items the session returned. A store that declines
   * the destination here still holds a valid session — its hosted
   * continuation collects the address instead — so a failed update
   * degrades to destinationAccepted=false, never to a fake success. */
  let summary = normalizeSummary(store, created, false);
  const updateTool = session.tools.update;
  if (updateTool && Array.isArray(created.line_items)) {
    try {
      const lineItems = created.line_items
        .filter((li) => typeof li?.id === "string" && typeof li?.item?.id === "string")
        .map((li) => ({
          id: li.id as string,
          item: { id: li.item?.id as string },
          quantity: typeof li.quantity === "number" ? li.quantity : 1,
        }));
      const lineItemIds = lineItems.map((li) => li.id);
      if (lineItems.length > 0) {
        const updateProps = updateTool.inputSchema?.properties ?? {};
        const updateCheckout: Record<string, unknown> = {
          line_items: lineItems,
          buyer: { email: buyer.email, phone_number: buyer.phone },
          fulfillment: {
            methods: [
              {
                type: "shipping",
                line_item_ids: lineItemIds,
                destinations: [
                  {
                    first_name: buyer.firstName,
                    last_name: buyer.lastName,
                    street_address: address.street,
                    ...(address.extended
                      ? { extended_address: address.extended }
                      : {}),
                    address_locality: address.city,
                    address_region: address.region,
                    postal_code: address.postal,
                    address_country: address.country,
                    phone_number: buyer.phone,
                  },
                ],
              },
            ],
          },
        };
        const updateArgs: Record<string, unknown> = { meta };
        if ("id" in updateProps) updateArgs.id = created.id;
        if ("checkout" in updateProps) updateArgs.checkout = updateCheckout;
        else Object.assign(updateArgs, updateCheckout);
        const res = await callCheckoutTool(session, updateTool, updateArgs);
        const updated = asCheckout(res.payload);
        if (!res.isError && updated && typeof updated.id === "string") {
          summary = normalizeSummary(store, updated, true);
        }
      }
    } catch (error) {
      console.warn(
        `[ucp-checkout] ${store.merchant} destination update failed:`,
        String(error),
      );
    }
  }
  return { ok: true, session: summary };
}

/* ------------------------------------------------------------------ */
/* Re-read a session: has the store confirmed an order?                */
/* ------------------------------------------------------------------ */

export async function getStoreCheckoutStatus(
  store: UcpStore,
  checkoutId: string,
): Promise<CheckoutStatusResult> {
  const session = await openCheckoutSession(store);
  if (!session) {
    return { ok: false, error: `${store.merchant} could not be reached.` };
  }
  const getTool = session.tools.get;
  if (!getTool) {
    return {
      ok: false,
      error: `${store.merchant} does not offer checkout status through its published UCP profile.`,
    };
  }
  try {
    const getProps = getTool.inputSchema?.properties ?? {};
    const args: Record<string, unknown> = {
      meta: { "ucp-agent": { profile: AGENT_PROFILE } },
    };
    if ("id" in getProps || Object.keys(getProps).length === 0) {
      args.id = checkoutId;
    }
    const res = await callCheckoutTool(session, getTool, args);
    const raw = asCheckout(res.payload);
    if (res.isError || !raw || typeof raw.id !== "string") {
      const codes = normalizeMessages((res.payload ?? {}) as RawCheckout).map(
        (m) => m.code,
      );
      if (codes.includes("checkout_not_found")) {
        return {
          ok: false,
          notFound: true,
          error: `${store.merchant} does not expose this checkout session for status checks.`,
        };
      }
      return {
        ok: false,
        error: `${store.merchant} did not return that checkout session.`,
      };
    }
    return {
      ok: true,
      session: normalizeSummary(store, raw, true),
      order: extractOrder(raw),
    };
  } catch (error) {
    console.warn(`[ucp-checkout] ${store.merchant} status failed:`, String(error));
    return { ok: false, error: `${store.merchant} could not be reached.` };
  }
}
