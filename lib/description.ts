/**
 * Listing-description cleaning — shared by every adapter that carries
 * a merchant-supplied product description (UCP catalog payloads, the
 * eBay Buy Browse item detail, browsing-route search state).
 *
 * Descriptions are REAL retrieved text only: this helper never writes,
 * summarizes, or pads copy. It strips markup, decodes entities, and
 * normalizes whitespace so the merchant's own words render as plain
 * readable text, capped at a readable length — the full text always
 * remains one tap away on the merchant's own listing page, which the
 * product page links to ("See full details at [store]").
 */

/** Readable on-page cap; the store link carries the full text. */
export const DESCRIPTION_MAX_CHARS = 600;

const BLOCK_TAGS =
  /<\s*(?:br|p|div|li|ul|ol|tr|h[1-6])\b[^>]*>/gi;

function decodeEntities(text: string): string {
  const decodeOnce = (value: string): string =>
    value
      .replace(/&quot;/g, '"')
      .replace(/&#0?34;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&nbsp;/g, " ")
      .replace(/&#(\d+);/g, (_, code: string) => {
        const n = Number.parseInt(code, 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000
          ? String.fromCodePoint(n)
          : " ";
      })
      .replace(/&amp;/g, "&");
  // Some sources double-encode (&amp;quot;); decode until stable.
  let out = text;
  for (let i = 0; i < 3; i++) {
    const next = decodeOnce(out);
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * Clean one raw description (plain text or HTML) into display text.
 * Returns null when nothing readable remains — callers then simply
 * render no description for that offer.
 */
export function cleanDescription(
  raw: string | null | undefined,
): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const text = decodeEntities(
    raw
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(BLOCK_TAGS, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  if (text.length <= DESCRIPTION_MAX_CHARS) return text;
  const cut = text.slice(0, DESCRIPTION_MAX_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 200 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
