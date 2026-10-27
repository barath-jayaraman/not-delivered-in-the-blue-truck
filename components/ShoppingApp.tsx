"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  CartItem,
  DecideResponse,
  Merchant,
  Priority,
  ProductSummary,
  PrototypeOrder,
  ReturnMethod,
  ScoredOffer,
  SearchResponse,
} from "@/lib/types";
import { BRAND } from "@/lib/config";

const ORDER_STORAGE_KEY = "not-delivered-in-the-blue-truck-prototype-orders-v1";

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

const EXAMPLES = [
  "Bose headphones",
  "Bose headphones Ultra two",
  "running shoes",
  "55 inch TV",
  "robot vacuum",
  "coffee maker",
];

function formatDate(value: Date | string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(typeof value === "string" ? new Date(value) : value);
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

function returnsLabel(offer: ScoredOffer): string {
  if (offer.returnCost === "final-sale") return "Final sale — no returns";
  return `${offer.returnWindowDays} days · ${
    offer.returnCost === "free" ? "free returns" : "buyer-paid return shipping"
  }`;
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

export default function ShoppingApp() {
  const [query, setQuery] = useState("Bose headphones");
  const [budget, setBudget] = useState("");
  const [needByDays, setNeedByDays] = useState(7);
  const [priority, setPriority] = useState<Priority>("cheapest");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [matches, setMatches] = useState<ProductSummary[]>([]);
  const [result, setResult] = useState<DecideResponse | null>(null);
  const [selectedOfferId, setSelectedOfferId] = useState<string | null>(null);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [cartNotice, setCartNotice] = useState<string | null>(null);
  const [guestName, setGuestName] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [guestAddress, setGuestAddress] = useState("");
  const [demoCard, setDemoCard] = useState("4242 4242 4242 4242");
  const [demoExpiry, setDemoExpiry] = useState("12/30");
  const [demoCvc, setDemoCvc] = useState("123");
  const [orders, setOrders] = useState<PrototypeOrder[]>([]);
  const [ordersLoaded, setOrdersLoaded] = useState(false);
  const [placedOrders, setPlacedOrders] = useState<PrototypeOrder[]>([]);
  const [returnMethods, setReturnMethods] = useState<Record<string, ReturnMethod>>({});
  const [labelOrderNumber, setLabelOrderNumber] = useState<string | null>(null);
  const [now, setNow] = useState(0);

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

  const selectedOffer = useMemo(
    () => result?.offers.find((offer) => offer.id === selectedOfferId) ?? result?.recommendation,
    [result, selectedOfferId],
  );

  const cartTotals = useMemo(() => {
    const subtotal = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const shipping = cart.reduce((sum, item) => sum + item.shippingCost * item.quantity, 0);
    return { subtotal, shipping, total: subtotal + shipping, count: cart.reduce((n, i) => n + i.quantity, 0) };
  }, [cart]);

  const labelOrder = orders.find((order) => order.confirmationNumber === labelOrderNumber);

  async function openProduct(productId: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId,
          budget: budget ? Number(budget) : null,
          needByDays,
          priority,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not load that product comparison.");
        return;
      }
      const decideResult = data as DecideResponse;
      setResult(decideResult);
      setSelectedOfferId(decideResult.recommendation.id);
    } catch {
      setError("Could not reach the prototype comparison engine. Try again.");
    } finally {
      setLoading(false);
    }
  }

  async function onSearch(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);
    setSelectedOfferId(null);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      const data = (await res.json()) as SearchResponse & { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Search failed.");
        setMatches([]);
        return;
      }
      setMatches(data.products);
      if (data.products.length === 0) {
        setError(
          `No sample prototype products match “${query}”. Try Bose headphones, running shoes, a 55 inch TV, a robot vacuum, or a coffee maker.`,
        );
      } else if (data.products.length === 1) {
        await openProduct(data.products[0].id);
      }
    } catch {
      setError("Could not reach prototype search. Try again.");
    } finally {
      setLoading(false);
    }
  }

  function addToCart(offer: ScoredOffer) {
    if (!result) return;
    const item: CartItem = {
      productId: result.product.id,
      productName: result.product.name,
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
    setCartNotice(`${result.product.name} from ${offer.seller} was added to the prototype cart.`);
  }

  function removeFromCart(offerId: string) {
    setCart((previous) => previous.filter((item) => item.offerId !== offerId));
  }

  function completeSandboxCheckout(e: React.FormEvent) {
    e.preventDefault();
    if (cart.length === 0) return;

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
        status: "Sample order confirmed",
        dataSource: "sample",
      };
    });

    setOrders((previous) => [...newOrders, ...previous]);
    setPlacedOrders(newOrders);
    setCart([]);
    setCartNotice(null);
    setNow(Date.now());
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

  function renderOfferModule(merchant: Merchant) {
    if (!result) return null;
    const merchantOffers = result.offers.filter((offer) => offer.merchant === merchant);
    if (merchantOffers.length === 0) return null;
    const isEbay = merchant === "eBay";
    return (
      <section
        className={`merchantModule ${isEbay ? "ebayModule" : "bestBuyModule"}`}
        aria-label={`${merchant} sample offers`}
      >
        <div className="merchantHeader">
          <div>
            <span className={`merchantLogo ${isEbay ? "ebayLogo" : "bestBuyLogo"}`}>{merchant}</span>
            <h4>{isEbay ? "eBay offers — separate module" : "Best Buy offers"}</h4>
          </div>
          <p>
            {isEbay
              ? "Prototype presentation keeps eBay sample content visually separate and labelled. A future live module must re-query within the 6-hour freshness limit."
              : "Best Buy arrival is a sample shipping-service estimate, not an API ETA. Returns shown here are a curated retailer-policy sample."}
          </p>
        </div>
        <div className="tableWrap merchantTableWrap">
          <table className="compareTable">
            <thead>
              <tr>
                <th>Select</th>
                <th>Seller / condition</th>
                <th>Price</th>
                <th>Shipping</th>
                <th>Estimated arrival</th>
                <th>Returns</th>
                <th>Warranty · rating</th>
                <th>Score</th>
              </tr>
            </thead>
            <tbody>
              {merchantOffers.map((offer) => (
                <tr
                  key={offer.id}
                  className={`${offer.id === selectedOffer?.id ? "rowSelected" : ""} ${
                    offer.id === result.recommendation.id ? "rowWinner" : ""
                  }`}
                  onClick={() => setSelectedOfferId(offer.id)}
                >
                  <td>
                    <input
                      type="radio"
                      name="selected-offer"
                      aria-label={`Select ${offer.seller}`}
                      checked={offer.id === selectedOffer?.id}
                      onChange={() => setSelectedOfferId(offer.id)}
                    />
                  </td>
                  <td className="sellerCell">
                    <strong>{offer.seller}</strong>
                    <small>{offer.condition} · {offer.sampleListingLabel}</small>
                    {offer.id === result.recommendation.id && <span className="tag"> Recommended</span>}
                    <small className="provenance">
                      Source: sample data · Method: sample (production: API only) · Retrieved: not retrieved · Policy: api-only
                    </small>
                  </td>
                  <td>{money(offer.price)}</td>
                  <td>{offer.shippingCost === 0 ? "Free" : money(offer.shippingCost)}</td>
                  <td>
                    <strong>{arrivalDate(offer.deliveryDays)}</strong>
                    <small className="cellSub">{offer.deliveryDays} days · {offer.deliveryBasis}</small>
                  </td>
                  <td>
                    {returnsLabel(offer)}
                    <small className="cellSub">{offer.returnPolicySource}</small>
                  </td>
                  <td>{offer.warrantyMonths} mo · {offer.sellerRating.toFixed(1)}★</td>
                  <td><strong>{offer.score}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    );
  }

  return (
    <section id="app" className="appSection">
      <h2>Search once. Compare the whole offer.</h2>
      <p className="appIntro">
        Stage 1 prototype with guest checkout only. Search a category to see matching
        models, or search a specific model to open its top-five comparison.
      </p>
      <p className="prototypeNotice">{BRAND.betaNote}</p>

      <form className="searchForm" onSubmit={onSearch}>
        <label className="field fieldWide">
          <span>Search products</span>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. Bose headphones or Bose headphones Ultra two"
            required
          />
        </label>
        <label className="field">
          <span>Budget (optional, $)</span>
          <input
            type="number"
            min={1}
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            placeholder="No limit"
          />
        </label>
        <label className="field">
          <span>Need it within (days)</span>
          <input
            type="number"
            min={1}
            max={30}
            value={needByDays}
            onChange={(e) => setNeedByDays(Number(e.target.value))}
          />
        </label>
        <fieldset className="field priorityField">
          <legend>What matters most?</legend>
          <div className="priorityRow">
            {(
              [
                ["cheapest", "Cheapest"],
                ["fastest", "Fastest"],
                ["returns", "Easiest returns"],
              ] as [Priority, string][]
            ).map(([value, label]) => (
              <label key={value} className={`pill ${priority === value ? "pillActive" : ""}`}>
                <input
                  type="radio"
                  name="priority"
                  value={value}
                  checked={priority === value}
                  onChange={() => setPriority(value)}
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        <button className="ctaButton" type="submit" disabled={loading}>
          {loading ? "Searching…" : "Search sample catalog"}
        </button>
      </form>

      <div className="examples">
        Try:{" "}
        {EXAMPLES.map((example) => (
          <button key={example} type="button" className="exampleChip" onClick={() => setQuery(example)}>
            {example}
          </button>
        ))}
      </div>

      {error && (
        <div className="errorBox" role="alert">
          <p>{error}</p>
        </div>
      )}

      {matches.length > 1 && !result && (
        <div className="modelResults">
          <div className="sectionHeadingRow">
            <div>
              <p className="eyebrow">Sample search results</p>
              <h3>{matches.length} matching models</h3>
            </div>
            <span className="sampleBadge">Sample data</span>
          </div>
          <div className="modelGrid">
            {matches.map((item) => (
              <article className="modelCard" key={item.id}>
                <p className="modelCategory">{item.category}</p>
                <h4>{item.name}</h4>
                <p>
                  Sample prices {money(item.lowestPrice)}–{money(item.highestPrice)} · fastest
                  sample arrival in {item.fastestDeliveryDays} days · {item.offerCount} offers
                </p>
                <p className="provenanceText">
                  Sources: eBay + Best Buy sample records · Method: sample · Retrieved: not retrieved · Policy: api-only
                </p>
                <button className="secondaryButton" type="button" onClick={() => void openProduct(item.id)}>
                  Compare top five
                </button>
              </article>
            ))}
          </div>
        </div>
      )}

      {result && selectedOffer && (
        <div className="results">
          <div className="sectionHeadingRow productHeading">
            <div>
              <p className="eyebrow">Product comparison · sample data</p>
              <h3>{result.product.name}</h3>
              <p className="rangeLine">
                Sample price range <strong>{money(result.priceRange.lowest)}–{money(result.priceRange.highest)}</strong>
                {" "}· Fastest sample arrival: <strong>{result.fastestDeliveryDays} days</strong>
              </p>
            </div>
            <button className="secondaryButton" type="button" onClick={() => void openProduct(result.product.id)} disabled={loading}>
              Re-score with these preferences
            </button>
          </div>

          <article className="recCard">
            <div className="recHead">
              <span className="recBadge">Prototype recommendation</span>
              <span className="scoreBadge">Score {result.recommendation.score}/100</span>
            </div>
            <h3>{result.recommendation.seller}</h3>
            <p className="recExplanation">{result.explanation}</p>
            <p className="logicNote">
              This explanation is generated from our own comparison logic and parameter
              deltas. It is not trained on eBay Content.
            </p>
          </article>

          <h4 className="tableTitle">Top five options — grouped by merchant</h4>
          {renderOfferModule("eBay")}
          {renderOfferModule("Best Buy")}

          <article className="selectedPanel">
            <div>
              <p className="eyebrow">Selected offer</p>
              <h4>{selectedOffer.seller}</h4>
              <p>
                {money(selectedOffer.totalCost)} all-in · {selectedOffer.condition} · arrives{" "}
                {arrivalDate(selectedOffer.deliveryDays)} · {returnsLabel(selectedOffer)}
              </p>
              <p className="shipsSold">Ships from and sold by {selectedOffer.seller}</p>
            </div>
            <button className="ctaButton" type="button" onClick={() => addToCart(selectedOffer)}>
              Add selected offer to cart
            </button>
          </article>
          {cartNotice && <p className="successNotice">{cartNotice}</p>}
        </div>
      )}

      <section className="flowSection" aria-labelledby="cart-heading">
        <div className="sectionHeadingRow">
          <div>
            <p className="eyebrow">Guest prototype checkout</p>
            <h3 id="cart-heading">Cart {cartTotals.count > 0 ? `(${cartTotals.count})` : ""}</h3>
          </div>
          <span className="sampleBadge">No real charge</span>
        </div>

        {cart.length === 0 ? (
          <p className="mutedText">Your prototype cart is empty. Select an offer above and add it to the cart.</p>
        ) : (
          <>
            <div className="cartList">
              {cart.map((item) => (
                <article className="cartItem" key={item.offerId}>
                  <div>
                    <strong>{item.productName}</strong>
                    <p>Ships from and sold by {item.seller}</p>
                    <small>
                      {item.condition} · Qty {item.quantity} · Sample arrival in {item.deliveryDays} days · {item.returnWindowDays}-day sample return window
                    </small>
                  </div>
                  <div className="cartPrice">
                    <strong>{money(item.totalCost * item.quantity)}</strong>
                    <button type="button" className="textButton" onClick={() => removeFromCart(item.offerId)}>
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
              <button className="ctaButton" type="submit">
                Complete sandbox checkout — no charge
              </button>
            </form>
          </>
        )}
      </section>

      {placedOrders.length > 0 && (
        <section className="flowSection confirmationSection" aria-labelledby="confirmation-heading">
          <p className="eyebrow">Prototype confirmation</p>
          <h3 id="confirmation-heading">Sample order confirmed — no real retailer order was placed</h3>
          <p>
            In the live product design, the customer would receive both the retailer&apos;s
            confirmation and our confirmation email. <strong>No email was sent by this
            prototype.</strong>
          </p>
          {placedOrders.map((order) => (
            <article className="confirmationCard" key={order.confirmationNumber}>
              <div>
                <span>Confirmation number</span>
                <strong>{order.confirmationNumber}</strong>
              </div>
              <div>
                <span>Product</span>
                <strong>{order.productName}</strong>
              </div>
              <div>
                <span>Seller</span>
                <strong>Ships from and sold by {order.seller}</strong>
              </div>
              <div>
                <span>Total</span>
                <strong>{money(order.totalCost)}</strong>
              </div>
              <p>
                Sample estimated arrival: {formatDate(order.estimatedArrival)} · Guest: {order.guestName} ({order.guestEmail})
              </p>
            </article>
          ))}
        </section>
      )}

      <section className="flowSection" aria-labelledby="orders-heading">
        <div className="sectionHeadingRow">
          <div>
            <p className="eyebrow">Local prototype records</p>
            <h3 id="orders-heading">Order history</h3>
          </div>
          <span className="sampleBadge">Stored only in this browser</span>
        </div>
        {orders.length === 0 ? (
          <p className="mutedText">No sample orders yet. Completed sandbox checkouts will appear here with a live return countdown.</p>
        ) : (
          <div className="orderList">
            {orders.map((order) => {
              const status = countdown(order, now);
              const canInitiate = status.canReturn && !order.returnRequest;
              return (
                <article className="orderCard" key={order.confirmationNumber}>
                  <div className="orderMain">
                    <div>
                      <p className="orderNumber">{order.confirmationNumber}</p>
                      <h4>{order.productName}</h4>
                      <p>Ships from and sold by {order.seller}</p>
                      <small>
                        Purchased {formatDateTime(order.purchasedAt)} · Sample arrival {formatDate(order.estimatedArrival)} · {money(order.totalCost)} · Qty {order.quantity}
                      </small>
                    </div>
                    <span className={`statusBadge ${order.returnRequest ? "statusReturn" : ""}`}>{order.status}</span>
                  </div>

                  <div className={`countdownBox ${status.expired ? "countdownExpired" : ""}`}>
                    <span>Live return countdown</span>
                    <strong>{status.label}</strong>
                    {order.returnDeadline && <small>Deadline: {formatDateTime(order.returnDeadline)}</small>}
                  </div>

                  {order.returnRequest ? (
                    <div className="returnActions">
                      <p>
                        Sample return initiated via {order.returnRequest.method}. Label number {order.returnRequest.labelNumber}.
                      </p>
                      <button className="secondaryButton" type="button" onClick={() => setLabelOrderNumber(order.confirmationNumber)}>
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
                      <button className="secondaryButton" type="button" onClick={() => initiateReturn(order)}>
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
      </section>

      {labelOrder?.returnRequest && (
        <section className="labelOverlay" aria-labelledby="label-heading">
          <div className="labelCard printLabel">
            <p className="labelWarning">SAMPLE RETURN LABEL — NOT A REAL UPS LABEL</p>
            <h3 id="label-heading">Prototype return label</h3>
            <p className="shipsSold">Return to sample {labelOrder.merchant} returns processing</p>
            <dl>
              <div><dt>From</dt><dd>{labelOrder.guestName}</dd></div>
              <div><dt>Product</dt><dd>{labelOrder.productName}</dd></div>
              <div><dt>Sold by</dt><dd>{labelOrder.seller}</dd></div>
              <div><dt>Confirmation</dt><dd>{labelOrder.confirmationNumber}</dd></div>
              <div><dt>Method</dt><dd>{labelOrder.returnRequest.method}</dd></div>
              <div><dt>Sample tracking</dt><dd>{labelOrder.returnRequest.labelNumber}</dd></div>
            </dl>
            <div className="barcode" aria-hidden="true" />
            <p className="labelFinePrint">
              This label is generated locally for interface demonstration only. No retailer
              return was created, no carrier shipment exists, and this label must not be used
              to send an item.
            </p>
            <div className="labelButtons">
              <button className="ctaButton" type="button" onClick={() => window.print()}>
                Print sample label
              </button>
              <button className="secondaryButton" type="button" onClick={() => setLabelOrderNumber(null)}>
                Close
              </button>
            </div>
          </div>
        </section>
      )}
    </section>
  );
}
