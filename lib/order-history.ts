import type { Merchant, StoreOrder } from "./types";

/**
 * Order history lives in the shopper's own browser — nowhere else.
 *
 * This app is guest-only and stores nothing on a server, so both
 * kinds of purchase record are kept in localStorage on the shopper's
 * device and read back only there:
 *
 * - StoreOrder (Path A): an order a store itself confirmed after an
 *   in-app checkout, recorded with the store's own figures and its
 *   order id (see StoreOrder in lib/types.ts). Stored under
 *   ORDER_STORAGE_KEY by components/ShoppingApp.tsx.
 * - StoreHandoff (Path B): the buyer was sent to the store's own
 *   site with the items already in the store's cart and checked out
 *   THERE. A handoff record is a note of that handoff — what was in
 *   the cart and its price at handoff time — never an order placed
 *   in this app, and it is labeled that way wherever it is shown.
 *
 * Records are written only from real, completed checkout actions on
 * this device. Nothing here is ever seeded with sample data.
 */

export const ORDER_STORAGE_KEY = "not-delivered-in-the-blue-truck-orders-v2";
export const HANDOFF_STORAGE_KEY = "not-delivered-in-the-blue-truck-handoffs-v1";

export interface StoreHandoffItem {
  title: string;
  quantity: number;
  /** Unit price shown in this app at the moment of handoff. */
  price: number;
}

export interface StoreHandoff {
  merchant: Merchant;
  items: StoreHandoffItem[];
  /** Sum of the item prices at handoff; shipping and tax were the
   *  store's to settle on its own site. */
  itemsTotal: number;
  handedOffAt: string;
  /** The store's pre-loaded cart link, when it returned one. */
  cartUrl: string | null;
}

export type OrderHistoryEntry =
  | { kind: "order"; at: string; order: StoreOrder }
  | { kind: "handoff"; at: string; handoff: StoreHandoff };

function loadList<T>(key: string): T[] {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as T[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Storage may be unavailable or corrupted in a restricted
    // browser context; history is a convenience, never a blocker.
    return [];
  }
}

export function loadStoredOrders(): StoreOrder[] {
  return loadList<StoreOrder>(ORDER_STORAGE_KEY);
}

export function loadStoredHandoffs(): StoreHandoff[] {
  return loadList<StoreHandoff>(HANDOFF_STORAGE_KEY);
}

/** Prepend a handoff record and persist the list; returns the new list. */
export function recordStoredHandoff(handoff: StoreHandoff): StoreHandoff[] {
  const next = [handoff, ...loadStoredHandoffs()].slice(0, 50);
  try {
    window.localStorage.setItem(HANDOFF_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // See loadList — a failed write must not break the handoff itself.
  }
  return next;
}

/** Both record kinds in one list, newest first. */
export function mergeOrderHistory(
  orders: StoreOrder[],
  handoffs: StoreHandoff[],
): OrderHistoryEntry[] {
  const entries: OrderHistoryEntry[] = [
    ...orders.map(
      (order): OrderHistoryEntry => ({ kind: "order", at: order.confirmedAt, order }),
    ),
    ...handoffs.map(
      (handoff): OrderHistoryEntry => ({
        kind: "handoff",
        at: handoff.handedOffAt,
        handoff,
      }),
    ),
  ];
  return entries.sort((a, b) => b.at.localeCompare(a.at));
}
