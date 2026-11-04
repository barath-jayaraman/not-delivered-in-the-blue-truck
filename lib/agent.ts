import { getPolicyGateEntries } from "./adapters";
import type { AgentActivity, AgentStep, Priority, ReturnCost } from "./types";

/**
 * MUSE SPARK AGENT PIPELINE — narration + live Meta Model API calls.
 *
 * The comparison pipeline runs these steps for every decision:
 * interpret → route → gather → verify → score → explain.
 *
 * Muse Spark (through the Meta Model API) performs the judgement inside
 * two of those steps when a key is configured:
 *   - interpret: turns the shopper's raw words into structured search terms
 *     that are then matched against the LOCAL catalog (lib/data.ts). Muse
 *     never invents products, prices, or offers — the catalog is the only
 *     source of offers, and it is still the sample catalog.
 *   - explain: writes the plain-language recommendation from the deltas the
 *     deterministic scoring step (lib/scoring.ts) already computed. The
 *     model's text is accepted only if every dollar figure in it appears in
 *     the scored facts it was given; otherwise the local explanation stands.
 * Scoring itself stays deterministic application logic so the numbers are
 * never model-invented.
 *
 * CONFIGURATION (server-side only — never expose the key to the client):
 *   META_MODEL_API_KEY       — required to go live; absent = local pipeline.
 *   META_MODEL_API_ENDPOINT  — optional; defaults to the Meta chat-completions
 *                              endpoint below.
 *   META_MODEL_NAME          — optional; defaults to "muse-spark-1.1".
 *
 * HONESTY RULES: the activity payload reports mode "live" only when a live
 * call actually succeeded for that request, and names the steps that ran
 * live. A failed or timed-out live call falls back to the local pipeline
 * silently, and the label says the request ran locally — the app never
 * fakes a live model call.
 */

export const DEFAULT_META_MODEL_ENDPOINT =
  "https://api.meta.ai/v1/chat/completions";
export const DEFAULT_META_MODEL_NAME = "muse-spark-1.1";

/**
 * Muse Spark reasons at length by default (measured Oct 28, 2026: a short
 * explain prompt burned 1,598 of a 1,600-token cap on reasoning and returned
 * no visible text). reasoning_effort "low" is accepted by the API and keeps
 * these extraction/short-writing calls fast; the cap stays generous as
 * headroom so the visible reply is never starved.
 */
const LIVE_MAX_TOKENS = 2500;
/** Abort a live call after ~20s and fall back to the local pipeline. */
const LIVE_TIMEOUT_MS = 20_000;
/**
 * Per-step budgets (Nov 2, 2026 — search-speed work). The interpret
 * step used to run BEFORE the live search on every /api/search, so its
 * latency was a serial tax on every search. The search route now runs
 * interpretation CONCURRENTLY with a live search on the raw query and
 * only waits for it up to SEARCH_INTERPRET_BUDGET_MS (inside the
 * route); this 8s default remains the transport ceiling for the
 * decide path, where interpretation is a fallback, not a gate. The
 * fallback for a slow call is simply the shopper's raw query — the
 * same result a failed call gives today. The explain step writes from
 * already-scored facts; past 12s the local explanation (identical
 * numbers, local words) stands.
 */
const INTERPRET_TIMEOUT_MS = 8_000;
const EXPLAIN_TIMEOUT_MS = 12_000;

export interface MetaModelConfig {
  /** True when META_MODEL_API_KEY is set (the endpoint has a default). */
  liveConfigured: boolean;
  endpoint: string;
  model: string;
}

export function getMetaModelConfig(): MetaModelConfig {
  const apiKey = process.env.META_MODEL_API_KEY?.trim() || null;
  return {
    liveConfigured: Boolean(apiKey),
    endpoint:
      process.env.META_MODEL_API_ENDPOINT?.trim() || DEFAULT_META_MODEL_ENDPOINT,
    model: process.env.META_MODEL_NAME?.trim() || DEFAULT_META_MODEL_NAME,
  };
}

/* ------------------------------------------------------------------ */
/* Live transport                                                      */
/* ------------------------------------------------------------------ */

interface ChatMessage {
  role: "system" | "user";
  content: string;
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: unknown } }[];
}

/**
 * One Muse Spark chat completion, or null on any failure. Retries exactly
 * once, and only on a network error (a request that never reached the API);
 * HTTP errors and timeouts are never retried, so a call that may have been
 * processed is never double-billed.
 */
async function callMetaModel(
  messages: ChatMessage[],
  temperature: number,
  timeoutMs: number = LIVE_TIMEOUT_MS,
  maxTokens: number = LIVE_MAX_TOKENS,
): Promise<string | null> {
  const config = getMetaModelConfig();
  const apiKey = process.env.META_MODEL_API_KEY?.trim();
  if (!config.liveConfigured || !apiKey) return null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer: ReturnType<typeof setTimeout> = setTimeout(
      () => controller.abort(),
      timeoutMs,
    );
    try {
      const response = await fetch(config.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          max_tokens: maxTokens,
          reasoning_effort: "low",
          temperature,
        }),
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const data = (await response.json()) as ChatCompletionResponse | null;
      const content = data?.choices?.[0]?.message?.content;
      return typeof content === "string" && content.trim() ? content : null;
    } catch {
      // A timeout abort means the request may already have been processed —
      // never retry it. A network error means it never arrived — retry once.
      if (controller.signal.aborted) return null;
      if (attempt === 1) return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Interpret step (live)                                               */
/* ------------------------------------------------------------------ */

/** Structured reading of the shopper's raw query, produced by Muse Spark. */
export interface InterpretedQuery {
  canonicalQuery: string;
  category: string | null;
  brand: string | null;
  modelKeywords: string[];
  priorityHint: Priority | null;
}

function cleanShortString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().slice(0, maxLength);
  return cleaned ? cleaned : null;
}

/** Defensive parse: anything unexpected at all means "no interpretation". */
function parseInterpretation(raw: string): InterpretedQuery | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  const canonicalQuery = cleanShortString(obj.canonical_query, 120);
  if (!canonicalQuery) return null;

  const modelKeywords: string[] = [];
  if (Array.isArray(obj.model_keywords)) {
    for (const keyword of obj.model_keywords) {
      const cleaned = cleanShortString(keyword, 40);
      if (cleaned) modelKeywords.push(cleaned);
      if (modelKeywords.length >= 8) break;
    }
  }

  const hint = obj.priority_hint;
  return {
    canonicalQuery,
    category: cleanShortString(obj.category, 60),
    brand: cleanShortString(obj.brand, 60),
    modelKeywords,
    priorityHint:
      hint === "cheapest" || hint === "fastest" || hint === "returns"
        ? hint
        : null,
  };
}

/**
 * Ask Muse Spark to interpret the shopper's raw query. Returns null when
 * live calls are not configured or the call/parse fails — callers then use
 * the local matcher exactly as before. The catalog list grounds the model
 * in the only products that exist; it must map onto them, never invent.
 */
export async function interpretQuery(
  rawQuery: string,
  timeoutMs: number = INTERPRET_TIMEOUT_MS,
): Promise<InterpretedQuery | null> {
  const query = rawQuery.trim();
  if (!query || !getMetaModelConfig().liveConfigured) return null;

  const raw = await callMetaModel(
    [
      {
        role: "system",
        content:
          "You are the search interpreter for 'Not Delivered in the Blue Truck', a shopping comparison app whose search runs LIVE against retailer sources. " +
          "Convert the shopper's words into a clean structured search phrase for those live sources. " +
          "Keep the brand and model the shopper named (fixing obvious spelling only); do not restrict the request to any fixed list of products, and never invent products, brands, prices, or offers the shopper did not name. " +
          'Return ONLY a JSON object (no markdown, no commentary) with this shape: {"canonical_query": string, "category": string|null, "brand": string|null, "model_keywords": string[], "priority_hint": "cheapest"|"fastest"|"returns"|null}. ' +
          "canonical_query is the clean product search phrase. priority_hint is set only when the shopper's words clearly lean toward lowest price, fastest delivery, or easiest returns.",
      },
      { role: "user", content: query },
    ],
    0,
    timeoutMs,
  );
  return raw ? parseInterpretation(raw) : null;
}

/* ------------------------------------------------------------------ */
/* Explain step (live)                                                 */
/* ------------------------------------------------------------------ */

export interface ExplainOfferFacts {
  seller: string;
  merchant: string;
  totalCost: number;
  price: number;
  /** Null = the source stated no shipping charge (calculated at checkout, not in the total). */
  shippingCost: number | null;
  /** Null = the source stated no delivery window. */
  deliveryDays: number | null;
  returnWindowDays: number | null;
  returnCost: ReturnCost;
  warrantyMonths: number;
  /** Set when the listing text states a lifetime warranty (label, not a count). */
  warrantyLabel?: string | null;
  sellerRating: number;
  score: number;
  /**
   * True for UCP first-party store offers: the merchant's catalog
   * states NO shipping charge (it is calculated at checkout and is not
   * in the total) and NO seller rating. shippingCost 0 / sellerRating 0
   * there are absences of data and must never be rendered to the model
   * as "free" shipping or a 0.0 rating.
   */
  firstPartyStore?: boolean;
}

export interface ExplainInput {
  productName: string;
  priority: Priority;
  needByDays: number;
  winner: ExplainOfferFacts;
  cheapestSticker: ExplainOfferFacts;
  sameOffer: boolean;
}

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

function offerFacts(label: string, o: ExplainOfferFacts): string {
  const shipping =
    o.firstPartyStore || o.shippingCost === null
      ? "shipping not stated by the merchant — calculated at checkout and NOT included in the total (never call it free)"
      : o.shippingCost === 0
        ? "free"
        : money(o.shippingCost);
  const delivery =
    o.deliveryDays === null
      ? "delivery time not stated by the seller"
      : `arrives in ${o.deliveryDays} days`;
  const rating = o.firstPartyStore
    ? "no seller rating (the merchant's own first-party store)"
    : o.sellerRating.toFixed(1);
  // Return terms exactly as the source stated them: a stated window, a
  // stated cost with no stated window, or nothing stated at all. Never
  // hand the model a window the source did not state.
  const returns =
    o.returnWindowDays === null
      ? o.returnCost === "not-stated"
        ? "not stated by seller"
        : `${o.returnCost}, window not stated by seller`
      : `${o.returnCost} within ${o.returnWindowDays} days`;
  return (
    `${label}: seller ${o.seller} (${o.merchant}), total ${money(o.totalCost)} ` +
    `(sticker ${money(o.price)} + shipping ${shipping}), ` +
    `${delivery}, returns: ${returns}, ` +
    `warranty ${o.warrantyLabel ? "lifetime, as stated in the listing text" : o.warrantyMonths > 0 ? `${o.warrantyMonths} months` : "not stated by seller"}, seller rating ${rating}, score ${o.score}/100.`
  );
}

/**
 * The model may only spend numbers it was handed. If the explanation cites
 * any dollar figure that is not one of the scored facts, reject it whole.
 */
function figuresAreGrounded(text: string, allowed: number[]): boolean {
  const cited = text.match(/\$\s?[\d,]+(?:\.\d{1,2})?/g) ?? [];
  return cited.every((figure) => {
    const value = Number.parseFloat(figure.replace(/[$,\s]/g, ""));
    return allowed.some((a) => Math.abs(a - value) < 0.011);
  });
}

/**
 * Ask Muse Spark to write the recommendation from the scored deltas.
 * Returns null on any failure — transport, empty text, or an ungrounded
 * figure — and the caller keeps the local explanation.
 */
export async function explainRecommendation(
  input: ExplainInput,
): Promise<string | null> {
  if (!getMetaModelConfig().liveConfigured) return null;

  const raw = await callMetaModel(
    [
      {
        role: "system",
        content:
          "You write the recommendation explanation for 'Not Delivered in the Blue Truck', a shopping comparison app. " +
          "The app has already scored the offers deterministically; you are given those facts. " +
          "Use ONLY the numbers and facts provided — never invent prices, discounts, features, delivery promises, or policies. " +
          "Write 2-3 plain-language sentences for the shopper explaining why the recommended offer is the best whole deal for their priority, " +
          "including the trade-off against the cheapest-sticker offer when they differ. No markdown, no bullet points, no preamble.",
      },
      {
        role: "user",
        content:
          `Product: ${input.productName}. Shopper priority: ${input.priority}. Need-by: ${input.needByDays} days.\n` +
          `${offerFacts("Recommended offer", input.winner)}\n` +
          (input.sameOffer
            ? "The recommended offer is also the cheapest-sticker offer."
            : offerFacts("Cheapest-sticker offer", input.cheapestSticker)),
      },
    ],
    0.2,
    EXPLAIN_TIMEOUT_MS,
  );
  if (!raw) return null;

  const text = raw.trim().replace(/\s+/g, " ");
  if (text.length < 30 || text.length > 900) return null;
  const allowedFigures = [
    input.winner.price,
    input.winner.shippingCost,
    input.winner.totalCost,
    input.cheapestSticker.price,
    input.cheapestSticker.shippingCost,
    input.cheapestSticker.totalCost,
    // Trade-off differences between the two offers are scored facts too —
    // without them, any "costs $X more" phrasing reads as ungrounded.
    Math.abs(input.winner.price - input.cheapestSticker.price),
    Math.abs(input.winner.totalCost - input.cheapestSticker.totalCost),
    // Unstated shipping (null) is not a figure the model may cite.
  ].filter((n): n is number => n != null);
  return figuresAreGrounded(text, allowedFigures) ? text : null;
}

/* ------------------------------------------------------------------ */
/* Highlights step (live) — distill a listing description              */
/* ------------------------------------------------------------------ */

/**
 * Highlights budget (Nov 4, 2026): the distill call runs on the
 * product-page path only, in parallel with the description fetch /
 * explanation, under the same ~10s discipline as the other product-
 * page calls. Output is a handful of short bullets, so the token cap
 * is tight.
 */
const HIGHLIGHTS_TIMEOUT_MS = 10_000;
const HIGHLIGHTS_MAX_TOKENS = 800;
const HIGHLIGHTS_MIN = 3;
const HIGHLIGHTS_MAX = 5;

const HIGHLIGHT_STOPWORDS = new Set([
  "with", "from", "that", "this", "your", "yours", "their", "them",
  "they", "have", "has", "had", "will", "would", "can", "could",
  "should", "about", "above", "after", "again", "also", "and", "are",
  "been", "before", "below", "between", "both", "but", "by", "for",
  "if", "in", "into", "is", "it", "its", "no", "not", "of", "on",
  "or", "our", "out", "over", "per", "so", "than", "the", "to",
  "under", "up", "upon", "was", "we", "were", "when", "while", "you",
  "a", "an", "as", "at", "be", "do", "does",
]);

function significantTokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z'-]*/g) ?? []).filter(
    (token) => token.length >= 4 && !HIGHLIGHT_STOPWORDS.has(token),
  );
}

function figuresIn(text: string): string[] {
  return (text.match(/\d+(?:\.\d+)?/g) ?? []).map((n) =>
    String(Number.parseFloat(n)),
  );
}

/**
 * Grounding gate for one bullet, stricter than the explain step's:
 * the bullet's input is a single source text, so EVERY figure in the
 * bullet must appear in that text verbatim, and at least 60% of the
 * bullet's significant words must come from it. A bullet that needs
 * an outside fact fails here and is dropped, never repaired.
 */
function bulletIsGrounded(bullet: string, source: string): boolean {
  const sourceFigures = new Set(figuresIn(source));
  if (!figuresIn(bullet).every((f) => sourceFigures.has(f))) return false;
  const bulletTokens = significantTokens(bullet);
  if (!bulletTokens.length) return false;
  const sourceTokens = new Set(significantTokens(source));
  const hits = bulletTokens.filter((t) => sourceTokens.has(t)).length;
  return hits / bulletTokens.length >= 0.6;
}

/** Defensive parse of the model's reply into plain bullet strings. */
function parseHighlights(raw: string): string[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const bullets: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "string") continue;
    const cleaned = entry
      .replace(/^\s*(?:[-•*]|\d+[.)])\s*/, "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 120);
    if (cleaned.length >= 8) bullets.push(cleaned);
    if (bullets.length >= HIGHLIGHTS_MAX) break;
  }
  return bullets;
}

/**
 * Ask Muse Spark to distill ONE offer's retrieved listing description
 * into 4–5 short highlight bullets, grounded strictly in that text:
 * no added features, no marketing language, no figure that does not
 * appear verbatim in the source. Returns null — and the page renders
 * no Highlights section — when live calls are not configured, the
 * call fails, or fewer than HIGHLIGHTS_MIN bullets pass the grounding
 * gate. There is no local fallback text: unvalidated model output is
 * never shown.
 */
export async function distillHighlights(
  description: string,
): Promise<string[] | null> {
  if (!getMetaModelConfig().liveConfigured) return null;
  const source = description.trim();
  if (source.length < 80) return null;

  const raw = await callMetaModel(
    [
      {
        role: "system",
        content:
          "You extract highlights for 'Not Delivered in the Blue Truck', a shopping comparison app. " +
          "You are given ONE product listing's description text, retrieved live from the store. " +
          "Distill it into 4 to 5 short highlight bullets — the key points a shopper would want, in the listing's own substance. " +
          "Use ONLY facts stated in the text: never add features, materials, benefits, or claims that are not there, and add no marketing language of your own. " +
          "Do not state any number, dimension, weight, or rating unless it appears in the text exactly as given. " +
          "Each bullet is one plain phrase of at most 12 words, no trailing period needed. " +
          "Return ONLY a JSON array of strings (no markdown, no commentary).",
      },
      { role: "user", content: source.slice(0, 4000) },
    ],
    0,
    HIGHLIGHTS_TIMEOUT_MS,
    HIGHLIGHTS_MAX_TOKENS,
  );
  if (!raw) return null;

  const grounded = parseHighlights(raw).filter((bullet) =>
    bulletIsGrounded(bullet, source),
  );
  return grounded.length >= HIGHLIGHTS_MIN ? grounded : null;
}

/* ------------------------------------------------------------------ */
/* Activity narration                                                  */
/* ------------------------------------------------------------------ */

const PRIORITY_LABEL: Record<Priority, string> = {
  cheapest: "lowest total cost",
  fastest: "fastest arrival",
  returns: "easiest returns",
};

/** What actually happened live during this request (set by lib/decide-live.ts). */
export interface LiveRunInfo {
  /** Steps that ran on Muse Spark and succeeded for this request. */
  steps: AgentStep["id"][];
  /** The live interpretation, when the interpret step ran live. */
  interpretation?: InterpretedQuery | null;
  /** True when a live interpret was attempted but did not complete. */
  interpretFailed?: boolean;
}

export interface AgentActivityInput {
  productName: string;
  priority: Priority;
  needByDays: number;
  /** Merchants that actually supplied offers, with their production route. */
  gathered: { merchant: string; route: string; offerCount: number }[];
  totalOffers: number;
  recommendationSeller: string;
  /** Live-run facts for this request; omit when the local pipeline ran it. */
  live?: LiveRunInfo;
}

const STEP_TITLES: Record<AgentStep["id"], string> = {
  interpret: "Interpret the request",
  route: "Route merchants through the policy gate",
  gather: "Gather offers",
  verify: "Verify and normalize",
  score: "Score the trade-offs",
  explain: "Explain the recommendation",
};

export function buildAgentActivity(input: AgentActivityInput): AgentActivity {
  const config = getMetaModelConfig();
  const liveSteps = input.live?.steps ?? [];
  const ranLive = liveSteps.length > 0;
  const liveEngine = `${config.model} via Meta Model API (live call)`;
  const engineFor = (id: AgentStep["id"]): string =>
    liveSteps.includes(id) ? liveEngine : "Local pipeline";
  const gate = getPolicyGateEntries();
  const routeSummary = gate
    .map((entry) => `${entry.merchant} → ${entry.outcomeLabel.toLowerCase()}`)
    .join("; ");
  const gatherSummary = input.gathered
    .map((g) => `${g.merchant}: ${g.offerCount} via ${g.route}`)
    .join(" · ");

  const interpretation = input.live?.interpretation ?? null;
  let interpretDetail =
    `Resolved the shopper's search to ${input.productName} and read the priorities: ` +
    `${PRIORITY_LABEL[input.priority]}, needed within ${input.needByDays} days.`;
  if (interpretation) {
    interpretDetail =
      `Muse Spark interpreted the request as "${interpretation.canonicalQuery}"` +
      (interpretation.brand ? ` (brand: ${interpretation.brand})` : "") +
      (interpretation.category ? ` (category: ${interpretation.category})` : "") +
      (interpretation.priorityHint
        ? `, with a lean toward ${PRIORITY_LABEL[interpretation.priorityHint]} in the shopper's words`
        : "") +
      `, then matched it against the local catalog to ${input.productName}. ` +
      `The shopper's selected priority — ${PRIORITY_LABEL[input.priority]} — still governs the scoring.`;
  } else if (input.live?.interpretFailed) {
    interpretDetail +=
      " A live Muse Spark interpretation was attempted for this request and did not complete, so the local matcher resolved the product instead.";
  }

  const steps: AgentStep[] = [
    {
      id: "interpret",
      title: STEP_TITLES.interpret,
      detail: interpretDetail,
      engine: engineFor("interpret"),
      status: "done",
    },
    {
      id: "route",
      title: STEP_TITLES.route,
      detail: `Each merchant was routed by its own agent policy before any data moved — ${routeSummary}.`,
      engine: engineFor("route"),
      status: "done",
    },
    {
      id: "gather",
      title: STEP_TITLES.gather,
      detail: `Collected ${input.totalOffers} live offers (${gatherSummary}), fetched in this request through each merchant's policy-approved route.`,
      engine: engineFor("gather"),
      status: "done",
    },
    {
      id: "verify",
      title: STEP_TITLES.verify,
      detail:
        "Checked provenance on every offer (merchant, acquisition method, policy status) and normalized price, shipping, arrival, return window/cost, warranty, and seller rating into one schema.",
      engine: engineFor("verify"),
      status: "done",
    },
    {
      id: "score",
      title: STEP_TITLES.score,
      detail: `Scored every offer deterministically on total cost, speed vs the need-by date, returns, warranty, and seller rating, weighted for ${PRIORITY_LABEL[input.priority]}.`,
      engine: "Local pipeline (deterministic scoring)",
      status: "done",
    },
    {
      id: "explain",
      title: STEP_TITLES.explain,
      detail: liveSteps.includes("explain")
        ? `Muse Spark wrote the recommendation in plain language from the scored parameter deltas — the numbers come from the scoring step, never from the model.`
        : `Explained why ${input.recommendationSeller} is the best whole deal, in plain language, from the scored parameter deltas — the numbers come from the scoring step, never from the model.`,
      engine: engineFor("explain"),
      status: "done",
    },
  ];

  return {
    mode: ranLive ? "live" : config.liveConfigured ? "live-configured" : "local",
    liveConfigured: config.liveConfigured,
    liveSteps,
    modelLabel: ranLive
      ? `${config.model} via Meta Model API — live for this request (${liveSteps.map((s) => STEP_TITLES[s].toLowerCase()).join(", ")}); every figure was computed locally`
      : config.liveConfigured
        ? `${config.model} via Meta Model API — a key is configured, but this request ran on the local pipeline; no live call is claimed for it`
        : `${config.model} via Meta Model API — connects when the API key is configured; the local pipeline is running these steps now`,
    steps,
  };
}
