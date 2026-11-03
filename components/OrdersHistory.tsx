"use client";

import { useEffect, useState } from "react";
import type { StoreOrder } from "@/lib/types";
import {
  loadStoredHandoffs,
  loadStoredOrders,
  mergeOrderHistory,
  type OrderHistoryEntry,
  type StoreHandoff,
} from "@/lib/order-history";

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

/** Store total line for an order, as the store labeled it. */
function orderTotal(order: StoreOrder): number | null {
  const total = order.totals.find((line) => line.type === "total");
  return total ? total.amount : null;
}

function OrderCard({ order }: { order: StoreOrder }) {
  const total = orderTotal(order);
  return (
    <article className="orderCard">
      <div className="orderHead">
        <div className="orderMain">
          <p className="orderNumber">{order.orderId}</p>
          <h4>{order.merchant}</h4>
          <small>
            Confirmed by {order.merchant} · {formatDateTime(order.confirmedAt)} ·
            Guest: {order.buyerEmail}
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
        Delivery, tracking, and returns are handled by {order.merchant} under its
        own policies.
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

function HandoffCard({ handoff }: { handoff: StoreHandoff }) {
  return (
    <article className="orderCard">
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

/**
 * The order history recorded in THIS browser: store-confirmed in-app
 * orders and store-cart handoffs, newest first. The app is guest-only
 * and keeps no server-side account, so this list exists only on the
 * device where the purchases happened — an empty list is the honest
 * state for a browser that has not checked out here.
 */
export default function OrdersHistory() {
  const [entries, setEntries] = useState<OrderHistoryEntry[]>([]);

  useEffect(() => {
    setEntries(mergeOrderHistory(loadStoredOrders(), loadStoredHandoffs()));
  }, []);

  if (entries.length === 0) {
    return (
      <div className="flowCard">
        <p className="mutedText">
          No orders yet — orders you place here will show up on this device.
        </p>
      </div>
    );
  }
  return (
    <div className="orderList">
      {entries.map((entry) =>
        entry.kind === "order" ? (
          <OrderCard key={entry.order.orderId} order={entry.order} />
        ) : (
          <HandoffCard
            key={`handoff-${entry.handoff.merchant}-${entry.handoff.handedOffAt}`}
            handoff={entry.handoff}
          />
        ),
      )}
    </div>
  );
}
