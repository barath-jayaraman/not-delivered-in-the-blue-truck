import type { Metadata } from "next";
import Link from "next/link";
import { BRAND } from "@/lib/config";

export const metadata: Metadata = {
  title: `Privacy Policy — ${BRAND.name}`,
  description: `How ${BRAND.name} handles your information when you search and check out.`,
};

/**
 * Privacy policy in plain language, matching the app's actual
 * behavior: live-only search (nothing stored), no checkout or
 * payment information collected here (buying finishes on the
 * store's own site; only item ids and quantities go to the store
 * to pre-load its cart), and store-checkout handoffs remembered
 * only in the shopper's own browser.
 */
export default function PrivacyPage() {
  return (
    <main className="wrap legalMain">
      <Link className="backLink" href="/">
        ← Back to shopping
      </Link>
      <h1>Privacy Policy</h1>
      <p className="legalUpdated">Last updated: November 3, 2026</p>

      <p>
        {BRAND.name} is a shopping comparison service from {BRAND.company}. We
        show live prices and buying terms from many stores side by side, and
        send you to the selling store&apos;s own site to check out — with
        your items already in its cart where the store supports that. This
        page says, in plain language, what information we handle when you
        use it.
      </p>

      <h2>Searching and comparing</h2>
      <p>
        When you search, we fetch prices from stores at that moment and show
        them to you. We do not keep a copy of the prices we show, and searching
        does not require an account or any personal information.
      </p>

      <h2>Checking out</h2>
      <p>
        Checkout happens on the selling store&apos;s own site — this site
        does not collect your name, address, or any other checkout details.
        When you continue to a store&apos;s checkout, we ask the store to
        load the items you chose into its cart: only the item identifiers
        and quantities go to the store, never anything about you. You enter
        your details and pay on the store&apos;s site.
      </p>
      <p>
        The selling store is the seller of your purchase. What the store
        does with the details you give it there is covered by the
        store&apos;s own privacy policy.
      </p>

      <h2>Payment</h2>
      <p>
        We never see or handle your payment card. Payment is taken by the
        selling store&apos;s own payment provider on the store&apos;s secure
        payment step. Your card details go to that provider, not to us.
      </p>

      <h2>Orders shown in your browser</h2>
      <p>
        When you continue to a store&apos;s checkout from here, we remember
        that handoff — the store, the items, and the time — so you can find
        it again under Orders. That record is kept only in your own
        browser&apos;s local storage, on your device. It is not sent to us,
        and clearing your browser data removes it.
      </p>

      <h2>What we do not do</h2>
      <ul>
        <li>We do not sell personal information.</li>
        <li>We do not require accounts, and we do not ask for any store or bank login.</li>
        <li>We do not store the prices, searches, or checkout details described above on our servers.</li>
      </ul>

      <h2>Contact</h2>
      <p>
        Questions about this policy: {BRAND.company}, Fort Mill, South
        Carolina — barath.jayaraman@gmail.com.
      </p>
    </main>
  );
}
