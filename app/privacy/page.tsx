import type { Metadata } from "next";
import Link from "next/link";
import { BRAND } from "@/lib/config";

export const metadata: Metadata = {
  title: `Privacy Policy — ${BRAND.name}`,
  description: `How ${BRAND.name} handles your information when you search and check out.`,
};

/**
 * Privacy policy in plain language, matching the app's actual
 * behavior: live-only search (nothing stored), pass-through guest
 * checkout at UCP stores (details go to the selling store, are not
 * stored on our servers), payment taken by the store's own payment
 * provider, and confirmed orders remembered only in the shopper's own
 * browser.
 */
export default function PrivacyPage() {
  return (
    <main className="wrap legalMain">
      <Link className="backLink" href="/">
        ← Back to shopping
      </Link>
      <h1>Privacy Policy</h1>
      <p className="legalUpdated">Last updated: November 2, 2026</p>

      <p>
        {BRAND.name} is a shopping comparison service from {BRAND.company}. We
        show live prices and buying terms from many stores side by side, and —
        for a growing set of stores — let an invited guest check out without
        leaving this site. This page says, in plain language, what information
        we handle when you use it.
      </p>

      <h2>Searching and comparing</h2>
      <p>
        When you search, we fetch prices from stores at that moment and show
        them to you. We do not keep a copy of the prices we show, and searching
        does not require an account or any personal information.
      </p>

      <h2>Checking out</h2>
      <p>
        Checkout is currently invite-only: it requires an access code. When
        you check out with a store that sells through this site, you enter
        your name, email address, phone number, and delivery address. Those
        details are sent to the selling store so it can take your order and
        deliver it. <strong>We do not store your checkout details on our
        servers</strong> — they pass through to the store in the request that
        creates your checkout, and after that we hold only the store&apos;s
        checkout session identifier while you finish.
      </p>
      <p>
        The selling store is the seller of your purchase. What the store does
        with your details is covered by the store&apos;s own privacy policy,
        which is linked from your checkout before you pay.
      </p>

      <h2>Payment</h2>
      <p>
        We never see or handle your payment card. Payment is taken by the
        selling store&apos;s own payment provider on the store&apos;s secure
        payment step. Your card details go to that provider, not to us.
      </p>

      <h2>Orders shown in your browser</h2>
      <p>
        When a store confirms an order, we show the confirmation the store
        returned. If you view your orders on this site, that record is kept
        only in your own browser&apos;s local storage, on your device. It is
        not sent to us, and clearing your browser data removes it.
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
