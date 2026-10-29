import {
  buildAgentActivity,
  explainRecommendation,
  getMetaModelConfig,
  interpretQuery,
  type ExplainOfferFacts,
  type InterpretedQuery,
  type LiveRunInfo,
} from "./agent";
import { ebayApiEnabled, fetchLiveEbayOffers } from "./adapters/ebay-api";
import {
  fetchLiveWalmartOffers,
  walmartBrowseEnabled,
} from "./adapters/walmart-browse";
import { fetchRelayWalmartOffers } from "./adapters/walmart-relay";
import { findProduct, getProductById } from "./data";
import { buildExplanation, decide, scoreOffers } from "./scoring";
import type {
  AgentStep,
  DecideRequest,
  DecideResponse,
  Offer,
  ScoredOffer,
} from "./types";

/**
 * DECIDE ORCHESTRATION — local scoring with live Muse Spark steps.
 *
 * Flow when META_MODEL_API_KEY is configured:
 *   1. Interpret (live): Muse reads the shopper's raw query; its terms are
 *      matched against the LOCAL sample catalog. The model never supplies
 *      products, prices, or offers.
 *   2. Score (local, deterministic): lib/scoring.ts decides exactly as
 *      before — numbers are never model-invented.
 *   3. Explain (live): Muse writes the recommendation from the scored
 *      deltas; the text is accepted only if every figure in it is grounded
 *      in those deltas (see lib/agent.ts), else the local text stands.
 * Any live failure falls back to the local result silently, and the
 * agent-activity payload says precisely which steps ran live — mode "live"
 * is reported only when a live call actually succeeded for this request.
 * When no key is configured this returns decide() untouched.
 */

function resolveProductId(interpretation: InterpretedQuery): string | null {
  const candidates = [
    interpretation.canonicalQuery,
    [interpretation.brand, ...interpretation.modelKeywords]
      .filter(Boolean)
      .join(" "),
    interpretation.modelKeywords.join(" "),
  ];
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    const product = findProduct(trimmed);
    if (product) return product.id;
  }
  return null;
}

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

/** Same gathered-merchant summary lib/scoring.ts builds, for the narration. */
function gatheredFor(productId: string) {
  const product = getProductById(productId);
  if (!product) return null;
  return {
    totalOffers: product.offers.length,
    gathered: [...new Set(product.offers.map((offer) => offer.merchant))].map(
      (merchant) => ({
        merchant,
        route:
          merchant === "Walmart"
            ? "planned browsing route (Agentic Access Terms)"
            : "official API route",
        offerCount: product.offers.filter(
          (offer) => offer.merchant === merchant,
        ).length,
      }),
    ),
  };
}

/**
 * Live offers already merged into a result, keyed by the result object.
 * Successive merchant merges (Walmart browse, eBay API) re-score the full
 * pool — catalog samples plus every live offer merged so far — so an
 * earlier merchant's live offer is never dropped by a later merge.
 */
const mergedLivePool = new WeakMap<DecideResponse, Offer[]>();

/**
 * Merge newly fetched live offers into a decide result. The combined set
 * is re-scored with the same deterministic engine so live offers compete
 * on identical terms, and the local explanation is rebuilt so every
 * figure it cites stays grounded. The response is flagged through
 * `liveData` (which lists every live merchant present) and through each
 * live offer's provenance.
 */
function applyLiveOffers(
  result: DecideResponse,
  req: DecideRequest,
  liveOffers: Offer[],
): DecideResponse {
  const product = getProductById(result.product.id);
  if (!product) return result;

  const pool = [...(mergedLivePool.get(result) ?? []), ...liveOffers];
  mergedLivePool.set(result, pool);
  const poolIds = new Set(pool.map((o) => o.id));

  const rescored = scoreOffers([...product.offers, ...pool], req);
  const top = rescored.slice(0, 5);
  // A live offer must be visible alongside the sample offers even when it
  // does not out-score five of them: swap it in for the lowest-ranked
  // non-live offer and restore score order. The recommendation still goes
  // to the genuine top scorer.
  for (const live of pool) {
    if (top.some((o) => o.id === live.id)) continue;
    const scoredLive = rescored.find((o) => o.id === live.id);
    if (!scoredLive) continue;
    let replaceIdx = -1;
    for (let i = top.length - 1; i >= 0; i--) {
      if (!poolIds.has(top[i].id)) {
        replaceIdx = i;
        break;
      }
    }
    if (replaceIdx >= 0) top[replaceIdx] = scoredLive;
  }
  top.sort((a, b) => b.score - a.score);
  result.offers = top;
  result.recommendation = result.offers[0];
  result.cheapestSticker = [...rescored].sort((a, b) => a.price - b.price)[0];
  result.explanation = buildExplanation(
    result.recommendation,
    result.cheapestSticker,
    result.priority,
    result.needByDays,
  );
  const all = [...product.offers, ...pool];
  result.priceRange = {
    lowest: Math.min(...all.map((o) => o.price)),
    highest: Math.max(...all.map((o) => o.price)),
  };
  result.fastestDeliveryDays = Math.min(...all.map((o) => o.deliveryDays));

  const byMerchant = new Map<string, Offer[]>();
  for (const offer of pool) {
    const group = byMerchant.get(offer.merchant) ?? [];
    group.push(offer);
    byMerchant.set(offer.merchant, group);
  }
  const merchants = [...byMerchant.entries()].map(([merchant, offers]) => ({
    merchant,
    retrievedAt:
      offers[0].provenance.retrievedAt ?? new Date().toISOString(),
    sourceUrl: offers[0].provenance.sourceUrl ?? "",
    offerIds: offers.map((o) => o.id),
  }));
  result.liveData = {
    merchant: merchants[0].merchant,
    retrievedAt: merchants[0].retrievedAt,
    sourceUrl: merchants[0].sourceUrl,
    offerIds: pool.map((o) => o.id),
    merchants,
  };
  return result;
}

/**
 * Merge the live Walmart offer into a decide result. Source preference:
 * (1) the direct browsed offer from lib/adapters/walmart-browse.ts —
 * works wherever Walmart serves this client; (2) the fetch-relay offer
 * from lib/adapters/walmart-relay.ts — the same adapter's extraction,
 * produced off-host and republished as a JSON document, for hosts whose
 * direct fetches Walmart blocks/challenges (production). When browsing
 * is disabled (ENABLE_WALMART_BROWSE=0), both sources are off; when
 * neither yields an offer, the result is returned untouched and the
 * sample flow stands.
 */
async function mergeLiveWalmartOffers(
  result: DecideResponse,
  req: DecideRequest,
): Promise<DecideResponse> {
  if (!walmartBrowseEnabled()) return result;
  const product = getProductById(result.product.id);
  if (!product) return result;

  let liveOffers: Offer[] = [];
  try {
    liveOffers = await fetchLiveWalmartOffers(product);
  } catch {
    liveOffers = [];
  }
  if (!liveOffers.length) {
    try {
      liveOffers = await fetchRelayWalmartOffers(product);
    } catch {
      return result;
    }
  }
  if (!liveOffers.length) return result;
  return applyLiveOffers(result, req, liveOffers);
}

/**
 * Merge the live eBay offer (when ENABLE_EBAY_API=1 and the production
 * keyset is configured) into a decide result. Same contract as the
 * Walmart merge: any failure or no honest match leaves the result
 * untouched, and the sample flow is never disturbed.
 */
async function mergeLiveEbayOffers(
  result: DecideResponse,
  req: DecideRequest,
): Promise<DecideResponse> {
  if (!ebayApiEnabled()) return result;
  const product = getProductById(result.product.id);
  if (!product) return result;

  let liveOffers: Awaited<ReturnType<typeof fetchLiveEbayOffers>> = [];
  try {
    liveOffers = await fetchLiveEbayOffers(product);
  } catch {
    return result;
  }
  if (!liveOffers.length) return result;
  return applyLiveOffers(result, req, liveOffers);
}

export async function decideWithAgent(
  req: DecideRequest,
): Promise<DecideResponse | null> {
  const config = getMetaModelConfig();
  if (!config.liveConfigured) {
    const result = decide(req);
    if (!result) return null;
    await mergeLiveWalmartOffers(result, req);
    return mergeLiveEbayOffers(result, req);
  }

  const liveSteps: AgentStep["id"][] = [];
  let interpretation: InterpretedQuery | null = null;
  let interpretFailed = false;
  let effectiveReq = req;

  if (req.query && !req.productId) {
    interpretation = await interpretQuery(req.query);
    if (interpretation) {
      liveSteps.push("interpret");
      const productId = resolveProductId(interpretation);
      if (productId) effectiveReq = { ...req, productId };
    } else {
      interpretFailed = true;
    }
  }

  const result = decide(effectiveReq);
  if (!result) return null;

  // Merge any live merchant offers (Walmart browse, eBay API) before the
  // explanation step so the Muse explanation grounds against the same
  // winner/cheapest facts it cites.
  await mergeLiveWalmartOffers(result, effectiveReq);
  await mergeLiveEbayOffers(result, effectiveReq);

  const liveExplanation = await explainRecommendation({
    productName: result.product.name,
    priority: result.priority,
    needByDays: result.needByDays,
    winner: toExplainFacts(result.recommendation),
    cheapestSticker: toExplainFacts(result.cheapestSticker),
    sameOffer: result.recommendation.id === result.cheapestSticker.id,
  });
  if (liveExplanation) {
    result.explanation = liveExplanation;
    liveSteps.push("explain");
  }

  const gathered = gatheredFor(result.product.id);
  if (gathered) {
    const live: LiveRunInfo = {
      steps: liveSteps,
      interpretation,
      interpretFailed,
    };
    result.agentActivity = buildAgentActivity({
      productName: result.product.name,
      priority: result.priority,
      needByDays: result.needByDays,
      gathered: gathered.gathered,
      totalOffers: gathered.totalOffers,
      recommendationSeller: result.recommendation.seller,
      live,
    });
  }
  return result;
}
