/**
 * Warranty extraction — verbatim-grounded, from listing text only.
 *
 * Accuracy rule (Barath, Nov 4, 2026): a warranty is shown only when a
 * source we actually retrieved states one. The Nov 4, 2026 warranty
 * audit found every adapter hardcoding warrantyMonths = 0 — no
 * warranty was ever read from any source, so even a listing whose own
 * description said "backed by our 10-year limited warranty" (the
 * Casper Element Mattress, via its UCP catalog text) rendered as
 * "Not stated by seller". This extractor closes that omission using
 * ONLY text already retrieved in the request:
 *
 *   Class A — an explicit duration: "10-year limited warranty",
 *             "10 year warranty", "2-year warranty" → months = N × 12.
 *   Class B — an explicit lifetime statement: "lifetime warranty",
 *             "lifetime limited warranty", "limited lifetime
 *             warranty" → represented faithfully as a lifetime label,
 *             never converted into an invented month count.
 *
 * NOTHING else counts. No inference from brand, category, or store
 * policy pages. Vague text ("warranty included", "covered by a
 * warranty", "extended warranty available") without a duration or a
 * lifetime statement sets NO value — the offer keeps warrantyMonths 0
 * and renders "Not stated by seller". When in doubt, no match.
 */

export interface ExtractedWarranty {
  /** Stated period in months (years × 12). 0 for a lifetime warranty. */
  months: number;
  /**
   * Display label for the lifetime case ("Lifetime warranty"); null
   * for a year-based warranty, which renders from `months`.
   */
  label: string | null;
  /** The exact phrase matched in the source text (for provenance). */
  phrase: string;
}

// "10-year limited warranty" / "10 year warranty" / "2-year warranty".
// The duration must sit directly against "warranty" (an intervening
// "limited" is the only word allowed) — "3-year extended warranty"
// deliberately does not match: that is a purchasable add-on, not the
// item's stated warranty.
const YEAR_WARRANTY_RE =
  /(?<!\d)(\d{1,3})\s*[-–—‑]?\s*years?\s+(?:limited\s+)?warranty\b/i;

// "lifetime warranty" / "lifetime limited warranty" /
// "limited lifetime warranty".
const LIFETIME_WARRANTY_RE =
  /(?:limited\s+)?lifetime\s+(?:limited\s+)?warranty\b/i;

/**
 * Scan retrieved listing text for an explicit warranty statement.
 * Returns the earliest statement in the text, or null when the text
 * states no warranty this extractor is allowed to claim.
 */
export function extractWarrantyFromText(
  text: string | null | undefined,
): ExtractedWarranty | null {
  if (typeof text !== "string" || !text.trim()) return null;

  const yearMatch = YEAR_WARRANTY_RE.exec(text);
  const lifetimeMatch = LIFETIME_WARRANTY_RE.exec(text);

  const yearHit =
    yearMatch && Number.parseInt(yearMatch[1], 10) > 0
      ? { index: yearMatch.index, match: yearMatch }
      : null;
  const lifetimeHit = lifetimeMatch
    ? { index: lifetimeMatch.index, match: lifetimeMatch }
    : null;

  if (yearHit && (!lifetimeHit || yearHit.index <= lifetimeHit.index)) {
    const years = Number.parseInt(yearHit.match[1], 10);
    return { months: years * 12, label: null, phrase: yearHit.match[0] };
  }
  if (lifetimeHit) {
    return {
      months: 0,
      label: "Lifetime warranty",
      phrase: lifetimeHit.match[0],
    };
  }
  return null;
}
