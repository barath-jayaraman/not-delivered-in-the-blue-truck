import { getMerchantPolicy } from "../adapters";
import type { Offer, Product } from "../types";
import { walmartBrowseEnabled } from "./walmart-browse";

/**
 * WALMART FETCH RELAY — consumer side.
 *
 * Walmart serves its search pages to some networks but blocks/challenges
 * fetches from this app's production host (Vercel's serverless egress):
 * the direct adapter (lib/adapters/walmart-browse.ts) works off-Vercel
 * and returns nothing there. The relay closes that gap without weakening
 * any guardrail: a fetcher running where the fetch is allowed
 * (scripts/fetch-walmart-offers.mjs — the SAME adapter code, same
 * self-identifying user agent, rate limits, and stop-on-block rules)
 * publishes the extracted offers as a JSON document in this project's
 * public repo, and the app reads that document back over HTTPS.
 *
 * Honesty rules for relayed offers:
 * - The offer keeps the price, sourceUrl, and retrievedAt exactly as
 *   extracted from Walmart at fetch time — the relay never rewrites them.
 * - An offer is used only when its original retrieval is fresh (within
 *   RELAY_MAX_AGE_MS); anything older is ignored, never served stale.
 * - The provenance note is extended to say the offer arrived via the
 *   relay, naming the document's generation time, the original Walmart
 *   retrieval time, and the original listing URL.
 * - The relay inherits the adapter's kill switch: ENABLE_WALMART_BROWSE=0
 *   disables relayed Walmart data exactly like direct browsing, and the
 *   merchant policy gate applies unchanged.
 * Any failure — network, parse, missing product, stale offer — returns
 * no offers and the caller falls back to sample data. Never throws.
 */

const RELAY_URL =
  "https://raw.githubusercontent.com/barath-jayaraman/not-delivered-in-the-blue-truck/main/data/live-offers.json";
const RELAY_CACHE_TTL_MS = 5 * 60_000;
const RELAY_MAX_AGE_MS = 12 * 60 * 60_000;
const RELAY_FETCH_TIMEOUT_MS = 8_000;

interface LiveOffersDoc {
  generatedAt: string;
  offers: Record<string, Offer>;
}

let docCache: { fetchedAt: number; doc: LiveOffersDoc } | null = null;
let docInFlight: Promise<LiveOffersDoc | null> | null = null;

function isLiveOffersDoc(value: unknown): value is LiveOffersDoc {
  if (typeof value !== "object" || value === null) return false;
  const doc = value as { generatedAt?: unknown; offers?: unknown };
  return (
    typeof doc.generatedAt === "string" &&
    typeof doc.offers === "object" &&
    doc.offers !== null
  );
}

async function fetchRelayDoc(): Promise<LiveOffersDoc | null> {
  if (docCache && Date.now() - docCache.fetchedAt < RELAY_CACHE_TTL_MS) {
    return docCache.doc;
  }
  if (docInFlight) return docInFlight;
  docInFlight = (async () => {
    try {
      const response = await fetch(RELAY_URL, {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(RELAY_FETCH_TIMEOUT_MS),
      });
      if (response.status !== 200) {
        console.warn(
          `[walmart-relay] relay document returned HTTP ${response.status}; returning no relay offers.`,
        );
        return null;
      }
      const parsed: unknown = await response.json();
      if (!isLiveOffersDoc(parsed)) {
        console.warn(
          "[walmart-relay] relay document has an unexpected shape; returning no relay offers.",
        );
        return null;
      }
      docCache = { fetchedAt: Date.now(), doc: parsed };
      return parsed;
    } catch (error) {
      console.warn("[walmart-relay] relay fetch failed:", String(error));
      return null;
    } finally {
      docInFlight = null;
    }
  })();
  return docInFlight;
}

function isUsableRelayOffer(offer: Offer | undefined): offer is Offer {
  if (!offer || offer.merchant !== "Walmart") return false;
  if (typeof offer.price !== "number" || !(offer.price > 0)) return false;
  const retrievedAt = offer.provenance?.retrievedAt;
  if (!retrievedAt || !offer.provenance?.sourceUrl) return false;
  const age = Date.now() - new Date(retrievedAt).getTime();
  return Number.isFinite(age) && age >= 0 && age <= RELAY_MAX_AGE_MS;
}

/**
 * Return the relayed live Walmart offer for a catalog product, or [] when
 * the relay is disabled, the policy gate does not allow Walmart browsing,
 * the document is unavailable, the product has no relay offer, or the
 * offer's original retrieval is more than 12 hours old. Never throws.
 */
export async function fetchRelayWalmartOffers(
  product: Product,
): Promise<Offer[]> {
  if (!walmartBrowseEnabled()) return [];

  const policy = getMerchantPolicy("Walmart");
  if (
    policy.status !== "browser-allowed-under-terms" ||
    !policy.allowedAcquisitionMethods.includes("browser")
  ) {
    return [];
  }

  const doc = await fetchRelayDoc();
  if (!doc) return [];
  const offer = doc.offers[product.id];
  if (!isUsableRelayOffer(offer)) return [];

  const servedAt = new Date().toISOString();
  const relayed: Offer = {
    ...offer,
    provenance: {
      ...offer.provenance,
      policyNote:
        `${offer.provenance.policyNote} Relay: this offer was retrieved from ` +
        `Walmart's public search-results page at ${offer.provenance.retrievedAt} ` +
        `by the project's fetch relay (the app's production host cannot fetch ` +
        `Walmart directly — its requests are blocked/challenged there) and ` +
        `published in the project's live-offers document generated ` +
        `${doc.generatedAt}; this app fetched that document at ${servedAt}. ` +
        `Original Walmart listing: ${offer.provenance.sourceUrl}.`,
    },
  };
  return [relayed];
}
