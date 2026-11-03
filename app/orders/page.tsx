import type { Metadata } from "next";
import Link from "next/link";
import { BRAND } from "@/lib/config";
import OrdersHistory from "@/components/OrdersHistory";

export const metadata: Metadata = {
  title: `Your orders — ${BRAND.name}`,
  description:
    "Orders you have placed through Not Delivered in the Blue Truck, remembered in your own browser on this device.",
};

/**
 * Order history page. This app is guest-only and stores nothing on a
 * server, so the history lives in the shopper's own browser
 * (lib/order-history.ts): store-confirmed in-app orders, plus store
 * checkouts the shopper was handed off to, labeled as such. The list
 * renders client-side from that local record; a browser that has not
 * checked out here sees the honest empty state.
 */
export default function OrdersPage() {
  return (
    <main className="wrap flowMain">
      <Link className="backLink" href="/">
        ← Back to shopping
      </Link>
      <h2 className="viewTitle">Your orders</h2>
      <p className="mutedText">
        Kept only in this browser, on this device — this site has no accounts
        and stores no orders on a server. Orders a store confirmed here show
        the store&apos;s own confirmation; checkouts finished on a store&apos;s
        own site are labeled “Completed at the store.”
      </p>
      <OrdersHistory />
    </main>
  );
}
