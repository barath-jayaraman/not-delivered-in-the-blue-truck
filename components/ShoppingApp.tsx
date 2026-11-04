"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  DecideResponse,
  Priority,
  ProductSummary,
  ScoredOffer,
  SearchResponse,
} from "@/lib/types";
import { BRAND } from "@/lib/config";
import { CATEGORY_IMAGES, productImage } from "@/lib/images";

/** The comparison always asks for delivery within a week in this prototype. */
const NEED_BY_DAYS = 7;

type View = "home" | "results" | "product";
type SortMode = "price" | "fastest";

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

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

function arrivalFullDate(deliveryDays: number): string {
  const date = new Date();
  date.setDate(date.getDate() + deliveryDays);
  return formatFullDate(date);
}

function returnWindowLabel(offer: ScoredOffer): string {
  if (offer.returnCost === "final-sale") return "Final sale";
  // returnWindowDays null means the source stated no return window —
  // an absence of data, labelled exactly like warranty's absence.
  if (offer.returnWindowDays === null) return "Not stated by seller";
  return `${offer.returnWindowDays} days`;
}

function restockingFeeLabel(offer: ScoredOffer): string {
  // The fee renders only from a verified published policy (a stated
  // percentage, or "None" where the policy affirmatively supports
  // it). Anything else is an absence of data — never an inference.
  return offer.restockingFee ?? "Not stated by seller";
}

function returnCostLabel(offer: ScoredOffer): string {
  if (offer.returnCost === "free") return "Free";
  if (offer.returnCost === "buyer-paid") return "Buyer-paid";
  if (offer.returnCost === "not-stated") return "Not stated";
  return "—";
}

function warrantyLabel(offer: ScoredOffer): string {
  // A stated lifetime warranty is a label, not a month count.
  if (offer.warrantyLabel) return offer.warrantyLabel;
  // warrantyMonths 0 means the source stated no warranty period — that is
  // an absence of data, never a claim of "no warranty".
  if (offer.warrantyMonths <= 0) return "Not stated by seller";
  if (offer.warrantyMonths % 12 === 0) {
    const years = offer.warrantyMonths / 12;
    return `${years}-year warranty`;
  }
  return `${offer.warrantyMonths}-month warranty`;
}

/** An offer can be pre-loaded into the store's own cart only when
 *  it came from a UCP store and carries the merchant's purchasable
 *  item id — those offers get the store-checkout handoff button. */
function canPreloadStoreCart(offer: ScoredOffer): boolean {
  return offer.provenance.policyStatus === "ucp-public-profile" && !!offer.checkoutItemId;
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

  /** Per-offer store-checkout state, keyed by offer id. */
  const [checkoutSessions, setCheckoutSessions] = useState<
    Record<
      string,
      {
        fallbackUrl?: string;
        cartBusy?: boolean;
        cartUrl?: string;
        cartNote?: string;
        cartError?: string;
      }
    >
  >({});

  /* This site keeps no cart and no order history (Barath, Nov 4,
     2026): every purchase finishes on the selling store's own site,
     so there is nothing of the shopper's to remember here. */

  /* The search-only home (wonder-v7) makes no live calls on load:
     nothing is fetched until the shopper searches. */

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [view]);

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
      // A delivery-speed filter can only be satisfied by a STATED
      // delivery window — unstated (null) never passes it.
      if (
        filterMaxDays !== null &&
        (product.fastestDeliveryDays === null ||
          product.fastestDeliveryDays > filterMaxDays)
      )
        return false;
      return true;
    });
    if (sort === "price") list = [...list].sort((a, b) => a.lowestPrice - b.lowestPrice);
    if (sort === "fastest") {
      // Unstated delivery (null) sorts last — never as fastest.
      list = [...list].sort(
        (a, b) =>
          (a.fastestDeliveryDays ?? Number.POSITIVE_INFINITY) -
          (b.fastestDeliveryDays ?? Number.POSITIVE_INFINITY),
      );
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
    if (filterMinReturnDays !== null && (offer.returnWindowDays ?? 0) < filterMinReturnDays) return false;
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
    setView("home");
  }

  /* ----- store checkout (the site's only checkout path) ----- */

  function setCheckoutState(
    offerId: string,
    patch: Partial<{
      fallbackUrl: string;
      cartBusy: boolean;
      cartUrl: string;
      cartNote: string;
      cartError: string;
    }>,
  ) {
    setCheckoutSessions((previous) => ({
      ...previous,
      [offerId]: { ...previous[offerId], ...patch },
    }));
  }

  /**
   * The site's only checkout path, for one product from its product
   * page: ask the store to pre-load its own cart with this item and
   * hand back its continuation link. No buyer details are collected
   * or sent by this site — the buyer enters everything and pays on
   * the store's site. The returned link is rendered in the row
   * (popup blockers can't eat it) and also opened in a new tab.
   * Nothing is recorded here: the purchase finishes at the store,
   * so this site keeps no cart and no order history.
   */
  async function continueAtStore(offer: ScoredOffer) {
    if (!offer.checkoutItemId) return;
    const merchant = offer.merchant;
    setCheckoutState(offer.id, {
      cartBusy: true,
      cartUrl: undefined,
      cartNote: undefined,
      cartError: undefined,
    });
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "cartlink",
          merchant,
          items: [{ itemId: offer.checkoutItemId, quantity: 1 }],
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        fallbackUrl?: string;
        continueUrl?: string;
      };
      if (!res.ok || !data.ok || !data.continueUrl) {
        setCheckoutState(offer.id, {
          cartBusy: false,
          cartError:
            data.error ?? `${merchant} could not prepare a cart. Use the product link instead.`,
          fallbackUrl: data.fallbackUrl,
        });
        return;
      }
      window.open(data.continueUrl, "_blank", "noopener");
      setCheckoutState(offer.id, {
        cartBusy: false,
        cartUrl: data.continueUrl,
        cartNote:
          `Your item is in ${merchant}'s cart — the link opened in a new tab. ` +
          `Enter your details and pay on ${merchant}'s site.`,
      });
    } catch {
      setCheckoutState(offer.id, {
        cartBusy: false,
        cartError: `Could not reach ${merchant} to prepare a cart. Try again.`,
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
              <strong>Step 3 — Check out at the store.</strong>
            </p>
          </div>
        </div>

        <p className="heroHint">Searching 230 stores — and growing.</p>
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
                  ? `Nothing matched “${searchMeta?.query}” — live search at eBay, Walmart, and the UCP stores (Steve Madden, Gymshark, Everlane, Monos, Allbirds, Kith, Misen, SKIMS, Fenty Beauty, Lord & Taylor, Stein Mart, Scandinavian Designs, Slumberland, Pier 1, ShopLC, The Lakeside Collection, LTD Commodities, SkyMall, Mast General Store, Kane's Furniture, Steinhafels, Schneiderman's Furniture, FYE, DTLR, Beach Camera, Turtle Beach, Evo, FAO Schwarz, Casper, Away, HexClad, Lodge Cast Iron, Rad Power Bikes, The Sill, Brookstone, Sharper Image, Peak Design, Woodcraft, Arhaus, Bonobos), and the browsing-route stores (Micro Center, Harbor Freight, Carter's, Mattress Firm) returned nothing for it. Try headphones, a 55 inch TV, running shoes, leggings, a sweater, a carry-on, sneakers, a chef's knife, lip gloss, a sofa, a mattress, a camera, a snowboard, a frying pan, an electric bike, a plush toy, a laptop, a drill, or a bodysuit.`
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
                    <h3>{product.name}</h3>
                    <p className="resultFrom">
                      From <strong>{money(product.lowestPrice)}</strong>
                    </p>
                    <p className="arrivalLine">
                      {product.fastestDeliveryDays !== null
                        ? `Arrives in as fast as ${product.fastestDeliveryDays} days`
                        : "Delivery not stated by seller"}
                    </p>
                    {product.dataSource === "live" && (
                      <p className="resultMeta">
                        Live prices from {product.sourceMerchants.join(" · ")}
                        {product.sourceMerchants.length > 1
                          ? ` · Available at ${product.sourceMerchants.length} stores`
                          : ""}
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
    /* A single offer is not a "Best Whole Deal" — there is nothing it
       beat. Only crown a winner when stores actually compete. */
    const winnerId = result.offers.length > 1 ? result.recommendation.id : null;
    const visibleOffers = result.offers;
    /* Details: the winning offer's own listing description, exactly as
       its source returned it (fetched live and cleaned server-side —
       never generated). Falls back to the first offer that carries
       one; the section renders nothing when no offer does. */
    const detailsOffer =
      (result.recommendation.description ? result.recommendation : null) ??
      result.offers.find((offer) => offer.description) ??
      null;
    /* Counts are stated by distinct stores, not offers — several offers
       can come from a single store. */
    const storeCount = result.sourceMerchants.length;
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
          <h1>{result.product.name}</h1>
          <span className="titleFrom">
            from <strong>{money(result.priceRange.lowest)}</strong>
          </span>
        </div>

        <p className="productFacts">
          {storeCount === 1
            ? `${result.offers[0].condition} · `
            : `${storeCount} stores compared · ${money(result.priceRange.lowest)}–${money(result.priceRange.highest)} · `}
          {result.fastestDeliveryDays !== null
            ? `Arrives in as fast as ${result.fastestDeliveryDays} day${result.fastestDeliveryDays === 1 ? "" : "s"}`
            : "Delivery not stated by seller"}
        </p>

        {/* "Muse Spark's take" note removed from the product page
            (Barath, Nov 4, 2026 — display only; the /api/decide
            explanation machinery is untouched and can be restored by
            uncommenting this block).
        {result.explanation && (
          <p className="museNote">
            <strong>
              {result.agentActivity.mode === "live"
                ? "Muse Spark's take"
                : "Our take"}
              :
            </strong>{" "}
            {result.explanation}
          </p>
        )}
        */}

        {result.offers.length > 1 && (
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
        )}

        {visibleOffers.length === 0 ? (
          <div className="emptyBox">
            <strong>No offers for this product right now</strong>
            <p>Try the search again in a moment.</p>
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
                <th scope="col">Restocking fee</th>
                <th scope="col">Warranty</th>
                <th scope="col">
                  <span className="sr-only">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visibleOffers.map((offer) => {
                const isWinner = offer.id === winnerId;
                const checkoutState = checkoutSessions[offer.id] ?? {};
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
                        {offer.provenance.sourceUrl && (
                          <a
                            className="detailsLink"
                            href={offer.provenance.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            See full details at {offer.merchant} ↗
                          </a>
                        )}
                      </span>
                    </td>
                    <td data-label="Total (all-in)">
                      {offer.shippingCost === null ? (
                        <>
                          <span className="totalValue">{money(offer.price)}</span>
                          <span className="breakdown">
                            Shipping not stated — calculated at checkout
                          </span>
                        </>
                      ) : (
                        <>
                          <span className="totalValue">{money(offer.totalCost)}</span>
                          <span className="breakdown">
                            {money(offer.price)} +{" "}
                            {offer.shippingCost === 0
                              ? "free shipping"
                              : `${money(offer.shippingCost)} shipping`}
                          </span>
                        </>
                      )}
                    </td>
                    <td data-label="Delivery date">
                      {offer.deliveryDays === null ? (
                        <span className="deliveryDate">Not stated by seller</span>
                      ) : (
                        <>
                          <span className="deliveryDate">{arrivalFullDate(offer.deliveryDays)}</span>
                          <span className="arrivesSub">
                            Arrives in {offer.deliveryDays} day{offer.deliveryDays === 1 ? "" : "s"}
                          </span>
                        </>
                      )}
                    </td>
                    <td data-label="Return window">
                      {returnWindowLabel(offer)}
                      {offer.returnPolicyNote && (
                        <span className="breakdown">{offer.returnPolicyNote}</span>
                      )}
                    </td>
                    <td data-label="Return cost">{returnCostLabel(offer)}</td>
                    <td data-label="Restocking fee">{restockingFeeLabel(offer)}</td>
                    <td data-label="Warranty">{warrantyLabel(offer)}</td>
                    <td data-label="Action">
                      {canPreloadStoreCart(offer) ? (
                        <div>
                          <button
                            type="button"
                            className={`addBtn ${isWinner ? "btnCoral" : "btnOutline"}`}
                            disabled={checkoutState.cartBusy}
                            onClick={() => void continueAtStore(offer)}
                          >
                            {checkoutState.cartBusy
                              ? `Preparing your cart at ${offer.merchant}…`
                              : `Continue checkout at ${offer.merchant} ↗`}
                          </button>
                          {checkoutState.cartError && (
                            <p className="mutedText">
                              {checkoutState.cartError}{" "}
                              {offer.provenance.sourceUrl && (
                                <a
                                  href={offer.provenance.sourceUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  Open the product at {offer.merchant} instead ↗
                                </a>
                              )}
                            </p>
                          )}
                          {checkoutState.cartUrl && (
                            <p className="mutedText">
                              <a
                                href={checkoutState.cartUrl}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Open your {offer.merchant} cart ↗
                              </a>
                            </p>
                          )}
                          {checkoutState.cartNote && (
                            <p className="mutedText">{checkoutState.cartNote}</p>
                          )}
                        </div>
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

        {detailsOffer?.highlights && detailsOffer.highlights.length > 0 && (
          <section className="detailsSection" aria-label="Highlights">
            <h2>Highlights</h2>
            <ul className="highlightsList">
              {detailsOffer.highlights.map((highlight) => (
                <li key={highlight}>{highlight}</li>
              ))}
            </ul>
          </section>
        )}

        {detailsOffer?.description && (
          <section className="detailsSection" aria-label="Product details">
            <h2>Details</h2>
            <p>{detailsOffer.description}</p>
          </section>
        )}

        {result.dataSource === "live" && result.retrievedAt && (
          <p className="liveLine">
            Prices retrieved {formatDateTime(result.retrievedAt)} from{" "}
            {result.sourceMerchants.join(" and ")} — prices are the listings&apos; own,
            retrieved live for this comparison.
          </p>
        )}
        <p className="smallPrint">
          {result.agentActivity.mode === "live"
            ? "Details derived by Muse Spark"
            : "Details derived locally — live model unavailable for this request."}
        </p>
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

      <footer className="siteFooter">
        <div className="wrap footerInner footerLine">
          <span>
            <strong>{BRAND.name}</strong> — shop them all, in one place.
          </span>
          <nav className="footerLinks" aria-label="Site links">
            <a href="/privacy">Privacy Policy</a>
            <a href="/terms">Terms of Service</a>
            <a href="/list-your-store">List your store</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
