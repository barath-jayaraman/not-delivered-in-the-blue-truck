import {
  buildAgentActivity,
  explainRecommendation,
  getMetaModelConfig,
  interpretQuery,
  type ExplainOfferFacts,
  type InterpretedQuery,
  type LiveRunInfo,
} from "./agent";
import { findProduct, getProductById } from "./data";
import { decide } from "./scoring";
import type {
  AgentStep,
  DecideRequest,
  DecideResponse,
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

export async function decideWithAgent(
  req: DecideRequest,
): Promise<DecideResponse | null> {
  const config = getMetaModelConfig();
  if (!config.liveConfigured) return decide(req);

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
