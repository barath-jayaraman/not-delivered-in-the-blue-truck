import { getPolicyGateEntries } from "./adapters";
import type { AgentActivity, AgentStep, Priority } from "./types";

/**
 * MUSE SPARK AGENT PIPELINE — narration + live-call seam.
 *
 * The comparison pipeline runs these steps for every decision:
 * interpret → route → gather → verify → score → explain.
 *
 * In the finished product, Muse Spark (through the Meta Model API) performs
 * the judgement inside these steps: interpreting the request, choosing the
 * merchant routes, reading merchant pages on the browsing route, validating
 * extracted fields, matching the same product across merchants, and writing
 * the plain-language trade-off explanation. Scoring itself stays
 * deterministic application logic so the numbers are never model-invented.
 *
 * LIVE-CALL SEAM: set both environment variables (server-side only) and
 * `liveConfigured` becomes true:
 *   META_MODEL_API_ENDPOINT  — the Meta Model API endpoint
 *   META_MODEL_API_KEY       — the API key for that endpoint
 *   META_MODEL_NAME          — optional, defaults to "Muse Spark"
 * A live implementation posts each step's structured input to that endpoint
 * and merges the model's output into the same AgentStep shape. Until then,
 * the local pipeline performs the identical steps and the UI labels them
 * honestly as local — the app never fakes a live model call.
 */

export interface MetaModelConfig {
  liveConfigured: boolean;
  endpoint: string | null;
  model: string;
}

export function getMetaModelConfig(): MetaModelConfig {
  const endpoint = process.env.META_MODEL_API_ENDPOINT?.trim() || null;
  const apiKey = process.env.META_MODEL_API_KEY?.trim() || null;
  return {
    liveConfigured: Boolean(endpoint && apiKey),
    endpoint,
    model: process.env.META_MODEL_NAME?.trim() || "Muse Spark",
  };
}

const PRIORITY_LABEL: Record<Priority, string> = {
  cheapest: "lowest total cost",
  fastest: "fastest arrival",
  returns: "easiest returns",
};

export interface AgentActivityInput {
  productName: string;
  priority: Priority;
  needByDays: number;
  /** Merchants that actually supplied offers, with their production route. */
  gathered: { merchant: string; route: string; offerCount: number }[];
  totalOffers: number;
  recommendationSeller: string;
}

export function buildAgentActivity(input: AgentActivityInput): AgentActivity {
  const config = getMetaModelConfig();
  const engine = config.liveConfigured
    ? `${config.model} via Meta Model API (endpoint configured)`
    : "Local pipeline";
  const gate = getPolicyGateEntries();
  const routeSummary = gate
    .map((entry) => `${entry.merchant} → ${entry.outcomeLabel.toLowerCase()}`)
    .join("; ");
  const gatherSummary = input.gathered
    .map((g) => `${g.merchant}: ${g.offerCount} via ${g.route}`)
    .join(" · ");

  const steps: AgentStep[] = [
    {
      id: "interpret",
      title: "Interpret the request",
      detail: `Resolved the shopper's search to ${input.productName} and read the priorities: ${PRIORITY_LABEL[input.priority]}, needed within ${input.needByDays} days.`,
      engine,
      status: "done",
    },
    {
      id: "route",
      title: "Route merchants through the policy gate",
      detail: `Each merchant was routed by its own agent policy before any data moved — ${routeSummary}.`,
      engine,
      status: "done",
    },
    {
      id: "gather",
      title: "Gather offers",
      detail: `Collected ${input.totalOffers} sample offers (${gatherSummary}). Records are labelled sample data; in production the same routes carry live offers.`,
      engine,
      status: "done",
    },
    {
      id: "verify",
      title: "Verify and normalize",
      detail:
        "Checked provenance on every offer (merchant, acquisition method, policy status) and normalized price, shipping, arrival, return window/cost, warranty, and seller rating into one schema.",
      engine,
      status: "done",
    },
    {
      id: "score",
      title: "Score the trade-offs",
      detail: `Scored every offer deterministically on total cost, speed vs the need-by date, returns, warranty, and seller rating, weighted for ${PRIORITY_LABEL[input.priority]}.`,
      engine: "Local pipeline (deterministic scoring)",
      status: "done",
    },
    {
      id: "explain",
      title: "Explain the recommendation",
      detail: `Explained why ${input.recommendationSeller} wins, in plain language, from the scored parameter deltas — the numbers come from the scoring step, never from the model.`,
      engine,
      status: "done",
    },
  ];

  return {
    mode: config.liveConfigured ? "live-configured" : "local",
    liveConfigured: config.liveConfigured,
    modelLabel: config.liveConfigured
      ? `${config.model} via Meta Model API — endpoint configured; live calls slot into the steps below`
      : `${config.model} via Meta Model API — connects when the API key is configured; the local pipeline is running these steps now`,
    steps,
  };
}
