import type { Merchant } from "./types";

/**
 * VERIFIED STORE RETURN POLICIES (Nov 4, 2026).
 *
 * Each entry was read from the merchant's OWN published policy page
 * (fetched and checked on Nov 4, 2026, in the returns-accuracy sweep —
 * see ~/workspace/meta-hackathon/warranty-returns-accuracy-audit-nov4.md
 * and policy-sweep-nov4.json for the per-store evidence and verbatim
 * quotes). This table exists because of the Kane's Furniture defect:
 * a generic 30-day default once rendered in the comparison table as
 * if it were each store's own policy. The rules here are the opposite:
 *
 * - A field is populated ONLY when the store's published policy
 *   states it. Anything the policy does not state stays null and the
 *   UI shows "Not stated by seller".
 * - restockingFee is a display string ("20%") when the policy states
 *   a fee, or "None" ONLY when the policy affirmatively supports no
 *   restocking fee. "None" is never inferred from silence.
 * - policyNote carries, in plain words drawn from the policy text,
 *   material terms the structured fields cannot express (e.g. a
 *   cancellation window instead of a return window).
 * - A store with no entry (or an entry whose fetch could not be
 *   verified) gets NO override: its offers keep the honest fallback.
 *
 * Return policies are the merchant's own published figures, not live
 * listing data; the provenance note on every affected offer names
 * this source and its verification date.
 */
export interface VerifiedStorePolicy {
  /** Stated return window in days; null when the policy states none. */
  returnWindowDays: number | null;
  /** Stated return cost; null when the policy does not state who pays. */
  returnCost: "free" | "buyer-paid" | "final-sale" | null;
  /** Stated restocking fee ("20%"), or "None" where the policy
   *  affirmatively supports no fee; null when not stated. */
  restockingFee: string | null;
  /** Short faithful summary of terms the fields cannot express. */
  policyNote: string | null;
  /** The published policy page the entry was verified against. */
  sourceUrl: string;
}

const VERIFIED_STORE_POLICIES: Partial<
  Record<Merchant, VerifiedStorePolicy>
> = {
  "Steve Madden": {
    returnWindowDays: 30,
    returnCost: null,
    restockingFee: null,
    policyNote: "Final Sale / clearance items cannot be returned. Mail returns carry a $6.95 per-order return fee covering restocking and postage.",
    sourceUrl: "https://www.stevemadden.com/policies/refund-policy",
  },
  "Gymshark": {
    returnWindowDays: 30,
    returnCost: null,
    restockingFee: null,
    policyNote: "Returns within 30 days of delivery. Underwear and boxers cannot be returned.",
    sourceUrl: "https://intercom.help/gymshark/en/articles/12829778-how-do-i-return-my-order",
  },
  "Everlane": {
    returnWindowDays: 30,
    returnCost: "free",
    restockingFee: null,
    policyNote: "45 days for countries other than US & Canada. Final Sale items and some underwear cannot be returned.",
    sourceUrl: "https://www.everlane.com/policies/refund-policy",
  },
  "Monos": {
    returnWindowDays: 100,
    returnCost: "buyer-paid",
    restockingFee: null,
    policyNote: "Bags, apparel and accessories: 30 days. Return shipping cost is deducted from the refund.",
    sourceUrl: "https://monos.com/policies/refund-policy",
  },
  "Allbirds": {
    returnWindowDays: 30,
    returnCost: "buyer-paid",
    restockingFee: null,
    policyNote: "Items must be unworn and unwashed with original tags. Final Sale items cannot be returned.",
    sourceUrl: "https://www.allbirds.com/policies/refund-policy",
  },
  "Kith": {
    returnWindowDays: 30,
    returnCost: null,
    restockingFee: "$8",
    policyNote: "Returns are granted as an online gift card, not a refund to original payment, minus the $8 fee.",
    sourceUrl: "https://kith.com/policies/refund-policy",
  },
  "Misen": {
    returnWindowDays: 60,
    returnCost: "buyer-paid",
    restockingFee: null,
    policyNote: "60-day trial period. Final Sale and food & beverage items are not returnable.",
    sourceUrl: "https://misen.com/policies/refund-policy",
  },
  "SKIMS": {
    returnWindowDays: 30,
    returnCost: "buyer-paid",
    restockingFee: null,
    policyNote: "Domestic return shipping fee is $6.00, waived if store credit is selected as the return payment.",
    sourceUrl: "https://skims.com/pages/returns",
  },
  "Fenty Beauty": {
    returnWindowDays: 30,
    returnCost: "free",
    restockingFee: null,
    policyNote: "No exchanges offered. Hazmat items such as Fenty Eau de Parfum cannot be returned.",
    sourceUrl: "https://fentybeauty.com/policies/refund-policy",
  },
  "Lord & Taylor": {
    returnWindowDays: 14,
    returnCost: null,
    restockingFee: null,
    policyNote: "All returns are subject to a $24 return fee. Orders cancelled within 24 hours are at no charge; after that a 3% cancellation fee applies.",
    sourceUrl: "https://lordandtaylor.com/policies/refund-policy",
  },
  "Stein Mart": {
    returnWindowDays: 30,
    returnCost: null,
    restockingFee: "$9.99",
    policyNote: "Most new, unused items are returned for store credit, not a refund to original payment.",
    sourceUrl: "https://steinmart.com/policies/refund-policy",
  },
  "Scandinavian Designs": {
    returnWindowDays: 14,
    returnCost: "buyer-paid",
    restockingFee: "20%",
    policyNote: "Restocking fee is at least 20% for returns other than damage, defect or error; exact fee depends on condition and packaging.",
    sourceUrl: "https://scandinaviandesigns.com/policies/refund-policy",
  },
  "Pier 1": {
    returnWindowDays: 30,
    returnCost: "buyer-paid",
    restockingFee: null,
    policyNote: "With limited exceptions, returns are refunded as store credit only, not to original payment.",
    sourceUrl: "https://www.pier1.com/policies/refund-policy",
  },
  "Vitacost": {
    returnWindowDays: 30,
    returnCost: null,
    restockingFee: null,
    policyNote: "EU orders have a 14-day cooling-off period. A return shipping label is sent if the return is accepted; cost not stated.",
    sourceUrl: "https://www.vitacost.com/policies/refund-policy",
  },
  "ShopLC": {
    returnWindowDays: 30,
    returnCost: "buyer-paid",
    restockingFee: null,
    policyNote: "Return label fee of $6.49 / $8.49 / $10.49 by weight is deducted from the refund; damaged or defective items are not charged the label fee.",
    sourceUrl: "https://www.shoplc.com/policies/refund-policy",
  },
  "The Lakeside Collection": {
    returnWindowDays: 30,
    returnCost: null,
    restockingFee: null,
    policyNote: "Shipping charges and processing & handling fees are not refundable.",
    sourceUrl: "https://www.lakeside.com/policies/refund-policy",
  },
  "LTD Commodities": {
    returnWindowDays: 30,
    returnCost: null,
    restockingFee: null,
    policyNote: "Shipping charges and processing & handling fees are not refundable.",
    sourceUrl: "https://www.ltdcommodities.com/policies/refund-policy",
  },
  "SkyMall": {
    returnWindowDays: 30,
    returnCost: null,
    restockingFee: null,
    policyNote: "Exceptions include personalized, hygiene, perishable, clothing, pet, opened software/DVD and oversized items.",
    sourceUrl: "https://skymall.com/policies/refund-policy",
  },
  "Mast General Store": {
    returnWindowDays: 90,
    returnCost: "buyer-paid",
    restockingFee: null,
    policyNote: "Footwear must show no evidence of being worn outside. Return shipping is free only for damaged, defective or incorrect items.",
    sourceUrl: "https://www.mastgeneralstore.com/policies/refund-policy",
  },
  "Kane's Furniture": {
    returnWindowDays: null,
    returnCost: null,
    restockingFee: "20%",
    policyNote: "Orders can be cancelled within 48 hours of purchase for a full refund; after 48 hours a 20% restocking fee applies, and orders cannot be cancelled after delivery.",
    sourceUrl: "https://www.kanesfurniture.com/policies/refund-policy",
  },
  "Steinhafels": {
    returnWindowDays: 15,
    returnCost: null,
    restockingFee: "15%",
    policyNote: "Request must be made within 15 days of receiving merchandise. Mattresses have a separate 120-night trial; rugs and accessories are not subject to the 15% fee.",
    sourceUrl: "https://www.steinhafels.com/policies/refund-policy",
  },
  "Schneiderman's Furniture": {
    returnWindowDays: 7,
    returnCost: "buyer-paid",
    restockingFee: null,
    policyNote: "In-stock merchandise only, in new unused condition. Mattresses, box springs, lift chairs and closeout/final sale items are non-returnable.",
    sourceUrl: "https://www.schneidermans.com/policies/refund-policy",
  },
  "FYE": {
    returnWindowDays: 30,
    returnCost: "buyer-paid",
    restockingFee: null,
    policyNote: "Merchandise not in new condition with original packing may be subject to a restocking fee; no amount is stated.",
    sourceUrl: "https://www.fye.com/policies/refund-policy",
  },
  "DTLR": {
    returnWindowDays: 30,
    returnCost: "buyer-paid",
    restockingFee: null,
    policyNote: "DTLR covers return shipping only in rare error cases.",
    sourceUrl: "https://www.dtlr.com/policies/refund-policy",
  },
  "Beach Camera": {
    returnWindowDays: 30,
    returnCost: "buyer-paid",
    restockingFee: null,
    policyNote: "A Return Authorization number is required and must be shown on the shipping box.",
    sourceUrl: "https://www.beachcamera.com/policies/refund-policy",
  },
  "Evo": {
    returnWindowDays: 366,
    returnCost: "buyer-paid",
    restockingFee: null,
    policyNote: "Drop-off at a US evo store is free; shipped returns have return shipping fees deducted from the refund. Final Sale closeout items excluded.",
    sourceUrl: "https://www.evo.com/policies/refund-policy",
  },
  "FAO Schwarz": {
    returnWindowDays: 30,
    returnCost: "buyer-paid",
    restockingFee: null,
    policyNote: "Refund is less original shipping fees and a $10 return fee.",
    sourceUrl: "https://faoschwarz.com/policies/refund-policy",
  },
  "Casper": {
    returnWindowDays: 100,
    returnCost: "free",
    restockingFee: null,
    policyNote: "Mattresses: 100-night trial, returns free after the 30-night adjustment period. Pillows and bedding: 30 days; mattress toppers and dog beds: 30-night trials.",
    sourceUrl: "https://casper.com/policies/refund-policy",
  },
  "Away": {
    returnWindowDays: 100,
    returnCost: "free",
    restockingFee: null,
    policyNote: "Unused items only; keep original packaging. Personalized products and gift cards cannot be returned.",
    sourceUrl: "https://www.awaytravel.com/pages/returns-exchanges",
  },
  "HexClad": {
    returnWindowDays: 30,
    returnCost: "buyer-paid",
    restockingFee: null,
    policyNote: "30-day money-back guarantee, described as risk-free in the policy heading.",
    sourceUrl: "https://hexclad.com/policies/refund-policy",
  },
  "Rad Power Bikes": {
    returnWindowDays: 30,
    returnCost: "buyer-paid",
    restockingFee: "30%",
    policyNote: "Restocking fee of 30% applies to used bikes and to accessories/merchandise, not to new bikes. Bike return shipping is $149.",
    sourceUrl: "https://www.radpowerbikes.com/policies/refund-policy",
  },
  "The Sill": {
    returnWindowDays: null,
    returnCost: null,
    restockingFee: null,
    policyNote: "No general returns or exchanges. Damaged orders are replaced under a 30-Day Customer Happiness Guarantee if reported within 30 days of delivery, with photos.",
    sourceUrl: "https://www.thesill.com/policies/refund-policy",
  },
  "Brookstone": {
    returnWindowDays: 30,
    returnCost: "buyer-paid",
    restockingFee: null,
    policyNote: "Return with the packing slip. Personalized and personal care items are final sale.",
    sourceUrl: "https://www.brookstone.com/policies/refund-policy",
  },
  "Sharper Image": {
    returnWindowDays: 60,
    returnCost: null,
    restockingFee: null,
    policyNote: "Massage chairs: customer pays return shipping plus a 20% restocking fee. Free returns are offered when a merchandise credit (e-gift card) is requested instead of a refund.",
    sourceUrl: "https://sharperimage.com/policies/refund-policy",
  },
  "Peak Design": {
    returnWindowDays: 30,
    returnCost: null,
    restockingFee: null,
    policyNote: "Full refund within 30 days, with a footnote asterisk in the original. Defective or broken products go through a warranty claim.",
    sourceUrl: "https://checkout.shopify.com/29861172/policies/4432494636.html?locale=en",
  },
  "Woodcraft": {
    returnWindowDays: 90,
    returnCost: null,
    restockingFee: null,
    policyNote: "CNC machines and 3D printers carry a minimum 15% restocking fee. Special-order and manufacturer drop-ship items may be subject to a restocking fee and customer-paid return shipping.",
    sourceUrl: "https://www.woodcraft.com/policies/refund-policy",
  },
  "Arhaus": {
    returnWindowDays: 14,
    returnCost: null,
    restockingFee: "10%",
    policyNote: "Non-furniture items (bedding, decor, lighting etc.): 30 days. Certain refused or post-delivery returns of other items carry a 50% restocking fee.",
    sourceUrl: "https://www.arhaus.com/policies/refund-policy",
  },
  "Bonobos": {
    returnWindowDays: 90,
    returnCost: "free",
    restockingFee: null,
    policyNote: "Refund to original payment only within 45 days of shipment; returns up to 90 days are for store credit, and exchanges run the full 90 days. Items must be unworn with tags.",
    sourceUrl: "https://bonobos.com/policies/refund-policy",
  },
  "Fashion Nova": {
    returnWindowDays: 30,
    returnCost: "buyer-paid",
    restockingFee: null,
    policyNote: "Returns are for store credit. Return labels can be purchased for $5.99 (US) / $9.99 (Canada). Bodysuits, swimwear, undergarments, beauty and other listed categories are final sale.",
    sourceUrl: "https://www.fashionnova.com/pages/return-policy",
  },
  "Burrow": {
    returnWindowDays: 30,
    returnCost: "buyer-paid",
    restockingFee: null,
    policyNote: "Return shipping fee is 10% of the product price, capped at $250 per item. Mattresses: 100-day trial, returns free if in good condition. One free exchange within the 30-day window.",
    sourceUrl: "https://burrow.com/policies/refund-policy",
  },
  "ButcherBox": {
    returnWindowDays: null,
    returnCost: "final-sale",
    restockingFee: null,
    policyNote: "No returns are accepted because products are perishable.",
    sourceUrl: "https://www.butcherbox.com/policies/refund-policy",
  },
  "Champion": {
    returnWindowDays: 30,
    returnCost: "buyer-paid",
    restockingFee: null,
    policyNote: "Unworn merchandise only, from the official online store. Holiday purchases have an extended period (dates in policy).",
    sourceUrl: "https://www.champion.com/policies/refund-policy",
  },
  "Eddie Bauer": {
    returnWindowDays: 30,
    returnCost: null,
    restockingFee: "$20",
    policyNote: "Holiday orders placed Nov 18 - Dec 25 have an extended 45-day return period. Final Sale items are not eligible.",
    sourceUrl: "https://www.eddiebauer.com/policies/refund-policy",
  },
  "Faherty": {
    returnWindowDays: 60,
    returnCost: null,
    restockingFee: null,
    policyNote: "Items must be unworn, unwashed and undamaged with tags. Faherty reserves the right to impose a restocking fee or reduced refund if a returned item shows wear or use; no amount is stated.",
    sourceUrl: "https://fahertybrand.com/policies/refund-policy",
  },
  "Johnnie-O": {
    returnWindowDays: 60,
    returnCost: null,
    restockingFee: null,
    policyNote: "In-store/Happy Returns returns are free; mail-in is free on a first purchase and exchanges, otherwise a $7 label fee applies. Holiday: through Jan 31, 2027 or 60 days, whichever is later.",
    sourceUrl: "https://www.johnnie-o.com/pages/returns-exchanges",
  },
  "Sperry": {
    returnWindowDays: 60,
    returnCost: null,
    restockingFee: null,
    policyNote: "In-store returns are free; returns by mail or Happy Returns Bar carry a $6.95 fee. Items must be unworn with receipt and original packaging.",
    sourceUrl: "https://www.sperry.com/policies/refund-policy",
  },
  "True Classic": {
    returnWindowDays: 100,
    returnCost: "free",
    restockingFee: null,
    policyNote: "Items must be unworn and unwashed. Final Sale items are not eligible.",
    sourceUrl: "https://www.trueclassictees.com/policies/refund-policy",
  },
  "UNTUCKit": {
    returnWindowDays: 30,
    returnCost: "buyer-paid",
    restockingFee: null,
    policyNote: "Items must be unworn, unwashed and undamaged. Outlet stores accept exchanges only.",
    sourceUrl: "https://www.untuckit.com/policies/refund-policy",
  },
};

export function getVerifiedStorePolicy(
  merchant: Merchant,
): VerifiedStorePolicy | null {
  return VERIFIED_STORE_POLICIES[merchant] ?? null;
}
