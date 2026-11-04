"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  CartItem,
  CheckoutSessionSummary,
  DecideResponse,
  Merchant,
  Priority,
  ProductSummary,
  ScoredOffer,
  SearchResponse,
  StoreOrder,
} from "@/lib/types";
import { BRAND } from "@/lib/config";
import { CATEGORY_IMAGES, productImage } from "@/lib/images";
import {
  ORDER_STORAGE_KEY,
  loadStoredHandoffs,
  mergeOrderHistory,
  recordStoredHandoff,
  type StoreHandoff,
} from "@/lib/order-history";

/**
 * Confirmed REAL orders (store-returned data only), remembered in the
 * shopper's own browser under ORDER_STORAGE_KEY (lib/order-history.ts).
 * The retired v1 key held sandbox sample orders; those were never
 * real and are simply no longer read.
 */

/** The comparison always asks for delivery within a week in this prototype. */
const NEED_BY_DAYS = 7;

type View = "home" | "results" | "product" | "cart" | "confirmation" | "orders";
type SortMode = "price" | "fastest";

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

function formatDate(value: Date | string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(typeof value === "string" ? new Date(value) : value);
}

function formatFullDate(value: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(value);
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function arrivalDate(deliveryDays: number): string {
  const date = new Date();
  date.setDate(date.getDate() + deliveryDays);
  return formatDate(date);
}

function arrivalFullDate(deliveryDays: number): string {
  const date = new Date();
  date.setDate(date.getDate() + deliveryDays);
  return formatFullDate(date);
}

function returnWindowLabel(offer: ScoredOffer): string {
  if (offer.returnCost === "final-sale") return "Final sale";
  return `${offer.returnWindowDays} days`;
}

function returnCostLabel(offer: ScoredOffer): string {
  if (offer.returnCost === "free") return "Free";
  if (offer.returnCost === "buyer-paid") return "Buyer-paid";
  return "—";
}

function warrantyLabel(offer: ScoredOffer): string {
  // warrantyMonths 0 means the source stated no warranty period — that is
  // an absence of data, never a claim of "no warranty".
  if (offer.warrantyMonths <= 0) return "Not stated by seller";
  if (offer.warrantyMonths % 12 === 0) {
    const years = offer.warrantyMonths / 12;
    return `${years}-year warranty`;
  }
  return `${offer.warrantyMonths}-month warranty`;
}

/** A cart item checks out inside this app only when its offer came
 *  from a UCP store and carries the merchant's purchasable item id. */
function isInAppCheckout(item: CartItem): boolean {
  return item.policyStatus === "ucp-public-profile" && !!item.checkoutItemId;
}

/** Store total line for an order/session, as the store labeled it. */
function orderTotal(order: { totals: StoreOrder["totals"] }): number | null {
  const total = order.totals.find((line) => line.type === "total");
  return total ? total.amount : null;
}

/** Live-group categories that differ from the stored category-art keys. */
const CATEGORY_IMAGE_ALIASES: Record<string, string> = {
  "Running shoes": CATEGORY_IMAGES.Fitness,
  "Robot vacuums": CATEGORY_IMAGES.Home,
  "Coffee makers": CATEGORY_IMAGES["Coffee & Kitchen"],
};

/** Image for a search result row: the merchant's own image for live
 *  results, then category art, then the stored asset keyed by id. */
function summaryImage(product: ProductSummary): string {
  if (product.imageUrl) return product.imageUrl;
  return (
    CATEGORY_IMAGES[product.category] ??
    CATEGORY_IMAGE_ALIASES[product.category] ??
    productImage(product.id)
  );
}

/** Image for cart/order records, which remember a live product's image. */
function recordImage(record: { productId: string; imageUrl?: string | null }): string {
  return record.imageUrl ?? productImage(record.productId);
}

export default function ShoppingApp() {
  const [view, setView] = useState<View>("home");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [searchMeta, setSearchMeta] = useState<{ query: string; products: ProductSummary[] } | null>(null);
  const [sort, setSort] = useState<SortMode>("price");
  const [filterBrands, setFilterBrands] = useState<string[]>([]);
  const [filterMaxDays, setFilterMaxDays] = useState<number | null>(null);
  /* Offer filters, shared by the results list and the comparison
     table. Price always means the all-in total: item price + shipping. */
  const [filterMinTotal, setFilterMinTotal] = useState<number | null>(null);
  const [filterMaxTotal, setFilterMaxTotal] = useState<number | null>(null);
  const [customMin, setCustomMin] = useState("");
  const [customMax, setCustomMax] = useState("");
  const [filterFreeShipping, setFilterFreeShipping] = useState(false);
  const [filterWarrantyStated, setFilterWarrantyStated] = useState(false);
  const [filterFreeReturns, setFilterFreeReturns] = useState(false);
  const [filterMinReturnDays, setFilterMinReturnDays] = useState<number | null>(null);

  const [result, setResult] = useState<DecideResponse | null>(null);
  const [priority, setPriority] = useState<Priority>("cheapest");
  /** Live-search groups currently openable: group id → the query that found it. */
  const [liveGroups, setLiveGroups] = useState<Record<string, string>>({});

  const [cart, setCart] = useState<CartItem[]>([]);
  const [cartNotice, setCartNotice] = useState<string | null>(null);
  const [guestName, setGuestName] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [guestPhone, setGuestPhone] = useState("");
  const [guestStreet, setGuestStreet] = useState("");
  const [guestExtended, setGuestExtended] = useState("");
  const [guestCity, setGuestCity] = useState("");
  const [guestRegion, setGuestRegion] = useState("");
  const [guestPostal, setGuestPostal] = useState("");
  const [accessCode, setAccessCode] = useState("");
  const [buyerConsent, setBuyerConsent] = useState(false);

  /** Per-merchant live checkout state, keyed by merchant name. The
   *  session itself lives at the store; this is only its last summary. */
  const [checkoutSessions, setCheckoutSessions] = useState<
    Record<
      string,
      {
        busy?: boolean;
        error?: string;
        fallbackUrl?: string;
        session?: CheckoutSessionSummary;
        statusBusy?: boolean;
        statusNote?: string;
        cartBusy?: boolean;
        cartUrl?: string;
        cartNote?: string;
        cartError?: string;
      }
    >
  >({});

  const [orders, setOrders] = useState<StoreOrder[]>([]);
  const [ordersLoaded, setOrdersLoaded] = useState(false);
  const [placedOrders, setPlacedOrders] = useState<StoreOrder[]>([]);
  /** Path B handoffs (buyer checked out on the store's own site),
   *  remembered on this device only; see lib/order-history.ts. */
  const [handoffs, setHandoffs] = useState<StoreHandoff[]>([]);

  /* ----- order history persistence (local to the browser) -----
     Only orders a store itself confirmed are ever written here, with
     the store's own figures; see StoreOrder in lib/types.ts. */
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(ORDER_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as StoreOrder[];
        if (Array.isArray(parsed)) setOrders(parsed);
      }
      setHandoffs(loadStoredHandoffs());
    } catch {
      // A corrupted local record should not break the shopping flow.
    } finally {
      setOrdersLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!ordersLoaded) return;
    try {
      window.localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(orders));
    } catch {
      // Storage may be unavailable in a restricted browser context.
    }
  }, [orders, ordersLoaded]);

  /* The search-only home (wonder-v7) makes no live calls on load:
     nothing is fetched until the shopper searches. */

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [view]);

  const cartTotals = useMemo(() => {
    const subtotal = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const shipping = cart.reduce((sum, item) => sum + item.shippingCost * item.quantity, 0);
    return {
      subtotal,
      shipping,
      total: subtotal + shipping,
      count: cart.reduce((n, item) => n + item.quantity, 0),
    };
  }, [cart]);

  /** Merchants whose cart items check out inside this app (UCP). */
  const checkoutMerchants = useMemo(() => {
    const seen: Merchant[] = [];
    for (const item of cart) {
      if (isInAppCheckout(item) && !seen.includes(item.merchant)) {
        seen.push(item.merchant);
      }
    }
    return seen;
  }, [cart]);
  const handoffItems = useMemo(
    () => cart.filter((item) => !isInAppCheckout(item)),
    [cart],
  );
  const guestDetailsValid =
    guestName.trim().length > 0 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guestEmail.trim()) &&
    guestPhone.trim().length >= 5 &&
    guestStreet.trim().length > 0 &&
    guestCity.trim().length > 0 &&
    /^[A-Za-z]{2}$/.test(guestRegion.trim()) &&
    /^\d{5}(-\d{4})?$/.test(guestPostal.trim());

  const resultBrands = useMemo(
    () => (searchMeta ? [...new Set(searchMeta.products.map((p) => p.brand))].sort() : []),
    [searchMeta],
  );

  const visibleResults = useMemo(() => {
    if (!searchMeta) return [];
    let list = searchMeta.products.filter((product) => {
      if (filterBrands.length > 0 && !filterBrands.includes(product.brand)) return false;
      // Price filters judge a product by its best (lowest-total) offer.
      if (filterMinTotal !== null && product.lowestTotal < filterMinTotal) return false;
      if (filterMaxTotal !== null && product.lowestTotal > filterMaxTotal) return false;
      if (filterFreeShipping && !product.hasFreeShipping) return false;
      if (filterWarrantyStated && !product.hasStatedWarranty) return false;
      // Return filters judge a product by its most generous offer.
      if (filterFreeReturns && !product.hasFreeReturns) return false;
      if (filterMinReturnDays !== null && product.longestReturnWindowDays < filterMinReturnDays) return false;
      if (filterMaxDays !== null && product.fastestDeliveryDays > filterMaxDays) return false;
      return true;
    });
    if (sort === "price") list = [...list].sort((a, b) => a.lowestPrice - b.lowestPrice);
    if (sort === "fastest") {
      list = [...list].sort((a, b) => a.fastestDeliveryDays - b.fastestDeliveryDays);
    }
    return list;
  }, [searchMeta, filterBrands, filterMinTotal, filterMaxTotal, filterFreeShipping, filterWarrantyStated, filterFreeReturns, filterMinReturnDays, filterMaxDays, sort]);

  /* ----- offer filter helpers (results list + comparison table) ----- */

  const anyFilterActive =
    filterBrands.length > 0 ||
    filterMaxDays !== null ||
    filterMinTotal !== null ||
    filterMaxTotal !== null ||
    filterFreeShipping ||
    filterWarrantyStated ||
    filterFreeReturns ||
    filterMinReturnDays !== null;

  function clearOfferFilters() {
    setFilterMinTotal(null);
    setFilterMaxTotal(null);
    setCustomMin("");
    setCustomMax("");
    setFilterFreeShipping(false);
    setFilterWarrantyStated(false);
    setFilterFreeReturns(false);
    setFilterMinReturnDays(null);
  }

  function clearAllFilters() {
    clearOfferFilters();
    setFilterBrands([]);
    setFilterMaxDays(null);
  }

  function applyPricePreset(max: number | null) {
    setFilterMinTotal(null);
    setFilterMaxTotal(max);
    setCustomMin("");
    setCustomMax("");
  }

  function applyCustomRange(e: React.FormEvent) {
    e.preventDefault();
    const parse = (raw: string): number | null => {
      const value = Number(raw.replace(/[^0-9.]/g, ""));
      return raw.trim() !== "" && Number.isFinite(value) && value >= 0 ? value : null;
    };
    let min = parse(customMin);
    let max = parse(customMax);
    if (min !== null && max !== null && min > max) {
      [min, max] = [max, min];
    }
    setFilterMinTotal(min);
    setFilterMaxTotal(max);
  }

  /** Comparison-table filter: the offers themselves, by all-in total. */
  function offerMatchesFilters(offer: ScoredOffer): boolean {
    if (filterMinTotal !== null && offer.totalCost < filterMinTotal) return false;
    if (filterMaxTotal !== null && offer.totalCost > filterMaxTotal) return false;
    if (filterFreeShipping && offer.shippingCost !== 0) return false;
    if (filterWarrantyStated && offer.warrantyMonths <= 0) return false;
    if (filterFreeReturns && offer.returnCost !== "free") return false;
    if (filterMinReturnDays !== null && offer.returnWindowDays < filterMinReturnDays) return false;
    return true;
  }

  function renderFilterBar(shown: number, totalCount: number) {
    return (
      <div className="filterBar" aria-label="Filter offers">
        <span className="filterBarLabel">Filters</span>
        <div className="filterChipRow" role="group" aria-label="Price, total including shipping">
          <button
            type="button"
            className={`filterChip ${filterMinTotal === null && filterMaxTotal === null ? "active" : ""}`}
            onClick={() => applyPricePreset(null)}
          >
            Any price
          </button>
          <button
            type="button"
            className={`filterChip ${filterMinTotal === null && filterMaxTotal === 200 ? "active" : ""}`}
            onClick={() => applyPricePreset(200)}
          >
            Under $200
          </button>
          <button
            type="button"
            className={`filterChip ${filterMinTotal === null && filterMaxTotal === 500 ? "active" : ""}`}
            onClick={() => applyPricePreset(500)}
          >
            Under $500
          </button>
        </div>
        <form className="filterRange" onSubmit={applyCustomRange}>
          <label className="sr-only" htmlFor="filter-min-total">
            Minimum total price
          </label>
          <span className="filterRangeSign" aria-hidden="true">
            $
          </span>
          <input
            id="filter-min-total"
            type="text"
            inputMode="decimal"
            placeholder="Min"
            value={customMin}
            onChange={(e) => setCustomMin(e.target.value)}
          />
          <span className="filterRangeDash" aria-hidden="true">
            –
          </span>
          <label className="sr-only" htmlFor="filter-max-total">
            Maximum total price
          </label>
          <span className="filterRangeSign" aria-hidden="true">
            $
          </span>
          <input
            id="filter-max-total"
            type="text"
            inputMode="decimal"
            placeholder="Max"
            value={customMax}
            onChange={(e) => setCustomMax(e.target.value)}
          />
          <button type="submit" className="filterApply">
            Apply
          </button>
        </form>
        <button
          type="button"
          className={`filterChip ${filterFreeShipping ? "active" : ""}`}
          aria-pressed={filterFreeShipping}
          onClick={() => setFilterFreeShipping((value) => !value)}
        >
          Free shipping
        </button>
        <button
          type="button"
          className={`filterChip ${filterWarrantyStated ? "active" : ""}`}
          aria-pressed={filterWarrantyStated}
          onClick={() => setFilterWarrantyStated((value) => !value)}
        >
          Warranty stated
        </button>
        <button
          type="button"
          className={`filterChip ${filterFreeReturns ? "active" : ""}`}
          aria-pressed={filterFreeReturns}
          onClick={() => setFilterFreeReturns((value) => !value)}
        >
          Free returns
        </button>
        <div className="filterChipRow" role="group" aria-label="Return window">
          <button
            type="button"
            className={`filterChip ${filterMinReturnDays === null ? "active" : ""}`}
            onClick={() => setFilterMinReturnDays(null)}
          >
            Any return window
          </button>
          <button
            type="button"
            className={`filterChip ${filterMinReturnDays === 30 ? "active" : ""}`}
            onClick={() => setFilterMinReturnDays(30)}
          >
            30+ day returns
          </button>
          <button
            type="button"
            className={`filterChip ${filterMinReturnDays === 60 ? "active" : ""}`}
            onClick={() => setFilterMinReturnDays(60)}
          >
            60+ day returns
          </button>
        </div>
        {anyFilterActive && (
          <>
            <button type="button" className="filterClear" onClick={clearAllFilters}>
              Clear filters
            </button>
            <span className="filterCount">
              {shown} of {totalCount}
            </span>
          </>
        )}
      </div>
    );
  }

  /* ----- data actions ----- */

  async function openProduct(
    productId: string,
    prio: Priority = priority,
    liveQueryOverride?: string,
  ) {
    setLoading(true);
    setError(null);
    // A live-search result opens through its live group, not the catalog.
    const liveQuery = liveQueryOverride ?? liveGroups[productId];
    try {
      const res = await fetch("/api/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId,
          liveGroupId: liveQuery ? productId : undefined,
          query: liveQuery,
          budget: null,
          needByDays: NEED_BY_DAYS,
          priority: prio,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not load that product comparison.");
        return;
      }
      setResult(data as DecideResponse);
      setView("product");
    } catch {
      setError("Could not reach the comparison service. Try again.");
    } finally {
      setLoading(false);
    }
  }

  async function runSearch(rawQuery: string) {
    const q = rawQuery.trim();
    if (!q) return;
    setQuery(q);
    setLoading(true);
    setError(null);
    setSort("price");
    setFilterBrands([]);
    setFilterMaxDays(null);
    clearOfferFilters();
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const data = (await res.json()) as SearchResponse & { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Search failed.");
        setSearchMeta({ query: q, products: [] });
        setView("results");
        return;
      }
      // Remember live groups so their product pages open through the
      // live decide path (and priority changes keep working).
      if (data.dataSource === "live") {
        setLiveGroups((previous) => {
          const next = { ...previous };
          for (const product of data.products) next[product.id] = q;
          return next;
        });
      }
      if (data.products.length === 1) {
        setSearchMeta({ query: q, products: data.products });
        await openProduct(
          data.products[0].id,
          priority,
          data.dataSource === "live" ? q : undefined,
        );
        return;
      }
      setSearchMeta({ query: q, products: data.products });
      setView("results");
    } catch {
      setError("Could not reach search. Try again.");
    } finally {
      setLoading(false);
    }
  }

  function onHeaderSearch(e: React.FormEvent) {
    e.preventDefault();
    void runSearch(query);
  }

  function changePriority(next: Priority) {
    if (!result || next === priority) return;
    setPriority(next);
    void openProduct(result.product.id, next);
  }

  function goHome() {
    setError(null);
    setCartNotice(null);
    setView("home");
  }

  /* ----- cart & checkout ----- */

  function addToCart(offer: ScoredOffer) {
    if (!result) return;
    const item: CartItem = {
      productId: result.product.id,
      productName: result.product.name,
      imageUrl: result.product.imageUrl ?? null,
      offerId: offer.id,
      merchant: offer.merchant,
      seller: offer.seller,
      condition: offer.condition,
      price: offer.price,
      shippingCost: offer.shippingCost,
      totalCost: offer.totalCost,
      deliveryDays: offer.deliveryDays,
      returnWindowDays: offer.returnWindowDays,
      returnCost: offer.returnCost,
      quantity: 1,
      checkoutItemId: offer.checkoutItemId ?? null,
      sourceUrl: offer.provenance.sourceUrl,
      policyStatus: offer.provenance.policyStatus,
    };
    setCart((previous) => {
      const existing = previous.find((entry) => entry.offerId === offer.id);
      if (existing) {
        return previous.map((entry) =>
          entry.offerId === offer.id
            ? { ...entry, quantity: Math.min(10, entry.quantity + 1) }
            : entry,
        );
      }
      return [...previous, item];
    });
    setPlacedOrders([]);
    setCartNotice(`${result.product.name} from ${offer.seller} was added to the cart.`);
  }

  function removeFromCart(offerId: string) {
    setCart((previous) => previous.filter((item) => item.offerId !== offerId));
  }

  /**
   * Quantity editing for the cart/checkout page. The checkout API caps
   * a line at 10, so the editor clamps to 1–10 as well — the quantity
   * the page shows is exactly the quantity both checkout paths send.
   */
  function updateCartQuantity(offerId: string, quantity: number) {
    if (!Number.isFinite(quantity)) return;
    const next = Math.max(1, Math.min(10, Math.round(quantity)));
    setCart((previous) =>
      previous.map((item) =>
        item.offerId === offerId ? { ...item, quantity: next } : item,
      ),
    );
  }

  function setCheckoutState(
    merchant: Merchant,
    patch: Partial<{
      busy: boolean;
      error: string;
      fallbackUrl: string;
      session: CheckoutSessionSummary;
      statusBusy: boolean;
      statusNote: string;
      cartBusy: boolean;
      cartUrl: string;
      cartNote: string;
      cartError: string;
    }>,
  ) {
    setCheckoutSessions((previous) => ({
      ...previous,
      [merchant]: { ...previous[merchant], ...patch },
    }));
  }

  /**
   * Start a REAL checkout session at one UCP store for that store's
   * cart items. The server validates the access code before creating
   * anything; the session, totals, and messages shown afterwards are
   * the store's own response. No order exists until the store confirms
   * one (see checkStoreOrder).
   */
  async function startStoreCheckout(merchant: Merchant) {
    const items = cart.filter(
      (item) => item.merchant === merchant && isInAppCheckout(item),
    );
    if (items.length === 0) return;
    setCheckoutState(merchant, { busy: true, error: undefined, statusNote: undefined });
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "start",
          accessCode,
          merchant,
          items: items.map((item) => ({
            itemId: item.checkoutItemId,
            quantity: item.quantity,
          })),
          buyer: { name: guestName, email: guestEmail, phone: guestPhone },
          address: {
            street: guestStreet,
            extended: guestExtended,
            city: guestCity,
            region: guestRegion,
            postal: guestPostal,
          },
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        fallbackUrl?: string;
        session?: CheckoutSessionSummary;
      };
      if (!res.ok || !data.ok || !data.session) {
        setCheckoutState(merchant, {
          busy: false,
          error: data.error ?? `Could not start checkout at ${merchant}.`,
          fallbackUrl: data.fallbackUrl,
          session: undefined,
        });
        return;
      }
      setCheckoutState(merchant, { busy: false, session: data.session });
    } catch {
      setCheckoutState(merchant, {
        busy: false,
        error: `Could not reach checkout at ${merchant}. Try again.`,
        session: undefined,
      });
    }
  }

  /**
   * Path B: ask the store to pre-load a cart with this merchant's
   * items and hand back its own continuation link. No guest details
   * are collected or sent — the buyer enters everything on the
   * store's site. The returned link is rendered in the panel (popup
   * blockers can't eat it) and also opened in a new tab.
   */
  async function continueAtStore(merchant: Merchant) {
    const items = cart.filter(
      (item) => item.merchant === merchant && isInAppCheckout(item),
    );
    if (items.length === 0) return;
    setCheckoutState(merchant, { cartBusy: true, cartError: undefined, cartNote: undefined });
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "cartlink",
          accessCode,
          merchant,
          items: items.map((item) => ({
            itemId: item.checkoutItemId,
            quantity: item.quantity,
          })),
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        fallbackUrl?: string;
        continueUrl?: string;
      };
      if (!res.ok || !data.ok || !data.continueUrl) {
        setCheckoutState(merchant, {
          cartBusy: false,
          cartError:
            data.error ?? `${merchant} could not prepare a cart. Use the product link instead.`,
          fallbackUrl: data.fallbackUrl,
        });
        return;
      }
      window.open(data.continueUrl, "_blank", "noopener");
      /* Remember the handoff on this device only. The buyer checks
         out at the store, so this record is labeled a store checkout
         wherever it appears — never an order placed in this app. */
      setHandoffs(
        recordStoredHandoff({
          merchant,
          items: items.map((item) => ({
            title: item.productName,
            quantity: item.quantity,
            price: item.price,
          })),
          itemsTotal: items.reduce(
            (sum, item) => sum + item.price * item.quantity,
            0,
          ),
          handedOffAt: new Date().toISOString(),
          cartUrl: data.continueUrl,
        }),
      );
      setCheckoutState(merchant, {
        cartBusy: false,
        cartUrl: data.continueUrl,
        cartNote:
          `Your items are in ${merchant}'s cart — the link opened in a new tab. ` +
          `Enter your details and pay on ${merchant}'s site.`,
      });
    } catch {
      setCheckoutState(merchant, {
        cartBusy: false,
        cartError: `Could not reach ${merchant} to prepare a cart. Try again.`,
      });
    }
  }

  /**
   * Ask the store whether the session has produced an order. Only a
   * store-returned order is recorded — anything else is reported as
   * "not confirmed yet", never dressed up as a purchase.
   */
  async function checkStoreOrder(merchant: Merchant) {
    const session = checkoutSessions[merchant]?.session;
    if (!session) return;
    setCheckoutState(merchant, { statusBusy: true, statusNote: undefined });
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "status",
          accessCode,
          merchant,
          checkoutId: session.checkoutId,
          buyerEmail: guestEmail,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        session?: CheckoutSessionSummary | null;
        order?: StoreOrder | null;
        note?: string;
      };
      if (!res.ok || !data.ok) {
        setCheckoutState(merchant, {
          statusBusy: false,
          statusNote: data.error ?? `Could not read the session at ${merchant}.`,
        });
        return;
      }
      if (data.session) {
        setCheckoutState(merchant, { session: data.session });
      }
      if (data.order) {
        const order = data.order;
        setOrders((previous) => [
          order,
          ...previous.filter((entry) => entry.orderId !== order.orderId),
        ]);
        setPlacedOrders([order]);
        setCart((previous) =>
          previous.filter((item) => item.merchant !== merchant),
        );
        setCheckoutState(merchant, { statusBusy: false, session: undefined });
        setView("confirmation");
        return;
      }
      setCheckoutState(merchant, {
        statusBusy: false,
        statusNote:
          data.note ??
          (`${merchant} has not confirmed an order for this session yet. ` +
            `Finish the payment step on ${merchant}'s page, then check again.`),
      });
    } catch {
      setCheckoutState(merchant, {
        statusBusy: false,
        statusNote: `Could not reach ${merchant} to check the order. Try again.`,
      });
    }
  }

  /* ----- views ----- */

  function renderHome() {
    return (
      <main className="wrap homeMain">
        <h1 className="homeTitle">One place to shop them all.</h1>
        <p className="homeSub">Search once. We do the comparing.</p>

        <form className="heroSearch" onSubmit={onHeaderSearch} role="search">
          <label className="sr-only" htmlFor="home-search">
            Search for a product
          </label>
          <input
            id="home-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="What are you looking for?"
            autoComplete="off"
          />
          <button type="submit" disabled={loading}>
            {loading ? "Searching…" : "Search"}
          </button>
        </form>
        <p className="heroHint">Try a sofa, running shoes, a coffee maker — anything.</p>

        <div className="homeSteps">
          <div className="homeStep">
            <span className="stepNum">1</span>
            <p>
              <strong>Step 1 — Search for the product.</strong>
              <br />
              Type what you want, just like any store.
            </p>
          </div>
          <div className="homeStep">
            <span className="stepNum">2</span>
            <p>
              <strong>Step 2 — See it across different stores and compare price, delivery speed, return policy, and warranty.</strong>
            </p>
          </div>
          <div className="homeStep">
            <span className="stepNum">3</span>
            <p>
              <strong>Step 3 — Check out here, or at the store.</strong>
            </p>
          </div>
        </div>
      </main>
    );
  }

  function renderResults() {
    const total = searchMeta?.products.length ?? 0;
    return (
      <main className="wrap resultsMain">
        <div className="resultsHead">
          <p className="resultsCount">
            {visibleResults.length} result{visibleResults.length === 1 ? "" : "s"} for &ldquo;
            {searchMeta?.query}&rdquo;
          </p>
          <label className="sortControl" htmlFor="sort">
            Sort
            <select
              id="sort"
              value={sort}
              onChange={(e) => setSort(e.target.value as SortMode)}
            >
              <option value="price">Price: low to high</option>
              <option value="fastest">Fastest delivery</option>
            </select>
          </label>
        </div>

        {total > 0 && renderFilterBar(visibleResults.length, total)}

        <div className={`resultsLayout ${total === 0 ? "noRail" : ""}`}>
          {total > 0 && (
            <aside className="filterRail" aria-label="Filters">
              <span className="label">Filters</span>
              {resultBrands.length > 1 && (
                <div className="filterGroup">
                  <h3>Brand</h3>
                  {resultBrands.map((brand) => (
                    <label className="filterOption" key={brand}>
                      <input
                        type="checkbox"
                        checked={filterBrands.includes(brand)}
                        onChange={(e) =>
                          setFilterBrands((previous) =>
                            e.target.checked
                              ? [...previous, brand]
                              : previous.filter((entry) => entry !== brand),
                          )
                        }
                      />
                      {brand}
                    </label>
                  ))}
                </div>
              )}
              <div className="filterGroup">
                <h3>Delivery speed</h3>
                {(
                  [
                    [null, "Any speed"],
                    [2, "2 days or faster"],
                    [3, "3 days or faster"],
                    [5, "5 days or faster"],
                  ] as [number | null, string][]
                ).map(([value, label]) => (
                  <label className="filterOption" key={label}>
                    <input
                      type="radio"
                      name="filter-delivery"
                      checked={filterMaxDays === value}
                      onChange={() => setFilterMaxDays(value)}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </aside>
          )}

          {visibleResults.length === 0 ? (
            <div className="emptyBox">
              <strong>{total === 0 ? "No products to show" : "No offers match those filters"}</strong>
              <p>
                {total === 0
                  ? `Nothing matched “${searchMeta?.query}” — live search at eBay, Walmart, and the UCP stores (Steve Madden, Gymshark, Everlane, Monos, Allbirds, Kith, Misen, SKIMS, Fenty Beauty, Lord & Taylor, Stein Mart, Scandinavian Designs, Slumberland, Pier 1, Vitacost, ShopLC, The Lakeside Collection, LTD Commodities, SkyMall, Mast General Store, Kane's Furniture, Steinhafels, Schneiderman's Furniture, FYE, DTLR, Beach Camera, Turtle Beach, Evo, FAO Schwarz, Casper, Away, HexClad, Lodge Cast Iron, Rad Power Bikes, The Sill, Brookstone, Sharper Image, Peak Design, Woodcraft, Arhaus, Bonobos), and the browsing-route stores (Micro Center, Harbor Freight, Carter's, Mattress Firm) returned nothing for it. Try headphones, a 55 inch TV, running shoes, leggings, a sweater, a carry-on, sneakers, a chef's knife, lip gloss, a sofa, a mattress, a camera, a snowboard, a frying pan, an electric bike, a plush toy, a laptop, a drill, or a bodysuit.`
                  : "Loosen a filter to see more."}
              </p>
            </div>
          ) : (
            <div className="resultList">
              {visibleResults.map((product) => (
                <button
                  key={product.id}
                  type="button"
                  className="resultRow"
                  onClick={() => void openProduct(product.id)}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img className="resultThumb" src={summaryImage(product)} alt={product.name} />
                  <span className="resultBody">
                    <h3>
                      {product.name}
                      {product.dataSource === "live" && (
                        <span className="livePill">Live</span>
                      )}
                    </h3>
                    <p className="resultFrom">
                      From <strong>{money(product.lowestPrice)}</strong>
                    </p>
                    <p className="arrivalLine">
                      Arrives in as fast as {product.fastestDeliveryDays} days
                    </p>
                    {product.dataSource === "live" && (
                      <p className="resultMeta">
                        Live prices from {product.sourceMerchants.join(" · ")} ·{" "}
                        {product.offerCount} offer{product.offerCount === 1 ? "" : "s"}
                      </p>
                    )}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </main>
    );
  }

  function renderProduct() {
    if (!result) return null;
    const winnerId = result.recommendation.id;
    const visibleOffers = result.offers.filter(offerMatchesFilters);
    return (
      <main className="wrap productMain">
        <button type="button" className="backLink" onClick={() => setView(searchMeta ? "results" : "home")}>
          {searchMeta ? "← Back to results" : "← Back to home"}
        </button>

        <div className="titleLine">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className="titleThumb"
            src={
              result.product.imageUrl ??
              (result.dataSource === "live"
                ? (CATEGORY_IMAGES[result.product.category] ??
                  productImage(result.product.id))
                : productImage(result.product.id))
            }
            alt={result.product.name}
          />
          <h1>
            {result.product.name}
            {result.dataSource === "live" && <span className="livePill">Live</span>}
          </h1>
          <span className="titleFrom">
            from <strong>{money(result.priceRange.lowest)}</strong>
          </span>
        </div>

        <div className="priorityRow" aria-label="Sort offers">
          <span>Show me:</span>
          {(
            [
              ["cheapest", "Lowest total"],
              ["fastest", "Fastest delivery"],
              ["returns", "Easiest returns"],
            ] as [Priority, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`priorityChip ${result.priority === value ? "active" : ""}`}
              aria-pressed={result.priority === value}
              disabled={loading}
              onClick={() => changePriority(value)}
            >
              {result.priority === value ? "✓ " : ""}
              {label}
            </button>
          ))}
        </div>

        {renderFilterBar(visibleOffers.length, result.offers.length)}

        {visibleOffers.length === 0 ? (
          <div className="emptyBox">
            <strong>No offers match those filters</strong>
            <p>Loosen a filter to see the other offers for this product.</p>
          </div>
        ) : (
        <div className="compareWrap">
          <table className="compareTable">
            <thead>
              <tr>
                <th scope="col">Merchant / Seller</th>
                <th scope="col">Total (all-in)</th>
                <th scope="col">Delivery date</th>
                <th scope="col">Return window</th>
                <th scope="col">Return cost</th>
                <th scope="col">Warranty</th>
                <th scope="col">
                  <span className="sr-only">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visibleOffers.map((offer) => {
                const isWinner = offer.id === winnerId;
                return (
                  <tr key={offer.id} className={isWinner ? "winnerRow" : ""}>
                    <td data-label="Merchant / Seller">
                      <span className="sellerCellInner">
                        {isWinner && <span className="winnerPill">★ Best Whole Deal</span>}
                        <span className="merchantName">{offer.merchant}</span>
                        <span className="sellerName">{offer.seller}</span>
                        <span className="conditionLine">
                          {offer.condition} ·{" "}
                          {offer.provenance.policyStatus === "ucp-public-profile"
                            ? "First-party store — no seller rating stated"
                            : `${offer.sellerRating.toFixed(1)} seller rating`}
                        </span>
                        {result.liveData?.offerIds.includes(offer.id) && (
                          <span className="livePill livePillSmall">Live price</span>
                        )}
                      </span>
                    </td>
                    <td data-label="Total (all-in)">
                      <span className="totalValue">{money(offer.totalCost)}</span>
                      <span className="breakdown">
                        {money(offer.price)} + {money(offer.shippingCost)} shipping
                      </span>
                    </td>
                    <td data-label="Delivery date">
                      <span className="deliveryDate">{arrivalFullDate(offer.deliveryDays)}</span>
                      <span className="arrivesSub">
                        Arrives in {offer.deliveryDays} day{offer.deliveryDays === 1 ? "" : "s"}
                      </span>
                    </td>
                    <td data-label="Return window">{returnWindowLabel(offer)}</td>
                    <td data-label="Return cost">{returnCostLabel(offer)}</td>
                    <td data-label="Warranty">{warrantyLabel(offer)}</td>
                    <td data-label="Action">
                      {offer.provenance.policyStatus === "ucp-public-profile" ? (
                        <button
                          type="button"
                          className={`addBtn ${isWinner ? "btnCoral" : "btnOutline"}`}
                          onClick={() => addToCart(offer)}
                        >
                          Add to cart
                        </button>
                      ) : offer.provenance.sourceUrl ? (
                        <a
                          className={`addBtn ${isWinner ? "btnCoral" : "btnOutline"}`}
                          href={offer.provenance.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Buy at {offer.merchant} ↗
                        </a>
                      ) : (
                        <span className="mutedText">
                          Sold by {offer.merchant} on its own site
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        )}

        {cartNotice && (
          <p className="successNotice">
            {cartNotice}{" "}
            <button type="button" className="backLink" onClick={() => setView("cart")}>
              View cart →
            </button>
          </p>
        )}

        <p className="shipsLine">Ships from and sold by {result.recommendation.seller}</p>
        {result.dataSource === "live" && result.retrievedAt && (
          <p className="liveLine">
            Live prices retrieved {formatDateTime(result.retrievedAt)} from{" "}
            {result.sourceMerchants.join(" and ")} — every figure is the listing&apos;s
            own.
          </p>
        )}
        <p className="smallPrint">
          {result.agentActivity.mode === "live"
            ? "Comparison assembled with Muse Spark."
            : "Comparison assembled locally — live model unavailable for this request."}
        </p>
      </main>
    );
  }

  function renderCart() {
    return (
      <main className="wrap flowMain">
        <h2 className="viewTitle">Cart {cartTotals.count > 0 ? `(${cartTotals.count})` : ""}</h2>

        {cart.length === 0 ? (
          <div className="flowCard">
            <p className="mutedText">
              Your cart is empty. Open a product and add an offer from its comparison table.
            </p>
            <button type="button" className="btnPine" onClick={goHome}>
              Continue shopping
            </button>
          </div>
        ) : (
          <div className="flowCard">
            <div className="cartList">
              {cart.map((item) => (
                <article className="cartItem" key={item.offerId}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img className="cartThumb" src={recordImage(item)} alt={item.productName} />
                  <div className="cartItemBody">
                    <strong>{item.productName}</strong>
                    <p>Ships from and sold by {item.seller}</p>
                    <small>
                      {item.condition} · Arrives {arrivalDate(item.deliveryDays)} ·{" "}
                      {item.returnWindowDays}-day return window
                    </small>
                    <div className="qtyControl">
                      <span>Qty</span>
                      <button
                        type="button"
                        aria-label={`Decrease quantity of ${item.productName}`}
                        disabled={item.quantity <= 1}
                        onClick={() => updateCartQuantity(item.offerId, item.quantity - 1)}
                      >
                        −
                      </button>
                      <input
                        type="number"
                        aria-label={`Quantity of ${item.productName}`}
                        min={1}
                        max={10}
                        value={item.quantity}
                        onChange={(e) => {
                          const parsed = Number.parseInt(e.target.value, 10);
                          if (!Number.isNaN(parsed)) {
                            updateCartQuantity(item.offerId, parsed);
                          }
                        }}
                      />
                      <button
                        type="button"
                        aria-label={`Increase quantity of ${item.productName}`}
                        disabled={item.quantity >= 10}
                        onClick={() => updateCartQuantity(item.offerId, item.quantity + 1)}
                      >
                        +
                      </button>
                    </div>
                  </div>
                  <div className="cartPriceCol">
                    <strong>{money(item.totalCost * item.quantity)}</strong>
                    <button type="button" className="removeBtn" onClick={() => removeFromCart(item.offerId)}>
                      Remove
                    </button>
                  </div>
                </article>
              ))}
            </div>

            <div className="totalsBox">
              <span>Subtotal {money(cartTotals.subtotal)}</span>
              <span>Shipping {cartTotals.shipping === 0 ? "Calculated at checkout" : money(cartTotals.shipping)}</span>
              <strong>Total {money(cartTotals.total)}</strong>
            </div>
            <p className="mutedText">
              Comparison totals are estimates from live listings. At checkout, the
              selling store computes the binding totals — including its shipping
              charge and tax — and shows them before you pay.
            </p>

            {handoffItems.length > 0 && (
              <section aria-label="Buy on the store's site">
                <h4>Buy on the store&apos;s site</h4>
                <p className="mutedText">
                  These stores complete purchases on their own sites — the button
                  takes you straight to the listing.
                </p>
                <div className="cartList">
                  {handoffItems.map((item) => (
                    <article className="cartItem" key={`handoff-${item.offerId}`}>
                      <div className="cartItemBody">
                        <strong>{item.productName}</strong>
                        <p>Ships from and sold by {item.seller}</p>
                      </div>
                      {item.sourceUrl ? (
                        <a
                          className="btnOutline"
                          href={item.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Buy at {item.merchant} ↗
                        </a>
                      ) : (
                        <span className="mutedText">Available at {item.merchant}</span>
                      )}
                    </article>
                  ))}
                </div>
              </section>
            )}

            {checkoutMerchants.length > 0 && (
              <section className="checkoutForm" aria-label="Checkout">
                <h4>Checkout — invite-only</h4>
                <p className="warningText">
                  Checkout here is real, and currently limited to invited guests:
                  it takes an access code, and each store below is checked out
                  separately with that store. Your details go to the selling
                  store to fulfill your order and are not stored by this site.
                  Payment is taken by the store&apos;s own payment provider on
                  the store&apos;s secure payment step — never enter a card
                  number on this site.
                </p>
                <div className="formGrid">
                  <label className="field">
                    <span>Access code</span>
                    <input
                      className="codeInput"
                      type="password"
                      value={accessCode}
                      onChange={(e) => setAccessCode(e.target.value)}
                      autoComplete="off"
                      placeholder="Required to check out"
                    />
                  </label>
                  <label className="field">
                    <span>Guest name</span>
                    <input value={guestName} onChange={(e) => setGuestName(e.target.value)} autoComplete="name" />
                  </label>
                  <label className="field">
                    <span>Guest email</span>
                    <input type="email" value={guestEmail} onChange={(e) => setGuestEmail(e.target.value)} autoComplete="email" />
                  </label>
                  <label className="field">
                    <span>Phone</span>
                    <input type="tel" value={guestPhone} onChange={(e) => setGuestPhone(e.target.value)} autoComplete="tel" />
                  </label>
                  <label className="field formWide">
                    <span>Street address</span>
                    <input value={guestStreet} onChange={(e) => setGuestStreet(e.target.value)} autoComplete="street-address" />
                  </label>
                  <label className="field">
                    <span>Apt / suite (optional)</span>
                    <input value={guestExtended} onChange={(e) => setGuestExtended(e.target.value)} autoComplete="address-line2" />
                  </label>
                  <label className="field">
                    <span>City</span>
                    <input value={guestCity} onChange={(e) => setGuestCity(e.target.value)} autoComplete="address-level2" />
                  </label>
                  <label className="field">
                    <span>State (2-letter)</span>
                    <input value={guestRegion} onChange={(e) => setGuestRegion(e.target.value)} autoComplete="address-level1" maxLength={2} />
                  </label>
                  <label className="field">
                    <span>ZIP code</span>
                    <input value={guestPostal} onChange={(e) => setGuestPostal(e.target.value)} autoComplete="postal-code" inputMode="numeric" />
                  </label>
                </div>

                <label className="consentCheck">
                  <input
                    type="checkbox"
                    checked={buyerConsent}
                    onChange={(e) => setBuyerConsent(e.target.checked)}
                  />
                  <span>
                    <strong>I agree</strong> — send my name, email, phone, and
                    delivery address to the selling store so it can take payment
                    through its own payment provider and fulfill my order, under
                    the store&apos;s policies (linked in the checkout below).
                  </span>
                </label>

                {checkoutMerchants.map((merchant) => {
                  const state = checkoutSessions[merchant] ?? {};
                  const session = state.session;
                  const merchantItems = cart.filter(
                    (item) => item.merchant === merchant && isInAppCheckout(item),
                  );
                  const fallbackItem = merchantItems.find((item) => item.sourceUrl);
                  return (
                    <section className="checkoutPanel" key={merchant} aria-label={`Checkout at ${merchant}`}>
                      <h4>{merchant}</h4>
                      <p className="mutedText">
                        {merchantItems.length} item{merchantItems.length === 1 ? "" : "s"} ·{" "}
                        {money(
                          merchantItems.reduce(
                            (sum, item) => sum + item.price * item.quantity,
                            0,
                          ),
                        )}{" "}
                        before shipping and tax, which {merchant} calculates in its checkout.
                      </p>

                      <p className="pathTag">Path A — check out here</p>

                      {state.error && (
                        <div className="errorBox" role="alert">
                          <p>{state.error}</p>
                          {(fallbackItem?.sourceUrl || state.fallbackUrl) && (
                            <p>
                              <a
                                href={fallbackItem?.sourceUrl ?? state.fallbackUrl}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Buy it at {merchant} instead ↗
                              </a>
                            </p>
                          )}
                        </div>
                      )}

                      {!session ? (
                        <button
                          type="button"
                          className="btnCoral btnBlock"
                          disabled={
                            state.busy ||
                            !accessCode.trim() ||
                            !guestDetailsValid ||
                            !buyerConsent
                          }
                          onClick={() => void startStoreCheckout(merchant)}
                        >
                          {state.busy
                            ? `Starting checkout at ${merchant}…`
                            : `Start checkout at ${merchant}`}
                        </button>
                      ) : (
                        <div>
                          <p>
                            <strong>Checkout started at {merchant}.</strong>{" "}
                            {session.destinationAccepted
                              ? "Your delivery address was accepted. "
                              : "Confirm your delivery address on the store's payment step. "}
                            {merchant} reports the session status as “{session.status}”.
                          </p>
                          <div className="sessionTotals" aria-label={`${merchant} totals`}>
                            {session.totals.map((line) => (
                              <div
                                className={`totalsRow ${line.type === "total" ? "grand" : ""}`}
                                key={`${line.type}-${line.displayText}`}
                              >
                                <span>{line.displayText}</span>
                                <span>{money(line.amount)}</span>
                              </div>
                            ))}
                          </div>
                          {session.messages.length > 0 && (
                            <ul className="sessionMessages">
                              {session.messages.map((message, index) => (
                                <li key={`${message.code}-${index}`}>{message.content}</li>
                              ))}
                            </ul>
                          )}
                          {session.policyLinks.length > 0 && (
                            <div className="policyLinkList">
                              {session.policyLinks.map((link) => (
                                <a key={link.url} href={link.url} target="_blank" rel="noreferrer">
                                  {merchant} {link.title} ↗
                                </a>
                              ))}
                            </div>
                          )}
                          {session.continueUrl ? (
                            <div className="viewActions">
                              <a
                                className="btnCoral"
                                href={session.continueUrl}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Pay at {merchant} ↗
                              </a>
                              <button
                                type="button"
                                className="btnOutline"
                                disabled={state.statusBusy}
                                onClick={() => void checkStoreOrder(merchant)}
                              >
                                {state.statusBusy
                                  ? "Checking…"
                                  : "I've paid — check for my order"}
                              </button>
                            </div>
                          ) : (
                            <p className="mutedText">
                              {merchant} did not return a payment step for this
                              session. Use the store link in the cart above to buy
                              the item on its site instead.
                            </p>
                          )}
                          {state.statusNote && <p className="mutedText">{state.statusNote}</p>}
                          {session.expiresAt && (
                            <p className="mutedText">
                              This checkout session expires {formatDateTime(session.expiresAt)}.
                            </p>
                          )}
                        </div>
                      )}
                      <div className="pathBlock">
                        <p className="pathTag">Path B — continue at {merchant}</p>
                        <p className="mutedText">
                          Prefer the store&apos;s own checkout? We load these
                          items into {merchant}&apos;s cart for you — you enter
                          your details and pay on {merchant}&apos;s site.
                          Nothing about you is sent from here.
                        </p>
                        {state.cartError && (
                          <div className="errorBox" role="alert">
                            <p>{state.cartError}</p>
                            {(fallbackItem?.sourceUrl || state.fallbackUrl) && (
                              <p>
                                <a
                                  href={fallbackItem?.sourceUrl ?? state.fallbackUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  Open the product at {merchant} instead ↗
                                </a>
                              </p>
                            )}
                          </div>
                        )}
                        <button
                          type="button"
                          className="btnOutline btnBlock"
                          disabled={state.cartBusy || !accessCode.trim()}
                          onClick={() => void continueAtStore(merchant)}
                        >
                          {state.cartBusy
                            ? `Preparing your cart at ${merchant}…`
                            : `Continue at ${merchant} ↗`}
                        </button>
                        {state.cartUrl && (
                          <p>
                            <a
                              className="btnCoral"
                              href={state.cartUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Open your {merchant} cart ↗
                            </a>
                          </p>
                        )}
                        {state.cartNote && (
                          <p className="mutedText">{state.cartNote}</p>
                        )}
                      </div>
                      {!accessCode.trim() && (
                        <p className="consentHint">
                          Enter your access code above to enable checkout.
                        </p>
                      )}
                    </section>
                  );
                })}
              </section>
            )}
          </div>
        )}
      </main>
    );
  }

  function renderOrderCard(order: StoreOrder) {
    const total = orderTotal(order);
    return (
      <article className="orderCard" key={order.orderId}>
        <div className="orderHead">
          <div className="orderMain">
            <p className="orderNumber">{order.orderId}</p>
            <h4>{order.merchant}</h4>
            <small>
              Confirmed by {order.merchant} · {formatDateTime(order.confirmedAt)} · Guest:{" "}
              {order.buyerEmail}
            </small>
          </div>
          {order.status && <span className="statusBadge">{order.status}</span>}
        </div>
        <div className="cartList">
          {order.items.map((item, index) => (
            <div className="cartItem" key={`${item.title}-${index}`}>
              <div className="cartItemBody">
                <strong>{item.title}</strong>
                <small>Qty {item.quantity}</small>
              </div>
              <div className="cartPriceCol">
                <strong>{money(item.price * item.quantity)}</strong>
              </div>
            </div>
          ))}
        </div>
        {total !== null && (
          <p className="confirmationMeta">
            Total charged by {order.merchant}: {money(total)} {order.currency}
          </p>
        )}
        <p className="confirmationMeta">
          Delivery, tracking, and returns are handled by {order.merchant} under its own
          policies.
          {order.orderUrl && (
            <>
              {" "}
              <a href={order.orderUrl} target="_blank" rel="noreferrer">
                View this order at {order.merchant} ↗
              </a>
            </>
          )}
        </p>
      </article>
    );
  }

  function renderConfirmation() {
    return (
      <main className="wrap flowMain">
        <h2 className="viewTitle">Order confirmed</h2>
        <div className="flowCard">
          <p>
            The selling store confirmed this order — the details below are exactly
            what the store returned. The store will also email its own
            confirmation to the guest email used at checkout.
          </p>
          <div className="confirmationGrid">
            {placedOrders.map((order) => renderOrderCard(order))}
          </div>
          <div className="viewActions">
            <button type="button" className="btnPine" onClick={() => setView("orders")}>
              View orders
            </button>
            <button type="button" className="btnOutline" onClick={goHome}>
              Continue shopping
            </button>
          </div>
        </div>
      </main>
    );
  }

  function renderHandoffCard(handoff: StoreHandoff) {
    return (
      <article
        className="orderCard"
        key={`handoff-${handoff.merchant}-${handoff.handedOffAt}`}
      >
        <div className="orderHead">
          <div className="orderMain">
            <p className="orderNumber">Completed at the store</p>
            <h4>{handoff.merchant}</h4>
            <small>
              Sent to {handoff.merchant}&apos;s cart ·{" "}
              {formatDateTime(handoff.handedOffAt)}
            </small>
          </div>
          <span className="statusBadge">At {handoff.merchant}</span>
        </div>
        <div className="cartList">
          {handoff.items.map((item, index) => (
            <div className="cartItem" key={`${item.title}-${index}`}>
              <div className="cartItemBody">
                <strong>{item.title}</strong>
                <small>Qty {item.quantity}</small>
              </div>
              <div className="cartPriceCol">
                <strong>{money(item.price * item.quantity)}</strong>
              </div>
            </div>
          ))}
        </div>
        <p className="confirmationMeta">
          Items total when handed off: {money(handoff.itemsTotal)}. You entered
          your details and paid on {handoff.merchant}&apos;s site —{" "}
          {handoff.merchant} handles the order, delivery, and returns.
          {handoff.cartUrl && (
            <>
              {" "}
              <a href={handoff.cartUrl} target="_blank" rel="noreferrer">
                Open the cart at {handoff.merchant} ↗
              </a>
            </>
          )}
        </p>
      </article>
    );
  }

  function renderOrders() {
    const entries = mergeOrderHistory(orders, handoffs);
    return (
      <main className="wrap flowMain">
        <h2 className="viewTitle">Orders</h2>
        {entries.length === 0 ? (
          <div className="flowCard">
            <p className="mutedText">
              No orders yet. When a store confirms an order from a checkout here,
              it will appear with the store&apos;s own confirmation details.
            </p>
          </div>
        ) : (
          <div className="orderList">
            {entries.map((entry) =>
              entry.kind === "order"
                ? renderOrderCard(entry.order)
                : renderHandoffCard(entry.handoff),
            )}
          </div>
        )}
      </main>
    );
  }

  return (
    <div>
      <header className="siteHeader">
        <div className="wrap headerInner">
          <button type="button" className="wordmark" onClick={goHome} aria-label="Not Delivered in the Blue Truck — home">
            Not Delivered in the <span>Blue Truck</span>
          </button>
          {view !== "home" && (
            <>
              <form className="headerSearch" onSubmit={onHeaderSearch} role="search">
                <label className="sr-only" htmlFor="site-search">
                  Search products
                </label>
                <input
                  id="site-search"
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search products"
                  autoComplete="off"
                />
                <button type="submit" disabled={loading}>
                  {loading ? "Searching…" : "Search"}
                </button>
              </form>
              <nav className="headerNav" aria-label="Account">
                <button type="button" className="headerNavBtn" onClick={() => setView("orders")}>
                  Orders
                </button>
                <button type="button" className="headerNavBtn" onClick={() => setView("cart")}>
                  Cart
                  {cartTotals.count > 0 && <span className="cartBadge">{cartTotals.count}</span>}
                </button>
              </nav>
            </>
          )}
        </div>
      </header>

      {error && (
        <div className="wrap">
          <div className="errorBox" role="alert">
            <p>{error}</p>
          </div>
        </div>
      )}

      {view === "home" && renderHome()}
      {view === "results" && renderResults()}
      {view === "product" && renderProduct()}
      {view === "cart" && renderCart()}
      {view === "confirmation" && placedOrders.length > 0 && renderConfirmation()}
      {view === "confirmation" && placedOrders.length === 0 && renderOrders()}
      {view === "orders" && renderOrders()}

      <footer className="siteFooter">
        <div className="wrap footerInner footerLine">
          <span>
            <strong>{BRAND.name}</strong> — shop them all, in one place.
          </span>
          <nav className="footerLinks" aria-label="Site links">
            <a href="/orders">Orders</a>
            <a href="/privacy">Privacy Policy</a>
            <a href="/terms">Terms of Service</a>
            <a href="/list-your-store">List your store</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
