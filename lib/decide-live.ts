import {
  buildAgentActivity,
  explainRecommendation,
  getMetaModelConfig,
  interpretQuery,
  type ExplainOfferFacts,
  type InterpretedQuery,
  type LiveRunInfo,
} from "./agent";
import { getProductById } from "./data";
import {
  pickGroupForProduct,
  searchLiveProducts,
  type LiveProductGroup,
} from "./live-search";
import { getPolicyGateEntries } from "./adapters";
import { buildExplanation, scoreOffers } from "./scoring";
import type {
  DecideRequest,
  DecideResponse,
  Offer,
  ScoredOffer,
} from "./types";

/**
 * DECIDE ORCHESTRATION — live-only comparisons, local deterministic
 * scoring, live Muse Spark explanation when configured.
 *
 * NO STORED LISTINGS OR PRICES (Barath's rule, Oct 31, 2026): every
 * decide request fetches its offers live, in that request, through
 * lib/live-search.ts (eBay Buy Browse API + Walmart search-page fetch).
 * There is no catalog of sample offers to fall back to and no relay
 * document is read: when the live sources return nothing for the
 * requested product, this returns null and the route answers with the
 * honest empty state.
 *
 * Resolution paths, all ending in a FRESH live search:
 *   1. liveGroupId — the shopper picked a live search result; the group
 *      is re-fetched with the original query and matched by group id
 *      (falling back to the known-product matcher when listings shifted).
 *   2. productId — a known product's presentation metadata (lib/data.ts)
 *      supplies the exact brand + model; a live search for it is matched
 *      with the model-token discipline (pickGroupForProduct).
 *   3. query — Muse Spark (when configured) canonicalizes the words,
 *      a live search runs, and the best-matching group is compared.
 *
 * Scoring is the deterministic engine in lib/scoring.ts — numbers are
 * never model-invented. The Muse explanation is accepted only when
 * every figure in it is grounded in the scored facts (lib/agent.ts);
 * otherwise the local explanation stands.
 */

function toExplainFacts(offer: ScoredOffer): ExplainOfferFacts {
  return {
    seller: offer.seller,
    merchant: offer.merchant,
    totalCost: offer.totalCost,
    price: offer.price,
    shippingCost: offer.shippingCost,
    deliveryDays: offer.deliveryDays,
    returnWindowDays: offer.returnWindowDays,
    returnCost: offer.returnCost,
    warrantyMonths: offer.warrantyMonths,
    sellerRating: offer.sellerRating,
    score: offer.score,
  };
}

/**
 * Build the comparison for one live product group whose offers were
 * fetched in THIS request. Scored with the same deterministic engine as
 * any offer set; the explanation follows the same grounding rule — the
 * local text, or Muse's text only when every figure in it matches the
 * scored facts.
 */
async function buildLiveComparison(
  req: DecideRequest,
  group: LiveProductGroup,
  liveInfo: LiveRunInfo,
): Promise<DecideResponse> {
  const config = getMetaModelConfig();
  const scored = scoreOffers(group.offers, req);
  const offers = scored.slice(0, 5);
  const recommendation = offers[0];
  const cheapestSticker = [...scored].sort((a, b) => a.price - b.price)[0];
  let explanation = buildExplanation(
    recommendation,
    cheapestSticker,
    req.priority,
    req.needByDays,
  );

  const liveSteps = [...liveInfo.steps];
  if (config.liveConfigured) {
    const liveExplanation = await explainRecommendation({
      productName: group.name,
      priority: req.priority,
      needByDays: req.needByDays,
      winner: toExplainFacts(recommendation),
      cheapestSticker: toExplainFacts(cheapestSticker),
      sameOffer: recommendation.id === cheapestSticker.id,
    });
    if (liveExplanation) {
      explanation = liveExplanation;
      liveSteps.push("explain");
    }
  }

  const gathered = group.merchants.map((merchant) => ({
    merchant,
    route:
      merchant === "Walmart"
        ? "browsing route (Agentic Access Terms)"
        : "official API route",
    offerCount: group.offers.filter((o) => o.merchant === merchant).length,
  }));
  const agentActivity = buildAgentActivity({
    productName: group.name,
    priority: req.priority,
    needByDays: req.needByDays,
    gathered,
    totalOffers: group.offers.length,
    recommendationSeller: recommendation.seller,
    live: liveSteps.length
      ? { ...liveInfo, steps: liveSteps }
      : undefined,
  });
  // State plainly what actually happened in the gather step: a live
  // fetch in this request, for the exact model the shopper picked.
  const gatherStep = agentActivity.steps.find((s) => s.id === "gather");
  if (gatherStep) {
    gatherStep.detail =
      `Collected ${group.offers.length} live offers (${gathered
        .map((g) => `${g.merchant}: ${g.offerCount} via ${g.route}`)
        .join(" · ")}) for the exact model the shopper picked, fetched ` +
      `live in this request (retrieved ${group.retrievedAt}). Every figure ` +
      `is the listing's own; listings that did not state shipping or delivery were excluded.`;
  }

  const byMerchant = new Map<string, Offer[]>();
  for (const offer of group.offers) {
    const list = byMerchant.get(offer.merchant) ?? [];
    list.push(offer);
    byMerchant.set(offer.merchant, list);
  }
  const merchants = [...byMerchant.entries()].map(([merchant, list]) => ({
    merchant,
    retrievedAt: list[0].provenance.retrievedAt ?? group.retrievedAt,
    sourceUrl: list[0].provenance.sourceUrl ?? "",
    offerIds: list.map((o) => o.id),
  }));

  return {
    product: {
      id: group.id,
      name: group.name,
      category: group.category,
      imageUrl: group.imageUrl,
    },
    priority: req.priority,
    needByDays: req.needByDays,
    budget: req.budget ?? null,
    offers,
    recommendation,
    cheapestSticker,
    explanation,
    priceRange: {
      lowest: Math.min(...group.offers.map((o) => o.price)),
      highest: Math.max(...group.offers.map((o) => o.price)),
    },
    fastestDeliveryDays: Math.min(...group.offers.map((o) => o.deliveryDays)),
    dataSource: "live",
    sourceMerchants: group.merchants,
    acquisitionMethod: group.offers[0].provenance.acquisitionMethod,
    retrievedAt: group.retrievedAt,
    policyStatus: recommendation.provenance.policyStatus,
    policyGate: getPolicyGateEntries(),
    agentActivity,
    liveData: {
      merchant: merchants[0].merchant,
      retrievedAt: merchants[0].retrievedAt,
      sourceUrl: merchants[0].sourceUrl,
      offerIds: group.offers.map((o) => o.id),
      merchants,
    },
  };
}

export async function decideWithAgent(
  req: DecideRequest,
): Promise<DecideResponse | null> {
  const liveInfo: LiveRunInfo = {
    steps: [],
    interpretation: null,
    interpretFailed: false,
  };

  // Path 1: the shopper picked a live search result. Re-fetch live with
  // the original query and re-find the group — nothing is reused from
  // the earlier search request.
  if (req.liveGroupId) {
    const meta = req.productId ? getProductById(req.productId) : null;
    const fetchQuery =
      req.query?.trim() || (meta ? `${meta.brand} ${meta.model}` : "");
    if (!fetchQuery) return null;
    const { groups } = await searchLiveProducts(fetchQuery);
    let group = groups.find((g) => g.id === req.liveGroupId) ?? null;
    if (!group && meta) group = pickGroupForProduct(groups, meta);
    if (!group) return null;
    return buildLiveComparison(req, group, liveInfo);
  }

  // Path 2: a known product (presentation metadata only) — resolve its
  // exact brand + model to a group from a fresh live search.
  if (req.productId) {
    const meta = getProductById(req.productId);
    if (!meta) return null;
    const { groups } = await searchLiveProducts(`${meta.brand} ${meta.model}`);
    const group = pickGroupForProduct(groups, meta);
    if (!group) return null;
    return buildLiveComparison(req, group, liveInfo);
  }

  // Path 3: free-form query — interpret (when Muse is configured), then
  // a fresh live search; compare the best-matching group.
  if (req.query) {
    let searchQuery = req.query;
    if (getMetaModelConfig().liveConfigured) {
      const interpretation: InterpretedQuery | null =
        await interpretQuery(req.query);
      if (interpretation) {
        liveInfo.steps.push("interpret");
        liveInfo.interpretation = interpretation;
        if (interpretation.canonicalQuery.trim()) {
          searchQuery = interpretation.canonicalQuery.trim();
        }
      } else {
        liveInfo.interpretFailed = true;
      }
    }
    const { groups } = await searchLiveProducts(searchQuery);
    if (!groups.length) return null;
    let group = groups[0];
    const hintedBrand = liveInfo.interpretation?.brand?.trim();
    if (hintedBrand) {
      const branded = groups.find(
        (g) => g.brand.toLowerCase() === hintedBrand.toLowerCase(),
      );
      if (branded) group = branded;
    }
    return buildLiveComparison(req, group, liveInfo);
  }

  return null;
}
