import type { Metadata } from "next";
import Link from "next/link";
import { BRAND } from "@/lib/config";
import ListYourStoreForm from "@/components/ListYourStoreForm";

export const metadata: Metadata = {
  title: `List your store — ${BRAND.name}`,
  description:
    "Run an online store? Request a listing on Not Delivered in the Blue Truck. Every store is checked against its own terms before it is added.",
};

/**
 * Merchant listing-request page. Store owners ask to be included;
 * every request is then checked against the store's own published
 * terms before the store is added (the same policy gate every current
 * merchant passed). The form itself stores nothing — it composes a
 * prefilled email to Nio Innovations via the visitor's own email app
 * (see components/ListYourStoreForm.tsx).
 */
export default function ListYourStorePage() {
  return (
    <main className="wrap legalMain">
      <Link className="backLink" href="/">
        ← Back to shopping
      </Link>
      <h1>List your store</h1>
      <p>
        Run an online store and want it in the comparison? Send us the details
        below. One rule applies to every store here, including the big ones:
        we read the store&apos;s own published terms first, and a store gets
        listed only when its terms allow the way we fetch its prices. If your
        store publishes a UCP profile, include the link — that&apos;s the
        fastest route in.
      </p>
      <ListYourStoreForm />
    </main>
  );
}
