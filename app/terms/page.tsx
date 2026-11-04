import type { Metadata } from "next";
import Link from "next/link";
import { BRAND } from "@/lib/config";

export const metadata: Metadata = {
  title: `Terms of Service — ${BRAND.name}`,
  description: `The terms for using ${BRAND.name} to compare prices and check out.`,
};

/**
 * Terms of service in plain language, matching the app's actual
 * behavior: live prices that can change, the selling store as the
 * seller of record, checkout on the store's own site (we pre-load
 * the cart where the store supports it), payment by the store's
 * provider, and delivery/returns handled by the store.
 */
export default function TermsPage() {
  return (
    <main className="wrap legalMain">
      <Link className="backLink" href="/">
        ← Back to shopping
      </Link>
      <h1>Terms of Service</h1>
      <p className="legalUpdated">Last updated: November 3, 2026</p>

      <p>
        {BRAND.name} is operated by {BRAND.company}. By using this site you
        agree to these terms.
      </p>

      <h2>What this service does</h2>
      <p>
        We search stores at the moment you ask and compare the whole buying
        decision — price, shipping, delivery time, return window and cost,
        warranty, and seller rating — then show you the comparison. When you
        are ready to buy, we send you to the selling store&apos;s own site
        to check out — for many stores with your items already loaded into
        its cart; for the rest, we link you to the item there.
      </p>

      <h2>Prices and availability</h2>
      <p>
        Every price is fetched live when you search or compare, from the
        store&apos;s own systems. Prices, shipping charges, taxes, and
        availability can change at any time, including between your
        comparison and your checkout. The totals that bind your purchase are
        the ones the selling store shows in its checkout before you pay.
        Some comparison fields a store does not publish (for example a
        return policy it does not state in its feed) are shown as estimates
        and are labeled as such.
      </p>

      <h2>The selling store is your seller</h2>
      <p>
        When you buy, your purchase contract is with the store that sells the
        item — not with us. The store takes your payment through its own
        payment provider, fulfills and delivers your order, and handles
        returns and warranty claims under its own policies, which the store
        presents in its checkout before you pay.
      </p>

      <h2>Checkout</h2>
      <p>
        Checkout happens on the selling store&apos;s own site and does not
        create an account here. We may change, pause, or end the
        store-checkout links at any time. Do not enter payment card details
        anywhere on this site — payment is only ever taken on the selling
        store&apos;s secure payment step.
      </p>

      <h2>Orders and confirmations</h2>
      <p>
        An order exists only when the selling store confirms it, and your
        confirmation comes from the selling store. If a store cannot
        prepare your cart, we will say so and link you to the item at the
        store instead — a handoff to a store&apos;s cart is never
        presented as a completed order.
      </p>

      <h2>Acceptable use</h2>
      <p>
        Use this service for your own shopping. Do not use the service to
        place orders you do not intend to complete, and do not attempt to
        disrupt the service.
      </p>

      <h2>Liability</h2>
      <p>
        The service is provided as-is. To the extent the law allows,{" "}
        {BRAND.company} is not liable for a store&apos;s prices,
        availability, delivery, product quality, or returns — those are the
        selling store&apos;s responsibilities.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about these terms: {BRAND.company}, Fort Mill, South
        Carolina — barath.jayaraman@gmail.com.
      </p>
    </main>
  );
}
