import type {
  DecideRequest,
  DecideResponse,
  Offer,
  Priority,
  ScoredOffer,
} from "./types";
import { findProduct, getProductById } from "./data";

/**
 * LOCAL SCORING ENGINE (v1).
 *
 * Scores every offer 0–100 on the parameters that actually decide a purchase:
 * total cost (price + shipping), delivery speed vs. the need-by date, the
 * return window and what a return costs, warranty, and seller rating —
 * weighted by the priority the user picked.
 *
 * PLUG-IN POINT: future inputs may come only from policy-approved official
 * retailer APIs (see README.md and lib/adapters.ts). `buildExplanation()` can
 * be replaced by a Muse Spark call that explains OUR scoring and parameter
 * deltas. Muse must not be trained on eBay Content. The scoring maths and
 * the merchant-separated presentation stay the same.
 */

const WEIGHTS: Record<
  Priority,
  { cost: number; speed: number; returns: number; warranty: number; rating: number }
> = {
  cheapest: { cost: 0.6, speed: 0.1, returns: 0.1, warranty: 0.05, rating: 0.15 },
  fastest: { cost: 0.25, speed: 0.5, returns: 0.1, warranty: 0.05, rating: 0.1 },
  returns: { cost: 0.2, speed: 0.1, returns: 0.5, warranty: 0.05, rating: 0.15 },
};

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n));
}

function returnsSubscore(offer: Offer, priority: Priority): number {
  if (offer.returnCost === "final-sale") {
    // Final sale is a hard trap when returns matter, a footnote when they don't.
    return priority === "returns" ? 0.03 : 0.25;
  }
  let s = clamp01(offer.returnWindowDays / 90); // 90+ day window = perfect
  if (offer.returnCost === "buyer-paid") {
    // Buyer-paid returns quietly erase a low sticker price.
    s *= priority === "returns" ? 0.4 : 0.6;
  }
  return s;
}

export function scoreOffers(
  offers: Offer[],
  req: DecideRequest,
): ScoredOffer[] {
  const totals = offers.map((o) => o.price + o.shippingCost);
  const minTotal = Math.min(...totals);
  const maxTotal = Math.max(...totals);
  const maxDays = Math.max(...offers.map((o) => o.deliveryDays), 1);
  const w = WEIGHTS[req.priority];

  return offers
    .map((offer) => {
      const totalCost = offer.price + offer.shippingCost;
      const flags: string[] = [];

      const costScore =
        maxTotal === minTotal
          ? 1
          : 1 - (totalCost - minTotal) / (maxTotal - minTotal);
      const speedScore = 1 - (offer.deliveryDays - 1) / Math.max(maxDays - 1, 1);
      const retScore = returnsSubscore(offer, req.priority);
      const warrantyScore = clamp01(offer.warrantyMonths / 24);
      const ratingScore = clamp01((offer.sellerRating - 3.5) / 1.5);

      let score =
        100 *
        (w.cost * costScore +
          w.speed * clamp01(speedScore) +
          w.returns * retScore +
          w.warranty * warrantyScore +
          w.rating * ratingScore);

      if (offer.deliveryDays > req.needByDays) {
        score -= 25;
        flags.push(
          `Arrives in ${offer.deliveryDays} days — after your ${req.needByDays}-day need-by`,
        );
      }
      if (req.budget != null && totalCost > req.budget) {
        score -= 20;
        flags.push(`Total ${money(totalCost)} is over your ${money(req.budget)} budget`);
      }
      if (offer.returnCost === "final-sale") flags.push("Final sale — no returns");
      if (offer.returnCost === "buyer-paid") flags.push("Returns are buyer-paid");
      if (offer.shippingCost === 0) flags.push("Free shipping");
      if (offer.deliveryDays <= req.needByDays)
        flags.push(`Arrives in ${offer.deliveryDays} day${offer.deliveryDays === 1 ? "" : "s"}`);

      return {
        ...offer,
        totalCost,
        score: Math.max(0, Math.round(score)),
        flags,
      };
    })
    .sort((a, b) => b.score - a.score);
}

function returnsPhrase(o: ScoredOffer): string {
  if (o.returnCost === "final-sale") return "final sale (no returns)";
  return `${o.returnCost === "free" ? "free" : "buyer-paid"} ${o.returnWindowDays}-day returns`;
}

export function buildExplanation(
  winner: ScoredOffer,
  cheapest: ScoredOffer,
  priority: Priority,
  needByDays: number,
): string {
  const priorityLabel =
    priority === "cheapest"
      ? "lowest total cost"
      : priority === "fastest"
        ? "getting it to you fastest"
        : "the easiest returns";

  if (winner.id === cheapest.id) {
    return (
      `The cheapest sticker price is also the right buy here. ${winner.seller} wins on ${priorityLabel}: ` +
      `${money(winner.totalCost)} all-in (${money(winner.price)} + ${winner.shippingCost === 0 ? "free shipping" : money(winner.shippingCost) + " shipping"}), ` +
      `arrives in ${winner.deliveryDays} day${winner.deliveryDays === 1 ? "" : "s"}, ${returnsPhrase(winner)}, ` +
      `${winner.warrantyMonths} months of warranty, and a ${winner.sellerRating.toFixed(1)}-star rated seller. ` +
      (winner.deliveryDays > needByDays
        ? `One warning: no offer in the sample prototype data makes your ${needByDays}-day deadline — this is the closest option. `
        : "") +
      `No trade-off to explain — the lowest price and the best decision are the same offer this time.`
    );
  }

  const parts: string[] = [];
  const stickerDiff = winner.price - cheapest.price;
  parts.push(
    stickerDiff > 0
      ? `${money(Math.abs(stickerDiff))} more on the sticker than the cheapest offer (${cheapest.seller})`
      : `the same sticker ballpark as the cheapest offer (${cheapest.seller})`,
  );

  const totalDiff = winner.totalCost - cheapest.totalCost;
  parts.push(
    totalDiff <= 0
      ? `actually ${money(Math.abs(totalDiff))} less all-in once shipping is counted (${money(winner.totalCost)} vs ${money(cheapest.totalCost)})`
      : `${money(totalDiff)} more all-in (${money(winner.totalCost)} vs ${money(cheapest.totalCost)})`,
  );

  if (winner.deliveryDays !== cheapest.deliveryDays) {
    parts.push(
      winner.deliveryDays < cheapest.deliveryDays
        ? `arrives ${cheapest.deliveryDays - winner.deliveryDays} day${cheapest.deliveryDays - winner.deliveryDays === 1 ? "" : "s"} sooner (${winner.deliveryDays} vs ${cheapest.deliveryDays} days)`
        : winner.deliveryDays > needByDays
          ? `arrives ${winner.deliveryDays - cheapest.deliveryDays} day${winner.deliveryDays - cheapest.deliveryDays === 1 ? "" : "s"} later and misses your ${needByDays}-day deadline — it still wins on everything else`
          : `arrives ${winner.deliveryDays - cheapest.deliveryDays} day${winner.deliveryDays - cheapest.deliveryDays === 1 ? "" : "s"} later, still inside your deadline`,
    );
  }
  if (winner.shippingCost === 0 && cheapest.shippingCost > 0) {
    parts.push("free shipping");
  }
  if (
    winner.returnWindowDays !== cheapest.returnWindowDays ||
    winner.returnCost !== cheapest.returnCost
  ) {
    parts.push(
      `${returnsPhrase(winner)} instead of ${returnsPhrase(cheapest)}`,
    );
  }
  if (winner.warrantyMonths !== cheapest.warrantyMonths) {
    parts.push(
      `${winner.warrantyMonths} months of warranty vs ${cheapest.warrantyMonths} from the cheapest seller`,
    );
  }
  if (winner.sellerRating > cheapest.sellerRating) {
    parts.push(
      `a better-rated seller (${winner.sellerRating.toFixed(1)}★ vs ${cheapest.sellerRating.toFixed(1)}★)`,
    );
  }

  return (
    `Recommended for ${priorityLabel}: ${winner.seller}. It is ${parts.join(", ")}. ` +
    `Judged on price alone you would have picked ${cheapest.seller} — judged on everything, ${winner.seller} is the better buy.`
  );
}

export function decide(req: DecideRequest): DecideResponse | null {
  const product = req.productId
    ? getProductById(req.productId)
    : req.query
      ? findProduct(req.query)
      : null;
  if (!product) return null;

  const allOffers = scoreOffers(product.offers, req);
  const offers = allOffers.slice(0, 5);
  const recommendation = offers[0];
  const cheapestSticker = [...allOffers].sort((a, b) => a.price - b.price)[0];
  const prices = product.offers.map((offer) => offer.price);

  return {
    product: { id: product.id, name: product.name, category: product.category },
    priority: req.priority,
    needByDays: req.needByDays,
    budget: req.budget ?? null,
    offers,
    recommendation,
    cheapestSticker,
    explanation: buildExplanation(
      recommendation,
      cheapestSticker,
      req.priority,
      req.needByDays,
    ),
    priceRange: { lowest: Math.min(...prices), highest: Math.max(...prices) },
    fastestDeliveryDays: Math.min(...product.offers.map((offer) => offer.deliveryDays)),
    dataSource: "sample",
    sourceMerchants: [...new Set(product.offers.map((offer) => offer.merchant))],
    acquisitionMethod: "sample",
    retrievedAt: null,
    policyStatus: "sample-only-api-route",
  };
}
