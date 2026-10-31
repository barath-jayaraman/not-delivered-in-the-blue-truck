"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  CartItem,
  DecideResponse,
  Priority,
  ProductSummary,
  PrototypeOrder,
  ReturnMethod,
  ScoredOffer,
  SearchResponse,
} from "@/lib/types";
import { BRAND } from "@/lib/config";
import { CATEGORY_IMAGES, CATEGORY_TILES, productImage } from "@/lib/images";

const ORDER_STORAGE_KEY = "not-delivered-in-the-blue-truck-prototype-orders-v1";

/** The comparison always asks for delivery within a week in this prototype. */
const NEED_BY_DAYS = 7;

type View = "home" | "results" | "product" | "cart" | "confirmation" | "orders";
type SortMode = "featured" | "price" | "fastest";

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

function countdown(order: PrototypeOrder, now: number) {
  if (order.returnCost === "final-sale" || !order.returnDeadline) {
    return {
      label: "Final sale — returns are not available for this sample order.",
      canReturn: false,
      expired: true,
    };
  }
  const remainingMs = new Date(order.returnDeadline).getTime() - now;
  if (remainingMs <= 0) {
    return {
      label: `Return window closed on ${formatDate(order.returnDeadline)}.`,
      canReturn: false,
      expired: true,
    };
  }
  const totalMinutes = Math.floor(remainingMs / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  return {
    label: `${days} day${days === 1 ? "" : "s"}, ${hours} hr, ${minutes} min left — return by ${formatDate(order.returnDeadline)}`,
    canReturn: true,
    expired: false,
  };
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
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

  const [featured, setFeatured] = useState<ProductSummary[]>([]);
  const [featuredLoaded, setFeaturedLoaded] = useState(false);
  const [searchMeta, setSearchMeta] = useState<{ query: string; products: ProductSummary[] } | null>(null);
  const [sort, setSort] = useState<SortMode>("featured");
  const [filterBrands, setFilterBrands] = useState<string[]>([]);
  const [filterMaxPrice, setFilterMaxPrice] = useState<number | null>(null);
  const [filterMaxDays, setFilterMaxDays] = useState<number | null>(null);

  const [result, setResult] = useState<DecideResponse | null>(null);
  const [priority, setPriority] = useState<Priority>("cheapest");
  /** Live-search groups currently openable: group id → the query that found it. */
  const [liveGroups, setLiveGroups] = useState<Record<string, string>>({});

  const [cart, setCart] = useState<CartItem[]>([]);
  const [cartNotice, setCartNotice] = useState<string | null>(null);
  const [guestName, setGuestName] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [guestAddress, setGuestAddress] = useState("");
  const [demoCard, setDemoCard] = useState("4242 4242 4242 4242");
  const [demoExpiry, setDemoExpiry] = useState("12/30");
  const [demoCvc, setDemoCvc] = useState("123");
  const [walmartConsent, setWalmartConsent] = useState(false);

  const [orders, setOrders] = useState<PrototypeOrder[]>([]);
  const [ordersLoaded, setOrdersLoaded] = useState(false);
  const [placedOrders, setPlacedOrders] = useState<PrototypeOrder[]>([]);
  const [returnMethods, setReturnMethods] = useState<Record<string, ReturnMethod>>({});
  const [labelOrderNumber, setLabelOrderNumber] = useState<string | null>(null);
  const [now, setNow] = useState(0);

  /* ----- order history persistence (local to the browser) ----- */
  useEffect(() => {
    setNow(Date.now());
    try {
      const raw = window.localStorage.getItem(ORDER_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as PrototypeOrder[];
        if (Array.isArray(parsed)) setOrders(parsed);
      }
    } catch {
      // A corrupted local prototype record should not break the shopping flow.
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

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  /* ----- featured products for the home view: LIVE category searches.
     Every figure on these cards was fetched live when the page loaded;
     nothing is stored or re-shown from an earlier fetch. ----- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const byId = new Map<string, ProductSummary>();
      for (const term of ["headphones", "tv", "coffee", "vacuum", "running shoes"]) {
        try {
          const res = await fetch(`/api/search?q=${encodeURIComponent(term)}`);
          if (!res.ok) continue;
          const data = (await res.json()) as SearchResponse;
          for (const product of data.products) {
            if (!byId.has(product.id)) byId.set(product.id, product);
          }
        } catch {
          // A failed category probe just leaves that product out of the grid.
        }
      }
      if (!cancelled) {
        setFeatured([...byId.values()]);
        // Featured cards open through the live decide path, re-fetching
        // live under the product's own name.
        setLiveGroups((previous) => {
          const next = { ...previous };
          for (const product of byId.values()) {
            if (!next[product.id]) next[product.id] = product.name;
          }
          return next;
        });
        setFeaturedLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Any cart change voids a previously given Walmart consent: the guest must
  // re-review exactly what they are authorizing.
  useEffect(() => {
    setWalmartConsent(false);
  }, [cart]);

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

  const cartHasWalmart = cart.some((item) => item.merchant === "Walmart");
  const walmartCartItems = cart.filter((item) => item.merchant === "Walmart");
  const labelOrder = orders.find((order) => order.confirmationNumber === labelOrderNumber);

  const resultBrands = useMemo(
    () => (searchMeta ? [...new Set(searchMeta.products.map((p) => p.brand))].sort() : []),
    [searchMeta],
  );

  const visibleResults = useMemo(() => {
    if (!searchMeta) return [];
    let list = searchMeta.products.filter((product) => {
      if (filterBrands.length > 0 && !filterBrands.includes(product.brand)) return false;
      if (filterMaxPrice !== null && product.lowestPrice > filterMaxPrice) return false;
      if (filterMaxDays !== null && product.fastestDeliveryDays > filterMaxDays) return false;
      return true;
    });
    if (sort === "price") list = [...list].sort((a, b) => a.lowestPrice - b.lowestPrice);
    if (sort === "fastest") {
      list = [...list].sort((a, b) => a.fastestDeliveryDays - b.fastestDeliveryDays);
    }
    return list;
  }, [searchMeta, filterBrands, filterMaxPrice, filterMaxDays, sort]);

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
      setError("Could not reach the prototype comparison engine. Try again.");
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
    setSort("featured");
    setFilterBrands([]);
    setFilterMaxPrice(null);
    setFilterMaxDays(null);
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
      setError("Could not reach prototype search. Try again.");
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
    };
    setCart((previous) => {
      const existing = previous.find((entry) => entry.offerId === offer.id);
      if (existing) {
        return previous.map((entry) =>
          entry.offerId === offer.id ? { ...entry, quantity: entry.quantity + 1 } : entry,
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

  function completeSandboxCheckout(e: React.FormEvent) {
    e.preventDefault();
    if (cart.length === 0) return;
    // Walmart Human Consent Gate: no consent, no checkout — even in sandbox.
    if (cartHasWalmart && !walmartConsent) return;

    const purchasedAt = new Date();
    const base = purchasedAt.getTime().toString(36).toUpperCase();
    const newOrders: PrototypeOrder[] = cart.map((item, index) => {
      const estimatedArrival = new Date(purchasedAt);
      estimatedArrival.setDate(estimatedArrival.getDate() + item.deliveryDays);
      const returnDeadline =
        item.returnCost === "final-sale"
          ? null
          : new Date(purchasedAt.getTime() + item.returnWindowDays * 86400000).toISOString();
      return {
        confirmationNumber: `NDBT-${base}-${index + 1}${randomSuffix()}`,
        productId: item.productId,
        productName: item.productName,
        imageUrl: item.imageUrl ?? null,
        offerId: item.offerId,
        merchant: item.merchant,
        seller: item.seller,
        condition: item.condition,
        quantity: item.quantity,
        price: item.price,
        shippingCost: item.shippingCost,
        totalCost: item.totalCost * item.quantity,
        deliveryDays: item.deliveryDays,
        estimatedArrival: estimatedArrival.toISOString(),
        purchasedAt: purchasedAt.toISOString(),
        returnWindowDays: item.returnWindowDays,
        returnCost: item.returnCost,
        returnDeadline,
        guestName,
        guestEmail,
        consentGateConfirmed: item.merchant === "Walmart" ? walmartConsent : undefined,
        status: "Sample order confirmed",
        dataSource: "sample",
      };
    });

    setOrders((previous) => [...newOrders, ...previous]);
    setPlacedOrders(newOrders);
    setCart([]);
    setCartNotice(null);
    setNow(Date.now());
    setView("confirmation");
  }

  function initiateReturn(order: PrototypeOrder) {
    const method = returnMethods[order.confirmationNumber] ?? "UPS drop-off";
    const updated: PrototypeOrder = {
      ...order,
      status: "Sample return initiated",
      returnRequest: {
        method,
        requestedAt: new Date().toISOString(),
        labelNumber: `SAMPLE-${randomSuffix()}-${order.confirmationNumber.slice(-4)}`,
        status: "Sample return label created",
      },
    };
    setOrders((previous) =>
      previous.map((entry) => (entry.confirmationNumber === order.confirmationNumber ? updated : entry)),
    );
    setPlacedOrders((previous) =>
      previous.map((entry) => (entry.confirmationNumber === order.confirmationNumber ? updated : entry)),
    );
    setLabelOrderNumber(order.confirmationNumber);
  }

  /* ----- views ----- */

  function renderHome() {
    return (
      <main className="wrap">
        <section className="section homeCategories" aria-label="Categories">
          <div className="categoryGrid">
            {CATEGORY_TILES.map((tile) => (
              <button
                key={tile.label}
                type="button"
                className="categoryTile"
                onClick={() => void runSearch(tile.searchTerm)}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className="catPhoto" src={tile.image} alt="" />
                <strong>{tile.label}</strong>
              </button>
            ))}
          </div>
        </section>

        <section className="section" aria-labelledby="featured-products">
          <div className="sectionHead">
            <h2 id="featured-products">Featured products</h2>
          </div>
          {featured.length === 0 ? (
            <p className="loadingNote">
              {featuredLoaded
                ? "Live picks are unavailable right now — search above to compare live offers."
                : "Loading live products…"}
            </p>
          ) : (
            <div className="productGrid">
              {featured.map((product) => (
                <article className="productCard" key={product.id}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img className="productPhoto" src={summaryImage(product)} alt={product.name} />
                  <div className="productBody">
                    <h3>
                      {product.name}
                      {product.dataSource === "live" && (
                        <span className="livePill">Live</span>
                      )}
                    </h3>
                    <div className="fromPrice">
                      From<strong>{money(product.lowestPrice)}</strong>
                    </div>
                    <p className="arrivalLine">
                      Arrives in as fast as {product.fastestDeliveryDays} days
                    </p>
                    <button
                      type="button"
                      className="btnPine"
                      onClick={() => void openProduct(product.id)}
                    >
                      View
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
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
              <option value="featured">Featured</option>
              <option value="price">Price: low to high</option>
              <option value="fastest">Fastest delivery</option>
            </select>
          </label>
        </div>

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
                <h3>Price</h3>
                {(
                  [
                    [null, "Any price"],
                    [200, "Under $200"],
                    [300, "Under $300"],
                    [500, "Under $500"],
                    [1000, "Under $1,000"],
                  ] as [number | null, string][]
                ).map(([value, label]) => (
                  <label className="filterOption" key={label}>
                    <input
                      type="radio"
                      name="filter-price"
                      checked={filterMaxPrice === value}
                      onChange={() => setFilterMaxPrice(value)}
                    />
                    {label}
                  </label>
                ))}
              </div>
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
              <strong>No products to show</strong>
              <p>
                {total === 0
                  ? `Nothing matched “${searchMeta?.query}” — not in the catalog, and live search at Walmart and eBay returned nothing for it. Try headphones, a 55 inch TV, a robot vacuum, running shoes, or a coffee maker.`
                  : "No products match the selected filters. Loosen a filter to see more."}
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
              {result.offers.map((offer) => {
                const isWinner = offer.id === winnerId;
                return (
                  <tr key={offer.id} className={isWinner ? "winnerRow" : ""}>
                    <td data-label="Merchant / Seller">
                      <span className="sellerCellInner">
                        {isWinner && <span className="winnerPill">★ Best Whole Deal</span>}
                        <span className="merchantName">{offer.merchant}</span>
                        <span className="sellerName">{offer.seller}</span>
                        <span className="conditionLine">
                          {offer.condition} · {offer.sellerRating.toFixed(1)} seller rating
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
                      <button
                        type="button"
                        className={`addBtn ${isWinner ? "btnCoral" : "btnOutline"}`}
                        onClick={() => addToCart(offer)}
                      >
                        Add to cart
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

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
                      {item.condition} · Qty {item.quantity} · Arrives {arrivalDate(item.deliveryDays)} ·{" "}
                      {item.returnWindowDays}-day return window
                    </small>
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
              <span>Shipping {cartTotals.shipping === 0 ? "Free" : money(cartTotals.shipping)}</span>
              <strong>Total {money(cartTotals.total)}</strong>
            </div>

            <form className="checkoutForm" onSubmit={completeSandboxCheckout}>
              <h4>Sandbox guest checkout — no login</h4>
              <p className="warningText">
                Do not enter a real payment card. These fields stay in this page, are not
                transmitted or stored, and completing checkout creates only a local sample
                order. It does not place an order with eBay, Best Buy, or any retailer.
              </p>
              <div className="formGrid">
                <label className="field">
                  <span>Guest name</span>
                  <input value={guestName} onChange={(e) => setGuestName(e.target.value)} autoComplete="name" required />
                </label>
                <label className="field">
                  <span>Guest email</span>
                  <input type="email" value={guestEmail} onChange={(e) => setGuestEmail(e.target.value)} autoComplete="email" required />
                </label>
                <label className="field formWide">
                  <span>Delivery address (prototype only)</span>
                  <input value={guestAddress} onChange={(e) => setGuestAddress(e.target.value)} autoComplete="street-address" required />
                </label>
                <label className="field">
                  <span>Demo card number</span>
                  <input value={demoCard} onChange={(e) => setDemoCard(e.target.value)} inputMode="numeric" autoComplete="off" required />
                </label>
                <label className="field">
                  <span>Demo expiry</span>
                  <input value={demoExpiry} onChange={(e) => setDemoExpiry(e.target.value)} autoComplete="off" required />
                </label>
                <label className="field">
                  <span>Demo CVC</span>
                  <input value={demoCvc} onChange={(e) => setDemoCvc(e.target.value)} inputMode="numeric" autoComplete="off" required />
                </label>
              </div>

              {cartHasWalmart && (
                <section className="consentGate" aria-labelledby="consent-gate-heading">
                  <p className="label">Human Consent Gate — required for Walmart</p>
                  <h4 id="consent-gate-heading">Review and authorize the Walmart purchase</h4>
                  <p>
                    Walmart&apos;s Agentic Access Terms require a person to approve every
                    purchase: the agent never checks out on its own, and your
                    payment-card details are never shared with the agent. This sandbox
                    mirrors that rule — review the Walmart item below, then confirm to
                    continue.
                  </p>
                  <ul className="consentReview">
                    {walmartCartItems.map((item) => (
                      <li key={item.offerId}>
                        <strong>{item.productName}</strong> · Ships from and sold by{" "}
                        {item.seller} · {money(item.totalCost * item.quantity)} all-in ·
                        estimated arrival {arrivalDate(item.deliveryDays)} ·{" "}
                        {item.returnWindowDays}-day sample return window
                      </li>
                    ))}
                  </ul>
                  <label className="consentCheck">
                    <input
                      type="checkbox"
                      checked={walmartConsent}
                      onChange={(e) => setWalmartConsent(e.target.checked)}
                      required
                    />
                    <span>
                      <strong>I authorize this purchase</strong> — I reviewed the merchant,
                      item, total, and delivery above and approve this Walmart checkout.
                    </span>
                  </label>
                </section>
              )}

              <button
                className="btnCoral btnBlock"
                type="submit"
                disabled={cartHasWalmart && !walmartConsent}
              >
                Complete sandbox checkout — no charge
              </button>
              {cartHasWalmart && !walmartConsent && (
                <p className="consentHint">
                  The Walmart consent gate above must be confirmed before checkout can
                  complete.
                </p>
              )}
            </form>
          </div>
        )}
      </main>
    );
  }

  function renderConfirmation() {
    return (
      <main className="wrap flowMain">
        <h2 className="viewTitle">Order confirmed</h2>
        <div className="flowCard">
          <p>
            Sample order confirmed — no real retailer order was placed. In the live product
            design, the customer would receive both the retailer&apos;s confirmation and
            our confirmation email. <strong>No email was sent by this prototype.</strong>
          </p>
          <div className="confirmationGrid">
            {placedOrders.map((order) => (
              <article className="confirmationCard" key={order.confirmationNumber}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className="cartThumb" src={recordImage(order)} alt={order.productName} />
                <div>
                  <dl>
                    <div>
                      <dt>Confirmation number</dt>
                      <dd>{order.confirmationNumber}</dd>
                    </div>
                    <div>
                      <dt>Product</dt>
                      <dd>{order.productName}</dd>
                    </div>
                    <div>
                      <dt>Seller</dt>
                      <dd>Ships from and sold by {order.seller}</dd>
                    </div>
                    <div>
                      <dt>Total</dt>
                      <dd>{money(order.totalCost)}</dd>
                    </div>
                  </dl>
                  <p className="confirmationMeta">
                    Sample estimated arrival: {formatDate(order.estimatedArrival)} · Guest:{" "}
                    {order.guestName} ({order.guestEmail})
                  </p>
                  {order.consentGateConfirmed && (
                    <p className="confirmationMeta">
                      Walmart Human Consent Gate: confirmed by the guest before checkout, as
                      Walmart&apos;s Agentic Access Terms require.
                    </p>
                  )}
                </div>
              </article>
            ))}
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

  function renderOrders() {
    return (
      <main className="wrap flowMain">
        <h2 className="viewTitle">Orders</h2>
        {orders.length === 0 ? (
          <div className="flowCard">
            <p className="mutedText">
              No sample orders yet. Completed sandbox checkouts will appear here with a live
              return countdown.
            </p>
          </div>
        ) : (
          <div className="orderList">
            {orders.map((order) => {
              const status = countdown(order, now);
              const canInitiate = status.canReturn && !order.returnRequest;
              return (
                <article className="orderCard" key={order.confirmationNumber}>
                  <div className="orderHead">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img className="orderThumb" src={recordImage(order)} alt={order.productName} />
                    <div className="orderMain">
                      <p className="orderNumber">{order.confirmationNumber}</p>
                      <h4>{order.productName}</h4>
                      <p>Ships from and sold by {order.seller}</p>
                      <small>
                        Purchased {formatDateTime(order.purchasedAt)} · Sample arrival{" "}
                        {formatDate(order.estimatedArrival)} · {money(order.totalCost)} · Qty{" "}
                        {order.quantity}
                      </small>
                    </div>
                    <span className={`statusBadge ${order.returnRequest ? "statusReturn" : ""}`}>
                      {order.status}
                    </span>
                  </div>

                  <div className={`countdownBox ${status.expired ? "countdownExpired" : ""}`}>
                    <span>Live return countdown</span>
                    <strong>{status.label}</strong>
                    {order.returnDeadline && (
                      <small>Deadline: {formatDateTime(order.returnDeadline)}</small>
                    )}
                  </div>

                  {order.returnRequest ? (
                    <div className="returnActions">
                      <p>
                        Sample return initiated via {order.returnRequest.method}. Label number{" "}
                        {order.returnRequest.labelNumber}.
                      </p>
                      <button
                        className="btnOutline"
                        type="button"
                        onClick={() => setLabelOrderNumber(order.confirmationNumber)}
                      >
                        View sample return label
                      </button>
                    </div>
                  ) : canInitiate ? (
                    <div className="returnActions">
                      <label className="field returnMethodField">
                        <span>Return method</span>
                        <select
                          value={returnMethods[order.confirmationNumber] ?? "UPS drop-off"}
                          onChange={(e) =>
                            setReturnMethods((previous) => ({
                              ...previous,
                              [order.confirmationNumber]: e.target.value as ReturnMethod,
                            }))
                          }
                        >
                          <option>UPS drop-off</option>
                          <option>UPS pickup</option>
                        </select>
                      </label>
                      <button className="btnOutline" type="button" onClick={() => initiateReturn(order)}>
                        Initiate prototype return
                      </button>
                    </div>
                  ) : (
                    <p className="mutedText">No prototype return can be initiated for this order.</p>
                  )}
                </article>
              );
            })}
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
        <div className="wrap footerInner">
          <div>
            <strong>{BRAND.name}</strong>
            <p>Built by {BRAND.company}.</p>
          </div>
          <span className="prototypeTag">Live prices, fetched when you search · Prototype checkout.</span>
        </div>
      </footer>

      {labelOrder?.returnRequest && (
        <div className="labelOverlay" role="dialog" aria-labelledby="label-heading">
          <div className="labelCard">
            <div className="labelWatermark" aria-hidden="true">
              SAMPLE
            </div>
            <p className="labelWarning">SAMPLE RETURN LABEL — NOT A REAL UPS LABEL</p>
            <h3 id="label-heading">Prototype return label</h3>
            <p className="shipsLine">Return to: {labelOrder.seller}</p>
            <dl>
              <div>
                <dt>From</dt>
                <dd>{labelOrder.guestName}</dd>
              </div>
              <div>
                <dt>Product</dt>
                <dd>{labelOrder.productName}</dd>
              </div>
              <div>
                <dt>Sold by</dt>
                <dd>{labelOrder.seller}</dd>
              </div>
              <div>
                <dt>Confirmation</dt>
                <dd>{labelOrder.confirmationNumber}</dd>
              </div>
              <div>
                <dt>Method</dt>
                <dd>{labelOrder.returnRequest.method}</dd>
              </div>
              <div>
                <dt>Sample tracking</dt>
                <dd>{labelOrder.returnRequest.labelNumber}</dd>
              </div>
            </dl>
            <div className="barcode" aria-hidden="true" />
            <p className="labelFinePrint">
              This label is generated locally for interface demonstration only. No retailer
              return was created, no carrier shipment exists, and this label must not be used
              to send an item.
            </p>
            <div className="labelButtons">
              <button className="btnCoral" type="button" onClick={() => window.print()}>
                Print sample label
              </button>
              <button className="btnOutline" type="button" onClick={() => setLabelOrderNumber(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
