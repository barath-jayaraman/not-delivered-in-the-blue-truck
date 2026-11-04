import { getMerchantPolicy } from "../adapters";
import { normalizeSearch } from "../data";
import { cleanDescription } from "../description";
import type { Merchant, Offer } from "../types";

/**
 * UCP LIVE ADAPTER — Universal Commerce Protocol catalog over MCP.
 *
 * Policy basis: each store in UCP_STORES publishes a public UCP profile
 * at https://<storefront>/.well-known/ucp declaring the
 * dev.ucp.shopping.catalog.search capability over an MCP transport
 * (JSON-RPC / streamable HTTP). That profile is the merchant's own
 * published, authorized channel for agents — the policy registry marks
 * these merchants "ucp-authorized-channel" (route: api). This module
 * performs public catalog reads only: no auth, and no cart/checkout
 * calls are made here — searching never creates a checkout. Checkout
 * lives in lib/adapters/ucp-checkout.ts and runs over this same
 * published profile only when a buyer explicitly starts it.
 *
 * LIVE-ONLY (Barath's rule, Oct 31, 2026): every search runs ONE live
 * catalog call IN THIS REQUEST and maps ONLY the figures the merchant's
 * response carries. Catalog results and prices are never cached or
 * stored between requests; a store that does not answer yields no
 * offers, never a stored or invented price. The only reuse is the
 * protocol's handshake state — the profile's declared endpoint, the
 * MCP session id, and the catalog tool found by tools/list discovery
 * (never hardcoded) — held in memory for minutes (see
 * SESSION_CACHE_TTL_MS below). It contains no catalog data, and any
 * failed call discards it and re-runs the full flow (live profile,
 * initialize handshake, tools/list discovery) inside that request.
 *
 * What the UCP catalog DOES carry (verified live Nov 4, 2026, on
 * Monos, Kane's Furniture, and Allbirds): a per-product `description`
 * object ({ html }) in the catalog.search payload itself — the store's
 * own listing text. It is cleaned (markup stripped, length-capped;
 * lib/description.ts) and passed through verbatim; no product-detail
 * call is needed for it, though the servers also declare lookup /
 * get_product tools. What the UCP catalog does NOT state (verified
 * from live responses, Oct 31, 2026): shipping charges, delivery
 * estimates, return terms, warranty, seller ratings. Following the codebase's existing pattern
 * for API gaps (cf. the curated eBay return pattern and the Best Buy
 * shipping-service estimate in lib/adapters.ts), those Offer fields use
 * clearly labelled curated/service estimates, disclosed in every
 * offer's provenance note:
 * - shippingCost 0 means "not stated by the catalog — calculated by the
 *   merchant at checkout", NOT free shipping (lib/scoring.ts does not
 *   attach its "Free shipping" flag to UCP offers);
 * - deliveryDays is a standard ground service-level estimate;
 * - return terms are NOT stated (returnWindowDays null, rendered
 *   "Not stated by seller"). Accuracy fix, Nov 4, 2026: the earlier
 *   generic 30-day/buyer-paid default rendered in the comparison table
 *   as if it were each merchant's own policy — e.g. Kane's Furniture,
 *   whose published terms are a 48-hour cancellation window and a 20%
 *   restocking fee, nothing like 30 days. A return window is shown
 *   only when a source actually states one;
 * - warrantyMonths 0 = not stated (rendered "Not stated by seller");
 * - sellerRating 0 = first-party store, no rating stated (the UI
 *   renders that as a first-party note, not a star rating).
 * The price — the figure the comparison is built on — is always the
 * merchant's own live figure, converted from UCP minor units.
 *
 * Agent identity: catalog calls carry meta.ucp-agent.profile — the URL
 * of the caller's own UCP profile. This app has no publicly hosted
 * profile of its own yet, so it defaults to Shopify's published keyless
 * test fixture (documented at shopify.dev for exactly this kind of
 * experimentation); set UCP_AGENT_PROFILE to a self-hosted profile URL
 * to use it. Requests also carry the project's self-identifying UA.
 *
 * Store inclusion evidence (all verified live): profile
 * HTTP 200 + catalog.search declared + a real priced catalog response —
 * Steve Madden, Gymshark, Everlane, Monos, Allbirds, Kith, Misen,
 * SKIMS, and Fenty Beauty (whose endpoint timed out during the Oct 30
 * sweep and answered on the single Oct 31 retry, per instructions),
 * verified Oct 31, 2026; plus the twenty Wave-1 sweep winners noted
 * inline below (broad assortment first), verified Nov 1, 2026; plus
 * the ten Wave-2 stores noted inline below (Wave 1's verified-but-
 * deferred set), re-verified live Nov 1, 2026 before registering.
 */

const USER_AGENT =
  "NotDeliveredInTheBlueTruck/0.1 (UCP MCP client; contact barath.jayaraman@gmail.com)";

export const AGENT_PROFILE =
  process.env.UCP_AGENT_PROFILE ??
  "https://shopify.dev/ucp/agent-profiles/2026-04-08/valid-with-capabilities.json";

const PROFILE_TIMEOUT_MS = 6_000;
const HANDSHAKE_TIMEOUT_MS = 8_000;
const CATALOG_TIMEOUT_MS = 10_000;
const CATALOG_LIMIT = 5;
/**
 * How long a store's resolved session (profile endpoint, MCP session
 * id, discovered catalog tool + argument shape) may be reused before
 * the full handshake runs again. This caches HANDSHAKE STATE ONLY —
 * it holds no products, prices, or catalog data of any kind, so a
 * reused session can never serve a stale price: every catalog call
 * still goes to the merchant live, in the request that displays it.
 * Measured Nov 2, 2026: the profile fetch + initialize + initialized
 * notification + tools/list chain costs 1.7–3.9s per store while the
 * catalog call itself is ~0.5s — re-running the chain per request was
 * the search's main latency. Shopify's UCP endpoints proved stateless
 * in probing (a catalog call with no session at all succeeds; issued
 * sessions stay valid well past a minute), and any hot-path failure
 * invalidates the entry and rebuilds via the full flow below.
 */
const SESSION_CACHE_TTL_MS = 10 * 60_000;
const MCP_PROTOCOL_VERSION = "2025-06-18";
const CATALOG_SEARCH_CAP = "dev.ucp.shopping.catalog.search";

/** Service estimate for the delivery field the UCP catalog does not state. */
const SERVICE_DELIVERY_DAYS = 5;

export function ucpEnabled(): boolean {
  return process.env.ENABLE_UCP !== "0";
}

/* ------------------------------------------------------------------ */
/* Store registry                                                      */
/* ------------------------------------------------------------------ */

export interface UcpStore {
  merchant: Merchant;
  /** Host serving the store's published /.well-known/ucp profile. */
  profileHost: string;
  /** The store's own brand (used for grouping identity). */
  brand: string;
  /**
   * Endpoint the store's profile declared when last verified. The live
   * profile is re-read on every request and wins; this is only a
   * fallback for a failed profile fetch, exactly as in the POC.
   */
  fallbackEndpoint: string;
  category: string;
  /** Normalized phrases that name this store/brand in a query. */
  brandAliases: string[];
  /** Normalized assortment phrases that route a query to this store. */
  keywords: string[];
  /**
   * True for first-party brand stores whose product titles omit the
   * brand ("Carry-On", "MOMENTUM WHITE"): the brand is prefixed for
   * grouping identity. False for multi-brand retailers (Kith), whose
   * products group under their own brands.
   */
  prefixBrand: boolean;
}

export const UCP_STORES: UcpStore[] = [
  {
    merchant: "Steve Madden",
    profileHost: "stevemadden.com",
    brand: "Steve Madden",
    fallbackEndpoint: "https://stevemadden.myshopify.com/api/ucp/mcp",
    category: "Shoes",
    brandAliases: ["steve madden", "madden"],
    keywords: [
      "shoes", "shoe", "sneakers", "sneaker", "boots", "boot", "sandals",
      "sandal", "heels", "heel", "loafers", "loafer", "footwear",
      "momentum", "ponce", "dixon", "mavis",
    ],
    prefixBrand: true,
  },
  {
    merchant: "Gymshark",
    profileHost: "gymshark.com",
    brand: "Gymshark",
    fallbackEndpoint: "https://gymsharkusa.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: ["gymshark"],
    keywords: [
      "leggings", "gym", "workout", "fitness", "activewear", "athleisure",
      "sports bra", "gym shorts",
    ],
    prefixBrand: true,
  },
  {
    merchant: "Everlane",
    profileHost: "everlane.com",
    brand: "Everlane",
    fallbackEndpoint: "https://m34kzg-ke.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: ["everlane"],
    keywords: [
      "sweater", "sweaters", "cashmere", "jeans", "denim", "apparel",
      "clothing", "boxy sweater",
    ],
    prefixBrand: true,
  },
  {
    merchant: "Monos",
    profileHost: "monos.com",
    brand: "Monos",
    fallbackEndpoint: "https://monostravel.myshopify.com/api/ucp/mcp",
    category: "Luggage",
    brandAliases: ["monos"],
    keywords: [
      "luggage", "carry on", "carryon", "suitcase", "suitcases",
      "travel bag",
    ],
    prefixBrand: true,
  },
  {
    merchant: "Allbirds",
    profileHost: "allbirds.com",
    brand: "Allbirds",
    fallbackEndpoint: "https://weareallbirds.myshopify.com/api/ucp/mcp",
    category: "Shoes",
    brandAliases: ["allbirds"],
    keywords: [
      "shoes", "shoe", "sneakers", "sneaker", "runners", "runner",
      "footwear", "tree runner", "wool runner",
    ],
    prefixBrand: true,
  },
  {
    merchant: "Kith",
    profileHost: "kith.com",
    brand: "Kith",
    fallbackEndpoint: "https://kithnyc.myshopify.com/api/ucp/mcp",
    category: "Shoes",
    brandAliases: ["kith"],
    keywords: ["sneakers", "sneaker", "streetwear", "margiela", "replica sneakers"],
    prefixBrand: false,
  },
  {
    merchant: "Misen",
    profileHost: "misen.com",
    brand: "Misen",
    fallbackEndpoint: "https://misenco.myshopify.com/api/ucp/mcp",
    category: "Kitchen",
    brandAliases: ["misen"],
    keywords: [
      "knife", "knives", "chef knife", "chefs knife", "pan", "skillet",
      "cookware", "kitchen",
    ],
    prefixBrand: true,
  },
  {
    merchant: "SKIMS",
    profileHost: "skims.com",
    brand: "SKIMS",
    fallbackEndpoint: "https://skimsbody.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: ["skims"],
    keywords: [
      "bodysuit", "shapewear", "underwear", "loungewear", "fits everybody",
    ],
    prefixBrand: true,
  },
  {
    merchant: "Fenty Beauty",
    profileHost: "fentybeauty.com",
    brand: "Fenty Beauty",
    fallbackEndpoint: "https://fentybeautyshop.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: ["fenty beauty", "fenty"],
    keywords: [
      "lip gloss", "lipstick", "gloss", "foundation", "makeup", "beauty",
      "mascara", "gloss bomb",
    ],
    prefixBrand: true,
  },
  /* ---------------------------------------------------------------- */
  /* Wave 1 (Nov 1, 2026) — Top-1000 sweep UCP-live winners, broad     */
  /* assortment first. Every store below passed the same evidence bar  */
  /* as the original nine: live profile (HTTP 200, catalog.search      */
  /* declared), MCP endpoint read from the profile, initialize         */
  /* handshake, tools/list discovery, and one catalog search that      */
  /* returned a real priced product (noted per store).                 */
  /* ---------------------------------------------------------------- */
  {
    // Verified: "'Bauletto' handbag" — USD 2683.90
    merchant: "Lord & Taylor",
    profileHost: "lordandtaylor.com",
    brand: "Lord & Taylor",
    fallbackEndpoint: "https://lordandtaylor.myshopify.com/api/ucp/mcp",
    category: "Department Store",
    brandAliases: ["lord and taylor", "lord taylor"],
    keywords: [
      "handbag", "handbags", "purse", "purses", "designer dress",
      "evening gown", "gown", "gowns",
    ],
    prefixBrand: false,
  },
  {
    // Verified: "Noir Tulle Black Knit Maxi Dress" — USD 98
    merchant: "Stein Mart",
    profileHost: "steinmart.com",
    brand: "Stein Mart",
    fallbackEndpoint: "https://steinmart-prod.myshopify.com/api/ucp/mcp",
    category: "Department Store",
    brandAliases: ["stein mart"],
    keywords: [
      "maxi dress", "maxi dresses", "off price clothing",
      "discount clothing", "discount dresses",
    ],
    prefixBrand: false,
  },
  {
    // Verified: "Maeve Sofa" — USD 1499
    merchant: "Scandinavian Designs",
    profileHost: "scandinaviandesigns.com",
    brand: "Scandinavian Designs",
    fallbackEndpoint: "https://scandinaviandesigns1963.myshopify.com/api/ucp/mcp",
    category: "Furniture",
    brandAliases: ["scandinavian designs"],
    keywords: [
      "sofa", "sofas", "couch", "couches", "scandinavian furniture",
      "mid century furniture", "dining table", "dining tables",
    ],
    prefixBrand: true,
  },
  {
    // Verified: "Nectar Classic Hybrid Mattress" — USD 499
    merchant: "Slumberland",
    profileHost: "slumberland.com",
    brand: "Slumberland",
    fallbackEndpoint: "https://ca59ae-5.myshopify.com/api/ucp/mcp",
    category: "Furniture",
    brandAliases: ["slumberland"],
    keywords: [
      "mattress", "mattresses", "bed frame", "bed frames",
      "adjustable bed", "adjustable beds",
    ],
    prefixBrand: false,
  },
  {
    // Verified: "Adjustable Height Arched Floor Lamp with Double Drum
    // Shade and 3 Color Temperatures" — USD 144.95
    merchant: "Pier 1",
    profileHost: "pier1.com",
    brand: "Pier 1",
    fallbackEndpoint: "https://p1-dev.myshopify.com/api/ucp/mcp",
    category: "Home",
    brandAliases: ["pier 1", "pier one"],
    keywords: [
      "lamp", "lamps", "floor lamp", "floor lamps", "home decor",
      "throw pillow", "throw pillows", "candle", "candles",
    ],
    prefixBrand: true,
  },
  {
    // Verified: "Pure Encapsulations, Vitamin D3, 125 mcg (5,000 IU),
    // 120 Capsules" — USD 36
    merchant: "Vitacost",
    profileHost: "vitacost.com",
    brand: "Vitacost",
    fallbackEndpoint: "https://icost.myshopify.com/api/ucp/mcp",
    category: "Health & Grocery",
    brandAliases: ["vitacost"],
    keywords: [
      "vitamin", "vitamins", "vitamin d", "supplement", "supplements",
      "probiotics", "protein powder",
    ],
    prefixBrand: false,
  },
  {
    // Verified: "STT 925 Silver MI05 Ring" — USD 199.99
    merchant: "ShopLC",
    profileHost: "shoplc.com",
    brand: "ShopLC",
    fallbackEndpoint: "https://shoplcus.myshopify.com/api/ucp/mcp",
    category: "General",
    brandAliases: ["shoplc", "shop lc"],
    keywords: [
      "ring", "rings", "necklace", "necklaces", "jewelry",
      "gemstone", "gemstones",
    ],
    prefixBrand: false,
  },
  {
    // Verified: "Mossy Oak Never Stop Exploring 50\" x 60\" Fleece
    // Plush Throw" — USD 14.99
    merchant: "The Lakeside Collection",
    profileHost: "lakeside.com",
    brand: "The Lakeside Collection",
    fallbackEndpoint: "https://lakeside-asc.myshopify.com/api/ucp/mcp",
    category: "General",
    brandAliases: ["lakeside collection", "lakeside"],
    keywords: [
      "blanket", "blankets", "throw blanket", "throw blankets",
      "fleece throw", "fleece throws",
    ],
    prefixBrand: false,
  },
  {
    // Verified: "Collapsible Storage Box" — USD 7.99
    merchant: "LTD Commodities",
    profileHost: "ltdcommodities.com",
    brand: "LTD Commodities",
    fallbackEndpoint: "https://et7vgr-3p.myshopify.com/api/ucp/mcp",
    category: "General",
    brandAliases: ["ltd commodities"],
    keywords: [
      "storage box", "storage boxes", "organizer", "organizers",
      "closet organizer", "closet organizers",
    ],
    prefixBrand: false,
  },
  {
    // Verified: "Ritz Gear Gaming PC Bundle, 4-in-1 LED Gaming PC Kit
    // with Keyboard, Mouse, Mouse Pad & Headset" — USD 39.99
    merchant: "SkyMall",
    profileHost: "skymall.com",
    brand: "SkyMall",
    fallbackEndpoint: "https://skywall.myshopify.com/api/ucp/mcp",
    category: "General",
    brandAliases: ["skymall", "sky mall"],
    keywords: [
      "gadget", "gadgets", "gaming bundle", "travel accessories",
      "travel gadget", "travel gadgets",
    ],
    prefixBrand: false,
  },
  {
    // Verified: "Patagonia Men's Nomader Jacket" — USD 149.97
    merchant: "Mast General Store",
    profileHost: "mastgeneralstore.com",
    brand: "Mast General Store",
    fallbackEndpoint: "https://b424c7-09.myshopify.com/api/ucp/mcp",
    category: "General",
    brandAliases: ["mast general store", "mast general"],
    keywords: [
      "patagonia", "outdoor jacket", "outdoor jackets",
      "outdoor apparel", "hiking apparel",
    ],
    prefixBrand: false,
  },
  {
    // Verified: "Bettie Sofa" — USD 499.99
    merchant: "Kane's Furniture",
    profileHost: "kanesfurniture.com",
    brand: "Kane's Furniture",
    fallbackEndpoint: "https://kanes-furniture.myshopify.com/api/ucp/mcp",
    category: "Furniture",
    brandAliases: ["kanes furniture", "kane s furniture", "kanes"],
    keywords: [
      "sofa", "sofas", "sectional", "sectionals", "recliner",
      "recliners", "bedroom set", "bedroom sets",
    ],
    prefixBrand: false,
  },
  {
    // Verified: "Jenny Sofa" — USD 899.99
    merchant: "Steinhafels",
    profileHost: "steinhafels.com",
    brand: "Steinhafels",
    fallbackEndpoint: "https://jnwr2j-dq.myshopify.com/api/ucp/mcp",
    category: "Furniture",
    brandAliases: ["steinhafels"],
    keywords: [
      "sofa", "sofas", "sectional", "sectionals", "mattress",
      "mattresses", "dining set", "dining sets",
    ],
    prefixBrand: false,
  },
  {
    // Verified: "Renegade Sofa" — USD 1349
    merchant: "Schneiderman's Furniture",
    profileHost: "schneidermans.com",
    brand: "Schneiderman's Furniture",
    fallbackEndpoint: "https://schneidermans.myshopify.com/api/ucp/mcp",
    category: "Furniture",
    brandAliases: [
      "schneidermans furniture", "schneiderman s furniture", "schneidermans",
    ],
    keywords: [
      "sofa", "sofas", "sectional", "sectionals", "recliner",
      "recliners", "loveseat", "loveseats",
    ],
    prefixBrand: false,
  },
  {
    // Verified: "Little Richard - The Rill Thing (Opaque Pink Vinyl)"
    // — USD 31.99
    merchant: "FYE",
    profileHost: "fye.com",
    brand: "FYE",
    fallbackEndpoint: "https://2428392.myshopify.com/api/ucp/mcp",
    category: "Entertainment",
    brandAliases: ["fye"],
    keywords: [
      "vinyl", "vinyl record", "vinyl records", "record", "records",
      "lp", "album", "albums",
    ],
    prefixBrand: false,
  },
  {
    // Verified: "Nike Air Trainer Huarache" — USD 89.98
    merchant: "DTLR",
    profileHost: "dtlr.com",
    brand: "DTLR",
    fallbackEndpoint: "https://dtlrvilla.myshopify.com/api/ucp/mcp",
    category: "Shoes",
    brandAliases: ["dtlr"],
    keywords: [
      "sneakers", "sneaker", "athletic shoes", "nike shoes",
      "jordan shoes",
    ],
    prefixBrand: false,
  },
  {
    // Verified: "Kodak PIXPRO FZ55 Digital Camera Black with Lexar
    // 64GB Memory Card" — USD 169.95
    merchant: "Beach Camera",
    profileHost: "beachcamera.com",
    brand: "Beach Camera",
    fallbackEndpoint: "https://beachcamera-com.myshopify.com/api/ucp/mcp",
    category: "Electronics",
    brandAliases: ["beach camera"],
    keywords: [
      "camera", "cameras", "digital camera", "digital cameras",
      "camcorder", "camcorders", "binoculars",
    ],
    prefixBrand: false,
  },
  {
    // Verified: "Stealth™ 700 Headset (Gen 3)" — USD 199.99
    merchant: "Turtle Beach",
    profileHost: "turtlebeach.com",
    brand: "Turtle Beach",
    fallbackEndpoint: "https://turtle-beach-usa.myshopify.com/api/ucp/mcp",
    category: "Electronics",
    brandAliases: ["turtle beach"],
    keywords: [
      "gaming headset", "gaming headsets", "headset", "headsets",
      "xbox headset", "playstation headset",
    ],
    prefixBrand: true,
  },
  {
    // Verified: "Rome Ravine Snowboard 2026" — USD 414.95
    merchant: "Evo",
    profileHost: "evo.com",
    brand: "Evo",
    fallbackEndpoint: "https://qe10ec-cr.myshopify.com/api/ucp/mcp",
    category: "Sporting Goods",
    brandAliases: ["evo"],
    keywords: [
      "snowboard", "snowboards", "skis", "ski boots",
      "mountain bike", "mountain bikes",
    ],
    prefixBrand: false,
  },
  {
    // Verified: "16\" Toy Soldier Plush Bear" — USD 45
    merchant: "FAO Schwarz",
    profileHost: "faoschwarz.com",
    brand: "FAO Schwarz",
    fallbackEndpoint: "https://fao-schwarz.myshopify.com/api/ucp/mcp",
    category: "Toys",
    brandAliases: ["fao schwarz", "fao"],
    keywords: [
      "toy", "toys", "plush", "plush toy", "plush toys",
      "stuffed animal", "stuffed animals", "teddy bear", "teddy bears",
    ],
    prefixBrand: true,
  },
  /* ---------------------------------------------------------------- */
  /* Wave 2 (Nov 1, 2026) — the ten stores Wave 1 verified end-to-end */
  /* but deferred at its 20-store cap. Each was RE-verified live on   */
  /* Nov 1, 2026 before registering (profile HTTP 200, catalog.search */
  /* declared, endpoint read from the live profile, initialize        */
  /* handshake, tools/list discovery, one catalog search returning a  */
  /* real priced product — noted per store). Fallback endpoints below */
  /* are exactly what each store's live profile declared at that      */
  /* re-verification.                                                 */
  /* ---------------------------------------------------------------- */
  {
    // Verified: "Element Mattress" — USD 445
    merchant: "Casper",
    profileHost: "casper.com",
    brand: "Casper",
    fallbackEndpoint: "https://e75063-e5.myshopify.com/api/ucp/mcp",
    category: "Furniture",
    brandAliases: ["casper"],
    keywords: [
      "mattress", "mattresses", "pillow", "pillows", "bedding",
      "foam mattress",
    ],
    prefixBrand: true,
  },
  {
    // Verified: "The Carry-On in Olive Green" — USD 275
    merchant: "Away",
    profileHost: "awaytravel.com",
    brand: "Away",
    fallbackEndpoint: "https://766ad1-ab.myshopify.com/api/ucp/mcp",
    category: "Luggage",
    brandAliases: ["away", "away travel"],
    keywords: [
      "luggage", "carry on", "carryon", "suitcase", "suitcases",
      "travel bag",
    ],
    prefixBrand: true,
  },
  {
    // Verified: "Hybrid Fry Pan, 12\"" — USD 179
    merchant: "HexClad",
    profileHost: "hexclad.com",
    brand: "HexClad",
    fallbackEndpoint: "https://hexclad-cookware.myshopify.com/api/ucp/mcp",
    category: "Kitchen",
    brandAliases: ["hexclad", "hex clad"],
    keywords: [
      "frying pan", "fry pan", "pan", "pans", "wok", "cookware",
    ],
    prefixBrand: true,
  },
  {
    // Verified: "Classic Cast Iron Skillets" — USD 12.95
    merchant: "Lodge Cast Iron",
    profileHost: "lodgecastiron.com",
    brand: "Lodge Cast Iron",
    fallbackEndpoint: "https://lodgecastiron-us.myshopify.com/api/ucp/mcp",
    category: "Kitchen",
    brandAliases: ["lodge cast iron", "lodge"],
    keywords: [
      "cast iron skillet", "cast iron skillets", "cast iron", "skillet",
      "skillets", "dutch oven", "griddle",
    ],
    prefixBrand: true,
  },
  {
    // Verified: "RadRunner™ Plus Electric Cargo Utility Bike" — USD 1799
    merchant: "Rad Power Bikes",
    profileHost: "radpowerbikes.com",
    brand: "Rad Power Bikes",
    fallbackEndpoint: "https://rad-power-bikes.myshopify.com/api/ucp/mcp",
    category: "Sporting Goods",
    brandAliases: ["rad power bikes", "rad power"],
    keywords: [
      "electric bike", "electric bikes", "e bike", "ebike", "e-bike",
      "cargo bike", "fat tire bike",
    ],
    prefixBrand: true,
  },
  {
    // Verified: "Monstera Thai Constellation" — USD 99
    merchant: "The Sill",
    profileHost: "thesill.com",
    brand: "The Sill",
    fallbackEndpoint: "https://the-sill.myshopify.com/api/ucp/mcp",
    category: "Home",
    brandAliases: ["the sill", "sill"],
    keywords: [
      "plant", "plants", "houseplant", "houseplants", "monstera",
      "potted plant", "planter", "planters",
    ],
    prefixBrand: true,
  },
  {
    // Verified: "3D Shiatsu Heating Back and Neck Massager" — USD 69.99
    merchant: "Brookstone",
    profileHost: "brookstone.com",
    brand: "Brookstone",
    fallbackEndpoint: "https://brookstone-prod.myshopify.com/api/ucp/mcp",
    category: "General",
    brandAliases: ["brookstone"],
    keywords: [
      "massager", "massagers", "neck massager", "foot massager",
      "massage chair",
    ],
    prefixBrand: false,
  },
  {
    // Verified: "PowerBoost Pro Plus Hot and Cold Compact Massage Gun
    // by Sharper Image" — USD 179.99
    merchant: "Sharper Image",
    profileHost: "sharperimage.com",
    brand: "Sharper Image",
    fallbackEndpoint: "https://30786c.myshopify.com/api/ucp/mcp",
    category: "General",
    brandAliases: ["sharper image"],
    keywords: [
      "massage gun", "massage guns", "percussion massager",
      "air purifier", "air purifiers",
    ],
    prefixBrand: false,
  },
  {
    // Verified: "Travel Backpack | 45L | Black" — USD 299.95
    merchant: "Peak Design",
    profileHost: "peakdesign.com",
    brand: "Peak Design",
    fallbackEndpoint: "https://peakdesignstore.myshopify.com/api/ucp/mcp",
    category: "Luggage",
    brandAliases: ["peak design"],
    keywords: [
      "backpack", "backpacks", "camera bag", "camera bags",
      "travel backpack", "everyday backpack",
    ],
    prefixBrand: true,
  },
  {
    // Verified: "Single Bevel Straight Chisel" — USD 46.99
    merchant: "Woodcraft",
    profileHost: "woodcraft.com",
    brand: "Woodcraft",
    fallbackEndpoint: "https://woodcraft-supply.myshopify.com/api/ucp/mcp",
    category: "Tools",
    brandAliases: ["woodcraft"],
    keywords: [
      "chisel", "chisels", "woodworking", "woodworking tools",
      "hand plane", "wood carving",
    ],
    prefixBrand: false,
  },
  {
    // Verified Nov 1, 2026 on re-verification (its first pass failed
    // the initialize handshake): "Kipton Wide Arm Elevated Sofa" —
    // USD 6200
    merchant: "Arhaus",
    profileHost: "arhaus.com",
    brand: "Arhaus",
    fallbackEndpoint: "https://arhausllc.myshopify.com/api/ucp/mcp",
    category: "Furniture",
    brandAliases: ["arhaus"],
    keywords: [
      "sofa", "sofas", "couch", "couches", "sectional", "sectionals",
      "armchair", "armchairs", "furniture", "coffee table",
      "dining table", "dining tables",
    ],
    prefixBrand: true,
  },
  /* ---------------------------------------------------------------- */
  /* Wave 3 (Nov 1, 2026) — Top-1000 sweep UCP-live winners, third    */
  /* batch, verified to the same evidence bar (see per-store notes).  */
  /* ---------------------------------------------------------------- */
  {
    // Verified: "Performance Link Pants" — USD 129
    merchant: "Bonobos",
    profileHost: "bonobos.com",
    brand: "Bonobos",
    fallbackEndpoint: "https://h45hqs-bx.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: ["bonobos"],
    keywords: [
      "chinos", "pants", "dress shirt", "dress shirts", "menswear",
      "mens pants", "golf pants",
    ],
    prefixBrand: true,
  },
  /* ---------------------------------------------------------------- */
  /* Wave 4 (Nov 3, 2026) — Top-1000 sweep UCP-live winners, fourth   */
  /* batch, verified to the same evidence bar (see per-store notes).  */
  /* ButcherBox, Fashion Nova and Eddie Bauer are the wave-3 trio     */
  /* whose Nov 1 attempts timed out on this sandbox's egress         */
  /* approval cards — never store failures; all three passed          */
  /* end-to-end on Nov 3, 2026. Fallback endpoints are exactly the    */
  /* hosts each store's live profile declared at verification.        */
  /* ---------------------------------------------------------------- */
  {
    // Verified: "Weaver Leather® Prodigy™ Original Athletic Boots"
    // — USD 90.49
    merchant: "Dover Saddlery",
    profileHost: "doversaddlery.com",
    brand: "Dover Saddlery",
    fallbackEndpoint: "https://dover-saddlery.myshopify.com/api/ucp/mcp",
    category: "Equestrian",
    brandAliases: ["dover saddlery", "dover"],
    keywords: [
      "horse", "horses", "equestrian", "saddle", "saddles", "tack",
      "horse tack", "horse boots", "horse blanket", "horse blankets",
      "riding boots", "breeches",
    ],
    prefixBrand: false,
  },
  {
    // Verified: "Katarina Maxi Gown Dress - Black" — USD 55.99
    merchant: "Fashion Nova",
    profileHost: "fashionnova.com",
    brand: "Fashion Nova",
    fallbackEndpoint: "https://fnova.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: ["fashion nova", "fashionnova"],
    keywords: [
      "dress", "dresses", "maxi dress", "gown", "gowns", "jumpsuit",
      "jumpsuits", "going out dress", "bodycon dress",
    ],
    prefixBrand: true,
  },
  {
    // Verified: "Ember Sofa" — USD 1203
    merchant: "Burrow",
    profileHost: "burrow.com",
    brand: "Burrow",
    fallbackEndpoint: "https://burrow-prod.myshopify.com/api/ucp/mcp",
    category: "Furniture",
    brandAliases: ["burrow"],
    keywords: [
      "sofa", "sofas", "couch", "couches", "sectional", "sectionals",
      "modular sofa", "loveseat", "loveseats",
    ],
    prefixBrand: true,
  },
  {
    // Verified: "Ground Beef 85/15" — USD 16.5
    merchant: "ButcherBox",
    profileHost: "butcherbox.com",
    brand: "ButcherBox",
    fallbackEndpoint: "https://butcherbox-prod.myshopify.com/api/ucp/mcp",
    category: "Grocery",
    brandAliases: ["butcherbox", "butcher box"],
    keywords: [
      "ground beef", "beef", "steak", "steaks", "meat",
      "meat delivery", "grass fed beef", "chicken breast", "salmon",
      "pork chops",
    ],
    prefixBrand: true,
  },
  {
    // Verified: "Powerblend Hoodie, Full Script Logo" — USD 37.5
    merchant: "Champion",
    profileHost: "champion.com",
    brand: "Champion",
    fallbackEndpoint: "https://abg-champion-store.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: ["champion"],
    keywords: [
      "hoodie", "hoodies", "sweatshirt", "sweatshirts", "sweatpants",
      "joggers", "athletic apparel", "reverse weave",
    ],
    prefixBrand: true,
  },
  {
    // Verified: "Men's Cirruslite Down Jacket" — USD 129
    merchant: "Eddie Bauer",
    profileHost: "eddiebauer.com",
    brand: "Eddie Bauer",
    fallbackEndpoint: "https://4gqgby-g9.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: ["eddie bauer"],
    keywords: [
      "down jacket", "down jackets", "puffer jacket", "jacket",
      "jackets", "flannel", "outdoor apparel", "hiking apparel",
    ],
    prefixBrand: true,
  },
  {
    // Verified: "The Movement Shirt - Light Blue Gingham" — USD 168
    merchant: "Faherty",
    profileHost: "fahertybrand.com",
    brand: "Faherty",
    fallbackEndpoint: "https://faherty.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: ["faherty"],
    keywords: [
      "shirt", "shirts", "button down", "flannel shirt", "mens shirt",
      "mens shirts",
    ],
    prefixBrand: true,
  },
  {
    // Verified: "Original 4-Button Polo - Solid" — USD 89
    merchant: "Johnnie-O",
    profileHost: "johnnie-o.com",
    brand: "Johnnie-O",
    fallbackEndpoint: "https://johnnie-oadmin.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: ["johnnie-o", "johnnie o", "johnnieo"],
    keywords: [
      "polo", "polos", "polo shirt", "polo shirts", "golf shirt",
      "golf shirts", "mens polo",
    ],
    prefixBrand: true,
  },
  {
    // Verified: "Slim Boat Shoe" — USD 47.98
    merchant: "Sperry",
    profileHost: "sperry.com",
    brand: "Sperry",
    fallbackEndpoint: "https://zc1uwf-et.myshopify.com/api/ucp/mcp",
    category: "Shoes",
    brandAliases: ["sperry", "sperry top sider", "top sider"],
    keywords: [
      "boat shoe", "boat shoes", "deck shoes", "loafers", "loafer",
      "shoes", "shoe", "footwear",
    ],
    prefixBrand: true,
  },
  {
    // Verified: "White Classic Crew Neck" — USD 34.99
    merchant: "True Classic",
    profileHost: "trueclassic.com",
    brand: "True Classic",
    fallbackEndpoint: "https://trueclassictees-com.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: ["true classic"],
    keywords: [
      "t shirt", "t shirts", "t-shirt", "t-shirts", "tee", "tees",
      "crew neck", "mens t shirt", "mens tees",
    ],
    prefixBrand: true,
  },
  {
    // Verified: "Wrinkle-Free Black Stone Shirt" — USD 109
    merchant: "UNTUCKit",
    profileHost: "untuckit.com",
    brand: "UNTUCKit",
    fallbackEndpoint: "https://untuckit.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: ["untuckit", "untuck it"],
    keywords: [
      "untucked shirt", "untucked shirts", "dress shirt",
      "dress shirts", "button down shirt", "wrinkle free shirt",
    ],
    prefixBrand: true,
  },
  /* ---------------------------------------------------------------- */
  /* Wave 5 (Nov 4, 2026) — Grok live-store sweep of UCP candidates  */
  /* not previously probed by this app (its own verification sweep   */
  /* ran against a Nov 3, 2026 snapshot of this registry). Each row  */
  /* below comes from a real search_catalog response received in     */
  /* that sweep: public UCP profile 200 + catalog.search declared +  */
  /* a priced USD product returned. ADOPT WITH CAUTION stores are    */
  /* UCP-ONLY here: their terms ban bots generally, so no browsing   */
  /* or page-fetch route exists for them anywhere in this app — the  */
  /* merchant-published UCP endpoint is the sole route, labelled     */
  /* "UCP-only, not authorized in the terms" in the policy gate.     */
  /* Stores whose terms mention AI/intelligent agents (the sweep's  */
  /* INVESTIGATE rows) are NOT registered — held for Barath's        */
  /* decision. fallbackEndpoint is the endpoint each store's live   */
  /* profile declared at sweep verification; the live profile is     */
  /* still re-read per request and wins, as for every store above.   */
  /* ---------------------------------------------------------------- */
  {
    // Sweep-verified Nov 4, 2026: "BASIC STÜSSY TEE" — USD 45
    // Endpoint declared by the live profile at verification: stussy-na.myshopify.com
    merchant: "Stüssy",
    profileHost: "stussy.com",
    brand: "Stüssy",
    fallbackEndpoint: "https://stussy-na.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "stussy", "st ssy", "stssy",
    ],
    keywords: [
      "shirt", "basic tee", "basic", "basics", "tee", "tees", "clothing",
      "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Standard Crest Tee" — USD 18
    // Endpoint declared by the live profile at verification: 1p-ecomm.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "1st Phorm",
    profileHost: "1stphorm.com",
    brand: "1st Phorm",
    fallbackEndpoint: "https://1p-ecomm.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "1st phorm", "1stphorm",
    ],
    keywords: [
      "shirt", "standard crest", "crest tee", "standard", "standards",
      "crest", "crests", "tee", "tees", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Melange Fleece Shirt" — USD 250
    // Endpoint declared by the live profile at verification: aime-leon-dore.myshopify.com
    merchant: "Aimé Leon Dore",
    profileHost: "aimeleondore.com",
    brand: "Aimé Leon Dore",
    fallbackEndpoint: "https://aime-leon-dore.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "aime leon dore", "aimeleondore", "aim leon dore", "aimleondore",
    ],
    keywords: [
      "shirt", "melange fleece", "fleece shirt", "melange", "melanges",
      "fleece", "fleeces", "shirts", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Barton Sofa" — USD 1801
    // Endpoint declared by the live profile at verification: albany-park.myshopify.com
    merchant: "Albany Park",
    profileHost: "albanypark.com",
    brand: "Albany Park",
    fallbackEndpoint: "https://albany-park.myshopify.com/api/ucp/mcp",
    category: "Furniture",
    brandAliases: [
      "albany park", "albanypark",
    ],
    keywords: [
      "shirt", "barton sofa", "barton", "bartons", "sofa", "sofas",
      "furniture",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Street Essential Tee - Anthracite" — USD 68
    // Endpoint declared by the live profile at verification: alo-yoga.myshopify.com
    merchant: "Alo Yoga",
    profileHost: "aloyoga.com",
    brand: "Alo Yoga",
    fallbackEndpoint: "https://alo-yoga.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "alo yoga", "aloyoga",
    ],
    keywords: [
      "shirt", "street tee", "tee anthracite", "street", "streets", "tee",
      "tees", "anthracite", "anthracites", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "D'Addario Cello Cowboy T-Shirt" — USD 19.42
    // Endpoint declared by the live profile at verification: e7e3e6.myshopify.com
    merchant: "Alto Music",
    profileHost: "altomusic.com",
    brand: "Alto Music",
    fallbackEndpoint: "https://e7e3e6.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "alto music", "altomusic",
    ],
    keywords: [
      "shirt", "addario cello", "cello cowboy", "cowboy shirt", "addario",
      "addarios", "cello", "cellos", "cowboy", "cowboys", "shirts",
      "clothing",
    ],
    prefixBrand: false,
  },
  {
    // Sweep-verified Nov 4, 2026: "The American Girls Collection™ Ringer Tee for Adults" — USD 32
    // Endpoint declared by the live profile at verification: prod-americangirl.myshopify.com
    merchant: "American Girl",
    profileHost: "americangirl.com",
    brand: "American Girl",
    fallbackEndpoint: "https://prod-americangirl.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "american girl", "americangirl",
    ],
    keywords: [
      "shirt", "girls collectiontm", "collectiontm ringer", "ringer tee",
      "tee adults", "girls", "girl", "collectiontm", "collectiontms",
      "ringer", "ringers", "tee",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Mens Relaxed Short Sleeve Tee - Reactive Dye Jersey - Black" — USD 46
    // Endpoint declared by the live profile at verification: andie-swim-1.myshopify.com
    merchant: "Andie Co.",
    profileHost: "andieswim.com",
    brand: "Andie Co.",
    fallbackEndpoint: "https://andie-swim-1.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "andie co", "andieco",
    ],
    keywords: [
      "shirt", "relaxed short", "short sleeve", "sleeve tee", "tee reactive",
      "relaxed", "short", "shorts", "sleeve", "sleeves", "tee", "tees",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Scott Shirt - White" — USD 280
    // Endpoint declared by the live profile at verification: aninebing.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "ANINE BING",
    profileHost: "aninebing.com",
    brand: "ANINE BING",
    fallbackEndpoint: "https://aninebing.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "anine bing", "aninebing",
    ],
    keywords: [
      "shirt", "scott shirt", "scott", "scotts", "shirts", "clothing",
      "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Anker MagGo Power Bank (10K, Slim)" — USD 79.86
    // Endpoint declared by the live profile at verification: ankerus.myshopify.com
    merchant: "Anker",
    profileHost: "anker.com",
    brand: "Anker",
    fallbackEndpoint: "https://ankerus.myshopify.com/api/ucp/mcp",
    category: "Electronics",
    brandAliases: [
      "anker",
    ],
    keywords: [
      "shirt", "maggo power", "power bank", "bank 10k", "10k slim", "maggo",
      "maggos", "power", "powers", "bank", "banks", "10k",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "ROMANCE T-SHIRT" — USD 155
    // Endpoint declared by the live profile at verification: apb-store.myshopify.com
    merchant: "APB",
    profileHost: "apbstore.com",
    brand: "APB",
    fallbackEndpoint: "https://apb-store.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "apb",
    ],
    keywords: [
      "shirt", "romance shirt", "romance", "romances", "shirts", "clothing",
      "apparel",
    ],
    prefixBrand: false,
  },
  {
    // Sweep-verified Nov 4, 2026: "Grateful AF Raglan Shirt — 3/4 Sleeve Baseball Tee" — USD 29
    // Endpoint declared by the live profile at verification: apollo-neuro.myshopify.com
    merchant: "Apollo Neuro",
    profileHost: "apolloneuro.com",
    brand: "Apollo Neuro",
    fallbackEndpoint: "https://apollo-neuro.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "apollo neuro", "apolloneuro",
    ],
    keywords: [
      "shirt", "grateful raglan", "raglan shirt", "shirt sleeve",
      "sleeve baseball", "grateful", "gratefuls", "raglan", "raglans",
      "shirts", "sleeve", "sleeves",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Long Sleeved Linen Blend Shirt" — USD 25.98
    // Endpoint declared by the live profile at verification: ashleystewart1.myshopify.com
    merchant: "Ashley Stewart",
    profileHost: "ashleystewart.com",
    brand: "Ashley Stewart",
    fallbackEndpoint: "https://ashleystewart1.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "ashley stewart", "ashleystewart",
    ],
    keywords: [
      "shirt", "long sleeved", "sleeved linen", "linen blend", "blend shirt",
      "long", "longs", "sleeved", "linen", "linens", "blend", "blends",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Flagship Landscape T-Shirt - Run Wild" — USD 25
    // Endpoint declared by the live profile at verification: athletic-brewing-company.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Athletic Brewing Company",
    profileHost: "athleticbrewing.com",
    brand: "Athletic Brewing Company",
    fallbackEndpoint: "https://athletic-brewing-company.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "athletic brewing company", "athleticbrewingcompany",
    ],
    keywords: [
      "shirt", "flagship landscape", "landscape shirt", "shirt run",
      "run wild", "flagship", "flagships", "landscape", "landscapes",
      "shirts", "run", "runs",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Model 000: Black & White" — USD 130.5
    // Endpoint declared by the live profile at verification: atoms-k2.myshopify.com
    merchant: "Atoms",
    profileHost: "atoms.com",
    brand: "Atoms",
    fallbackEndpoint: "https://atoms-k2.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "atoms",
    ],
    keywords: [
      "shirt", "model", "models", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Arcam OPEN BOX A50 Signature Stereo Integrated Amplifier - A Grade" — USD 2499.95
    // Endpoint declared by the live profile at verification: audioadvice.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Audio Advice",
    profileHost: "audioadvice.com",
    brand: "Audio Advice",
    fallbackEndpoint: "https://audioadvice.myshopify.com/api/ucp/mcp",
    category: "Electronics",
    brandAliases: [
      "audio advice", "audioadvice",
    ],
    keywords: [
      "shirt", "arcam open", "open box", "box a50", "a50 stereo", "arcam",
      "arcams", "open", "opens", "box", "boxes", "a50",
    ],
    prefixBrand: false,
  },
  {
    // Sweep-verified Nov 4, 2026: "Aventon Topograph Shirt" — USD 24.99
    // Endpoint declared by the live profile at verification: aventonbikes.myshopify.com
    merchant: "Aventon Bikes",
    profileHost: "aventon.com",
    brand: "Aventon Bikes",
    fallbackEndpoint: "https://aventonbikes.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "aventon bikes", "aventonbikes",
    ],
    keywords: [
      "shirt", "topograph shirt", "topograph", "topographs", "shirts",
      "bike", "bikes", "ebike", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Natural As Love Organic Cause Tee" — USD 24
    // Endpoint declared by the live profile at verification: avocadomattress.myshopify.com
    merchant: "Avocado Green Mattress",
    profileHost: "avocadogreenmattress.com",
    brand: "Avocado Green Mattress",
    fallbackEndpoint: "https://avocadomattress.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "avocado green mattress", "avocadogreenmattress",
    ],
    keywords: [
      "shirt", "natural love", "love organic", "organic cause", "cause tee",
      "natural", "naturals", "love", "loves", "organic", "organics", "cause",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Bad Tee - Black" — USD 38
    // Endpoint declared by the live profile at verification: bad-birdie.myshopify.com
    merchant: "Bad Birdie",
    profileHost: "badbirdie.com",
    brand: "Bad Birdie",
    fallbackEndpoint: "https://bad-birdie.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "bad birdie", "badbirdie",
    ],
    keywords: [
      "shirt", "tee", "tees", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Hidden Comfort No Show" — USD 17
    // Endpoint declared by the live profile at verification: b9eh0c-ae.myshopify.com
    merchant: "Balega",
    profileHost: "balega.com",
    brand: "Balega",
    fallbackEndpoint: "https://b9eh0c-ae.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "balega",
    ],
    keywords: [
      "shirt", "hidden comfort", "comfort show", "hidden", "hiddens",
      "comfort", "comforts", "show", "shows", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Flame Broiled Button-Down Dog Shirt" — USD 10
    // Endpoint declared by the live profile at verification: bark-food.myshopify.com
    merchant: "BARK",
    profileHost: "bark.co",
    brand: "BARK",
    fallbackEndpoint: "https://bark-food.myshopify.com/api/ucp/mcp",
    category: "Pet Supplies",
    brandAliases: [
      "bark",
    ],
    keywords: [
      "shirt", "flame broiled", "broiled button", "button down", "down dog",
      "flame", "flames", "broiled", "button", "buttons", "down", "downs",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Cranberry Stiletto Matte Lip Whip" — USD 16.5
    // Endpoint declared by the live profile at verification: beauty-bakerie-dev.myshopify.com
    merchant: "Beauty Bakerie",
    profileHost: "beautybakerie.com",
    brand: "Beauty Bakerie",
    fallbackEndpoint: "https://beauty-bakerie-dev.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "beauty bakerie", "beautybakerie",
    ],
    keywords: [
      "shirt", "cranberry stiletto", "stiletto matte", "matte lip",
      "lip whip", "cranberry", "cranberries", "stiletto", "stilettos",
      "matte", "mattes", "lip",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "BKC Classic Script Tee" — USD 50
    // Endpoint declared by the live profile at verification: benchmade-prod.myshopify.com
    merchant: "Benchmade",
    profileHost: "benchmade.com",
    brand: "Benchmade",
    fallbackEndpoint: "https://benchmade-prod.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "benchmade",
    ],
    keywords: [
      "shirt", "bkc script", "script tee", "bkc", "bkcs", "script",
      "scripts", "tee", "tees", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "M's Snowy Summits T-Shirt" — USD 39.95
    // Endpoint declared by the live profile at verification: www-bigagnes-com.myshopify.com
    merchant: "Big Agnes",
    profileHost: "bigagnes.com",
    brand: "Big Agnes",
    fallbackEndpoint: "https://www-bigagnes-com.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "big agnes", "bigagnes",
    ],
    keywords: [
      "shirt", "snowy summits", "summits shirt", "snowy", "snowies",
      "summits", "summit", "shirts", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Ben Shirt - White" — USD 49
    // Endpoint declared by the live profile at verification: birdygrace.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "BIRDY GREY",
    profileHost: "birdygrey.com",
    brand: "BIRDY GREY",
    fallbackEndpoint: "https://birdygrace.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "birdy grey", "birdygrey",
    ],
    keywords: [
      "shirt", "ben shirt", "ben", "bens", "shirts", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "The Daily Habits Kit" — USD 62
    // Endpoint declared by the live profile at verification: bite-bits.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Bite",
    profileHost: "bitetoothpastebits.com",
    brand: "Bite",
    fallbackEndpoint: "https://bite-bits.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: [
      "bite",
    ],
    keywords: [
      "shirt", "daily habits", "habits kit", "daily", "dailies", "habits",
      "habit", "kit", "kits", "makeup", "skincare", "beauty",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Men's Circuit Short Sleeve Tee" — USD 65
    // Endpoint declared by the live profile at verification: b4fbf5-dc.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Black Diamond",
    profileHost: "blackdiamondequipment.com",
    brand: "Black Diamond",
    fallbackEndpoint: "https://b4fbf5-dc.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "black diamond", "blackdiamond",
    ],
    keywords: [
      "shirt", "circuit short", "short sleeve", "sleeve tee", "circuit",
      "circuits", "short", "shorts", "sleeve", "sleeves", "tee", "tees",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Easy-Care White Pinpoint Dress Shirt" — USD 129
    // Endpoint declared by the live profile at verification: 9ra0eq-ig.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Black Lapel",
    profileHost: "blacklapel.com",
    brand: "Black Lapel",
    fallbackEndpoint: "https://9ra0eq-ig.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "black lapel", "blacklapel",
    ],
    keywords: [
      "shirt", "easy care", "care pinpoint", "pinpoint dress", "dress shirt",
      "easy", "easies", "care", "cares", "pinpoint", "pinpoints", "dress",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "22\" Griddle Carry Bag" — USD 49.99
    // Endpoint declared by the live profile at verification: blackstoneproducts.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Blackstone Products",
    profileHost: "blackstoneproducts.com",
    brand: "Blackstone Products",
    fallbackEndpoint: "https://blackstoneproducts.myshopify.com/api/ucp/mcp",
    category: "Kitchen",
    brandAliases: [
      "blackstone products", "blackstoneproducts",
    ],
    keywords: [
      "bag", "griddle carry", "carry bag", "griddle", "griddles", "carry",
      "carries", "bags", "kitchen", "cookware",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Oxi Laundry Booster Refills" — USD 12
    // Endpoint declared by the live profile at verification: bluelandhome.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Blueland",
    profileHost: "blueland.com",
    brand: "Blueland",
    fallbackEndpoint: "https://bluelandhome.myshopify.com/api/ucp/mcp",
    category: "Home",
    brandAliases: [
      "blueland",
    ],
    keywords: [
      "shirt", "oxi laundry", "laundry booster", "booster refills", "oxi",
      "oxis", "laundry", "laundries", "booster", "boosters", "refills",
      "refill",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "BLUETTI POLO shirt" — USD 19.99
    // Endpoint declared by the live profile at verification: bluettipower.myshopify.com
    merchant: "BLUETTI",
    profileHost: "bluettipower.com",
    brand: "BLUETTI",
    fallbackEndpoint: "https://bluettipower.myshopify.com/api/ucp/mcp",
    category: "Electronics",
    brandAliases: [
      "bluetti",
    ],
    keywords: [
      "shirt", "polo shirt", "polo", "polos", "shirts", "electronics",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Complete Nano-hydroxyapatite Oral Care Starter Kit" — USD 25.5
    // Endpoint declared by the live profile at verification: boka-oral-care.myshopify.com
    merchant: "Boka",
    profileHost: "boka.com",
    brand: "Boka",
    fallbackEndpoint: "https://boka-oral-care.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: [
      "boka",
    ],
    keywords: [
      "shirt", "complete nano", "nano hydroxyapatite", "hydroxyapatite oral",
      "oral care", "complete", "completes", "nano", "nanos",
      "hydroxyapatite", "hydroxyapatites", "oral",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Soft Knit Sleepshirt - Mineral" — USD 99
    // Endpoint declared by the live profile at verification: boll-branch.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Boll & Branch",
    profileHost: "bollandbranch.com",
    brand: "Boll & Branch",
    fallbackEndpoint: "https://boll-branch.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "boll and branch", "boll branch", "bollandbranch",
    ],
    keywords: [
      "shirt", "soft knit", "knit sleepshirt", "sleepshirt mineral", "soft",
      "softs", "knit", "knits", "sleepshirt", "sleepshirts", "mineral",
      "minerals",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Boppy Nursing Pillow" — USD 50
    // Endpoint declared by the live profile at verification: newboppy.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Boppy",
    profileHost: "boppy.com",
    brand: "Boppy",
    fallbackEndpoint: "https://newboppy.myshopify.com/api/ucp/mcp",
    category: "Baby",
    brandAliases: [
      "boppy",
    ],
    keywords: [
      "shirt", "nursing pillow", "nursing", "nursings", "pillow", "pillows",
      "baby",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Revolution Home Gym" — USD 2999
    // Endpoint declared by the live profile at verification: bowflex-dtc.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "BowFlex",
    profileHost: "bowflex.com",
    brand: "BowFlex",
    fallbackEndpoint: "https://bowflex-dtc.myshopify.com/api/ucp/mcp",
    category: "Sporting Goods",
    brandAliases: [
      "bowflex",
    ],
    keywords: [
      "shirt", "revolution home", "home gym", "revolution", "revolutions",
      "home", "homes", "gym", "gyms", "outdoor gear",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "DOLL MIST TRAVEL MIST" — USD 20
    // Endpoint declared by the live profile at verification: boysmells.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Boy Smells",
    profileHost: "boysmells.com",
    brand: "Boy Smells",
    fallbackEndpoint: "https://boysmells.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: [
      "boy smells", "boysmells",
    ],
    keywords: [
      "shirt", "doll mist", "mist travel", "travel mist", "doll", "dolls",
      "mist", "mists", "travel", "travels", "makeup", "skincare",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Daily Chair" — USD 259
    // Endpoint declared by the live profile at verification: bureau-office.myshopify.com
    merchant: "Branch",
    profileHost: "branchfurniture.com",
    brand: "Branch",
    fallbackEndpoint: "https://bureau-office.myshopify.com/api/ucp/mcp",
    category: "Furniture",
    brandAliases: [
      "branch",
    ],
    keywords: [
      "shirt", "daily chair", "daily", "dailies", "chair", "chairs",
      "furniture",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "4.5 Cu-Ft Front Load SenseClean™ Washer in White" — USD 749
    // Endpoint declared by the live profile at verification: ywpg4z-vk.myshopify.com
    merchant: "BrandsMart USA",
    profileHost: "brandsmartusa.com",
    brand: "BrandsMart USA",
    fallbackEndpoint: "https://ywpg4z-vk.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "brandsmart usa", "brandsmartusa",
    ],
    keywords: [
      "shirt", "front load", "load sensecleantm", "sensecleantm washer",
      "front", "fronts", "load", "loads", "sensecleantm", "sensecleantms",
      "washer", "washers",
    ],
    prefixBrand: false,
  },
  {
    // Sweep-verified Nov 4, 2026: "B.R.E.E.O Shirt" — USD 30
    // Endpoint declared by the live profile at verification: breeo.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Breeo",
    profileHost: "breeo.com",
    brand: "Breeo",
    fallbackEndpoint: "https://breeo.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "breeo",
    ],
    keywords: [
      "shirt", "shirts", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "The Pantry Trio" — USD 99
    // Endpoint declared by the live profile at verification: brightland-ca.myshopify.com
    merchant: "Brightland",
    profileHost: "brightland.co",
    brand: "Brightland",
    fallbackEndpoint: "https://brightland-ca.myshopify.com/api/ucp/mcp",
    category: "Food & Beverage",
    brandAliases: [
      "brightland",
    ],
    keywords: [
      "shirt", "pantry trio", "pantry", "pantries", "trio", "trios",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Dreamweave Waffle Robe" — USD 129
    // Endpoint declared by the live profile at verification: brooklinen2.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Brooklinen",
    profileHost: "brooklinen.com",
    brand: "Brooklinen",
    fallbackEndpoint: "https://brooklinen2.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "brooklinen",
    ],
    keywords: [
      "shirt", "dreamweave waffle", "waffle robe", "dreamweave",
      "dreamweaves", "waffle", "waffles", "robe", "robes", "clothing",
      "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "CopperFlex® RV Hybrid" — USD 565
    // Endpoint declared by the live profile at verification: brooklynbeddingstore.myshopify.com
    merchant: "Brooklyn Bedding",
    profileHost: "brooklynbedding.com",
    brand: "Brooklyn Bedding",
    fallbackEndpoint: "https://brooklynbeddingstore.myshopify.com/api/ucp/mcp",
    category: "Furniture",
    brandAliases: [
      "brooklyn bedding", "brooklynbedding",
    ],
    keywords: [
      "shoes", "copperflex hybrid", "copperflex", "copperflexes", "hybrid",
      "hybrids", "bedding", "sheets", "furniture",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Santorini Reed Diffuser" — USD 48
    // Endpoint declared by the live profile at verification: brooklyn-candle-studio.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Brooklyn Candle Studio",
    profileHost: "brooklyncandlestudio.com",
    brand: "Brooklyn Candle Studio",
    fallbackEndpoint: "https://brooklyn-candle-studio.myshopify.com/api/ucp/mcp",
    category: "Home",
    brandAliases: [
      "brooklyn candle studio", "brooklyncandlestudio",
    ],
    keywords: [
      "shirt", "santorini reed", "reed diffuser", "santorini", "santorinis",
      "reed", "diffuser", "diffusers", "candle", "candles", "home goods",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Long-Sleeve T-Shirt | White" — USD 29.99
    // Endpoint declared by the live profile at verification: kryo-gear.myshopify.com
    merchant: "BruMate",
    profileHost: "brumate.com",
    brand: "BruMate",
    fallbackEndpoint: "https://kryo-gear.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "brumate",
    ],
    keywords: [
      "shirt", "long sleeve", "sleeve shirt", "long", "longs", "sleeve",
      "sleeves", "shirts", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Break Long Sleeve Tee - Heather Grey" — USD 46
    // Endpoint declared by the live profile at verification: buffbunny.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Buffbunny",
    profileHost: "buffbunny.com",
    brand: "Buffbunny",
    fallbackEndpoint: "https://buffbunny.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "buffbunny",
    ],
    keywords: [
      "shirt", "break long", "long sleeve", "sleeve tee", "tee heather",
      "break", "breaks", "long", "longs", "sleeve", "sleeves", "tee",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "The Mentalist™ Whole Bean Coffee, 5 lb." — USD 111.1
    // Endpoint declared by the live profile at verification: bulletproof-coffee.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Bulletproof",
    profileHost: "bulletproof.com",
    brand: "Bulletproof",
    fallbackEndpoint: "https://bulletproof-coffee.myshopify.com/api/ucp/mcp",
    category: "Food & Beverage",
    brandAliases: [
      "bulletproof",
    ],
    keywords: [
      "shirt", "mentalisttm whole", "whole bean", "bean coffee",
      "mentalisttm", "mentalisttms", "whole", "wholes", "bean", "beans",
      "coffee", "coffees",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Screen Protector" — USD 13.95
    // Endpoint declared by the live profile at verification: burga-store.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "BURGA",
    profileHost: "burga.com",
    brand: "BURGA",
    fallbackEndpoint: "https://burga-store.myshopify.com/api/ucp/mcp",
    category: "Electronics",
    brandAliases: [
      "burga",
    ],
    keywords: [
      "shirt", "screen protector", "screen", "screens", "protector",
      "protectors", "electronics",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Pro 2.0 Sonic Toothbrush" — USD 123.99
    // Endpoint declared by the live profile at verification: us-burstoralcare-dev.myshopify.com
    merchant: "Burst Oral Care",
    profileHost: "burstoralcare.com",
    brand: "Burst Oral Care",
    fallbackEndpoint: "https://us-burstoralcare-dev.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: [
      "burst oral care", "burstoralcare",
    ],
    keywords: [
      "shirt", "sonic toothbrush", "sonic", "sonics", "toothbrush",
      "toothbrushes", "makeup", "skincare", "beauty",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Short Sleeve Organic Cotton Toddler V Neck Tees 3 Pack" — USD 32.95
    // Endpoint declared by the live profile at verification: stg-burtsbeesbaby.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Burt's Bees Baby",
    profileHost: "burtsbeesbaby.com",
    brand: "Burt's Bees Baby",
    fallbackEndpoint: "https://stg-burtsbeesbaby.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "burt s bees baby", "burtsbeesbaby",
    ],
    keywords: [
      "shirt", "short sleeve", "sleeve organic", "organic cotton",
      "cotton toddler", "short", "shorts", "sleeve", "sleeves", "organic",
      "organics", "cotton",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Burton Elite Long Sleeve T-Shirt" — USD 49.95
    // Endpoint declared by the live profile at verification: burton-na-production.myshopify.com
    merchant: "Burton Snowboards",
    profileHost: "burton.com",
    brand: "Burton Snowboards",
    fallbackEndpoint: "https://burton-na-production.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "burton snowboards", "burtonsnowboards",
    ],
    keywords: [
      "shirt", "elite long", "long sleeve", "sleeve shirt", "elite",
      "elites", "long", "longs", "sleeve", "sleeves", "shirts", "snowboard",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Everyday Classic Fit Tee" — USD 31.5
    // Endpoint declared by the live profile at verification: bylt-apparel.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "BYLT Basics",
    profileHost: "byltbasics.com",
    brand: "BYLT Basics",
    fallbackEndpoint: "https://bylt-apparel.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "bylt basics", "byltbasics",
    ],
    keywords: [
      "shirt", "everyday fit", "fit tee", "everyday", "everydays", "fit",
      "fits", "tee", "tees", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "All you Need Is Love Bundle" — USD 55
    // Endpoint declared by the live profile at verification: crn-dev.myshopify.com
    merchant: "Camille Rose Naturals",
    profileHost: "camillerose.com",
    brand: "Camille Rose Naturals",
    fallbackEndpoint: "https://crn-dev.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: [
      "camille rose naturals", "camillerosenaturals",
    ],
    keywords: [
      "shirt", "you need", "need love", "you", "yous", "need", "love",
      "loves", "makeup", "skincare", "beauty",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Cerulean Tactile Switch by Durock" — USD 17.55
    // Endpoint declared by the live profile at verification: cannon-keys.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "CannonKeys",
    profileHost: "cannonkeys.com",
    brand: "CannonKeys",
    fallbackEndpoint: "https://cannon-keys.myshopify.com/api/ucp/mcp",
    category: "Hardware",
    brandAliases: [
      "cannonkeys",
    ],
    keywords: [
      "shirt", "cerulean tactile", "tactile switch", "switch durock",
      "cerulean", "ceruleans", "tactile", "tactiles", "switch", "switches",
      "durock", "durocks",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Volcano Concentrated Laundry Detergent" — USD 31
    // Endpoint declared by the live profile at verification: hvchpn-2q.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Capri Blue",
    profileHost: "capri-blue.com",
    brand: "Capri Blue",
    fallbackEndpoint: "https://hvchpn-2q.myshopify.com/api/ucp/mcp",
    category: "Home",
    brandAliases: [
      "capri blue", "capriblue",
    ],
    keywords: [
      "shirt", "volcano concentrated", "concentrated laundry",
      "laundry detergent", "volcano", "volcanos", "concentrated", "laundry",
      "laundries", "detergent", "detergents", "home goods",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "10-Cup Coffee Maker" — USD 495
    // Endpoint declared by the live profile at verification: caraway-home.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Caraway",
    profileHost: "carawayhome.com",
    brand: "Caraway",
    fallbackEndpoint: "https://caraway-home.myshopify.com/api/ucp/mcp",
    category: "Food & Beverage",
    brandAliases: [
      "caraway",
    ],
    keywords: [
      "shirt", "cup coffee", "coffee maker", "cup", "cups", "coffee",
      "coffees", "maker", "makers",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Edge Treatment Balm" — USD 12.99
    // Endpoint declared by the live profile at verification: 93k5e1-vz.myshopify.com
    merchant: "Carol's Daughter",
    profileHost: "carolsdaughter.com",
    brand: "Carol's Daughter",
    fallbackEndpoint: "https://93k5e1-vz.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: [
      "carol s daughter", "carolsdaughter",
    ],
    keywords: [
      "shirt", "edge treatment", "treatment balm", "edge", "edges",
      "treatment", "treatments", "balm", "balms", "makeup", "skincare",
      "beauty",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Vintage T-Shirt" — USD 11.98
    // Endpoint declared by the live profile at verification: ce6df2-8b.myshopify.com
    merchant: "Cascade Designs",
    profileHost: "msrgear.com",
    brand: "Cascade Designs",
    fallbackEndpoint: "https://ce6df2-8b.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "cascade designs", "cascadedesigns",
    ],
    keywords: [
      "shirt", "vintage shirt", "vintage", "vintages", "shirts", "clothing",
      "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Original Turkey" — USD 25.6
    // Endpoint declared by the live profile at verification: chomps.myshopify.com
    merchant: "Chomps",
    profileHost: "chomps.com",
    brand: "Chomps",
    fallbackEndpoint: "https://chomps.myshopify.com/api/ucp/mcp",
    category: "Food & Beverage",
    brandAliases: [
      "chomps",
    ],
    keywords: [
      "shirt", "turkey", "turkeys",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "The Pedro Short Sleeve Shirt | Noir Daisy" — USD 148
    // Endpoint declared by the live profile at verification: christy-dawn.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Christy Dawn",
    profileHost: "christydawn.com",
    brand: "Christy Dawn",
    fallbackEndpoint: "https://christy-dawn.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "christy dawn", "christydawn",
    ],
    keywords: [
      "shirt", "pedro short", "short sleeve", "sleeve shirt", "shirt noir",
      "pedro", "pedros", "short", "shorts", "sleeve", "sleeves", "shirts",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "The Sandstone (LS Waffle Cord Friday Shirt)" — USD 84.5
    // Endpoint declared by the live profile at verification: chubbies.myshopify.com
    merchant: "Chubbies Shorts",
    profileHost: "chubbiesshorts.com",
    brand: "Chubbies Shorts",
    fallbackEndpoint: "https://chubbies.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "chubbies shorts", "chubbiesshorts",
    ],
    keywords: [
      "shirt", "sandstone waffle", "waffle cord", "cord friday",
      "friday shirt", "sandstone", "sandstones", "waffle", "waffles", "cord",
      "cords", "friday",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Peanut Butter Banana with Dark Chocolate Flavor" — USD 17.5
    // Endpoint declared by the live profile at verification: clifbar-prod.myshopify.com
    merchant: "Clif Bar",
    profileHost: "clifbar.com",
    brand: "Clif Bar",
    fallbackEndpoint: "https://clifbar-prod.myshopify.com/api/ucp/mcp",
    category: "Food & Beverage",
    brandAliases: [
      "clif bar", "clifbar",
    ],
    keywords: [
      "shirt", "peanut butter", "butter banana", "banana dark",
      "dark chocolate", "peanut", "peanuts", "butter", "butters", "banana",
      "bananas", "dark",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Limited Edition Clinique T-Shirt in Black" — USD 25
    // Endpoint declared by the live profile at verification: elc-us-cl-prod.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Clinique Online",
    profileHost: "clinique.com",
    brand: "Clinique Online",
    fallbackEndpoint: "https://elc-us-cl-prod.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: [
      "clinique online", "cliniqueonline",
    ],
    keywords: [
      "shirt", "shirts", "makeup", "skincare", "beauty",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Cobra Pure 2.0 Golf Polo" — USD 65
    // Endpoint declared by the live profile at verification: cobrapuma-main.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "COBRA Golf",
    profileHost: "cobragolf.com",
    brand: "COBRA Golf",
    fallbackEndpoint: "https://cobrapuma-main.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "cobra golf", "cobragolf",
    ],
    keywords: [
      "shirt", "pure polo", "pure", "pures", "polo", "polos", "golf",
      "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Cocoshine Duo" — USD 28
    // Endpoint declared by the live profile at verification: coco-floss.myshopify.com
    merchant: "COCOLAB",
    profileHost: "cocofloss.com",
    brand: "COCOLAB",
    fallbackEndpoint: "https://coco-floss.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: [
      "cocolab",
    ],
    keywords: [
      "shirt", "cocoshine duo", "cocoshine", "cocoshines", "duo", "duos",
      "makeup", "skincare", "beauty",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Men's Cobbler Polo Shirt" — USD 59.95
    // Endpoint declared by the live profile at verification: ykijat-qn.myshopify.com
    merchant: "Cole Haan",
    profileHost: "colehaan.com",
    brand: "Cole Haan",
    fallbackEndpoint: "https://ykijat-qn.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "cole haan", "colehaan",
    ],
    keywords: [
      "shirt", "cobbler polo", "polo shirt", "cobbler", "cobblers", "polo",
      "polos", "shirts", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Just A Kiss" — USD 34
    // Endpoint declared by the live profile at verification: colourpop-prd.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "ColourPop",
    profileHost: "colourpop.com",
    brand: "ColourPop",
    fallbackEndpoint: "https://colourpop-prd.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: [
      "colourpop",
    ],
    keywords: [
      "shirt", "just kiss", "just", "justs", "kiss", "makeup", "skincare",
      "beauty",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Rifle Paper Co. Coffee Mug" — USD 35
    // Endpoint declared by the live profile at verification: corkcicle.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "CORKCICLE",
    profileHost: "corkcicle.com",
    brand: "CORKCICLE",
    fallbackEndpoint: "https://corkcicle.myshopify.com/api/ucp/mcp",
    category: "Food & Beverage",
    brandAliases: [
      "corkcicle",
    ],
    keywords: [
      "shirt", "rifle paper", "paper coffee", "coffee mug", "rifle",
      "rifles", "paper", "papers", "coffee", "coffees", "mug", "mugs",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Mero Organic Flannel Shirt - Men's" — USD 98
    // Endpoint declared by the live profile at verification: cotopaxi.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Cotopaxi",
    profileHost: "cotopaxi.com",
    brand: "Cotopaxi",
    fallbackEndpoint: "https://cotopaxi.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "cotopaxi",
    ],
    keywords: [
      "shirt", "mero organic", "organic flannel", "flannel shirt", "mero",
      "meros", "organic", "organics", "flannel", "flannels", "shirts",
      "clothing",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Throwback Tee" — USD 25
    // Endpoint declared by the live profile at verification: counter-culture-coffee-retail.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Counter Culture Coffee",
    profileHost: "counterculturecoffee.com",
    brand: "Counter Culture Coffee",
    fallbackEndpoint: "https://counter-culture-coffee-retail.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "counter culture coffee", "counterculturecoffee",
    ],
    keywords: [
      "shirt", "throwback tee", "throwback", "throwbacks", "tee", "tees",
      "coffee", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Men's All Day Tee" — USD 64
    // Endpoint declared by the live profile at verification: cozyearth2.myshopify.com
    merchant: "Cozy Earth",
    profileHost: "cozyearth.com",
    brand: "Cozy Earth",
    fallbackEndpoint: "https://cozyearth2.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "cozy earth", "cozyearth",
    ],
    keywords: [
      "shirt", "day tee", "day", "days", "tee", "tees", "clothing",
      "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Overtime Oversized Tee | White Relaxed-Fit" — USD 42
    // Endpoint declared by the live profile at verification: cuts-clothing.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Cuts",
    profileHost: "cutsclothing.com",
    brand: "Cuts",
    fallbackEndpoint: "https://cuts-clothing.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "cuts",
    ],
    keywords: [
      "shirt", "overtime oversized", "oversized tee", "tee relaxed",
      "relaxed fit", "overtime", "overtimes", "oversized", "tee", "tees",
      "relaxed", "fit",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Stretch Long Sleeve Tee" — USD 78
    // Endpoint declared by the live profile at verification: cuyana-prod.myshopify.com
    merchant: "Cuyana",
    profileHost: "cuyana.com",
    brand: "Cuyana",
    fallbackEndpoint: "https://cuyana-prod.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "cuyana",
    ],
    keywords: [
      "shirt", "stretch long", "long sleeve", "sleeve tee", "stretch",
      "stretches", "long", "longs", "sleeve", "sleeves", "tee", "tees",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Varsity Logo T-shirt in Moonbeam, Medium" — USD 45
    // Endpoint declared by the live profile at verification: dover.myshopify.com
    merchant: "DAGNE DOVER",
    profileHost: "dagnedover.com",
    brand: "DAGNE DOVER",
    fallbackEndpoint: "https://dover.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "dagne dover", "dagnedover",
    ],
    keywords: [
      "shirt", "varsity logo", "logo shirt", "shirt moonbeam",
      "moonbeam medium", "varsity", "varsities", "logo", "logos", "shirts",
      "moonbeam", "moonbeams",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "DK x Voz Art - おいしい Sweets Hoodie" — USD 75
    // Endpoint declared by the live profile at verification: minessentials.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Dangkeebs",
    profileHost: "dangkeebs.com",
    brand: "Dangkeebs",
    fallbackEndpoint: "https://minessentials.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "dangkeebs",
    ],
    keywords: [
      "shirt", "voz art", "art sweets", "sweets hoodie", "voz", "vozes",
      "art", "arts", "sweets", "sweet", "hoodie", "hoodies",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Sheer Loyalty \"Premium\" Oversized Tee in Black" — USD 50
    // Endpoint declared by the live profile at verification: darcsport.myshopify.com
    merchant: "DarcSport",
    profileHost: "darcsport.com",
    brand: "DarcSport",
    fallbackEndpoint: "https://darcsport.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "darcsport",
    ],
    keywords: [
      "shirt", "sheer loyalty", "loyalty oversized", "oversized tee",
      "sheer", "sheers", "loyalty", "loyalties", "oversized", "tee", "tees",
      "clothing",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Men's The Standard Crew Cushioned Lightweight Lifestyle Socks" — USD 25
    // Endpoint declared by the live profile at verification: darn-tough.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Darn Tough",
    profileHost: "darntough.com",
    brand: "Darn Tough",
    fallbackEndpoint: "https://darn-tough.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "darn tough", "darntough",
    ],
    keywords: [
      "shirt", "standard crew", "crew cushioned", "cushioned lightweight",
      "lightweight lifestyle", "standard", "standards", "crew", "crews",
      "cushioned", "lightweight", "lightweights",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Karako Men Bone Dress Shirt" — USD 14.99
    // Endpoint declared by the live profile at verification: dbi-production.myshopify.com
    merchant: "David's Bridal",
    profileHost: "davidsbridal.com",
    brand: "David's Bridal",
    fallbackEndpoint: "https://dbi-production.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "david s bridal", "davidsbridal",
    ],
    keywords: [
      "shirt", "karako bone", "bone dress", "dress shirt", "karako",
      "karakos", "bone", "bones", "dress", "shirts", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Signature Standard Tee" — USD 15
    // Endpoint declared by the live profile at verification: deathwishcoffee.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Death Wish Coffee",
    profileHost: "deathwishcoffee.com",
    brand: "Death Wish Coffee",
    fallbackEndpoint: "https://deathwishcoffee.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "death wish coffee", "deathwishcoffee",
    ],
    keywords: [
      "shirt", "standard tee", "standard", "standards", "tee", "tees",
      "coffee", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "MATTIE LOAFERS DK BROWN SUEDE" — USD 140
    // Endpoint declared by the live profile at verification: smdolcevita.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Dolce Vita",
    profileHost: "dolcevita.com",
    brand: "Dolce Vita",
    fallbackEndpoint: "https://smdolcevita.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "dolce vita", "dolcevita",
    ],
    keywords: [
      "shirt", "mattie loafers", "loafers suede", "mattie", "matties",
      "loafers", "loafer", "suede", "suedes", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "The Men's Signature 6 Blade Razor" — USD 10
    // Endpoint declared by the live profile at verification: dollar-shave-club-store.myshopify.com
    merchant: "Dollar Shave Club",
    profileHost: "dollarshaveclub.com",
    brand: "Dollar Shave Club",
    fallbackEndpoint: "https://dollar-shave-club-store.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: [
      "dollar shave club", "dollarshaveclub",
    ],
    keywords: [
      "shirt", "blade razor", "blade", "blades", "razor", "razors", "makeup",
      "skincare", "beauty",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: profile 200 + catalog.search answered
    // (the sweep's sample listing was a store service, not a product)
    // Endpoint declared by the live profile at verification: 13scents.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Dossier Perfumes",
    profileHost: "dossier.co",
    brand: "Dossier Perfumes",
    fallbackEndpoint: "https://13scents.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "dossier perfumes", "dossierperfumes",
    ],
    keywords: [
      "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Summer Citrus" — USD 7
    // Endpoint declared by the live profile at verification: drsquatchsoapco.myshopify.com
    merchant: "Dr. Squatch",
    profileHost: "drsquatch.com",
    brand: "Dr. Squatch",
    fallbackEndpoint: "https://drsquatchsoapco.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: [
      "dr squatch", "drsquatch",
    ],
    keywords: [
      "shirt", "summer citrus", "summer", "summers", "citrus", "citru",
      "makeup", "skincare", "beauty",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Button Down Top in White Shirting Stripe" — USD 95
    // Endpoint declared by the live profile at verification: draperjames.myshopify.com
    merchant: "Draper James",
    profileHost: "draperjames.com",
    brand: "Draper James",
    fallbackEndpoint: "https://draperjames.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "draper james", "draperjames",
    ],
    keywords: [
      "shirt", "button down", "down top", "top shirting", "shirting stripe",
      "button", "buttons", "down", "downs", "top", "tops", "shirting",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "LMNT INSIDER Bundle" — USD 135
    // Endpoint declared by the live profile at verification: elemental-labs.myshopify.com
    merchant: "Drink LMNT",
    profileHost: "www.drinklmnt.com",
    brand: "Drink LMNT",
    fallbackEndpoint: "https://elemental-labs.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "drink lmnt", "drinklmnt",
    ],
    keywords: [
      "shirt", "insider", "insiders", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Monstrously Good Retro T-Shirt" — USD 12.5
    // Endpoint declared by the live profile at verification: dylans-candy-bar-dev.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Dylan's Candy Bar",
    profileHost: "dylanscandybar.com",
    brand: "Dylan's Candy Bar",
    fallbackEndpoint: "https://dylans-candy-bar-dev.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "dylan s candy bar", "dylanscandybar",
    ],
    keywords: [
      "shirt", "monstrously good", "good retro", "retro shirt",
      "monstrously", "monstrouslies", "good", "goods", "retro", "retros",
      "shirts", "clothing",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Sleek Streak Shine Hair Care Kit" — USD 12
    // Endpoint declared by the live profile at verification: mbw1zp-yd.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "e.l.f. Cosmetics",
    profileHost: "elfcosmetics.com",
    brand: "e.l.f. Cosmetics",
    fallbackEndpoint: "https://mbw1zp-yd.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: [
      "e l f cosmetics", "elfcosmetics",
    ],
    keywords: [
      "shirt", "sleek streak", "streak shine", "shine hair", "hair care",
      "sleek", "sleeks", "streak", "streaks", "shine", "shines", "hair",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "EcoFlow T-shirt" — USD 19
    // Endpoint declared by the live profile at verification: ecoflow-tech.myshopify.com
    merchant: "EcoFlow",
    profileHost: "ecoflow.com",
    brand: "EcoFlow",
    fallbackEndpoint: "https://ecoflow-tech.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "ecoflow",
    ],
    keywords: [
      "shirt", "shirts", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "New Baby Foil Balloon Gift Set" — USD 78.98
    // Endpoint declared by the live profile at verification: zrq2ty-cs.myshopify.com
    merchant: "Edible Arrangements",
    profileHost: "ediblearrangements.com",
    brand: "Edible Arrangements",
    fallbackEndpoint: "https://zrq2ty-cs.myshopify.com/api/ucp/mcp",
    category: "Food & Beverage",
    brandAliases: [
      "edible arrangements", "ediblearrangements",
    ],
    keywords: [
      "shoes", "baby foil", "foil balloon", "balloon gift", "gift set",
      "baby", "babies", "foil", "foils", "balloon", "balloons", "gift",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "TravelPack™ Vacuum Kit Pro x The Diary Of A CEO" — USD 119
    // Endpoint declared by the live profile at verification: ekster.myshopify.com
    merchant: "Ekster",
    profileHost: "ekster.com",
    brand: "Ekster",
    fallbackEndpoint: "https://ekster.myshopify.com/api/ucp/mcp",
    category: "Luggage",
    brandAliases: [
      "ekster",
    ],
    keywords: [
      "shirt", "travelpacktm vacuum", "vacuum kit", "kit diary", "diary ceo",
      "travelpacktm", "travelpacktms", "vacuum", "vacuums", "kit", "kits",
      "diary",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Ember Mug 3" — USD 129.95
    // Endpoint declared by the live profile at verification: ember-tech.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Ember",
    profileHost: "ember.com",
    brand: "Ember",
    fallbackEndpoint: "https://ember-tech.myshopify.com/api/ucp/mcp",
    category: "Home",
    brandAliases: [
      "ember",
    ],
    keywords: [
      "shirt", "mug", "mugs", "home goods",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Unisex Tee – Teal" — USD 35
    // Endpoint declared by the live profile at verification: ergattashop.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Ergatta",
    profileHost: "ergatta.com",
    brand: "Ergatta",
    fallbackEndpoint: "https://ergattashop.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "ergatta",
    ],
    keywords: [
      "shirt", "tee teal", "tee", "tees", "teal", "teals", "clothing",
      "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "eufy Plus Member" — USD 15
    // Endpoint declared by the live profile at verification: eufy-us.myshopify.com
    merchant: "eufy",
    profileHost: "eufy.com",
    brand: "eufy",
    fallbackEndpoint: "https://eufy-us.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "eufy",
    ],
    keywords: [
      "shirt", "plus member", "plus", "plu", "member", "members", "clothing",
      "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Arc'teryx Mens Kragg SL Cotton L/S Shirt" — USD 70
    // Endpoint declared by the live profile at verification: extrabutterny.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Extra Butter",
    profileHost: "extrabutterny.com",
    brand: "Extra Butter",
    fallbackEndpoint: "https://extrabutterny.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "extra butter", "extrabutter",
    ],
    keywords: [
      "shirt", "arc teryx", "teryx kragg", "kragg cotton", "cotton shirt",
      "arc", "arcs", "teryx", "teryxes", "kragg", "kraggs", "cotton",
    ],
    prefixBrand: false,
  },
  {
    // Sweep-verified Nov 4, 2026: "Fable Unisex Hoodie" — USD 65
    // Endpoint declared by the live profile at verification: fable-pets.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Fable",
    profileHost: "fablepets.com",
    brand: "Fable",
    fallbackEndpoint: "https://fable-pets.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "fable",
    ],
    keywords: [
      "shirt", "hoodie", "hoodies", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "FASHIONPHILE Logo T-Shirt" — USD 30
    // Endpoint declared by the live profile at verification: 9b6844-68.myshopify.com
    merchant: "FASHIONPHILE",
    profileHost: "fashionphile.com",
    brand: "FASHIONPHILE",
    fallbackEndpoint: "https://9b6844-68.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "fashionphile",
    ],
    keywords: [
      "shirt", "logo shirt", "logo", "logos", "shirts", "clothing",
      "apparel",
    ],
    prefixBrand: false,
  },
  {
    // Sweep-verified Nov 4, 2026: "Essentials SS26 Classic Tee" — USD 75
    // Endpoint declared by the live profile at verification: fear-of-god.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Fear of God",
    profileHost: "fearofgod.com",
    brand: "Fear of God",
    fallbackEndpoint: "https://fear-of-god.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "fear of god", "fearofgod",
    ],
    keywords: [
      "shirt", "essentials ss26", "ss26 tee", "essentials", "essential",
      "ss26", "ss26s", "tee", "tees", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Graphic T-Shirt - White" — USD 80
    // Endpoint declared by the live profile at verification: feature-sneaker-boutique.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Feature",
    profileHost: "feature.com",
    brand: "Feature",
    fallbackEndpoint: "https://feature-sneaker-boutique.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "feature",
    ],
    keywords: [
      "shirt", "graphic shirt", "graphic", "graphics", "shirts", "clothing",
      "apparel",
    ],
    prefixBrand: false,
  },
  {
    // Sweep-verified Nov 4, 2026: "Women's Stride Flex Performance Tee" — USD 59
    // Endpoint declared by the live profile at verification: feetures-online.myshopify.com
    merchant: "Feetures",
    profileHost: "feetures.com",
    brand: "Feetures",
    fallbackEndpoint: "https://feetures-online.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "feetures",
    ],
    keywords: [
      "shirt", "stride flex", "flex performance", "performance tee",
      "stride", "strides", "flex", "flexes", "performance", "performances",
      "tee", "tees",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Fellowversary Graphic Tee" — USD 25
    // Endpoint declared by the live profile at verification: fellow-products.myshopify.com
    merchant: "Fellow",
    profileHost: "fellowproducts.com",
    brand: "Fellow",
    fallbackEndpoint: "https://fellow-products.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "fellow",
    ],
    keywords: [
      "shirt", "fellowversary graphic", "graphic tee", "fellowversary",
      "fellowversaries", "graphic", "graphics", "tee", "tees", "clothing",
      "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Custom Shop Logo T-Shirt, Vintage Black" — USD 37.99
    // Endpoint declared by the live profile at verification: fender-us-prd.myshopify.com
    merchant: "Fender",
    profileHost: "fender.com",
    brand: "Fender",
    fallbackEndpoint: "https://fender-us-prd.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "fender",
    ],
    keywords: [
      "shirt", "custom shop", "shop logo", "logo shirt", "shirt vintage",
      "custom", "customs", "shop", "shops", "logo", "logos", "shirts",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Fenix Brand Lighting for Extremes T-Shirts" — USD 19.95
    // Endpoint declared by the live profile at verification: fenixlighting.myshopify.com
    merchant: "Fenix Lighting",
    profileHost: "fenixlighting.com",
    brand: "Fenix Lighting",
    fallbackEndpoint: "https://fenixlighting.myshopify.com/api/ucp/mcp",
    category: "Electronics",
    brandAliases: [
      "fenix lighting", "fenixlighting",
    ],
    keywords: [
      "shirt", "brand extremes", "extremes shirts", "brand", "brands",
      "extremes", "extreme", "shirts", "lighting", "lamp", "electronics",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Field Flannel Shirt - Nubuck Tan" — USD 59.5
    // Endpoint declared by the live profile at verification: cb3d2b-00.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Filson",
    profileHost: "filson.com",
    brand: "Filson",
    fallbackEndpoint: "https://cb3d2b-00.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "filson",
    ],
    keywords: [
      "shirt", "field flannel", "flannel shirt", "shirt nubuck", "field",
      "fields", "flannel", "flannels", "shirts", "nubuck", "nubucks",
      "clothing",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Men's Rugged Wool Field Shirt" — USD 200
    // Endpoint declared by the live profile at verification: first-lite-apparel.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "First Lite",
    profileHost: "firstlite.com",
    brand: "First Lite",
    fallbackEndpoint: "https://first-lite-apparel.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "first lite", "firstlite",
    ],
    keywords: [
      "shirt", "rugged wool", "wool field", "field shirt", "rugged", "wool",
      "wools", "field", "fields", "shirts", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Floyd Sweatshirt" — USD 55
    // Endpoint declared by the live profile at verification: floyd-home.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Floyd Home",
    profileHost: "floydhome.com",
    brand: "Floyd Home",
    fallbackEndpoint: "https://floyd-home.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "floyd home", "floydhome",
    ],
    keywords: [
      "shirt", "sweatshirt", "sweatshirts", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "DOMKE PHOTOGS VEST BLACK/SMALL (Open Box)" — USD 116.95
    // Endpoint declared by the live profile at verification: evxnaz-ut.myshopify.com
    merchant: "Focus Camera",
    profileHost: "focuscamera.com",
    brand: "Focus Camera",
    fallbackEndpoint: "https://evxnaz-ut.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "focus camera", "focuscamera",
    ],
    keywords: [
      "shirt", "domke photogs", "photogs vest", "vest small", "small open",
      "domke", "domkes", "photogs", "photog", "vest", "vests", "small",
    ],
    prefixBrand: false,
  },
  {
    // Sweep-verified Nov 4, 2026: "Montecito Boat Neck Knit Shirt - Heartstrings" — USD 77
    // Endpoint declared by the live profile at verification: frankies-bikinis-2.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Frankies Bikinis",
    profileHost: "frankiesbikinis.com",
    brand: "Frankies Bikinis",
    fallbackEndpoint: "https://frankies-bikinis-2.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "frankies bikinis", "frankiesbikinis",
    ],
    keywords: [
      "shirt", "montecito boat", "boat neck", "neck knit", "knit shirt",
      "montecito", "montecitos", "boat", "boats", "neck", "necks", "knit",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Black Crew Neck" — USD 23
    // Endpoint declared by the live profile at verification: fresh-clean-tees.myshopify.com
    merchant: "Fresh Clean Tees",
    profileHost: "freshcleanthreads.com",
    brand: "Fresh Clean Tees",
    fallbackEndpoint: "https://fresh-clean-tees.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "fresh clean tees", "freshcleantees",
    ],
    keywords: [
      "shirt", "crew neck", "crew", "crews", "neck", "necks", "clothing",
      "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Delivery and Nursing Gown" — USD 29.99
    // Endpoint declared by the live profile at verification: fridababy.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Frida",
    profileHost: "frida.com",
    brand: "Frida",
    fallbackEndpoint: "https://fridababy.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "frida",
    ],
    keywords: [
      "shirt", "delivery nursing", "nursing gown", "delivery", "deliveries",
      "nursing", "nursings", "gown", "gowns", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Custom Shampoo" — USD 24.99
    // Endpoint declared by the live profile at verification: fob-admin.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Function of Beauty",
    profileHost: "functionofbeauty.com",
    brand: "Function of Beauty",
    fallbackEndpoint: "https://fob-admin.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: [
      "function of beauty", "functionofbeauty",
    ],
    keywords: [
      "shirt", "custom shampoo", "custom", "customs", "shampoo", "shampoos",
      "makeup", "skincare", "beauty",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Tempur-Pedic ProAdapt 2.0 Mattress | Soft, Medium, Medium Hybrid & Firm" — USD 2799
    // Endpoint declared by the live profile at verification: gallery-furniture-tx.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Gallery Furniture",
    profileHost: "galleryfurniture.com",
    brand: "Gallery Furniture",
    fallbackEndpoint: "https://gallery-furniture-tx.myshopify.com/api/ucp/mcp",
    category: "Furniture",
    brandAliases: [
      "gallery furniture", "galleryfurniture",
    ],
    keywords: [
      "shirt", "tempur pedic", "pedic proadapt", "proadapt mattress",
      "mattress soft", "tempur", "tempurs", "pedic", "pedics", "proadapt",
      "proadapts", "mattress",
    ],
    prefixBrand: false,
  },
  {
    // Sweep-verified Nov 4, 2026: "GHOST® CORE LOGO LONG SLEEVE | BLACK" — USD 39.99
    // Endpoint declared by the live profile at verification: ghost-lifestyle.myshopify.com
    merchant: "GHOST",
    profileHost: "ghostlifestyle.com",
    brand: "GHOST",
    fallbackEndpoint: "https://ghost-lifestyle.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "ghost",
    ],
    keywords: [
      "shirt", "core logo", "logo long", "long sleeve", "core", "cores",
      "logo", "logos", "long", "longs", "sleeve", "sleeves",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Luna Tank" — USD 92
    // Endpoint declared by the live profile at verification: ghost-democracy.myshopify.com
    merchant: "Ghost Democracy",
    profileHost: "ghostdemocracy.com",
    brand: "Ghost Democracy",
    fallbackEndpoint: "https://ghost-democracy.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "ghost democracy", "ghostdemocracy",
    ],
    keywords: [
      "shirt", "luna tank", "luna", "lunas", "tank", "tanks", "clothing",
      "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Gibson Logo Shirt" — USD 29
    // Endpoint declared by the live profile at verification: 59d3bb-c6.myshopify.com
    merchant: "Gibson",
    profileHost: "gibson.com",
    brand: "Gibson",
    fallbackEndpoint: "https://59d3bb-c6.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "gibson",
    ],
    keywords: [
      "shirt", "logo shirt", "logo", "logos", "shirts", "clothing",
      "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Marble Katie Crew Bodysuit" — USD 78
    // Endpoint declared by the live profile at verification: girlfriend-store.myshopify.com
    merchant: "Girlfriend Collective",
    profileHost: "girlfriend.com",
    brand: "Girlfriend Collective",
    fallbackEndpoint: "https://girlfriend-store.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "girlfriend collective", "girlfriendcollective",
    ],
    keywords: [
      "shirt", "marble katie", "katie crew", "crew bodysuit", "marble",
      "marbles", "katie", "katies", "crew", "crews", "bodysuit", "bodysuits",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Short Squoval Icons" — USD 83.95
    // Endpoint declared by the live profile at verification: glamrco.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "glamnetic",
    profileHost: "glamnetic.com",
    brand: "glamnetic",
    fallbackEndpoint: "https://glamrco.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: [
      "glamnetic",
    ],
    keywords: [
      "shirt", "short squoval", "squoval icons", "short", "shorts",
      "squoval", "squovals", "icons", "icon", "makeup", "skincare", "beauty",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: profile 200 + catalog.search answered
    // (the sweep's sample listing was a store service, not a product)
    // Endpoint declared by the live profile at verification: glorious-pc-gaming-race.myshopify.com
    merchant: "Glorious",
    profileHost: "gloriousgaming.com",
    brand: "Glorious",
    fallbackEndpoint: "https://glorious-pc-gaming-race.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "glorious",
    ],
    keywords: [
      "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Glossier Sweatshirt" — USD 55
    // Endpoint declared by the live profile at verification: glossier-admin.myshopify.com
    merchant: "Glossier",
    profileHost: "glossier.com",
    brand: "Glossier",
    fallbackEndpoint: "https://glossier-admin.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "glossier",
    ],
    keywords: [
      "shirt", "sweatshirt", "sweatshirts", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "You Jelly Crewneck" — USD 38
    // Endpoint declared by the live profile at verification: aramara-beauty.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Glow Recipe",
    profileHost: "glowrecipe.com",
    brand: "Glow Recipe",
    fallbackEndpoint: "https://aramara-beauty.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "glow recipe", "glowrecipe",
    ],
    keywords: [
      "shirt", "you jelly", "jelly crewneck", "you", "yous", "jelly",
      "jellies", "crewneck", "crewnecks", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Boulder 100 Briefcase (OPEN BOX)" — USD 259.97
    // Endpoint declared by the live profile at verification: goalzerous.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Goal Zero",
    profileHost: "goalzero.com",
    brand: "Goal Zero",
    fallbackEndpoint: "https://goalzerous.myshopify.com/api/ucp/mcp",
    category: "Hardware",
    brandAliases: [
      "goal zero", "goalzero",
    ],
    keywords: [
      "shirt", "boulder briefcase", "briefcase open", "open box", "boulder",
      "boulders", "briefcase", "briefcases", "open", "opens", "box", "boxes",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Assorted Chocolate Gold Gift Box, 60pc." — USD 125
    // Endpoint declared by the live profile at verification: godiva-us.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "GODIVA",
    profileHost: "godiva.com",
    brand: "GODIVA",
    fallbackEndpoint: "https://godiva-us.myshopify.com/api/ucp/mcp",
    category: "Food & Beverage",
    brandAliases: [
      "godiva",
    ],
    keywords: [
      "shirt", "assorted chocolate", "chocolate gift", "gift box",
      "box 60pc", "assorted", "chocolate", "chocolates", "gift", "gifts",
      "box", "boxes",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Gorilla Mind Core Tee" — USD 24.99
    // Endpoint declared by the live profile at verification: gorilla-mind.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Gorilla Mind",
    profileHost: "gorillamind.com",
    brand: "Gorilla Mind",
    fallbackEndpoint: "https://gorilla-mind.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "gorilla mind", "gorillamind",
    ],
    keywords: [
      "shirt", "core tee", "core", "cores", "tee", "tees", "clothing",
      "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Govee Table Lamp 2" — USD 79.99
    // Endpoint declared by the live profile at verification: store-govee-com.myshopify.com
    merchant: "Govee",
    profileHost: "govee.com",
    brand: "Govee",
    fallbackEndpoint: "https://store-govee-com.myshopify.com/api/ucp/mcp",
    category: "Home",
    brandAliases: [
      "govee",
    ],
    keywords: [
      "shirt", "table lamp", "table", "tables", "lamp", "lamps",
      "home goods",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Road Crew Tee - Camel" — USD 35.95
    // Endpoint declared by the live profile at verification: grayl.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "GRAYL",
    profileHost: "grayl.com",
    brand: "GRAYL",
    fallbackEndpoint: "https://grayl.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "grayl",
    ],
    keywords: [
      "shirt", "road crew", "crew tee", "tee camel", "road", "roads", "crew",
      "crews", "tee", "tees", "camel", "camels",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "“The Trio”" — USD 45
    // Endpoint declared by the live profile at verification: getgraza.myshopify.com
    merchant: "Graza",
    profileHost: "graza.co",
    brand: "Graza",
    fallbackEndpoint: "https://getgraza.myshopify.com/api/ucp/mcp",
    category: "Food & Beverage",
    brandAliases: [
      "graza",
    ],
    keywords: [
      "shirt", "trio", "trios",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Holy Sheet" — USD 50
    // Endpoint declared by the live profile at verification: great-jones-goods.myshopify.com
    merchant: "Great Jones",
    profileHost: "greatjonesgoods.com",
    brand: "Great Jones",
    fallbackEndpoint: "https://great-jones-goods.myshopify.com/api/ucp/mcp",
    category: "Home",
    brandAliases: [
      "great jones", "greatjones",
    ],
    keywords: [
      "shirt", "holy sheet", "holy", "holies", "sheet", "sheets",
      "home goods",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "The Royale 2.0 - Blanco" — USD 199
    // Endpoint declared by the live profile at verification: greats.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "GREATS",
    profileHost: "greats.com",
    brand: "GREATS",
    fallbackEndpoint: "https://greats.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "greats",
    ],
    keywords: [
      "shirt", "royale blanco", "royale", "royales", "blanco", "blancos",
      "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Catskill Knit Shirt" — USD 114
    // Endpoint declared by the live profile at verification: greyson-shop.myshopify.com
    merchant: "Greyson Clothiers",
    profileHost: "greysonclothiers.com",
    brand: "Greyson Clothiers",
    fallbackEndpoint: "https://greyson-shop.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "greyson clothiers", "greysonclothiers",
    ],
    keywords: [
      "shirt", "catskill knit", "knit shirt", "catskill", "catskills",
      "knit", "knits", "shirts", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Oxygen Brightener" — USD 13.99
    // Endpoint declared by the live profile at verification: fb4c79-b2.myshopify.com
    merchant: "Grove Collaborative",
    profileHost: "grove.co",
    brand: "Grove Collaborative",
    fallbackEndpoint: "https://fb4c79-b2.myshopify.com/api/ucp/mcp",
    category: "Home",
    brandAliases: [
      "grove collaborative", "grovecollaborative",
    ],
    keywords: [
      "shirt", "oxygen brightener", "oxygen", "oxygens", "brightener",
      "brighteners", "home goods",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Roctane Energy Gel" — USD 72
    // Endpoint declared by the live profile at verification: guenergy-2.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "GU Energy Labs",
    profileHost: "guenergy.com",
    brand: "GU Energy Labs",
    fallbackEndpoint: "https://guenergy-2.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: [
      "gu energy labs", "guenergylabs",
    ],
    keywords: [
      "shirt", "roctane gel", "roctane", "roctanes", "gel", "gels", "makeup",
      "skincare", "beauty",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Kids' Media Desk, Hutch and Chair Set" — USD 289.95
    // Endpoint declared by the live profile at verification: newgcstore.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Guidecraft",
    profileHost: "guidecraft.com",
    brand: "Guidecraft",
    fallbackEndpoint: "https://newgcstore.myshopify.com/api/ucp/mcp",
    category: "Furniture",
    brandAliases: [
      "guidecraft",
    ],
    keywords: [
      "shirt", "media desk", "desk hutch", "hutch chair", "chair set",
      "media", "medias", "desk", "desks", "hutch", "hutches", "chair",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Anti-Shine Stick" — USD 20
    // Endpoint declared by the live profile at verification: com-harrys-us.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Harry's",
    profileHost: "harrys.com",
    brand: "Harry's",
    fallbackEndpoint: "https://com-harrys-us.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: [
      "harry s", "harrys",
    ],
    keywords: [
      "shirt", "anti shine", "shine stick", "anti", "antis", "shine",
      "shines", "stick", "sticks", "makeup", "skincare", "beauty",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Tactical Table One L" — USD 194.95
    // Endpoint declared by the live profile at verification: helinox-furniture.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Helinox",
    profileHost: "helinox.com",
    brand: "Helinox",
    fallbackEndpoint: "https://helinox-furniture.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "helinox",
    ],
    keywords: [
      "shirt", "tactical table", "table one", "tactical", "tacticals",
      "table", "tables", "one", "ones", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Dave" — USD 35
    // Endpoint declared by the live profile at verification: fragrancehenryrose.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Henry Rose",
    profileHost: "henryrose.com",
    brand: "Henry Rose",
    fallbackEndpoint: "https://fragrancehenryrose.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: [
      "henry rose", "henryrose",
    ],
    keywords: [
      "shirt", "dave", "daves", "makeup", "skincare", "beauty",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Basic Tee Men's" — USD 13.99
    // Endpoint declared by the live profile at verification: production-herschel-us.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Herschel Supply Co.",
    profileHost: "herschel.com",
    brand: "Herschel Supply Co.",
    fallbackEndpoint: "https://production-herschel-us.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "herschel supply co", "herschelsupplyco",
    ],
    keywords: [
      "shirt", "basic tee", "basic", "basics", "tee", "tees", "clothing",
      "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "The Mari - Slim Fit - Soft Wash" — USD 380
    // Endpoint declared by the live profile at verification: hiut.myshopify.com
    merchant: "Hiut Denim",
    profileHost: "hiutdenim.com",
    brand: "Hiut Denim",
    fallbackEndpoint: "https://hiut.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "hiut denim", "hiutdenim",
    ],
    keywords: [
      "shirt", "mari slim", "slim fit", "fit soft", "soft wash", "mari",
      "maris", "slim", "slims", "fit", "fits", "soft",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "The Farrell Shirt: White" — USD 125
    // Endpoint declared by the live profile at verification: holderness-bourne.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Holderness & Bourne",
    profileHost: "holdernessandbourne.com",
    brand: "Holderness & Bourne",
    fallbackEndpoint: "https://holderness-bourne.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "holderness and bourne", "holderness bourne", "holdernessandbourne",
    ],
    keywords: [
      "shirt", "farrell shirt", "farrell", "farrells", "shirts", "clothing",
      "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Homesick T-Shirt" — USD 24.95
    // Endpoint declared by the live profile at verification: scroll-commerce.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Homesick",
    profileHost: "homesick.com",
    brand: "Homesick",
    fallbackEndpoint: "https://scroll-commerce.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "homesick",
    ],
    keywords: [
      "shirt", "shirts", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Sanitizing Alcohol Wipes, Grapefruit Grove" — USD 0
    // Endpoint declared by the live profile at verification: 9497e5-2.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Honest",
    profileHost: "honest.com",
    brand: "Honest",
    fallbackEndpoint: "https://9497e5-2.myshopify.com/api/ucp/mcp",
    category: "Baby",
    brandAliases: [
      "honest",
    ],
    keywords: [
      "bag", "sanitizing alcohol", "alcohol wipes", "wipes grapefruit",
      "grapefruit grove", "sanitizing", "sanitizings", "alcohol", "alcohols",
      "wipes", "wipe", "grapefruit",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Mobility CBD Oil" — USD 24.95
    // Endpoint declared by the live profile at verification: honest-paws.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Honest Paws",
    profileHost: "honestpaws.com",
    brand: "Honest Paws",
    fallbackEndpoint: "https://honest-paws.myshopify.com/api/ucp/mcp",
    category: "Pet Supplies",
    brandAliases: [
      "honest paws", "honestpaws",
    ],
    keywords: [
      "shirt", "mobility cbd", "cbd oil", "mobility", "mobilities", "cbd",
      "cbds", "oil", "oils", "pet supplies",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Vegan Leather Makeup Bag" — USD 98
    // Endpoint declared by the live profile at verification: hourglasscosmetics.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Hourglass Cosmetics",
    profileHost: "hourglasscosmetics.com",
    brand: "Hourglass Cosmetics",
    fallbackEndpoint: "https://hourglasscosmetics.myshopify.com/api/ucp/mcp",
    category: "Luggage",
    brandAliases: [
      "hourglass cosmetics", "hourglasscosmetics",
    ],
    keywords: [
      "bag", "vegan leather", "leather makeup", "makeup bag", "vegan",
      "vegans", "leather", "leathers", "makeup", "makeups", "bags",
      "luggage",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Gems" — USD 33
    // Endpoint declared by the live profile at verification: hu-kitchen-2.myshopify.com
    merchant: "Hu Kitchen",
    profileHost: "hukitchen.com",
    brand: "Hu Kitchen",
    fallbackEndpoint: "https://hu-kitchen-2.myshopify.com/api/ucp/mcp",
    category: "Food & Beverage",
    brandAliases: [
      "hu kitchen", "hukitchen",
    ],
    keywords: [
      "shoes", "gems", "gem",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "FAUX FILLER Extra Shine Lip Gloss" — USD 21
    // Endpoint declared by the live profile at verification: hudabeauty-srore.myshopify.com
    merchant: "Huda Beauty",
    profileHost: "hudabeauty.com",
    brand: "Huda Beauty",
    fallbackEndpoint: "https://hudabeauty-srore.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: [
      "huda beauty", "hudabeauty",
    ],
    keywords: [
      "shirt", "faux filler", "filler extra", "extra shine", "shine lip",
      "faux", "fauxes", "filler", "fillers", "extra", "extras", "shine",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Huel Men's T-Shirt" — USD 25
    // Endpoint declared by the live profile at verification: huelamerica.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Huel",
    profileHost: "www.huel.com",
    brand: "Huel",
    fallbackEndpoint: "https://huelamerica.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "huel",
    ],
    keywords: [
      "shirt", "shirts", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Daily Oversized Tee" — USD 29.99
    // Endpoint declared by the live profile at verification: hydrojug.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "HydroJug",
    profileHost: "hydrojug.com",
    brand: "HydroJug",
    fallbackEndpoint: "https://hydrojug.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "hydrojug",
    ],
    keywords: [
      "shirt", "daily oversized", "oversized tee", "daily", "dailies",
      "oversized", "tee", "tees", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Normatec 3 Lower Body" — USD 1149
    // Endpoint declared by the live profile at verification: hypericeprod.myshopify.com
    merchant: "Hyperice",
    profileHost: "hyperice.com",
    brand: "Hyperice",
    fallbackEndpoint: "https://hypericeprod.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: [
      "hyperice",
    ],
    keywords: [
      "shirt", "normatec lower", "lower body", "normatec", "normatecs",
      "lower", "lowers", "body", "bodies", "makeup", "skincare", "beauty",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "HyperX Cloud III – Gaming Headset" — USD 99.99
    // Endpoint declared by the live profile at verification: hyperx-us.myshopify.com
    merchant: "HyperX",
    profileHost: "hyperx.com",
    brand: "HyperX",
    fallbackEndpoint: "https://hyperx-us.myshopify.com/api/ucp/mcp",
    category: "Electronics",
    brandAliases: [
      "hyperx",
    ],
    keywords: [
      "shirt", "cloud iii", "iii gaming", "gaming headset", "cloud",
      "clouds", "iii", "iiis", "gaming", "gamings", "headset", "headsets",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Party Bar 125 Qt Cooler" — USD 279.99
    // Endpoint declared by the live profile at verification: igloocoolers.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Igloo",
    profileHost: "igloocoolers.com",
    brand: "Igloo",
    fallbackEndpoint: "https://igloocoolers.myshopify.com/api/ucp/mcp",
    category: "Home",
    brandAliases: [
      "igloo",
    ],
    keywords: [
      "shirt", "party bar", "bar cooler", "party", "parties", "bar", "bars",
      "cooler", "coolers", "home goods",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "True Skin Serum Foundation" — USD 56
    // Endpoint declared by the live profile at verification: ilia-beauty-v2.myshopify.com
    merchant: "ILIA Beauty",
    profileHost: "iliabeauty.com",
    brand: "ILIA Beauty",
    fallbackEndpoint: "https://ilia-beauty-v2.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: [
      "ilia beauty", "iliabeauty",
    ],
    keywords: [
      "shirt", "true skin", "skin serum", "serum foundation", "true",
      "trues", "skin", "skins", "serum", "serums", "foundation",
      "foundations",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Ringer Tee" — USD 36
    // Endpoint declared by the live profile at verification: intelligentsiacoffee.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Intelligentsia Coffee",
    profileHost: "intelligentsia.com",
    brand: "Intelligentsia Coffee",
    fallbackEndpoint: "https://intelligentsiacoffee.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "intelligentsia coffee", "intelligentsiacoffee",
    ],
    keywords: [
      "shirt", "ringer tee", "ringer", "ringers", "tee", "tees", "coffee",
      "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "GUMBLE Wings Graphic Black Tee" — USD 10.99
    // Endpoint declared by the live profile at verification: e73b81.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "IT'SUGAR",
    profileHost: "itsugar.com",
    brand: "IT'SUGAR",
    fallbackEndpoint: "https://e73b81.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "it sugar", "itsugar",
    ],
    keywords: [
      "shirt", "gumble wings", "wings graphic", "graphic tee", "gumble",
      "gumbles", "wings", "wing", "graphic", "graphics", "tee", "tees",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Jackery HomePower 2000 Plus v2" — USD 1199
    // Endpoint declared by the live profile at verification: jackery.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Jackery",
    profileHost: "jackery.com",
    brand: "Jackery",
    fallbackEndpoint: "https://jackery.myshopify.com/api/ucp/mcp",
    category: "Electronics",
    brandAliases: [
      "jackery",
    ],
    keywords: [
      "shirt", "homepower plus", "homepower", "homepowers", "plus", "plu",
      "electronics",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Right Pack" — USD 52.5
    // Endpoint declared by the live profile at verification: jansport-prod.myshopify.com
    merchant: "JanSport",
    profileHost: "jansport.com",
    brand: "JanSport",
    fallbackEndpoint: "https://jansport-prod.myshopify.com/api/ucp/mcp",
    category: "Luggage",
    brandAliases: [
      "jansport",
    ],
    keywords: [
      "shirt", "right", "rights", "luggage", "bags",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Spider Tee" — USD 35
    // Endpoint declared by the live profile at verification: jeffree-star-cosmetics.myshopify.com
    merchant: "Jeffree Star Cosmetics",
    profileHost: "jeffreestarcosmetics.com",
    brand: "Jeffree Star Cosmetics",
    fallbackEndpoint: "https://jeffree-star-cosmetics.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "jeffree star cosmetics", "jeffreestarcosmetics",
    ],
    keywords: [
      "shirt", "spider tee", "spider", "spiders", "tee", "tees", "clothing",
      "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Linen Logan Shirt" — USD 245
    // Endpoint declared by the live profile at verification: jennikayne-prod.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Jenni Kayne",
    profileHost: "jennikayne.com",
    brand: "Jenni Kayne",
    fallbackEndpoint: "https://jennikayne-prod.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "jenni kayne", "jennikayne",
    ],
    keywords: [
      "shirt", "linen logan", "logan shirt", "linen", "linens", "logan",
      "logans", "shirts", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Jessica Simpson 2.0 Carly Shirt in Snake" — USD 79
    // Endpoint declared by the live profile at verification: jessicasimpsonstyle.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Jessica Simpson",
    profileHost: "jessicasimpson.com",
    brand: "Jessica Simpson",
    fallbackEndpoint: "https://jessicasimpsonstyle.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "jessica simpson", "jessicasimpson",
    ],
    keywords: [
      "shirt", "carly shirt", "shirt snake", "carly", "carlies", "shirts",
      "snake", "snakes", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Blue Crew T-Shirt" — USD 25
    // Endpoint declared by the live profile at verification: jlabgrabbag.myshopify.com
    merchant: "JLab",
    profileHost: "jlab.com",
    brand: "JLab",
    fallbackEndpoint: "https://jlabgrabbag.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "jlab",
    ],
    keywords: [
      "shirt", "crew shirt", "crew", "crews", "shirts", "clothing",
      "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "The Nude Velvety Matte Lipstick" — USD 15
    // Endpoint declared by the live profile at verification: juvias-place.myshopify.com
    merchant: "Juvia's Place",
    profileHost: "juviasplace.com",
    brand: "Juvia's Place",
    fallbackEndpoint: "https://juvias-place.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: [
      "juvia s place", "juviasplace",
    ],
    keywords: [
      "shirt", "nude velvety", "velvety matte", "matte lipstick", "nude",
      "nudes", "velvety", "velveties", "matte", "mattes", "lipstick",
      "lipsticks",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Damage Shield Wash Care Set" — USD 62
    // Endpoint declared by the live profile at verification: aquiskhairpep.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "K18Hair",
    profileHost: "k18hair.com",
    brand: "K18Hair",
    fallbackEndpoint: "https://aquiskhairpep.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: [
      "k18hair",
    ],
    keywords: [
      "shirt", "damage shield", "shield wash", "wash care", "care set",
      "damage", "damages", "shield", "shields", "wash", "washes", "care",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "KBDfans T-shirt" — USD 9.9
    // Endpoint declared by the live profile at verification: kbdfans.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "KBDfans Mechanical Keyboards Store",
    profileHost: "kbdfans.com",
    brand: "KBDfans Mechanical Keyboards Store",
    fallbackEndpoint: "https://kbdfans.myshopify.com/api/ucp/mcp",
    category: "Accessories",
    brandAliases: [
      "kbdfans mechanical keyboards store",
      "kbdfansmechanicalkeyboardsstore",
    ],
    keywords: [
      "shirt", "shirts", "accessories",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Men's Flint II (Soft Toe)  |  Cascade Brown/Golden Rod" — USD 155
    // Endpoint declared by the live profile at verification: us-keenfootwear.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "KEEN Footwear",
    profileHost: "keenfootwear.com",
    brand: "KEEN Footwear",
    fallbackEndpoint: "https://us-keenfootwear.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "keen footwear", "keenfootwear",
    ],
    keywords: [
      "shirt", "flint soft", "soft toe", "toe cascade", "cascade golden",
      "flint", "flints", "soft", "softs", "toe", "toes", "cascade",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Low Loveseat" — USD 149.95
    // Endpoint declared by the live profile at verification: h1dpcq-ih.myshopify.com
    merchant: "Kelty",
    profileHost: "kelty.com",
    brand: "Kelty",
    fallbackEndpoint: "https://h1dpcq-ih.myshopify.com/api/ucp/mcp",
    category: "Furniture",
    brandAliases: [
      "kelty",
    ],
    keywords: [
      "shirt", "low loveseat", "low", "lows", "loveseat", "loveseats",
      "furniture",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Keychron K8 Wireless Mechanical Keyboard" — USD 59.99
    // Endpoint declared by the live profile at verification: keytron.myshopify.com
    merchant: "Keychron",
    profileHost: "keychron.com",
    brand: "Keychron",
    fallbackEndpoint: "https://keytron.myshopify.com/api/ucp/mcp",
    category: "Electronics",
    brandAliases: [
      "keychron",
    ],
    keywords: [
      "shirt", "wireless mechanical", "mechanical keyboard", "wireless",
      "mechanical", "mechanicals", "keyboard", "keyboards", "electronics",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Modal Rib T-Shirt" — USD 42
    // Endpoint declared by the live profile at verification: knix-us-store.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Knix",
    profileHost: "knix.com",
    brand: "Knix",
    fallbackEndpoint: "https://knix-us-store.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "knix",
    ],
    keywords: [
      "shirt", "modal rib", "rib shirt", "modal", "modals", "rib", "ribs",
      "shirts", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Field Flannel Shirt | Woodsmoke Quadrant Plaid" — USD 99
    // Endpoint declared by the live profile at verification: kuiu-shop.myshopify.com
    merchant: "KUIU",
    profileHost: "kuiu.com",
    brand: "KUIU",
    fallbackEndpoint: "https://kuiu-shop.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "kuiu",
    ],
    keywords: [
      "shirt", "field flannel", "flannel shirt", "shirt woodsmoke",
      "woodsmoke quadrant", "field", "fields", "flannel", "flannels",
      "shirts", "woodsmoke", "woodsmokes",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Matte Lip Kit" — USD 35
    // Endpoint declared by the live profile at verification: kylie-jenner-us.myshopify.com
    merchant: "Kylie Cosmetics",
    profileHost: "kyliecosmetics.com",
    brand: "Kylie Cosmetics",
    fallbackEndpoint: "https://kylie-jenner-us.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: [
      "kylie cosmetics", "kyliecosmetics",
    ],
    keywords: [
      "shirt", "matte lip", "lip kit", "matte", "mattes", "lip", "lips",
      "kit", "kits", "makeup", "skincare", "beauty",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Men's Crew Neck Tee in Midnight" — USD 50
    // Endpoint declared by the live profile at verification: kyte-baby-co.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Kyte Baby",
    profileHost: "kytebaby.com",
    brand: "Kyte Baby",
    fallbackEndpoint: "https://kyte-baby-co.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "kyte baby", "kytebaby",
    ],
    keywords: [
      "shirt", "crew neck", "neck tee", "tee midnight", "crew", "crews",
      "neck", "necks", "tee", "tees", "midnight", "midnights",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Oatmilk Everyday Draft Latte" — USD 38
    // Endpoint declared by the live profile at verification: lacolombe.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "La Colombe",
    profileHost: "lacolombe.com",
    brand: "La Colombe",
    fallbackEndpoint: "https://lacolombe.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "la colombe", "lacolombe",
    ],
    keywords: [
      "shirt", "oatmilk everyday", "everyday draft", "draft latte",
      "oatmilk", "oatmilks", "everyday", "everydays", "draft", "drafts",
      "latte", "lattes",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Sweet & Creamy with Adaptogens Superfood Creamer®" — USD 17
    // Endpoint declared by the live profile at verification: laird-superfood.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Laird Superfood",
    profileHost: "lairdsuperfood.com",
    brand: "Laird Superfood",
    fallbackEndpoint: "https://laird-superfood.myshopify.com/api/ucp/mcp",
    category: "Food & Beverage",
    brandAliases: [
      "laird superfood", "lairdsuperfood",
    ],
    keywords: [
      "shirt", "sweet creamy", "creamy adaptogens", "adaptogens creamer",
      "sweet", "sweets", "creamy", "creamies", "adaptogens", "adaptogen",
      "creamer", "creamers",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Jules Shirt White Percale" — USD 345
    // Endpoint declared by the live profile at verification: larroude-com.myshopify.com
    merchant: "Larroude",
    profileHost: "larroude.com",
    brand: "Larroude",
    fallbackEndpoint: "https://larroude-com.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "larroude",
    ],
    keywords: [
      "shirt", "jules shirt", "shirt percale", "jules", "jule", "shirts",
      "percale", "percales", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "The Perfect Lashify Sweatshirt" — USD 90
    // Endpoint declared by the live profile at verification: lashifyusa.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Lashify",
    profileHost: "lashify.com",
    brand: "Lashify",
    fallbackEndpoint: "https://lashifyusa.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "lashify",
    ],
    keywords: [
      "shirt", "perfect sweatshirt", "perfect", "perfects", "sweatshirt",
      "sweatshirts", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Timber Tee" — USD 35
    // Endpoint declared by the live profile at verification: ltg-b2c-us.myshopify.com
    merchant: "Leatherman",
    profileHost: "leatherman.com",
    brand: "Leatherman",
    fallbackEndpoint: "https://ltg-b2c-us.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "leatherman",
    ],
    keywords: [
      "shirt", "timber tee", "timber", "timbers", "tee", "tees", "clothing",
      "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Lectric T-Shirt" — USD 25
    // Endpoint declared by the live profile at verification: lectric-ebikes.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Lectric eBikes",
    profileHost: "lectricebikes.com",
    brand: "Lectric eBikes",
    fallbackEndpoint: "https://lectric-ebikes.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "lectric ebikes", "lectricebikes",
    ],
    keywords: [
      "shirt", "shirts", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Pumpkin Spice Popcorn" — USD 4.66
    // Endpoint declared by the live profile at verification: lesser-evil.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "LesserEvil Snacks",
    profileHost: "lesserevil.com",
    brand: "LesserEvil Snacks",
    fallbackEndpoint: "https://lesser-evil.myshopify.com/api/ucp/mcp",
    category: "Food & Beverage",
    brandAliases: [
      "lesserevil snacks", "lesserevilsnacks",
    ],
    keywords: [
      "shoes", "pumpkin spice", "spice popcorn", "pumpkin", "pumpkins",
      "spice", "spices", "popcorn", "popcorns",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Levain T-Shirt" — USD 35
    // Endpoint declared by the live profile at verification: levainbakery.myshopify.com
    merchant: "Levain Bakery",
    profileHost: "levainbakery.com",
    brand: "Levain Bakery",
    fallbackEndpoint: "https://levainbakery.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "levain bakery", "levainbakery",
    ],
    keywords: [
      "shirt", "shirts", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "LifeStraw Home 7-Cup Glass" — USD 64.95
    // Endpoint declared by the live profile at verification: lifestraw-store.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "LifeStraw",
    profileHost: "lifestraw.com",
    brand: "LifeStraw",
    fallbackEndpoint: "https://lifestraw-store.myshopify.com/api/ucp/mcp",
    category: "Home",
    brandAliases: [
      "lifestraw",
    ],
    keywords: [
      "shirt", "home cup", "cup glass", "home", "homes", "cup", "cups",
      "glass", "home goods",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "LIFX Tee" — USD 29.99
    // Endpoint declared by the live profile at verification: lifxus.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "LIFX",
    profileHost: "lifx.com",
    brand: "LIFX",
    fallbackEndpoint: "https://lifxus.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "lifx",
    ],
    keywords: [
      "shirt", "tee", "tees", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Pacific Full Button Shirt" — USD 88
    // Endpoint declared by the live profile at verification: link-soul.myshopify.com
    merchant: "LINKSOUL",
    profileHost: "linksoul.com",
    brand: "LINKSOUL",
    fallbackEndpoint: "https://link-soul.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "linksoul",
    ],
    keywords: [
      "shirt", "pacific full", "full button", "button shirt", "pacific",
      "pacifics", "full", "fulls", "button", "buttons", "shirts", "clothing",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Eternal Death Flannel Shirt" — USD 66
    // Endpoint declared by the live profile at verification: liquiddeath.myshopify.com
    merchant: "Liquid Death",
    profileHost: "liquiddeath.com",
    brand: "Liquid Death",
    fallbackEndpoint: "https://liquiddeath.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "liquid death", "liquiddeath",
    ],
    keywords: [
      "shirt", "eternal flannel", "flannel shirt", "eternal", "eternals",
      "flannel", "flannels", "shirts", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Sugar-Free Sweet Bundle" — USD 57.98
    // Endpoint declared by the live profile at verification: liv-group.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Liquid I.V.",
    profileHost: "liquid-iv.com",
    brand: "Liquid I.V.",
    fallbackEndpoint: "https://liv-group.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "liquid i v", "liquidiv",
    ],
    keywords: [
      "shirt", "sugar sweet", "sugar", "sugars", "sweet", "sweets",
      "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Black Women's Perfect Pocket Tee" — USD 34
    // Endpoint declared by the live profile at verification: little-sleepies.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Little Sleepies",
    profileHost: "littlesleepies.com",
    brand: "Little Sleepies",
    fallbackEndpoint: "https://little-sleepies.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "little sleepies", "littlesleepies",
    ],
    keywords: [
      "shirt", "perfect pocket", "pocket tee", "perfect", "perfects",
      "pocket", "pockets", "tee", "tees", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Ken Shirt" — USD 225
    // Endpoint declared by the live profile at verification: loeffler-randall-1.myshopify.com
    merchant: "Loeffler Randall",
    profileHost: "loefflerrandall.com",
    brand: "Loeffler Randall",
    fallbackEndpoint: "https://loeffler-randall-1.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "loeffler randall", "loefflerrandall",
    ],
    keywords: [
      "shirt", "ken shirt", "ken", "kens", "shirts", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Sleep Sweatshirt" — USD 59.99
    // Endpoint declared by the live profile at verification: byloftie.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Loftie",
    profileHost: "loftie.com",
    brand: "Loftie",
    fallbackEndpoint: "https://byloftie.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "loftie",
    ],
    keywords: [
      "shirt", "sleep sweatshirt", "sleep", "sleeps", "sweatshirt",
      "sweatshirts", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Theda Hand-Knotted Wool Rug" — USD 498
    // Endpoint declared by the live profile at verification: lulu-and-georgia.myshopify.com
    merchant: "Lulu and Georgia",
    profileHost: "luluandgeorgia.com",
    brand: "Lulu and Georgia",
    fallbackEndpoint: "https://lulu-and-georgia.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "lulu and georgia", "lulu georgia", "luluandgeorgia",
    ],
    keywords: [
      "shirt", "theda hand", "hand knotted", "knotted wool", "wool rug",
      "theda", "thedas", "hand", "hands", "knotted", "wool", "wools",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "M·A·C VIVA GLAM x Conner Ives “Protect the Dolls” Shirt" — USD 100
    // Endpoint declared by the live profile at verification: elc-us-mc-prod.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "MAC Cosmetics",
    profileHost: "maccosmetics.com",
    brand: "MAC Cosmetics",
    fallbackEndpoint: "https://elc-us-mc-prod.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: [
      "mac cosmetics", "maccosmetics",
    ],
    keywords: [
      "shirt", "viva glam", "glam conner", "conner ives", "ives protect",
      "viva", "vivas", "glam", "glams", "conner", "conners", "ives",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "SILVER Crew Neck T-Shirt" — USD 58
    // Endpoint declared by the live profile at verification: mack-weldon.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Mack Weldon",
    profileHost: "mackweldon.com",
    brand: "Mack Weldon",
    fallbackEndpoint: "https://mack-weldon.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "mack weldon", "mackweldon",
    ],
    keywords: [
      "shirt", "crew neck", "neck shirt", "crew", "crews", "neck", "necks",
      "shirts", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Wrangler x Made In T-Shirt" — USD 35
    // Endpoint declared by the live profile at verification: madeincookware.myshopify.com
    merchant: "Made In Cookware",
    profileHost: "madeincookware.com",
    brand: "Made In Cookware",
    fallbackEndpoint: "https://madeincookware.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "made in cookware", "madeincookware",
    ],
    keywords: [
      "shirt", "wrangler shirt", "wrangler", "wranglers", "shirts",
      "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Variety 6 - 24 Cereal Treats (6 Boxes)" — USD 55.5
    // Endpoint declared by the live profile at verification: magic-spoon.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Magic Spoon",
    profileHost: "magicspoon.com",
    brand: "Magic Spoon",
    fallbackEndpoint: "https://magic-spoon.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "magic spoon", "magicspoon",
    ],
    keywords: [
      "shirt", "variety cereal", "cereal treats", "treats boxes", "variety",
      "varieties", "cereal", "cereals", "treats", "treat", "boxes", "boxe",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Maglite® ML150LR Rechargeable LED Flashlight – 458-Meter Beam, 1,082 Lumens, 52,555 Candela & Up to 79-Hour Runtime, Quick Focus®, QuickClik® & Fast-Charging LiFePO4 Power" — USD 119.99
    // Endpoint declared by the live profile at verification: maglite.myshopify.com
    merchant: "Maglite",
    profileHost: "maglite.com",
    brand: "Maglite",
    fallbackEndpoint: "https://maglite.myshopify.com/api/ucp/mcp",
    category: "Hardware",
    brandAliases: [
      "maglite",
    ],
    keywords: [
      "shirt", "ml150lr rechargeable", "rechargeable led", "led flashlight",
      "flashlight meter", "ml150lr", "ml150lrs", "rechargeable",
      "rechargeables", "led", "flashlight", "flashlights",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Santa & Friends Blind Bags" — USD 4.99
    // Endpoint declared by the live profile at verification: i5nhgx-nj.myshopify.com
    merchant: "MAGNA TILES",
    profileHost: "magnatiles.com",
    brand: "MAGNA TILES",
    fallbackEndpoint: "https://i5nhgx-nj.myshopify.com/api/ucp/mcp",
    category: "Toys",
    brandAliases: [
      "magna tiles", "magnatiles",
    ],
    keywords: [
      "bag", "santa friends", "friends blind", "blind bags", "santa",
      "santas", "friends", "friend", "blind", "blinds", "bags", "toys",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "BERMUDA TEE" — USD 58
    // Endpoint declared by the live profile at verification: malbon.myshopify.com
    merchant: "Malbon",
    profileHost: "malbongolf.com",
    brand: "Malbon",
    fallbackEndpoint: "https://malbon.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "malbon",
    ],
    keywords: [
      "shirt", "bermuda tee", "bermuda", "bermudas", "tee", "tees",
      "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Yale Pointy Toe Chelsea Leather Bootie" — USD 189
    // Endpoint declared by the live profile at verification: mffootwear.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Marc Fisher Footwear",
    profileHost: "marcfisherfootwear.com",
    brand: "Marc Fisher Footwear",
    fallbackEndpoint: "https://mffootwear.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "marc fisher footwear", "marcfisherfootwear",
    ],
    keywords: [
      "shirt", "yale pointy", "pointy toe", "toe chelsea", "chelsea leather",
      "yale", "yales", "pointy", "pointies", "toe", "toes", "chelsea",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Stretch Selvage Short Sleeve Shirt" — USD 118
    // Endpoint declared by the live profile at verification: marinelayer.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Marine Layer",
    profileHost: "marinelayer.com",
    brand: "Marine Layer",
    fallbackEndpoint: "https://marinelayer.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "marine layer", "marinelayer",
    ],
    keywords: [
      "shirt", "stretch selvage", "selvage short", "short sleeve",
      "sleeve shirt", "stretch", "stretches", "selvage", "selvages", "short",
      "shorts", "sleeve",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Mattel Shop Test T-shirt" — USD 25
    // Endpoint declared by the live profile at verification: prod-mattel.myshopify.com
    merchant: "Mattel Shop",
    profileHost: "mattel.com",
    brand: "Mattel",
    fallbackEndpoint: "https://prod-mattel.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "mattel shop", "mattelshop",
    ],
    keywords: [
      "shirt", "shirts", "clothing", "apparel",
    ],
    prefixBrand: false,
  },
  {
    // Sweep-verified Nov 4, 2026: "Striped Fuzzy Jumper" — USD 65
    // Endpoint declared by the live profile at verification: max-bone.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "maxbone",
    profileHost: "maxbone.com",
    brand: "maxbone",
    fallbackEndpoint: "https://max-bone.myshopify.com/api/ucp/mcp",
    category: "Pet Supplies",
    brandAliases: [
      "maxbone",
    ],
    keywords: [
      "shirt", "striped fuzzy", "fuzzy jumper", "striped", "fuzzy",
      "fuzzies", "jumper", "jumpers", "pet supplies",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "MK Strawberry Frog Hawaiian Button-up Shirt" — USD 30
    // Endpoint declared by the live profile at verification: a701d1-5.myshopify.com
    merchant: "Mechanical Keyboards",
    profileHost: "mechanicalkeyboards.com",
    brand: "Mechanical Keyboards",
    fallbackEndpoint: "https://a701d1-5.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "mechanical keyboards", "mechanicalkeyboards",
    ],
    keywords: [
      "shirt", "strawberry frog", "frog hawaiian", "hawaiian button",
      "button shirt", "strawberry", "strawberries", "frog", "frogs",
      "hawaiian", "hawaiians", "button",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Mine to Love Mix & Match Playtime Doll Clothes" — USD 30.99
    // Endpoint declared by the live profile at verification: melissadoug.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Melissa & Doug",
    profileHost: "melissaanddoug.com",
    brand: "Melissa & Doug",
    fallbackEndpoint: "https://melissadoug.myshopify.com/api/ucp/mcp",
    category: "Toys",
    brandAliases: [
      "melissa and doug", "melissa doug", "melissaanddoug",
    ],
    keywords: [
      "shirt", "mine love", "love mix", "mix match", "match playtime",
      "mine", "mines", "love", "loves", "mix", "mixes", "match",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "The Top" — USD 120
    // Endpoint declared by the live profile at verification: meritbeauty.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "MERIT Beauty",
    profileHost: "meritbeauty.com",
    brand: "MERIT Beauty",
    fallbackEndpoint: "https://meritbeauty.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "merit beauty", "meritbeauty",
    ],
    keywords: [
      "shirt", "top", "tops", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Mongongo Oil Thermal & Heat Protectant Spray" — USD 5
    // Endpoint declared by the live profile at verification: mielleorganics.myshopify.com
    merchant: "MIELLE",
    profileHost: "mielleorganics.com",
    brand: "MIELLE",
    fallbackEndpoint: "https://mielleorganics.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: [
      "mielle",
    ],
    keywords: [
      "shirt", "mongongo oil", "oil thermal", "thermal heat",
      "heat protectant", "mongongo", "mongongos", "oil", "oils", "thermal",
      "thermals", "heat",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Color Statement Lipstick" — USD 7.49
    // Endpoint declared by the live profile at verification: milanicosmetics.myshopify.com
    merchant: "Milani Cosmetics",
    profileHost: "milanicosmetics.com",
    brand: "Milani Cosmetics",
    fallbackEndpoint: "https://milanicosmetics.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: [
      "milani cosmetics", "milanicosmetics",
    ],
    keywords: [
      "shirt", "color statement", "statement lipstick", "color", "colors",
      "statement", "statements", "lipstick", "lipsticks", "makeup",
      "skincare", "beauty",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "6\" Birthday Cake" — USD 65
    // Endpoint declared by the live profile at verification: milk-bar-development.myshopify.com
    merchant: "Milk Bar",
    profileHost: "milkbarstore.com",
    brand: "Milk Bar",
    fallbackEndpoint: "https://milk-bar-development.myshopify.com/api/ucp/mcp",
    category: "Food & Beverage",
    brandAliases: [
      "milk bar", "milkbar",
    ],
    keywords: [
      "shirt", "birthday cake", "birthday", "birthdays", "cake", "cakes",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Odyssey Lip Oil Gloss" — USD 26
    // Endpoint declared by the live profile at verification: milkmakeup21.myshopify.com
    merchant: "Milk Makeup",
    profileHost: "milkmakeup.com",
    brand: "Milk Makeup",
    fallbackEndpoint: "https://milkmakeup21.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: [
      "milk makeup", "milkmakeup",
    ],
    keywords: [
      "shirt", "odyssey lip", "lip oil", "oil gloss", "odyssey", "odysseys",
      "lip", "lips", "oil", "oils", "gloss", "makeup",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Men's Apollo Dress Shirt - White (MPS)" — USD 168
    // Endpoint declared by the live profile at verification: mostrial.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Ministry of Supply",
    profileHost: "ministryofsupply.com",
    brand: "Ministry of Supply",
    fallbackEndpoint: "https://mostrial.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "ministry of supply", "ministryofsupply",
    ],
    keywords: [
      "shirt", "apollo dress", "dress shirt", "shirt mps", "apollo",
      "apollos", "dress", "shirts", "mps", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Lightweight Men's Wool T Shirt Crew - 100% Merino Wool" — USD 69.99
    // Endpoint declared by the live profile at verification: minus33.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Minus33",
    profileHost: "minus33.com",
    brand: "Minus33",
    fallbackEndpoint: "https://minus33.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "minus33",
    ],
    keywords: [
      "shirt", "lightweight wool", "wool shirt", "shirt crew", "crew merino",
      "lightweight", "lightweights", "wool", "wools", "shirts", "crew",
      "crews",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Modkat Flip" — USD 99.99
    // Endpoint declared by the live profile at verification: modkat.myshopify.com
    merchant: "Modkat",
    profileHost: "modkat.com",
    brand: "Modkat",
    fallbackEndpoint: "https://modkat.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "modkat",
    ],
    keywords: [
      "shirt", "flip", "flips", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Flannel Shirt [hidden]" — USD 30
    // Endpoint declared by the live profile at verification: monicaandandyonline.myshopify.com
    merchant: "Monica + Andy",
    profileHost: "monicaandandy.com",
    brand: "Monica + Andy",
    fallbackEndpoint: "https://monicaandandyonline.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "monica andy", "monicaandy",
    ],
    keywords: [
      "shirt", "flannel shirt", "shirt hidden", "flannel", "flannels",
      "shirts", "hidden", "hiddens", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Powerstation Pro XL 25K Fabric Power Bank" — USD 199.95
    // Endpoint declared by the live profile at verification: mophiecharging.myshopify.com
    merchant: "mophie",
    profileHost: "mophie.com",
    brand: "mophie",
    fallbackEndpoint: "https://mophiecharging.myshopify.com/api/ucp/mcp",
    category: "Electronics",
    brandAliases: [
      "mophie",
    ],
    keywords: [
      "shirt", "powerstation 25k", "25k fabric", "fabric power",
      "power bank", "powerstation", "powerstations", "25k", "25ks", "fabric",
      "fabrics", "power",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Portrait Mode 5-Piece Face Brush Set" — USD 33
    // Endpoint declared by the live profile at verification: morphe-inc.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Morphe",
    profileHost: "morphe.com",
    brand: "Morphe",
    fallbackEndpoint: "https://morphe-inc.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: [
      "morphe",
    ],
    keywords: [
      "shirt", "portrait mode", "mode piece", "piece face", "face brush",
      "portrait", "portraits", "mode", "modes", "piece", "pieces", "face",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Screen Protector" — USD 13.99
    // Endpoint declared by the live profile at verification: mous-us.myshopify.com
    merchant: "Mous",
    profileHost: "mous.com",
    brand: "Mous",
    fallbackEndpoint: "https://mous-us.myshopify.com/api/ucp/mcp",
    category: "Electronics",
    brandAliases: [
      "mous",
    ],
    keywords: [
      "shirt", "screen protector", "screen", "screens", "protector",
      "protectors", "electronics",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Rain Water Dryer Sheets" — USD 10.59
    // Endpoint declared by the live profile at verification: 285b44-56.myshopify.com
    merchant: "Mrs. Meyer's Clean Day",
    profileHost: "mrsmeyers.com",
    brand: "Mrs. Meyer's Clean Day",
    fallbackEndpoint: "https://285b44-56.myshopify.com/api/ucp/mcp",
    category: "Home",
    brandAliases: [
      "mrs meyer s clean day", "mrsmeyerscleanday",
    ],
    keywords: [
      "shirt", "rain water", "water dryer", "dryer sheets", "rain", "rains",
      "water", "waters", "dryer", "dryers", "sheets", "sheet",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "UNLEARN \\ RELEARN T-Shirt" — USD 60
    // Endpoint declared by the live profile at verification: mud-wtr.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "MUD\\WTR",
    profileHost: "mudwtr.com",
    brand: "MUD\\WTR",
    fallbackEndpoint: "https://mud-wtr.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "mud wtr", "mudwtr",
    ],
    keywords: [
      "shirt", "unlearn relearn", "relearn shirt", "unlearn", "unlearns",
      "relearn", "relearns", "shirts", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Pebbles" — USD 118
    // Endpoint declared by the live profile at verification: mugsy-2.myshopify.com
    merchant: "Mugsy",
    profileHost: "mugsyjeans.com",
    brand: "Mugsy",
    fallbackEndpoint: "https://mugsy-2.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "mugsy",
    ],
    keywords: [
      "shirt", "pebbles", "pebble", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Muse S Athena" — USD 474.99
    // Endpoint declared by the live profile at verification: interaxon.myshopify.com
    merchant: "Muse",
    profileHost: "choosemuse.com",
    brand: "Muse",
    fallbackEndpoint: "https://interaxon.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: [
      "muse",
    ],
    keywords: [
      "shirt", "athena", "athenas", "makeup", "skincare", "beauty",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Super Fine Cashmere T-Shirt" — USD 158
    // Endpoint declared by the live profile at verification: naadamcashmere.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "NAADAM",
    profileHost: "naadam.co",
    brand: "NAADAM",
    fallbackEndpoint: "https://naadamcashmere.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "naadam",
    ],
    keywords: [
      "shirt", "super fine", "fine cashmere", "cashmere shirt", "super",
      "supers", "fine", "fines", "cashmere", "cashmeres", "shirts",
      "clothing",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "The Best Sellers Bundle" — USD 369
    // Endpoint declared by the live profile at verification: aislings-sweets-treats.myshopify.com
    merchant: "Nanit",
    profileHost: "nanit.com",
    brand: "Nanit",
    fallbackEndpoint: "https://aislings-sweets-treats.myshopify.com/api/ucp/mcp",
    category: "Baby",
    brandAliases: [
      "nanit",
    ],
    keywords: [
      "shirt", "sellers", "seller", "baby",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Nanoleaf Smart LED Bulbs" — USD 19.99
    // Endpoint declared by the live profile at verification: nanoleaf-markets.myshopify.com
    merchant: "Nanoleaf",
    profileHost: "nanoleaf.me",
    brand: "Nanoleaf",
    fallbackEndpoint: "https://nanoleaf-markets.myshopify.com/api/ucp/mcp",
    category: "Home",
    brandAliases: [
      "nanoleaf",
    ],
    keywords: [
      "shirt", "smart led", "led bulbs", "smart", "smarts", "led", "bulbs",
      "bulb", "home goods",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Body Wash" — USD 11
    // Endpoint declared by the live profile at verification: native-deodorant.myshopify.com
    merchant: "Native",
    profileHost: "nativecos.com",
    brand: "Native",
    fallbackEndpoint: "https://native-deodorant.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: [
      "native",
    ],
    keywords: [
      "shirt", "body wash", "body", "bodies", "wash", "washes", "makeup",
      "skincare", "beauty",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Just the Good Stuff Crewneck" — USD 35
    // Endpoint declared by the live profile at verification: the-native-pet.myshopify.com
    merchant: "Native Pet",
    profileHost: "nativepet.com",
    brand: "Native Pet",
    fallbackEndpoint: "https://the-native-pet.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "native pet", "nativepet",
    ],
    keywords: [
      "shirt", "just good", "good stuff", "stuff crewneck", "just", "justs",
      "good", "goods", "stuff", "stufves", "crewneck", "crewnecks",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Island Short Sleeve Shirt in Black" — USD 120
    // Endpoint declared by the live profile at verification: negative-underwear.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Negative",
    profileHost: "negativeunderwear.com",
    brand: "Negative",
    fallbackEndpoint: "https://negative-underwear.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "negative",
    ],
    keywords: [
      "shirt", "island short", "short sleeve", "sleeve shirt", "island",
      "islands", "short", "shorts", "sleeve", "sleeves", "shirts",
      "clothing",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Tempo™ Women's Endless Promise Synthetic Sleeping Bag" — USD 149.95
    // Endpoint declared by the live profile at verification: nemo-equipment-shop.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "NEMO Equipment",
    profileHost: "nemoequipment.com",
    brand: "NEMO Equipment",
    fallbackEndpoint: "https://nemo-equipment-shop.myshopify.com/api/ucp/mcp",
    category: "Sporting Goods",
    brandAliases: [
      "nemo equipment", "nemoequipment",
    ],
    keywords: [
      "shirt", "tempotm endless", "endless promise", "promise synthetic",
      "synthetic sleeping", "tempotm", "tempotms", "endless", "promise",
      "promises", "synthetic", "synthetics",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Bamboo Liquid Soap" — USD 26
    // Endpoint declared by the live profile at verification: nestny.myshopify.com
    merchant: "NEST NEW YORK",
    profileHost: "nestnewyork.com",
    brand: "NEST NEW YORK",
    fallbackEndpoint: "https://nestny.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: [
      "nest new york", "nestnewyork",
    ],
    keywords: [
      "shirt", "bamboo liquid", "liquid soap", "bamboo", "bamboos", "liquid",
      "liquids", "soap", "soaps", "makeup", "skincare", "beauty",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Men's Huarache Sandal 2.0 Brown" — USD 119
    // Endpoint declared by the live profile at verification: nisolo.myshopify.com
    merchant: "Nisolo",
    profileHost: "nisolo.com",
    brand: "Nisolo",
    fallbackEndpoint: "https://nisolo.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "nisolo",
    ],
    keywords: [
      "shirt", "huarache sandal", "huarache", "huaraches", "sandal",
      "sandals", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Classic Pocket Tee" — USD 58
    // Endpoint declared by the live profile at verification: noahnyc.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Noah NYC",
    profileHost: "noahny.com",
    brand: "Noah NYC",
    fallbackEndpoint: "https://noahnyc.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "noah nyc", "noahnyc",
    ],
    keywords: [
      "shirt", "pocket tee", "pocket", "pockets", "tee", "tees", "clothing",
      "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Shirt - Men's Extra Large | Green" — USD 29
    // Endpoint declared by the live profile at verification: nomadtest.myshopify.com
    merchant: "Nomad",
    profileHost: "nomadgoods.com",
    brand: "Nomad",
    fallbackEndpoint: "https://nomadtest.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "nomad",
    ],
    keywords: [
      "shirt", "shirt extra", "extra large", "shirts", "extra", "extras",
      "large", "larges", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Outset T-Shirt" — USD 44.99
    // Endpoint declared by the live profile at verification: basics-wallet.myshopify.com
    merchant: "NOMATIC",
    profileHost: "nomatic.com",
    brand: "NOMATIC",
    fallbackEndpoint: "https://basics-wallet.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "nomatic",
    ],
    keywords: [
      "shirt", "outset shirt", "outset", "outsets", "shirts", "clothing",
      "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Artifact Stratum 80" — USD 590
    // Endpoint declared by the live profile at verification: novelkeys-llc.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "NovelKeys",
    profileHost: "novelkeys.com",
    brand: "NovelKeys",
    fallbackEndpoint: "https://novelkeys-llc.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "novelkeys",
    ],
    keywords: [
      "shirt", "artifact stratum", "artifact", "artifacts", "stratum",
      "stratums", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "The Nugget® - Nebula" — USD 279
    // Endpoint declared by the live profile at verification: nuggetcomfort-com.myshopify.com
    merchant: "Nugget",
    profileHost: "nuggetcomfort.com",
    brand: "Nugget",
    fallbackEndpoint: "https://nuggetcomfort-com.myshopify.com/api/ucp/mcp",
    category: "Furniture",
    brandAliases: [
      "nugget",
    ],
    keywords: [
      "shirt", "nebula", "nebulas", "furniture",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Nuun Sport" — USD 7.49
    // Endpoint declared by the live profile at verification: nuunlife.myshopify.com
    merchant: "Nuun Hydration",
    profileHost: "nuun.com",
    brand: "Nuun Hydration",
    fallbackEndpoint: "https://nuunlife.myshopify.com/api/ucp/mcp",
    category: "Food & Beverage",
    brandAliases: [
      "nuun hydration", "nuunhydration",
    ],
    keywords: [
      "shirt", "sport", "sports",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Eclipse Daydream Baby Tee" — USD 24
    // Endpoint declared by the live profile at verification: nvgtn.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "NVGTN",
    profileHost: "nvgtn.com",
    brand: "NVGTN",
    fallbackEndpoint: "https://nvgtn.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "nvgtn",
    ],
    keywords: [
      "shirt", "eclipse daydream", "daydream baby", "baby tee", "eclipse",
      "eclipses", "daydream", "daydreams", "baby", "babies", "tee", "tees",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "STRENGTH & SHINE SET" — USD 46
    // Endpoint declared by the live profile at verification: olaplex.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "OLAPLEX",
    profileHost: "olaplex.com",
    brand: "OLAPLEX",
    fallbackEndpoint: "https://olaplex.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: [
      "olaplex",
    ],
    keywords: [
      "shirt", "strength shine", "shine set", "strength", "strengths",
      "shine", "shines", "set", "sets", "makeup", "skincare", "beauty",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Shirley Temple" — USD 35.99
    // Endpoint declared by the live profile at verification: olipop-store.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "OLIPOP",
    profileHost: "drinkolipop.com",
    brand: "OLIPOP",
    fallbackEndpoint: "https://olipop-store.myshopify.com/api/ucp/mcp",
    category: "Food & Beverage",
    brandAliases: [
      "olipop",
    ],
    keywords: [
      "shirt", "shirley temple", "shirley", "shirleys", "temple", "temples",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Gildan Adult Short Sleeve Tees" — USD 1.99
    // Endpoint declared by the live profile at verification: shopollies.myshopify.com
    merchant: "Ollies",
    profileHost: "ollies.com",
    brand: "Ollies",
    fallbackEndpoint: "https://shopollies.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "ollies",
    ],
    keywords: [
      "shirt", "gildan adult", "adult short", "short sleeve", "sleeve tees",
      "gildan", "gildans", "adult", "adults", "short", "shorts", "sleeve",
    ],
    prefixBrand: false,
  },
  {
    // Sweep-verified Nov 4, 2026: "Women's 40+ Multi" — USD 21.99
    // Endpoint declared by the live profile at verification: ollypbc.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "OLLY",
    profileHost: "olly.com",
    brand: "OLLY",
    fallbackEndpoint: "https://ollypbc.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: [
      "olly",
    ],
    keywords: [
      "shirt", "multi", "multis", "makeup", "skincare", "beauty",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "OluKai x Kahala Aloha Shirt" — USD 118
    // Endpoint declared by the live profile at verification: olukai-store.myshopify.com
    merchant: "OluKai",
    profileHost: "olukai.com",
    brand: "OluKai",
    fallbackEndpoint: "https://olukai-store.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "olukai",
    ],
    keywords: [
      "shirt", "kahala aloha", "aloha shirt", "kahala", "kahalas", "aloha",
      "alohas", "shirts", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "All-Day Ribbed T-Shirt 1 W Brume" — USD 70
    // Endpoint declared by the live profile at verification: on-central-prod-ecom.myshopify.com
    merchant: "On",
    profileHost: "on-running.com",
    brand: "On",
    fallbackEndpoint: "https://on-central-prod-ecom.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "on running", "on cloud", "on shoes",
    ],
    keywords: [
      "shirt", "day ribbed", "ribbed shirt", "shirt brume", "day", "days",
      "ribbed", "shirts", "brume", "brumes", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "The Sandlot Tee" — USD 35
    // Endpoint declared by the live profile at verification: onewheel.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Onewheel",
    profileHost: "onewheel.com",
    brand: "Onewheel",
    fallbackEndpoint: "https://onewheel.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "onewheel",
    ],
    keywords: [
      "shirt", "sandlot tee", "sandlot", "sandlots", "tee", "tees",
      "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Ooni Karu 2 Pro Multi-Fuel Pizza Oven- 2nd Generation" — USD 849
    // Endpoint declared by the live profile at verification: uuni.myshopify.com
    merchant: "Ooni",
    profileHost: "ooni.com",
    brand: "Ooni",
    fallbackEndpoint: "https://uuni.myshopify.com/api/ucp/mcp",
    category: "Home",
    brandAliases: [
      "ooni",
    ],
    keywords: [
      "shirt", "karu multi", "multi fuel", "fuel pizza", "pizza oven",
      "karu", "karus", "multi", "multis", "fuel", "fuels", "pizza",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "\"Call Me Crazy\" Cat Parent Hoodie" — USD 65
    // Endpoint declared by the live profile at verification: openfarm.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Open Farm",
    profileHost: "openfarmpet.com",
    brand: "Open Farm",
    fallbackEndpoint: "https://openfarm.myshopify.com/api/ucp/mcp",
    category: "Pet Supplies",
    brandAliases: [
      "open farm", "openfarm",
    ],
    keywords: [
      "shirt", "call crazy", "crazy cat", "cat parent", "parent hoodie",
      "call", "calls", "crazy", "crazies", "cat", "cats", "parent",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "No.08 Stainless Steel Folding Knife" — USD 23
    // Endpoint declared by the live profile at verification: kniforia.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "OPINEL",
    profileHost: "opinel-usa.com",
    brand: "OPINEL",
    fallbackEndpoint: "https://kniforia.myshopify.com/api/ucp/mcp",
    category: "Kitchen",
    brandAliases: [
      "opinel",
    ],
    keywords: [
      "shirt", "stainless steel", "steel folding", "folding knife",
      "stainless", "steel", "steels", "folding", "foldings", "knife",
      "knives", "kitchen",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "GOLD STANDARD 100% WHEY™" — USD 26.49
    // Endpoint declared by the live profile at verification: bjbebq-x1.myshopify.com
    merchant: "Optimum Nutrition",
    profileHost: "optimumnutrition.com",
    brand: "Optimum Nutrition",
    fallbackEndpoint: "https://bjbebq-x1.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: [
      "optimum nutrition", "optimumnutrition",
    ],
    keywords: [
      "shirt", "standard wheytm", "standard", "standards", "wheytm",
      "wheytms", "makeup", "skincare", "beauty",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "20g Clean Protein Shake - Creamy Chocolate Fudge" — USD 35.99
    // Endpoint declared by the live profile at verification: drink-orgain.myshopify.com
    merchant: "Orgain",
    profileHost: "orgain.com",
    brand: "Orgain",
    fallbackEndpoint: "https://drink-orgain.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: [
      "orgain",
    ],
    keywords: [
      "shirt", "20g clean", "clean protein", "protein shake", "shake creamy",
      "20g", "20gs", "clean", "cleans", "protein", "proteins", "shake",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Cardamom Milk" — USD 20
    // Endpoint declared by the live profile at verification: otherland-candles.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Otherland",
    profileHost: "otherland.com",
    brand: "Otherland",
    fallbackEndpoint: "https://otherland-candles.myshopify.com/api/ucp/mcp",
    category: "Home",
    brandAliases: [
      "otherland",
    ],
    keywords: [
      "shirt", "cardamom milk", "cardamom", "cardamoms", "milk", "milks",
      "home goods",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Pixel 11 and Pixel 11 Pro Defender Series Pro Case" — USD 69.99
    // Endpoint declared by the live profile at verification: 0ndwc3-ar.myshopify.com
    merchant: "OtterBox",
    profileHost: "otterbox.com",
    brand: "OtterBox",
    fallbackEndpoint: "https://0ndwc3-ar.myshopify.com/api/ucp/mcp",
    category: "Electronics",
    brandAliases: [
      "otterbox",
    ],
    keywords: [
      "shirt", "pixel pixel", "pixel defender", "defender series",
      "series case", "pixel", "pixels", "defender", "defenders", "series",
      "sery", "case",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Hair & Body Fragrance Mist St. Barts Scent" — USD 28
    // Endpoint declared by the live profile at verification: ouai.myshopify.com
    merchant: "OUAI",
    profileHost: "theouai.com",
    brand: "OUAI",
    fallbackEndpoint: "https://ouai.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: [
      "ouai",
    ],
    keywords: [
      "shirt", "hair body", "body fragrance", "fragrance mist", "mist barts",
      "hair", "hairs", "body", "bodies", "fragrance", "fragrances", "mist",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "CloudKnit Shortsleeve" — USD 58
    // Endpoint declared by the live profile at verification: outdoor-voices.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Outdoor Voices",
    profileHost: "outdoorvoices.com",
    brand: "Outdoor Voices",
    fallbackEndpoint: "https://outdoor-voices.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "outdoor voices", "outdoorvoices",
    ],
    keywords: [
      "shirt", "cloudknit shortsleeve", "cloudknit", "cloudknits",
      "shortsleeve", "shortsleeves", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Blanket Shirt" — USD 168
    // Endpoint declared by the live profile at verification: outerknown.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Outerknown",
    profileHost: "outerknown.com",
    brand: "Outerknown",
    fallbackEndpoint: "https://outerknown.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "outerknown",
    ],
    keywords: [
      "shirt", "blanket shirt", "blanket", "blankets", "shirts", "clothing",
      "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "FreeSip®" — USD 23.99
    // Endpoint declared by the live profile at verification: owala.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Owala",
    profileHost: "owalalife.com",
    brand: "Owala",
    fallbackEndpoint: "https://owala.myshopify.com/api/ucp/mcp",
    category: "Home",
    brandAliases: [
      "owala",
    ],
    keywords: [
      "shirt", "freesip", "freesips", "home goods",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Advocate Like a Mother T-shirt" — USD 32.5
    // Endpoint declared by the live profile at verification: owletcare.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Owlet",
    profileHost: "owletcare.com",
    brand: "Owlet",
    fallbackEndpoint: "https://owletcare.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "owlet",
    ],
    keywords: [
      "shirt", "advocate like", "like mother", "mother shirt", "advocate",
      "advocates", "like", "likes", "mother", "mothers", "shirts",
      "clothing",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Just the Basics" — USD 48.45
    // Endpoint declared by the live profile at verification: p-f-candle-co.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "P. F. Candle Co.",
    profileHost: "pfcandleco.com",
    brand: "P. F. Candle Co.",
    fallbackEndpoint: "https://p-f-candle-co.myshopify.com/api/ucp/mcp",
    category: "Home",
    brandAliases: [
      "p f candle co", "pfcandleco",
    ],
    keywords: [
      "shirt", "just basics", "just", "justs", "basics", "basic", "candle",
      "candles", "home goods",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Tobacco + Patchouli - Apothecary 8 oz Candle" — USD 30
    // Endpoint declared by the live profile at verification: paddywaxhq.myshopify.com
    merchant: "Paddywax",
    profileHost: "paddywax.com",
    brand: "Paddywax",
    fallbackEndpoint: "https://paddywaxhq.myshopify.com/api/ucp/mcp",
    category: "Home",
    brandAliases: [
      "paddywax",
    ],
    keywords: [
      "shirt", "tobacco patchouli", "patchouli apothecary",
      "apothecary candle", "tobacco", "tobaccos", "patchouli", "patchoulis",
      "apothecary", "apothecaries", "candle", "candles",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Brushed Cotton Top Sheet (Sky)" — USD 90
    // Endpoint declared by the live profile at verification: parachute-home-2.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Parachute Home",
    profileHost: "parachutehome.com",
    brand: "Parachute Home",
    fallbackEndpoint: "https://parachute-home-2.myshopify.com/api/ucp/mcp",
    category: "Home",
    brandAliases: [
      "parachute home", "parachutehome",
    ],
    keywords: [
      "shirt", "brushed cotton", "cotton top", "top sheet", "sheet sky",
      "brushed", "cotton", "cottons", "top", "tops", "sheet", "sheets",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Vanilla Wafers" — USD 39.99
    // Endpoint declared by the live profile at verification: partake-foods.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Partake Foods",
    profileHost: "partakefoods.com",
    brand: "Partake Foods",
    fallbackEndpoint: "https://partake-foods.myshopify.com/api/ucp/mcp",
    category: "Food & Beverage",
    brandAliases: [
      "partake foods", "partakefoods",
    ],
    keywords: [
      "shirt", "vanilla wafers", "vanilla", "vanillas", "wafers", "wafer",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Adult Wonder Woman T-Shirt" — USD 25.49
    // Endpoint declared by the live profile at verification: 1agzjw-e1.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Party City",
    profileHost: "partycity.com",
    brand: "Party City",
    fallbackEndpoint: "https://1agzjw-e1.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "party city", "partycity",
    ],
    keywords: [
      "shirt", "adult wonder", "wonder woman", "woman shirt", "adult",
      "adults", "wonder", "wonders", "woman", "womans", "shirts", "clothing",
    ],
    prefixBrand: false,
  },
  {
    // Sweep-verified Nov 4, 2026: "PMG X THE MET DIVINE L/S T" — USD 60
    // Endpoint declared by the live profile at verification: pat-mcgrath.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "PAT McGRATH LABS",
    profileHost: "patmcgrath.com",
    brand: "PAT McGRATH LABS",
    fallbackEndpoint: "https://pat-mcgrath.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "pat mcgrath labs", "patmcgrathlabs",
    ],
    keywords: [
      "shirt", "pmg met", "met divine", "pmg", "pmgs", "met", "mets",
      "divine", "divines", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Leave-In Conditioner" — USD 12
    // Endpoint declared by the live profile at verification: patternbeauty.myshopify.com
    merchant: "Pattern Beauty",
    profileHost: "patternbeauty.com",
    brand: "Pattern Beauty",
    fallbackEndpoint: "https://patternbeauty.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: [
      "pattern beauty", "patternbeauty",
    ],
    keywords: [
      "shirt", "leave conditioner", "leave", "leaves", "conditioner",
      "conditioners", "makeup", "skincare", "beauty",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Chain Heart T-Shirt" — USD 21.95
    // Endpoint declared by the live profile at verification: cd2956-64.myshopify.com
    merchant: "Pedego",
    profileHost: "pedegoelectricbikes.com",
    brand: "Pedego",
    fallbackEndpoint: "https://cd2956-64.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "pedego",
    ],
    keywords: [
      "shirt", "chain heart", "heart shirt", "chain", "chains", "heart",
      "hearts", "shirts", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Electric Blue Striped Shirt iPhone 15 Pro Case" — USD 65
    // Endpoint declared by the live profile at verification: pelacase.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Pela Case",
    profileHost: "pelacase.com",
    brand: "Pela Case",
    fallbackEndpoint: "https://pelacase.myshopify.com/api/ucp/mcp",
    category: "Electronics",
    brandAliases: [
      "pela case", "pelacase",
    ],
    keywords: [
      "shirt", "electric striped", "striped shirt", "shirt iphone",
      "electric", "electrics", "striped", "shirts", "iphone", "iphones",
      "electronics",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Elva Oversized Shirt - Black Stripe" — USD 69
    // Endpoint declared by the live profile at verification: petal-and-pup-usa.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Petal & Pup",
    profileHost: "petalandpup.com",
    brand: "Petal & Pup",
    fallbackEndpoint: "https://petal-and-pup-usa.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "petal and pup", "petal pup", "petalandpup",
    ],
    keywords: [
      "shirt", "elva oversized", "oversized shirt", "shirt stripe", "elva",
      "elvas", "oversized", "shirts", "stripe", "stripes", "clothing",
      "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "TRICK OR TREAT TEE" — USD 14.99
    // Endpoint declared by the live profile at verification: wowteam1.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Petsense",
    profileHost: "petsense.com",
    brand: "Petsense",
    fallbackEndpoint: "https://wowteam1.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "petsense",
    ],
    keywords: [
      "shirt", "trick treat", "treat tee", "trick", "tricks", "treat",
      "treats", "tee", "tees", "clothing", "apparel",
    ],
    prefixBrand: false,
  },
  {
    // Sweep-verified Nov 4, 2026: "Vanilla & Cream - Body Mist Duo" — USD 68
    // Endpoint declared by the live profile at verification: phlur-shop.myshopify.com
    merchant: "Phlur",
    profileHost: "phlur.com",
    brand: "Phlur",
    fallbackEndpoint: "https://phlur-shop.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: [
      "phlur",
    ],
    keywords: [
      "shirt", "vanilla body", "body mist", "mist duo", "vanilla",
      "vanillas", "body", "bodies", "mist", "mists", "duo", "duos",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Super CC Color-Correction + Care CC Cream | Light/Medium" — USD 16.99
    // Endpoint declared by the live profile at verification: markwins-pf.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Physician's Formula",
    profileHost: "physiciansformula.com",
    brand: "Physician's Formula",
    fallbackEndpoint: "https://markwins-pf.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: [
      "physician s formula", "physiciansformula",
    ],
    keywords: [
      "shirt", "super color", "color correction", "correction care",
      "care light", "super", "supers", "color", "colors", "correction",
      "corrections", "care",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Wautomobile" — USD 24.99
    // Endpoint declared by the live profile at verification: usa-plantoys.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "PlanToys",
    profileHost: "plantoys.com",
    brand: "PlanToys",
    fallbackEndpoint: "https://usa-plantoys.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "plantoys",
    ],
    keywords: [
      "shirt", "wautomobile", "wautomobiles", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "The Perfect Tee - Black" — USD 35
    // Endpoint declared by the live profile at verification: popflex.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "POPFLEX",
    profileHost: "popflexactive.com",
    brand: "POPFLEX",
    fallbackEndpoint: "https://popflex.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "popflex",
    ],
    keywords: [
      "shirt", "perfect tee", "perfect", "perfects", "tee", "tees",
      "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Black Classic Shirt" — USD 24
    // Endpoint declared by the live profile at verification: poshpeanuts-com.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Posh Peanut",
    profileHost: "poshpeanut.com",
    brand: "Posh Peanut",
    fallbackEndpoint: "https://poshpeanuts-com.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "posh peanut", "poshpeanut",
    ],
    keywords: [
      "shirt", "shirts", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "HD4BT On-Ear Bluetooth Headphones with ANC" — USD 34.99
    // Endpoint declared by the live profile at verification: presonus-us-prd.myshopify.com
    merchant: "PreSonus",
    profileHost: "presonus.com",
    brand: "PreSonus",
    fallbackEndpoint: "https://presonus-us-prd.myshopify.com/api/ucp/mcp",
    category: "Shoes",
    brandAliases: [
      "presonus",
    ],
    keywords: [
      "shoes", "hd4bt ear", "ear bluetooth", "bluetooth headphones",
      "headphones anc", "hd4bt", "hd4bts", "ear", "ears", "bluetooth",
      "bluetooths", "headphones",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Women's fit classic v-neck tee" — USD 14.75
    // Endpoint declared by the live profile at verification: primarykids.myshopify.com
    merchant: "Primary.com",
    profileHost: "primary.com",
    brand: "Primary.com",
    fallbackEndpoint: "https://primarykids.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "primary com", "primarycom",
    ],
    keywords: [
      "shirt", "fit neck", "neck tee", "fit", "fits", "neck", "necks", "tee",
      "tees", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "AUTHENTIC T-SHIRT (NEW)" — USD 24.99
    // Endpoint declared by the live profile at verification: priority-bicycles-2.myshopify.com
    merchant: "Priority Bicycles",
    profileHost: "prioritybicycles.com",
    brand: "Priority Bicycles",
    fallbackEndpoint: "https://priority-bicycles-2.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "priority bicycles", "prioritybicycles",
    ],
    keywords: [
      "shirt", "authentic shirt", "authentic", "authentics", "shirts",
      "bicycle", "bikes", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Drinking Glasses" — USD 35.95
    // Endpoint declared by the live profile at verification: morgans-dont-run-out.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Public Goods",
    profileHost: "publicgoods.com",
    brand: "Public Goods",
    fallbackEndpoint: "https://morgans-dont-run-out.myshopify.com/api/ucp/mcp",
    category: "Home",
    brandAliases: [
      "public goods", "publicgoods",
    ],
    keywords: [
      "shirt", "drinking glasses", "drinking", "drinkings", "glasses",
      "glasse", "home goods",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Dental Chews" — USD 15.99
    // Endpoint declared by the live profile at verification: 96d3f5-7a.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Pupford",
    profileHost: "pupford.com",
    brand: "Pupford",
    fallbackEndpoint: "https://96d3f5-7a.myshopify.com/api/ucp/mcp",
    category: "Pet Supplies",
    brandAliases: [
      "pupford",
    ],
    keywords: [
      "shirt", "dental chews", "dental", "dentals", "chews", "chew",
      "pet supplies",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Rev Oscillating Toothbrush" — USD 55
    // Endpoint declared by the live profile at verification: bb73c3-5.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "quip",
    profileHost: "getquip.com",
    brand: "quip",
    fallbackEndpoint: "https://bb73c3-5.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: [
      "quip",
    ],
    keywords: [
      "shirt", "rev oscillating", "oscillating toothbrush", "rev", "revs",
      "oscillating", "oscillatings", "toothbrush", "toothbrushes", "makeup",
      "skincare", "beauty",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "100/175/200W N-Type Solar Panel" — USD 109.99
    // Endpoint declared by the live profile at verification: rvi38u-rz.myshopify.com
    merchant: "Renogy",
    profileHost: "renogy.com",
    brand: "Renogy",
    fallbackEndpoint: "https://rvi38u-rz.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "renogy",
    ],
    keywords: [
      "shirt", "200w type", "type solar", "solar panel", "200w", "200ws",
      "type", "types", "solar", "solars", "panel", "panels",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Men's Peak Tri-Blend Crew T-Shirt" — USD 24.5
    // Endpoint declared by the live profile at verification: repfitnessco.myshopify.com
    merchant: "REP Fitness",
    profileHost: "repfitness.com",
    brand: "REP Fitness",
    fallbackEndpoint: "https://repfitnessco.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "rep fitness", "repfitness",
    ],
    keywords: [
      "shirt", "peak tri", "tri blend", "blend crew", "crew shirt", "peak",
      "peaks", "tri", "tris", "blend", "blends", "crew",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Represent Owners Club T-Shirt - Black Matte" — USD 57.5
    // Endpoint declared by the live profile at verification: representclo-us.myshopify.com
    merchant: "REPRESENT",
    profileHost: "representclo.com",
    brand: "REPRESENT",
    fallbackEndpoint: "https://representclo-us.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "represent",
    ],
    keywords: [
      "shirt", "owners club", "club shirt", "shirt matte", "owners", "owner",
      "club", "clubs", "shirts", "matte", "mattes", "clothing",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Ridge Apparel - The Blueprint Shirt" — USD 35
    // Endpoint declared by the live profile at verification: ridge-wallet.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Ridge",
    profileHost: "ridge.com",
    brand: "Ridge",
    fallbackEndpoint: "https://ridge-wallet.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "ridge",
    ],
    keywords: [
      "shirt", "apparel blueprint", "blueprint shirt", "apparel", "apparels",
      "blueprint", "blueprints", "shirts", "clothing",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Synbiotic+" — USD 61.36
    // Endpoint declared by the live profile at verification: mrwbcu-wt.myshopify.com
    merchant: "Ritual",
    profileHost: "ritual.com",
    brand: "Ritual",
    fallbackEndpoint: "https://mrwbcu-wt.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: [
      "ritual",
    ],
    keywords: [
      "shirt", "synbiotic", "synbiotics", "makeup", "skincare", "beauty",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "The Original Slip On Sneaker - Latte" — USD 125
    // Endpoint declared by the live profile at verification: rothys.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Rothy's",
    profileHost: "rothys.com",
    brand: "Rothy's",
    fallbackEndpoint: "https://rothys.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "rothy s", "rothys",
    ],
    keywords: [
      "shirt", "slip sneaker", "sneaker latte", "slip", "slips", "sneaker",
      "sneakers", "latte", "lattes", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Men's 'ADVENTURE' T-Shirt" — USD 14.99
    // Endpoint declared by the live profile at verification: ruffwear.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Ruffwear",
    profileHost: "ruffwear.com",
    brand: "Ruffwear",
    fallbackEndpoint: "https://ruffwear.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "ruffwear",
    ],
    keywords: [
      "shirt", "adventure shirt", "adventure", "adventures", "shirts",
      "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Original Puffy Blanket - Midnight Retro Stripes" — USD 99.95
    // Endpoint declared by the live profile at verification: gorumpl.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Rumpl",
    profileHost: "rumpl.com",
    brand: "Rumpl",
    fallbackEndpoint: "https://gorumpl.myshopify.com/api/ucp/mcp",
    category: "Home",
    brandAliases: [
      "rumpl",
    ],
    keywords: [
      "shirt", "puffy blanket", "blanket midnight", "midnight retro",
      "retro stripes", "puffy", "puffies", "blanket", "blankets", "midnight",
      "midnights", "retro",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Bento Box" — USD 35
    // Endpoint declared by the live profile at verification: swell-lifetime.myshopify.com
    merchant: "S'well",
    profileHost: "swell.com",
    brand: "S'well",
    fallbackEndpoint: "https://swell-lifetime.myshopify.com/api/ucp/mcp",
    category: "Home",
    brandAliases: [
      "s well", "swell",
    ],
    keywords: [
      "shirt", "bento box", "bento", "bentos", "box", "boxes", "home goods",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Slip Tint™ Tinted Moisturizer" — USD 38
    // Endpoint declared by the live profile at verification: saiehello.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Saie",
    profileHost: "saiehello.com",
    brand: "Saie",
    fallbackEndpoint: "https://saiehello.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: [
      "saie",
    ],
    keywords: [
      "shirt", "slip tinttm", "tinttm tinted", "tinted moisturizer", "slip",
      "slips", "tinttm", "tinttms", "tinted", "moisturizer", "moisturizers",
      "makeup",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "OntheGo™ 5-in-1 Multiport Adapter" — USD 44.99
    // Endpoint declared by the live profile at verification: satechi.myshopify.com
    merchant: "Satechi",
    profileHost: "satechi.net",
    brand: "Satechi",
    fallbackEndpoint: "https://satechi.myshopify.com/api/ucp/mcp",
    category: "Electronics",
    brandAliases: [
      "satechi",
    ],
    keywords: [
      "shirt", "onthegotm multiport", "multiport adapter", "onthegotm",
      "onthegotms", "multiport", "multiports", "adapter", "adapters",
      "electronics",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Oxford Striped Pillowcases" — USD 79
    // Endpoint declared by the live profile at verification: schoolhouse-development.myshopify.com
    merchant: "Schoolhouse",
    profileHost: "schoolhouse.com",
    brand: "Schoolhouse",
    fallbackEndpoint: "https://schoolhouse-development.myshopify.com/api/ucp/mcp",
    category: "Home",
    brandAliases: [
      "schoolhouse",
    ],
    keywords: [
      "shirt", "oxford striped", "striped pillowcases", "oxford", "oxfords",
      "striped", "pillowcases", "pillowcase", "home goods",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Lorraine Leather Flat Sandal" — USD 96.6
    // Endpoint declared by the live profile at verification: schutz.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "SCHUTZ",
    profileHost: "schutz-shoes.com",
    brand: "SCHUTZ",
    fallbackEndpoint: "https://schutz.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "schutz",
    ],
    keywords: [
      "shirt", "lorraine leather", "leather flat", "flat sandal", "lorraine",
      "lorraines", "leather", "leathers", "flat", "flats", "sandal",
      "sandals",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Ranger 26in" — USD 329.99
    // Endpoint declared by the live profile at verification: schwinnbikes.myshopify.com
    merchant: "Schwinn Bikes",
    profileHost: "schwinnbikes.com",
    brand: "Schwinn Bikes",
    fallbackEndpoint: "https://schwinnbikes.myshopify.com/api/ucp/mcp",
    category: "Sporting Goods",
    brandAliases: [
      "schwinn bikes", "schwinnbikes",
    ],
    keywords: [
      "shirt", "ranger 26in", "ranger", "rangers", "26in", "26ins", "bike",
      "bikes", "ebike", "outdoor gear",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Ultra-Sil Garment Mesh Bag" — USD 27.95
    // Endpoint declared by the live profile at verification: seatosummitusa.myshopify.com
    merchant: "Sea to Summit",
    profileHost: "seatosummit.com",
    brand: "Sea to Summit",
    fallbackEndpoint: "https://seatosummitusa.myshopify.com/api/ucp/mcp",
    category: "Luggage",
    brandAliases: [
      "sea to summit", "seatosummit",
    ],
    keywords: [
      "shirt", "sil garment", "garment mesh", "mesh bag", "sil", "sils",
      "garment", "garments", "mesh", "meshes", "bag", "bags",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Secretlab Stripe Crew" — USD 49
    // Endpoint declared by the live profile at verification: secretlabus.myshopify.com
    merchant: "Secretlab",
    profileHost: "secretlab.co",
    brand: "Secretlab",
    fallbackEndpoint: "https://secretlabus.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "secretlab",
    ],
    keywords: [
      "shirt", "stripe crew", "stripe", "stripes", "crew", "crews",
      "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Kobe Dri Fit M90 All Star Mens Short Sleeve Shirt (White)" — USD 24.97
    // Endpoint declared by the live profile at verification: shoepalace.myshopify.com
    merchant: "Shoe Palace",
    profileHost: "shoepalace.com",
    brand: "Shoe Palace",
    fallbackEndpoint: "https://shoepalace.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "shoe palace", "shoepalace",
    ],
    keywords: [
      "shirt", "kobe dri", "dri fit", "fit m90", "m90 star", "kobe", "kobes",
      "dri", "dris", "fit", "fits", "m90",
    ],
    prefixBrand: false,
  },
  {
    // Sweep-verified Nov 4, 2026: "Christopher & Banks Plaid Button Front Long Sleeve Shirt" — USD 19.99
    // Endpoint declared by the live profile at verification: 0bk0hn-tb.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "ShopHQ",
    profileHost: "shophq.com",
    brand: "ShopHQ",
    fallbackEndpoint: "https://0bk0hn-tb.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "shophq",
    ],
    keywords: [
      "shirt", "christopher banks", "banks plaid", "plaid button",
      "button front", "christopher", "christophers", "banks", "bank",
      "plaid", "plaids", "button",
    ],
    prefixBrand: false,
  },
  {
    // Sweep-verified Nov 4, 2026: "Lil Button Up Shirt ~ Field Green Gingham" — USD 28
    // Endpoint declared by the live profile at verification: showmeyourmumu.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Show Me Your Mumu",
    profileHost: "showmeyourmumu.com",
    brand: "Show Me Your Mumu",
    fallbackEndpoint: "https://showmeyourmumu.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "show me your mumu", "showmeyourmumu",
    ],
    keywords: [
      "shirt", "lil button", "button shirt", "shirt field", "field gingham",
      "lil", "lils", "button", "buttons", "shirts", "field", "fields",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Dark Chocolate Salted Caramel Bites" — USD 22.99
    // Endpoint declared by the live profile at verification: skinny-dipped.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "SkinnyDipped",
    profileHost: "skinnydipped.com",
    brand: "SkinnyDipped",
    fallbackEndpoint: "https://skinny-dipped.myshopify.com/api/ucp/mcp",
    category: "Food & Beverage",
    brandAliases: [
      "skinnydipped",
    ],
    keywords: [
      "bag", "dark chocolate", "chocolate salted", "salted caramel",
      "caramel bites", "dark", "darks", "chocolate", "chocolates", "salted",
      "caramel", "caramels",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "All Things Skratch Resort Shirt" — USD 112
    // Endpoint declared by the live profile at verification: skratchlabs.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Skratch Labs",
    profileHost: "skratchlabs.com",
    brand: "Skratch Labs",
    fallbackEndpoint: "https://skratchlabs.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "skratch labs", "skratchlabs",
    ],
    keywords: [
      "shirt", "things resort", "resort shirt", "things", "thing", "resort",
      "resorts", "shirts", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Crusher® ANC 2" — USD 239.99
    // Endpoint declared by the live profile at verification: f822a6-3.myshopify.com
    merchant: "Skullcandy",
    profileHost: "skullcandy.com",
    brand: "Skullcandy",
    fallbackEndpoint: "https://f822a6-3.myshopify.com/api/ucp/mcp",
    category: "Electronics",
    brandAliases: [
      "skullcandy",
    ],
    keywords: [
      "shirt", "crusher anc", "crusher", "crushers", "anc", "ancs",
      "electronics",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Peach Rings" — USD 3.49
    // Endpoint declared by the live profile at verification: smartsweets.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "SmartSweets",
    profileHost: "smartsweets.com",
    brand: "SmartSweets",
    fallbackEndpoint: "https://smartsweets.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "smartsweets",
    ],
    keywords: [
      "shirt", "peach rings", "peach", "peaches", "rings", "ring",
      "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Men's Merino Short Sleeve Tee" — USD 48
    // Endpoint declared by the live profile at verification: smartwool-amer.myshopify.com
    merchant: "Smartwool",
    profileHost: "smartwool.com",
    brand: "Smartwool",
    fallbackEndpoint: "https://smartwool-amer.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "smartwool",
    ],
    keywords: [
      "shirt", "merino short", "short sleeve", "sleeve tee", "merino",
      "merinos", "short", "shorts", "sleeve", "sleeves", "tee", "tees",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Wagyu Porterhouse Steak" — USD 145
    // Endpoint declared by the live profile at verification: f9c425-2.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Snake River Farms",
    profileHost: "snakeriverfarms.com",
    brand: "Snake River Farms",
    fallbackEndpoint: "https://f9c425-2.myshopify.com/api/ucp/mcp",
    category: "Food & Beverage",
    brandAliases: [
      "snake river farms", "snakeriverfarms",
    ],
    keywords: [
      "shirt", "wagyu porterhouse", "porterhouse steak", "wagyu", "wagyus",
      "porterhouse", "porterhouses", "steak", "steaks",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Anti Social Social Club Tonkatsu Fine Wind, Clear Morning Tee - White" — USD 38.5
    // Endpoint declared by the live profile at verification: sneakerpolitics.myshopify.com
    merchant: "Sneaker Politics",
    profileHost: "sneakerpolitics.com",
    brand: "Sneaker Politics",
    fallbackEndpoint: "https://sneakerpolitics.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "sneaker politics", "sneakerpolitics",
    ],
    keywords: [
      "shirt", "anti social", "social social", "social club",
      "club tonkatsu", "anti", "antis", "social", "socials", "club", "clubs",
      "tonkatsu",
    ],
    prefixBrand: false,
  },
  {
    // Sweep-verified Nov 4, 2026: "Super Soft Sweatshirt" — USD 55
    // Endpoint declared by the live profile at verification: snifco-2.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Snif",
    profileHost: "snif.co",
    brand: "Snif",
    fallbackEndpoint: "https://snifco-2.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "snif",
    ],
    keywords: [
      "shirt", "super soft", "soft sweatshirt", "super", "supers", "soft",
      "softs", "sweatshirt", "sweatshirts", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Soft Cotton Logo Short Sleeve T-Shirt" — USD 26.97
    // Endpoint declared by the live profile at verification: snow-peak-staging.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Snow Peak",
    profileHost: "snowpeak.com",
    brand: "Snow Peak",
    fallbackEndpoint: "https://snow-peak-staging.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "snow peak", "snowpeak",
    ],
    keywords: [
      "shirt", "soft cotton", "cotton logo", "logo short", "short sleeve",
      "soft", "softs", "cotton", "cottons", "logo", "logos", "short",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Percale Sheet Set" — USD 247
    // Endpoint declared by the live profile at verification: snowehome.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Snowe",
    profileHost: "snowehome.com",
    brand: "Snowe",
    fallbackEndpoint: "https://snowehome.myshopify.com/api/ucp/mcp",
    category: "Home",
    brandAliases: [
      "snowe",
    ],
    keywords: [
      "shirt", "percale sheet", "sheet set", "percale", "percales", "sheet",
      "sheets", "set", "sets", "home goods",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "WORLD TOUR T-SHIRT" — USD 65
    // Endpoint declared by the live profile at verification: social-status.myshopify.com
    merchant: "Social Status",
    profileHost: "socialstatuspgh.com",
    brand: "Social Status",
    fallbackEndpoint: "https://social-status.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "social status", "socialstatus",
    ],
    keywords: [
      "shirt", "world tour", "tour shirt", "world", "worlds", "tour",
      "tours", "shirts", "clothing", "apparel",
    ],
    prefixBrand: false,
  },
  {
    // Sweep-verified Nov 4, 2026: "FRESH PLUS" — USD 114.99
    // Endpoint declared by the live profile at verification: sodastream-usa.myshopify.com
    merchant: "SodaStream",
    profileHost: "sodastream.com",
    brand: "SodaStream",
    fallbackEndpoint: "https://sodastream-usa.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "sodastream",
    ],
    keywords: [
      "shirt", "fresh plus", "fresh", "freshes", "plus", "plu", "clothing",
      "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Avril Button Down Americana Stripe" — USD 87
    // Endpoint declared by the live profile at verification: solid-striped.myshopify.com
    merchant: "Solid and Striped",
    profileHost: "solidandstriped.com",
    brand: "Solid and Striped",
    fallbackEndpoint: "https://solid-striped.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "solid and striped", "solid striped", "solidandstriped",
    ],
    keywords: [
      "shirt", "avril button", "button down", "down americana",
      "americana stripe", "avril", "avrils", "button", "buttons", "down",
      "downs", "americana",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Authentic Tee" — USD 25
    // Endpoint declared by the live profile at verification: southernmarsh21.myshopify.com
    merchant: "Southern Marsh",
    profileHost: "southernmarsh.com",
    brand: "Southern Marsh",
    fallbackEndpoint: "https://southernmarsh21.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "southern marsh", "southernmarsh",
    ],
    keywords: [
      "shirt", "authentic tee", "authentic", "authentics", "tee", "tees",
      "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Apple Watch Series - Lite Fit" — USD 19.99
    // Endpoint declared by the live profile at verification: spigenus.myshopify.com
    merchant: "Spigen",
    profileHost: "spigen.com",
    brand: "Spigen",
    fallbackEndpoint: "https://spigenus.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "spigen",
    ],
    keywords: [
      "shirt", "apple watch", "watch series", "series lite", "lite fit",
      "apple", "apples", "watch", "watches", "series", "sery", "lite",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Critter Black Pocket T-Shirt" — USD 45
    // Endpoint declared by the live profile at verification: officialspyderco-dev.myshopify.com
    merchant: "Spyderco",
    profileHost: "spyderco.com",
    brand: "Spyderco",
    fallbackEndpoint: "https://officialspyderco-dev.myshopify.com/api/ucp/mcp",
    category: "Accessories",
    brandAliases: [
      "spyderco",
    ],
    keywords: [
      "shirt", "critter pocket", "pocket shirt", "critter", "critters",
      "pocket", "pockets", "shirts", "accessories",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Classic Fit T-Shirt \"Bright White\" 125AS254192F" — USD 46
    // Endpoint declared by the live profile at verification: stadiumgoods-qa.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Stadium Goods",
    profileHost: "stadiumgoods.com",
    brand: "Stadium Goods",
    fallbackEndpoint: "https://stadiumgoods-qa.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "stadium goods", "stadiumgoods",
    ],
    keywords: [
      "shirt", "fit shirt", "shirt bright", "bright 125as254192f", "fit",
      "fits", "shirts", "bright", "brights", "125as254192f",
      "125as254192ves", "clothing",
    ],
    prefixBrand: false,
  },
  {
    // Sweep-verified Nov 4, 2026: "The IceFlow® Flip Straw Jug | 64 OZ" — USD 60
    // Endpoint declared by the live profile at verification: stanley-pmi.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Stanley 1913",
    profileHost: "stanley1913.com",
    brand: "Stanley 1913",
    fallbackEndpoint: "https://stanley-pmi.myshopify.com/api/ucp/mcp",
    category: "Home",
    brandAliases: [
      "stanley 1913", "stanley1913",
    ],
    keywords: [
      "shirt", "iceflow flip", "flip straw", "straw jug", "iceflow",
      "iceflows", "flip", "flips", "straw", "straws", "jug", "jugs",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "\"The Springer\" Solid White" — USD 105
    // Endpoint declared by the live profile at verification: state-and-liberty-clothing-company.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "State and Liberty",
    profileHost: "stateandliberty.com",
    brand: "State and Liberty",
    fallbackEndpoint: "https://state-and-liberty-clothing-company.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "state and liberty", "state liberty", "stateandliberty",
    ],
    keywords: [
      "shirt", "springer solid", "springer", "springers", "solid", "solids",
      "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Crew Neck T Shirt | White" — USD 98
    // Endpoint declared by the live profile at verification: staud-clothing.myshopify.com
    merchant: "STAUD",
    profileHost: "staud.clothing",
    brand: "STAUD",
    fallbackEndpoint: "https://staud-clothing.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "staud",
    ],
    keywords: [
      "shirt", "crew neck", "neck shirt", "crew", "crews", "neck", "necks",
      "shirts", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Duck Duck Goose Freeze-Dried Raw Dinner Morsels for Cats" — USD 10.99
    // Endpoint declared by the live profile at verification: stella-chewys-dtc.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Stella & Chewy's",
    profileHost: "stellaandchewys.com",
    brand: "Stella & Chewy's",
    fallbackEndpoint: "https://stella-chewys-dtc.myshopify.com/api/ucp/mcp",
    category: "Pet Supplies",
    brandAliases: [
      "stella and chewy s", "stella chewy s", "stellaandchewys",
    ],
    keywords: [
      "shirt", "duck duck", "duck goose", "goose freeze", "freeze dried",
      "duck", "ducks", "goose", "gooses", "freeze", "freezes", "dried",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Roaster's Pick" — USD 23
    // Endpoint declared by the live profile at verification: stumptowncoffee.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Stumptown Coffee",
    profileHost: "stumptowncoffee.com",
    brand: "Stumptown Coffee",
    fallbackEndpoint: "https://stumptowncoffee.myshopify.com/api/ucp/mcp",
    category: "Food & Beverage",
    brandAliases: [
      "stumptown coffee", "stumptowncoffee",
    ],
    keywords: [
      "shirt", "roaster pick", "roaster", "roasters", "pick", "picks",
      "coffee",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Jet Lag Mask" — USD 49
    // Endpoint declared by the live profile at verification: summerfridaysbeauty.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Summer Fridays",
    profileHost: "summerfridays.com",
    brand: "Summer Fridays",
    fallbackEndpoint: "https://summerfridaysbeauty.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: [
      "summer fridays", "summerfridays",
    ],
    keywords: [
      "shirt", "jet lag", "lag mask", "jet", "jets", "lag", "lags", "mask",
      "masks", "makeup", "skincare", "beauty",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "The Perfect Boyfriend Shirt - White Sand" — USD 75
    // Endpoint declared by the live profile at verification: shopsummersalt.myshopify.com
    merchant: "Summersalt",
    profileHost: "summersalt.com",
    brand: "Summersalt",
    fallbackEndpoint: "https://shopsummersalt.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "summersalt",
    ],
    keywords: [
      "shirt", "perfect boyfriend", "boyfriend shirt", "shirt sand",
      "perfect", "perfects", "boyfriend", "boyfriends", "shirts", "sand",
      "sands", "clothing",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Par 3 Bamboo Golf Tees (80ct)" — USD 15
    // Endpoint declared by the live profile at verification: sundaygolfco.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Sunday Golf",
    profileHost: "sundaygolf.com",
    brand: "Sunday Golf",
    fallbackEndpoint: "https://sundaygolfco.myshopify.com/api/ucp/mcp",
    category: "Sporting Goods",
    brandAliases: [
      "sunday golf", "sundaygolf",
    ],
    keywords: [
      "shirt", "par bamboo", "bamboo tees", "tees 80ct", "par", "pars",
      "bamboo", "bamboos", "tees", "tee", "80ct", "80cts",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Heritage Shirt" — USD 75
    // Endpoint declared by the live profile at verification: lithiumcycles.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "SUPER73",
    profileHost: "super73.com",
    brand: "SUPER73",
    fallbackEndpoint: "https://lithiumcycles.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "super73",
    ],
    keywords: [
      "shirt", "heritage shirt", "heritage", "heritages", "shirts",
      "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Wear Sunscreen Tee" — USD 24
    // Endpoint declared by the live profile at verification: supergoop.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Supergoop!",
    profileHost: "supergoop.com",
    brand: "Supergoop!",
    fallbackEndpoint: "https://supergoop.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "supergoop",
    ],
    keywords: [
      "shirt", "wear sunscreen", "sunscreen tee", "wear", "wears",
      "sunscreen", "sunscreens", "tee", "tees", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "The Dewy Skin Cream" — USD 25
    // Endpoint declared by the live profile at verification: t6rvq5-fe.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Tatcha",
    profileHost: "tatcha.com",
    brand: "Tatcha",
    fallbackEndpoint: "https://t6rvq5-fe.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "tatcha",
    ],
    keywords: [
      "shirt", "dewy skin", "dewy", "dewies", "skin", "skins", "clothing",
      "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Tate’s Bake Shop T-Shirt Designed by Deanna First" — USD 30
    // Endpoint declared by the live profile at verification: k07ked-t5.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Tate's Bake Shop",
    profileHost: "tatesbakeshop.com",
    brand: "Tate's Bake Shop",
    fallbackEndpoint: "https://k07ked-t5.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "tate s bake shop", "tatesbakeshop",
    ],
    keywords: [
      "shirt", "shirt designed", "designed deanna", "deanna first", "shirts",
      "designed", "deanna", "deannas", "first", "firsts", "clothing",
      "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "The Division Shirt in Black Cherry" — USD 142
    // Endpoint declared by the live profile at verification: taylor-stitch.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Taylor Stitch",
    profileHost: "taylorstitch.com",
    brand: "Taylor Stitch",
    fallbackEndpoint: "https://taylor-stitch.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "taylor stitch", "taylorstitch",
    ],
    keywords: [
      "shirt", "division shirt", "shirt cherry", "division", "divisions",
      "shirts", "cherry", "cherries", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Flannel Button Up Shirt" — USD 19.97
    // Endpoint declared by the live profile at verification: c1ic1r-im.myshopify.com
    merchant: "Tea Collection",
    profileHost: "teacollection.com",
    brand: "Tea Collection",
    fallbackEndpoint: "https://c1ic1r-im.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "tea collection", "teacollection",
    ],
    keywords: [
      "shirt", "flannel button", "button shirt", "flannel", "flannels",
      "button", "buttons", "shirts", "tea", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Men's Standard Issue Pocket Tee" — USD 45
    // Endpoint declared by the live profile at verification: tecovas-3.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Tecovas",
    profileHost: "tecovas.com",
    brand: "Tecovas",
    fallbackEndpoint: "https://tecovas-3.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "tecovas",
    ],
    keywords: [
      "shirt", "standard issue", "issue pocket", "pocket tee", "standard",
      "standards", "issue", "issues", "pocket", "pockets", "tee", "tees",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Tactical Shirt" — USD 78
    // Endpoint declared by the live profile at verification: ten-thousand.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Ten Thousand",
    profileHost: "tenthousand.cc",
    brand: "Ten Thousand",
    fallbackEndpoint: "https://ten-thousand.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "ten thousand", "tenthousand",
    ],
    keywords: [
      "shirt", "tactical shirt", "tactical", "tacticals", "shirts",
      "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "SleepMask" — USD 109.99
    // Endpoint declared by the live profile at verification: usa-therabody.myshopify.com
    merchant: "Therabody",
    profileHost: "therabody.com",
    brand: "Therabody",
    fallbackEndpoint: "https://usa-therabody.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: [
      "therabody",
    ],
    keywords: [
      "shirt", "sleepmask", "sleepmasks", "makeup", "skincare", "beauty",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "24/7® Classic T-Shirt Bra" — USD 74
    // Endpoint declared by the live profile at verification: thirdlove.myshopify.com
    merchant: "Thirdlove",
    profileHost: "thirdlove.com",
    brand: "Thirdlove",
    fallbackEndpoint: "https://thirdlove.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "thirdlove",
    ],
    keywords: [
      "shirt", "shirt bra", "shirts", "bra", "bras", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Everyday Button-Down Shirt | Black" — USD 98
    // Endpoint declared by the live profile at verification: the-boot-company.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Thursday Boot Company",
    profileHost: "thursdayboots.com",
    brand: "Thursday Boot Company",
    fallbackEndpoint: "https://the-boot-company.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "thursday boot company", "thursdaybootcompany",
    ],
    keywords: [
      "shirt", "everyday button", "button down", "down shirt", "everyday",
      "everydays", "button", "buttons", "down", "downs", "shirts",
      "clothing",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Unisex Classic Script Oversized Tee" — USD 37.6
    // Endpoint declared by the live profile at verification: tlfapparel.myshopify.com
    merchant: "TLF Apparel",
    profileHost: "tlfapparel.com",
    brand: "TLF Apparel",
    fallbackEndpoint: "https://tlfapparel.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "tlf apparel", "tlfapparel",
    ],
    keywords: [
      "shirt", "script oversized", "oversized tee", "script", "scripts",
      "oversized", "tee", "tees", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Airsmyth Shirt" — USD 90
    // Endpoint declared by the live profile at verification: toadandco.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Toad&Co",
    profileHost: "toadandco.com",
    brand: "Toad&Co",
    fallbackEndpoint: "https://toadandco.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "toad and co", "toad co", "toadandco",
    ],
    keywords: [
      "shirt", "airsmyth shirt", "airsmyth", "airsmyths", "shirts",
      "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Second Skin Crew Neck Tee" — USD 62
    // Endpoint declared by the live profile at verification: tommyjohn.myshopify.com
    merchant: "Tommy John",
    profileHost: "tommyjohn.com",
    brand: "Tommy John",
    fallbackEndpoint: "https://tommyjohn.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "tommy john", "tommyjohn",
    ],
    keywords: [
      "shirt", "second skin", "skin crew", "crew neck", "neck tee", "second",
      "seconds", "skin", "skins", "crew", "crews", "neck",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Tonal Men's Long Sleeve Tee" — USD 80
    // Endpoint declared by the live profile at verification: 619373-09.myshopify.com
    merchant: "Tonal",
    profileHost: "tonal.com",
    brand: "Tonal",
    fallbackEndpoint: "https://619373-09.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "tonal",
    ],
    keywords: [
      "shirt", "long sleeve", "sleeve tee", "long", "longs", "sleeve",
      "sleeves", "tee", "tees", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Tee and Mo Tonie" — USD 19.99
    // Endpoint declared by the live profile at verification: tonies-us.myshopify.com
    merchant: "tonies",
    profileHost: "us.tonies.com",
    brand: "tonies",
    fallbackEndpoint: "https://tonies-us.myshopify.com/api/ucp/mcp",
    category: "Toys",
    brandAliases: [
      "tonies",
    ],
    keywords: [
      "shirt", "tee tonie", "tee", "tees", "tonie", "tonies", "toys",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "LipSoftie® Lip Treatment" — USD 16
    // Endpoint declared by the live profile at verification: trybe-beauty-inc.myshopify.com
    merchant: "Tower 28 Beauty",
    profileHost: "tower28beauty.com",
    brand: "Tower 28 Beauty",
    fallbackEndpoint: "https://trybe-beauty-inc.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: [
      "tower 28 beauty", "tower28beauty",
    ],
    keywords: [
      "shirt", "lipsoftie lip", "lip treatment", "lipsoftie", "lipsofties",
      "lip", "lips", "treatment", "treatments", "makeup", "skincare",
      "beauty",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Single Bag T" — USD 0
    // Endpoint declared by the live profile at verification: drinktrade.myshopify.com
    merchant: "Trade Coffee",
    profileHost: "drinktrade.com",
    brand: "Trade Coffee",
    fallbackEndpoint: "https://drinktrade.myshopify.com/api/ucp/mcp",
    category: "Luggage",
    brandAliases: [
      "trade coffee", "tradecoffee",
    ],
    keywords: [
      "shirt", "single bag", "single", "singles", "bag", "bags", "coffee",
      "luggage",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "TL T-Shirt" — USD 29.99
    // Endpoint declared by the live profile at verification: transparent-labs.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Transparent Labs",
    profileHost: "transparentlabs.com",
    brand: "Transparent Labs",
    fallbackEndpoint: "https://transparent-labs.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "transparent labs", "transparentlabs",
    ],
    keywords: [
      "shirt", "shirts", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Cloud Crew Tee" — USD 44.96
    // Endpoint declared by the live profile at verification: 00d268-cc.myshopify.com
    merchant: "TravisMathew",
    profileHost: "travismathew.com",
    brand: "TravisMathew",
    fallbackEndpoint: "https://00d268-cc.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "travismathew",
    ],
    keywords: [
      "shirt", "cloud crew", "crew tee", "cloud", "clouds", "crew", "crews",
      "tee", "tees", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Calvin Klein Men's Abstract Print Short Sleeve Cotton Shirt" — USD 30
    // Endpoint declared by the live profile at verification: f810ac.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Tuesday Morning",
    profileHost: "tuesdaymorning.com",
    brand: "Tuesday Morning",
    fallbackEndpoint: "https://f810ac.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "tuesday morning", "tuesdaymorning",
    ],
    keywords: [
      "shirt", "calvin klein", "klein abstract", "abstract print",
      "print short", "calvin", "calvins", "klein", "kleins", "abstract",
      "abstracts", "print",
    ],
    prefixBrand: false,
  },
  {
    // Sweep-verified Nov 4, 2026: "Really Great Cat Litter - OdorStop" — USD 29
    // Endpoint declared by the live profile at verification: tuft-paw.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Tuft & Paw",
    profileHost: "tuftandpaw.com",
    brand: "Tuft & Paw",
    fallbackEndpoint: "https://tuft-paw.myshopify.com/api/ucp/mcp",
    category: "Pet Supplies",
    brandAliases: [
      "tuft and paw", "tuft paw", "tuftandpaw",
    ],
    keywords: [
      "shirt", "really great", "great cat", "cat litter", "litter odorstop",
      "really", "reallies", "great", "greats", "cat", "cats", "litter",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "T&N Original Mattress" — USD 399
    // Endpoint declared by the live profile at verification: tuftandneedle-production.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Tuft and Needle",
    profileHost: "tuftandneedle.com",
    brand: "Tuft and Needle",
    fallbackEndpoint: "https://tuftandneedle-production.myshopify.com/api/ucp/mcp",
    category: "Furniture",
    brandAliases: [
      "tuft and needle", "tuft needle", "tuftandneedle",
    ],
    keywords: [
      "shirt", "mattress", "furniture",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "PlugBug Find My 120W Travel" — USD 129.99
    // Endpoint declared by the live profile at verification: twelvesouth.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Twelve South",
    profileHost: "twelvesouth.com",
    brand: "Twelve South",
    fallbackEndpoint: "https://twelvesouth.myshopify.com/api/ucp/mcp",
    category: "Electronics",
    brandAliases: [
      "twelve south", "twelvesouth",
    ],
    keywords: [
      "shirt", "plugbug find", "find 120w", "120w travel", "plugbug",
      "plugbugs", "find", "finds", "120w", "120ws", "travel", "travels",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Men's Merino Crew Neck T-Shirt" — USD 68
    // Endpoint declared by the live profile at verification: unbound-merino.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Unbound Merino",
    profileHost: "unboundmerino.com",
    brand: "Unbound Merino",
    fallbackEndpoint: "https://unbound-merino.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "unbound merino", "unboundmerino",
    ],
    keywords: [
      "shirt", "crew neck", "neck shirt", "crew", "crews", "neck", "necks",
      "shirts", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "UNDEFEATED OUTLINED S/S TEE" — USD 45
    // Endpoint declared by the live profile at verification: undefeated.myshopify.com
    merchant: "Undefeated",
    profileHost: "undefeated.com",
    brand: "Undefeated",
    fallbackEndpoint: "https://undefeated.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "undefeated",
    ],
    keywords: [
      "shirt", "outlined tee", "outlined", "tee", "tees", "clothing",
      "apparel",
    ],
    prefixBrand: false,
  },
  {
    // Sweep-verified Nov 4, 2026: "Minimalist Stretch Cotton Chambray Shirt - Vintage Indigo" — USD 158
    // Endpoint declared by the live profile at verification: universal-standard.myshopify.com
    merchant: "Universal Standard",
    profileHost: "universalstandard.com",
    brand: "Universal Standard",
    fallbackEndpoint: "https://universal-standard.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "universal standard", "universalstandard",
    ],
    keywords: [
      "shirt", "minimalist stretch", "stretch cotton", "cotton chambray",
      "chambray shirt", "minimalist", "minimalists", "stretch", "stretches",
      "cotton", "cottons", "chambray",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Velvet Caviar Crewneck" — USD 48
    // Endpoint declared by the live profile at verification: velvet-caviar.myshopify.com
    merchant: "Velvet Caviar",
    profileHost: "velvetcaviar.com",
    brand: "Velvet Caviar",
    fallbackEndpoint: "https://velvet-caviar.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "velvet caviar", "velvetcaviar",
    ],
    keywords: [
      "shirt", "crewneck", "crewnecks", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Verb T-Shirt" — USD 10.5
    // Endpoint declared by the live profile at verification: verbhaircare.myshopify.com
    merchant: "Verb Products",
    profileHost: "verbproducts.com",
    brand: "Verb Products",
    fallbackEndpoint: "https://verbhaircare.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "verb products", "verbproducts",
    ],
    keywords: [
      "shirt", "shirts", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: profile 200 + catalog.search answered
    // (the sweep's sample listing was a store service, not a product)
    // Endpoint declared by the live profile at verification: vince-camuto-store.myshopify.com
    merchant: "Vince Camuto",
    profileHost: "vincecamuto.com",
    brand: "Vince Camuto",
    fallbackEndpoint: "https://vince-camuto-store.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "vince camuto", "vincecamuto",
    ],
    keywords: [
      "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Collagen Peptides Advanced - with Hyaluronic Acid & Vitamin C" — USD 29.99
    // Endpoint declared by the live profile at verification: vital-proteins.myshopify.com
    merchant: "Vital Proteins",
    profileHost: "vitalproteins.com",
    brand: "Vital Proteins",
    fallbackEndpoint: "https://vital-proteins.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: [
      "vital proteins", "vitalproteins",
    ],
    keywords: [
      "shirt", "collagen peptides", "peptides advanced",
      "advanced hyaluronic", "hyaluronic acid", "collagen", "collagens",
      "peptides", "peptide", "advanced", "hyaluronic", "hyaluronics",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Noble Fir Garland - 5 Wick Hearth Candle" — USD 275
    // Endpoint declared by the live profile at verification: voluspa-us.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Voluspa",
    profileHost: "voluspa.com",
    brand: "Voluspa",
    fallbackEndpoint: "https://voluspa-us.myshopify.com/api/ucp/mcp",
    category: "Home",
    brandAliases: [
      "voluspa",
    ],
    keywords: [
      "shirt", "noble fir", "fir garland", "garland wick", "wick hearth",
      "noble", "nobles", "fir", "firs", "garland", "garlands", "wick",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "20-Slot Knife Case" — USD 140
    // Endpoint declared by the live profile at verification: wusthof.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "WÜSTHOF",
    profileHost: "wusthof.com",
    brand: "WÜSTHOF",
    fallbackEndpoint: "https://wusthof.myshopify.com/api/ucp/mcp",
    category: "Kitchen",
    brandAliases: [
      "w sthof", "wsthof", "wusthof",
    ],
    keywords: [
      "bag", "slot knife", "knife case", "slot", "slots", "knife", "knives",
      "case", "cases", "kitchen", "cookware",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "All Rig No Gig Shirt" — USD 29
    // Endpoint declared by the live profile at verification: walrus-audio-2.myshopify.com
    merchant: "Walrus Audio",
    profileHost: "walrusaudio.com",
    brand: "Walrus Audio",
    fallbackEndpoint: "https://walrus-audio-2.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "walrus audio", "walrusaudio",
    ],
    keywords: [
      "shirt", "rig gig", "gig shirt", "rig", "rigs", "gig", "gigs",
      "shirts", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Skin Activator Serum" — USD 125
    // Endpoint declared by the live profile at verification: westman-atelier.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Westman Atelier",
    profileHost: "westman-atelier.com",
    brand: "Westman Atelier",
    fallbackEndpoint: "https://westman-atelier.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: [
      "westman atelier", "westmanatelier",
    ],
    keywords: [
      "shirt", "skin activator", "activator serum", "skin", "skins",
      "activator", "activators", "serum", "serums", "makeup", "skincare",
      "beauty",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Megalast Lock 'N' Shine Lip Color + Gloss | Pinky Promise" — USD 6.49
    // Endpoint declared by the live profile at verification: markwins-wnw.myshopify.com
    merchant: "wet n wild Beauty",
    profileHost: "wetnwildbeauty.com",
    brand: "wet n wild Beauty",
    fallbackEndpoint: "https://markwins-wnw.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: [
      "wet n wild beauty", "wetnwildbeauty",
    ],
    keywords: [
      "shirt", "megalast lock", "lock shine", "shine lip", "lip color",
      "megalast", "megalasts", "lock", "locks", "shine", "shines", "lip",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Take Another Chance Oversized Tee Black" — USD 49.99
    // Endpoint declared by the live profile at verification: white-fox-boutique-usa.myshopify.com
    merchant: "White Fox Boutique",
    profileHost: "whitefoxboutique.com",
    brand: "White Fox Boutique",
    fallbackEndpoint: "https://white-fox-boutique-usa.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "white fox boutique", "whitefoxboutique",
    ],
    keywords: [
      "shirt", "take another", "another chance", "chance oversized",
      "oversized tee", "take", "takes", "another", "anothers", "chance",
      "chances", "oversized",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Waterproof Dog Collar" — USD 35
    // Endpoint declared by the live profile at verification: wildonepets.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Wild One",
    profileHost: "wildone.com",
    brand: "Wild One",
    fallbackEndpoint: "https://wildonepets.myshopify.com/api/ucp/mcp",
    category: "Pet Supplies",
    brandAliases: [
      "wild one", "wildone",
    ],
    keywords: [
      "shirt", "waterproof dog", "dog collar", "waterproof", "waterprooves",
      "dog", "dogs", "collar", "collars", "pet supplies",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Charli XCX iPhone Case" — USD 18.5
    // Endpoint declared by the live profile at verification: wildflower-3.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Wildflower Cases",
    profileHost: "wildflowercases.com",
    brand: "Wildflower Cases",
    fallbackEndpoint: "https://wildflower-3.myshopify.com/api/ucp/mcp",
    category: "Electronics",
    brandAliases: [
      "wildflower cases", "wildflowercases",
    ],
    keywords: [
      "shirt", "charli xcx", "xcx iphone", "iphone case", "charli",
      "charlis", "xcx", "xcxes", "iphone", "iphones", "case", "cases",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Sleep" — USD 199.95
    // Endpoint declared by the live profile at verification: 0e1fdz-w5.myshopify.com
    merchant: "Withings",
    profileHost: "withings.com",
    brand: "Withings",
    fallbackEndpoint: "https://0e1fdz-w5.myshopify.com/api/ucp/mcp",
    category: "Beauty",
    brandAliases: [
      "withings",
    ],
    keywords: [
      "shirt", "sleep", "sleeps", "makeup", "skincare", "beauty",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "130 Button-Down Shirt" — USD 158
    // Endpoint declared by the live profile at verification: wptest.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Wool&Prince",
    profileHost: "woolandprince.com",
    brand: "Wool&Prince",
    fallbackEndpoint: "https://wptest.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "wool and prince", "wool prince", "woolandprince",
    ],
    keywords: [
      "shirt", "button down", "down shirt", "button", "buttons", "down",
      "downs", "shirts", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Move on Groove on - 7-Inch Single" — USD 19.99
    // Endpoint declared by the live profile at verification: worldwidestereo.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "World Wide Stereo",
    profileHost: "worldwidestereo.com",
    brand: "World Wide Stereo",
    fallbackEndpoint: "https://worldwidestereo.myshopify.com/api/ucp/mcp",
    category: "Media",
    brandAliases: [
      "world wide stereo", "worldwidestereo",
    ],
    keywords: [
      "shirt", "move groove", "groove single", "move", "moves", "groove",
      "grooves", "single", "singles",
    ],
    prefixBrand: false,
  },
  {
    // Sweep-verified Nov 4, 2026: "Wyze Hoodie - Black" — USD 32
    // Endpoint declared by the live profile at verification: wyzecom.myshopify.com
    merchant: "Wyze",
    profileHost: "wyze.com",
    brand: "Wyze",
    fallbackEndpoint: "https://wyzecom.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "wyze",
    ],
    keywords: [
      "shirt", "hoodie", "hoodies", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Xero T-Shirts" — USD 19.95
    // Endpoint declared by the live profile at verification: shopxeroshoes.myshopify.com
    merchant: "Xero Shoes",
    profileHost: "xeroshoes.com",
    brand: "Xero Shoes",
    fallbackEndpoint: "https://shopxeroshoes.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "xero shoes", "xeroshoes",
    ],
    keywords: [
      "shirt", "shirts", "shoes", "footwear", "clothing", "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Let's Move On Vacation" — USD 29.99
    // Endpoint declared by the live profile at verification: yoto-usa.myshopify.com
    merchant: "Yoto",
    profileHost: "yotoplay.com",
    brand: "Yoto",
    fallbackEndpoint: "https://yoto-usa.myshopify.com/api/ucp/mcp",
    category: "Media",
    brandAliases: [
      "yoto",
    ],
    keywords: [
      "shirt", "let move", "move vacation", "let", "lets", "move", "moves",
      "vacation", "vacations",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "466 Tailored Tees" — USD 36
    // Endpoint declared by the live profile at verification: youngla.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "YoungLA",
    profileHost: "youngla.com",
    brand: "YoungLA",
    fallbackEndpoint: "https://youngla.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "youngla",
    ],
    keywords: [
      "shirt", "tailored tees", "tailored", "tees", "tee", "clothing",
      "apparel",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Glass Elite Anti-Glare Screen Protector" — USD 44.99
    // Endpoint declared by the live profile at verification: zagg-2640.myshopify.com
    merchant: "ZAGG",
    profileHost: "zagg.com",
    brand: "ZAGG",
    fallbackEndpoint: "https://zagg-2640.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "zagg",
    ],
    keywords: [
      "shirt", "glass elite", "elite anti", "anti glare", "glare screen",
      "glass", "elite", "elites", "anti", "antis", "glare", "glares",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "Senior Advanced 11-in-1 Multivitamin Bites for Senior Dogs" — USD 42.97
    // Endpoint declared by the live profile at verification: zesty-paws.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Zesty Paws",
    profileHost: "zestypaws.com",
    brand: "Zesty Paws",
    fallbackEndpoint: "https://zesty-paws.myshopify.com/api/ucp/mcp",
    category: "Pet Supplies",
    brandAliases: [
      "zesty paws", "zestypaws",
    ],
    keywords: [
      "shirt", "senior advanced", "advanced multivitamin",
      "multivitamin bites", "bites senior", "senior", "seniors", "advanced",
      "multivitamin", "multivitamins", "bites", "bite",
    ],
    prefixBrand: true,
  },
  {
    // Sweep-verified Nov 4, 2026: "adidas Men's 3-Stripes T-Shirt" — USD 20.99
    // Endpoint declared by the live profile at verification: lyons-group.myshopify.com
    // Terms: bans bots generally — UCP-only, not authorized in the terms
    merchant: "Zulily",
    profileHost: "zulily.com",
    brand: "Zulily",
    fallbackEndpoint: "https://lyons-group.myshopify.com/api/ucp/mcp",
    category: "Apparel",
    brandAliases: [
      "zulily",
    ],
    keywords: [
      "shirt", "adidas stripes", "stripes shirt", "adidas", "adida",
      "stripes", "stripe", "shirts", "clothing", "apparel",
    ],
    prefixBrand: false,
  },
];

/** Registry lookup by merchant display name (checkout routing). */
export function findUcpStore(merchant: string): UcpStore | undefined {
  return UCP_STORES.find((store) => store.merchant === merchant);
}

const MAX_UCP_STORES_PER_QUERY = 4;

/**
 * Route a shopper query to the UCP stores whose assortment it matches:
 * a brand mention always routes to that store; otherwise assortment
 * keywords decide. Stores the policy registry does not clear for the
 * UCP route are never selected.
 */
export function selectUcpStores(query: string): UcpStore[] {
  if (!ucpEnabled()) return [];
  const normalized = ` ${normalizeSearch(query)} `;
  const matches = (phrase: string) => normalized.includes(` ${phrase} `);
  const cleared = UCP_STORES.filter((store) => {
    const policy = getMerchantPolicy(store.merchant);
    return (
      policy.status === "ucp-authorized-channel" &&
      policy.allowedAcquisitionMethods.includes("api")
    );
  });
  // Brand-named queries route to the named store FIRST: a single pass
  // in registry order lets generic assortment keywords from earlier
  // stores fill the per-query cap before a named brand's own store is
  // reached (e.g. "arhaus sofa" selected four other furniture stores
  // and never Arhaus, which sits last in the registry).
  const brandMatches = cleared.filter((store) =>
    store.brandAliases.some(matches),
  );
  const keywordMatches = cleared.filter(
    (store) =>
      !brandMatches.includes(store) && store.keywords.some(matches),
  );
  return [...brandMatches, ...keywordMatches].slice(
    0,
    MAX_UCP_STORES_PER_QUERY,
  );
}

/* ------------------------------------------------------------------ */
/* HTTP + MCP plumbing (productized from scripts/fetch-ucp-offers.mjs) */
/* ------------------------------------------------------------------ */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
  } finally {
    clearTimeout(timer);
  }
}

interface McpMessage {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
}

function parseMcpBody(text: string, wantId?: number): McpMessage | null {
  try {
    return JSON.parse(text) as McpMessage;
  } catch {
    /* fall through to SSE scanning */
  }
  let fallback: McpMessage | null = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    try {
      const message = JSON.parse(trimmed.slice(5).trim()) as McpMessage;
      if (message && typeof message === "object") {
        if (wantId !== undefined && message.id === wantId) return message;
        fallback = message;
      }
    } catch {
      /* keep scanning */
    }
  }
  return fallback;
}

export async function mcpPost(
  endpoint: string,
  sessionId: string | null,
  payload: Record<string, unknown> & { id?: number },
  timeoutMs: number,
): Promise<{ status: number; sessionId: string | null; message: McpMessage | null }> {
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const response = await fetchWithTimeout(
    endpoint,
    { method: "POST", headers, body: JSON.stringify(payload) },
    timeoutMs,
  );
  const text = await response.text();
  return {
    status: response.status,
    sessionId: response.headers.get("mcp-session-id") ?? sessionId,
    message: text ? parseMcpBody(text, payload.id) : null,
  };
}

/** Read the store's published profile; returns the MCP endpoint it declares. */
export async function readProfileEndpoint(store: UcpStore): Promise<{
  endpoint: string;
  ucpVersion: string | null;
}> {
  const profileUrl = `https://${store.profileHost}/.well-known/ucp`;
  try {
    const response = await fetchWithTimeout(
      profileUrl,
      {
        method: "GET",
        redirect: "follow",
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      },
      PROFILE_TIMEOUT_MS,
    );
    if (response.status === 200) {
      const json = (await response.json()) as {
        ucp?: {
          version?: string;
          capabilities?: Record<string, unknown>;
          services?: Record<string, { endpoint?: string; transport?: string }[]>;
        };
      };
      const ucp = json?.ucp;
      if (ucp?.services && typeof ucp.services === "object") {
        const catalogDeclared =
          !ucp.capabilities || CATALOG_SEARCH_CAP in ucp.capabilities;
        const bindings: { service: string; endpoint?: string; transport?: string }[] = [];
        for (const [service, list] of Object.entries(ucp.services)) {
          if (!Array.isArray(list)) continue;
          for (const binding of list) bindings.push({ service, ...binding });
        }
        const shopping = bindings.filter((b) => b.service === "dev.ucp.shopping");
        const pool = shopping.length > 0 ? shopping : bindings;
        const mcp = pool.find((b) => b.transport === "mcp" && b.endpoint);
        if (mcp?.endpoint && catalogDeclared) {
          return {
            endpoint: mcp.endpoint,
            ucpVersion: typeof ucp.version === "string" ? ucp.version : null,
          };
        }
      }
    }
  } catch {
    /* profile unreachable — fall back to the last verified endpoint */
  }
  return { endpoint: store.fallbackEndpoint, ucpVersion: null };
}

/* ------------------------------------------------------------------ */
/* Catalog products                                                    */
/* ------------------------------------------------------------------ */

export interface UcpProduct {
  title: string;
  /**
   * The store's own listing description from the catalog payload,
   * cleaned to plain text (lib/description.ts). Null when the payload
   * carried none for this product.
   */
  description: string | null;
  /** Major-unit price (e.g. dollars), converted from UCP minor units. */
  price: number;
  currency: string;
  url: string | null;
  imageUrl: string | null;
  available: boolean | null;
  /** Store product id (Shopify gid tail) — stable per product. */
  productKey: string;
  /**
   * The purchasable item id for checkout line items: the gid of the
   * variant whose price this product carries (the product's own gid
   * only when the catalog returned no variant ids).
   */
  itemId: string | null;
  /** Title of that variant (e.g. a color), when the catalog gave one. */
  variantTitle: string | null;
}

const CURRENCY_EXPONENTS: Record<string, number> = {
  JPY: 0, KRW: 0, VND: 0, BHD: 3, JOD: 3, KWD: 3, OMR: 3, TND: 3,
};

export function moneyFromMinor(amount: number, currency: string): number {
  const exponent = CURRENCY_EXPONENTS[currency] ?? 2;
  return amount / 10 ** exponent;
}

interface RawUcpVariant {
  id?: string;
  title?: string;
  price?: { amount?: number; currency?: string };
  availability?: { available?: boolean };
  media?: { type?: string; url?: string }[];
}

interface RawUcpProduct {
  id?: string;
  title?: string;
  /** UCP carries the description as an object ({ html }); a plain
   *  string is also accepted defensively. */
  description?: string | { html?: string } | null;
  url?: string;
  price_range?: {
    min?: { amount?: number; currency?: string };
    max?: { amount?: number; currency?: string };
  };
  variants?: RawUcpVariant[];
  media?: { type?: string; url?: string }[];
}

function normalizeUcpProduct(raw: RawUcpProduct): UcpProduct | null {
  if (!raw || typeof raw.title !== "string" || !raw.title) return null;
  const variants = Array.isArray(raw.variants) ? raw.variants : [];
  const availablePriced = variants.find(
    (v) =>
      typeof v?.price?.amount === "number" &&
      v.price.currency === "USD" &&
      v.availability?.available === true,
  );
  const anyPriced = variants.find(
    (v) => typeof v?.price?.amount === "number" && v.price.currency === "USD",
  );
  let price: number | null = null;
  const pricedVariant = availablePriced ?? anyPriced;
  if (availablePriced?.price?.amount != null) {
    price = moneyFromMinor(availablePriced.price.amount, "USD");
  } else if (anyPriced?.price?.amount != null) {
    price = moneyFromMinor(anyPriced.price.amount, "USD");
  } else if (
    typeof raw.price_range?.min?.amount === "number" &&
    raw.price_range.min.currency === "USD"
  ) {
    price = moneyFromMinor(raw.price_range.min.amount, "USD");
  }
  if (price == null || price <= 0) return null;
  // The checkout item is the variant whose price is shown; fall back to
  // any variant id the catalog returned, then the product's own id.
  const itemId =
    (typeof pricedVariant?.id === "string" ? pricedVariant.id : null) ??
    variants.find((v) => typeof v?.id === "string")?.id ??
    (typeof raw.id === "string" ? raw.id : null);
  const variantTitle =
    typeof pricedVariant?.title === "string" ? pricedVariant.title : null;

  let available: boolean | null = null;
  if (variants.length > 0) {
    available = variants.some((v) => v?.availability?.available === true);
  }
  if (available === false) return null; // out of stock: not an offer

  const imageUrl =
    raw.media?.find((m) => m.type === "image" && m.url)?.url ??
    variants[0]?.media?.find((m) => m.type === "image" && m.url)?.url ??
    null;
  const productKey =
    (typeof raw.id === "string" ? raw.id.split("/").pop() : null) ??
    raw.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");

  // The product-level description is the store's listing text (the
  // priced variant repeats the same text). Cleaned, never rewritten.
  const rawDescription =
    typeof raw.description === "string"
      ? raw.description
      : typeof raw.description?.html === "string"
        ? raw.description.html
        : null;

  return {
    title: raw.title,
    description: cleanDescription(rawDescription),
    price,
    currency: "USD",
    url: typeof raw.url === "string" ? raw.url : null,
    imageUrl,
    available,
    productKey,
    itemId,
    variantTitle,
  };
}

function extractUcpProducts(result: Record<string, unknown>): UcpProduct[] {
  let payload = (result?.structuredContent as Record<string, unknown>) ?? null;
  if (!payload) {
    for (const block of (result?.content as { type?: string; text?: string }[]) ?? []) {
      if (block?.type === "text" && typeof block.text === "string") {
        try {
          payload = JSON.parse(block.text) as Record<string, unknown>;
          break;
        } catch {
          /* keep looking */
        }
      }
    }
  }
  const list = (payload?.products ?? payload?.items ?? payload?.results) as
    | RawUcpProduct[]
    | undefined;
  if (!Array.isArray(list)) return [];
  return list.map(normalizeUcpProduct).filter((p): p is UcpProduct => p !== null);
}

/* ------------------------------------------------------------------ */
/* Session state — handshake reuse, never catalog data                 */
/* ------------------------------------------------------------------ */

/** Which optional argument groups the discovered tool's schema declares. */
interface UcpToolShape {
  catalog: boolean;
  query: boolean;
  pagination: boolean;
  limit: boolean;
  context: boolean;
}

interface UcpSession {
  endpoint: string;
  sessionId: string | null;
  toolName: string;
  shape: UcpToolShape;
  expiresAt: number;
}

/** Resolved sessions by profile host. Handshake state only — see the
 *  SESSION_CACHE_TTL_MS note above. In-memory per server instance. */
const sessionCache = new Map<string, UcpSession>();
/** In-flight establishments, so concurrent queries share one handshake. */
const sessionInflight = new Map<string, Promise<UcpSession | null>>();

function getCachedSession(store: UcpStore): UcpSession | null {
  const session = sessionCache.get(store.profileHost);
  if (!session) return null;
  if (Date.now() >= session.expiresAt) {
    sessionCache.delete(store.profileHost);
    return null;
  }
  return session;
}

/**
 * Run the full protocol flow's discovery half for one store, live:
 * read the store's live profile, MCP initialize handshake,
 * tools/list discovery (the catalog tool is found in the server's own
 * tool list, never hardcoded). On success the resolved session is
 * cached for SESSION_CACHE_TTL_MS. Returns null when the store does
 * not answer or declares no catalog tool.
 */
async function establishSessionInner(store: UcpStore): Promise<UcpSession | null> {
  const { endpoint } = await readProfileEndpoint(store);

  // MCP initialize handshake (one timeout retry — Shopify endpoints
  // have been observed to stall a cold first request, POC Oct 30).
  const initializeOnce = () =>
    mcpPost(
      endpoint,
      null,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: {
            name: "NotDeliveredInTheBlueTruck UCP client",
            version: "0.1.0",
          },
        },
      },
      HANDSHAKE_TIMEOUT_MS,
    );
  let sessionId: string | null = null;
  try {
    let init;
    try {
      init = await initializeOnce();
    } catch (error) {
      if ((error as Error)?.name !== "AbortError") throw error;
      await sleep(2_000);
      init = await initializeOnce();
    }
    sessionId = init.sessionId;
    if (init.message?.result) {
      // Protocol courtesy notification. It is given a short grace
      // window only: a slow notification acknowledgement must never
      // stall discovery (probing, Nov 2 2026, showed these endpoints
      // answer catalog calls even with no handshake at all).
      const notification = mcpPost(
        endpoint,
        sessionId,
        { jsonrpc: "2.0", method: "notifications/initialized" },
        HANDSHAKE_TIMEOUT_MS,
      ).catch(() => null);
      await Promise.race([notification, sleep(2_000)]);
    }
  } catch {
    /* stateless fallback: proceed to tools/list without a session */
  }

  // Tool discovery — the catalog tool comes from the server's list.
  const list = await mcpPost(
    endpoint,
    sessionId,
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    HANDSHAKE_TIMEOUT_MS,
  );
  sessionId = list.sessionId ?? sessionId;
  const tools = (
    list.message?.result as { tools?: { name: string; inputSchema?: { properties?: Record<string, unknown> } }[] }
  )?.tools;
  if (!Array.isArray(tools)) return null;
  const searchTool =
    tools.find((t) => t.name === "search_catalog") ??
    tools.find((t) => /catalog/i.test(t.name) && /search/i.test(t.name)) ??
    tools.find((t) => /search/i.test(t.name) && !/lookup/i.test(t.name)) ??
    null;
  if (!searchTool) return null;

  // Argument shape follows the tool's own inputSchema.
  const schemaProps = searchTool.inputSchema?.properties ?? {};
  const session: UcpSession = {
    endpoint,
    sessionId,
    toolName: searchTool.name,
    shape: {
      catalog: "catalog" in schemaProps,
      query: "query" in schemaProps,
      pagination: "pagination" in schemaProps,
      limit: "limit" in schemaProps,
      context: "context" in schemaProps,
    },
    expiresAt: Date.now() + SESSION_CACHE_TTL_MS,
  };
  sessionCache.set(store.profileHost, session);
  return session;
}

function establishSession(store: UcpStore): Promise<UcpSession | null> {
  const existing = sessionInflight.get(store.profileHost);
  if (existing) return existing;
  const promise = establishSessionInner(store)
    .catch(() => null)
    .finally(() => {
      sessionInflight.delete(store.profileHost);
    });
  sessionInflight.set(store.profileHost, promise);
  return promise;
}

/** Build the catalog-call arguments from the tool's discovered shape. */
function buildCatalogArgs(
  shape: UcpToolShape,
  query: string,
): Record<string, unknown> {
  const args: Record<string, unknown> = {
    meta: { "ucp-agent": { profile: AGENT_PROFILE } },
  };
  if (shape.catalog) {
    args.catalog = { query, pagination: { limit: CATALOG_LIMIT } };
  } else if (shape.query) {
    args.query = query;
    if (shape.pagination) args.pagination = { limit: CATALOG_LIMIT };
    if (shape.limit) args.limit = CATALOG_LIMIT;
  } else {
    args.catalog = { query, pagination: { limit: CATALOG_LIMIT } };
  }
  if (shape.context) {
    args.context = { address_country: "US", currency: "USD" };
  }
  return args;
}

/**
 * One LIVE catalog call on an established session. `ok: false` marks a
 * failed call (transport, HTTP, protocol error, error result) — as
 * opposed to a successful call that honestly matched nothing, which is
 * `ok: true` with an empty product list.
 */
async function callCatalog(
  session: UcpSession,
  query: string,
): Promise<{ ok: boolean; products: UcpProduct[] }> {
  let call;
  try {
    call = await mcpPost(
      session.endpoint,
      session.sessionId,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: session.toolName,
          arguments: buildCatalogArgs(session.shape, query),
        },
      },
      CATALOG_TIMEOUT_MS,
    );
  } catch {
    return { ok: false, products: [] };
  }
  if (call.sessionId) session.sessionId = call.sessionId;
  if (call.status >= 400) return { ok: false, products: [] };
  if (!call.message?.result || call.message.error) {
    return { ok: false, products: [] };
  }
  const result = call.message.result;
  if ((result as { isError?: boolean }).isError) {
    return { ok: false, products: [] };
  }
  return { ok: true, products: extractUcpProducts(result) };
}

/* ------------------------------------------------------------------ */
/* One live catalog search against one store                           */
/* ------------------------------------------------------------------ */

/**
 * Search one store's catalog for `query`, live, in this request.
 * Returns the priced products the store's catalog returned — [] on
 * any failure (profile, handshake, discovery, or catalog). Never
 * throws, never serves stored data, never invents.
 *
 * Fast path: a session resolved within SESSION_CACHE_TTL_MS (endpoint,
 * session id, discovered tool — handshake state only) makes this a
 * single live catalog call. Any fast-path failure discards the cached
 * session and re-runs the full discovery flow inside this request
 * before calling again, exactly as every request behaved before the
 * cache existed.
 */
export async function searchUcpStore(
  store: UcpStore,
  query: string,
): Promise<UcpProduct[]> {
  try {
    const cached = getCachedSession(store);
    if (cached) {
      const hot = await callCatalog(cached, query);
      if (hot.ok) return hot.products;
      sessionCache.delete(store.profileHost);
    }
    const session = await establishSession(store);
    if (!session) return [];
    const cold = await callCatalog(session, query);
    return cold.ok ? cold.products : [];
  } catch (error) {
    console.warn(
      `[ucp] ${store.merchant} catalog search failed:`,
      String(error),
    );
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Offer construction                                                  */
/* ------------------------------------------------------------------ */

/**
 * Build an Offer from one live UCP catalog product. The price is the
 * merchant's own live figure; fields the catalog does not state use
 * the labelled curated/service estimates documented at the top of
 * this file and disclosed again in the provenance note.
 */
export function buildUcpOffer(
  store: UcpStore,
  product: UcpProduct,
  retrievedAt: string,
): Offer {
  return {
    id: `ucp-${store.profileHost.replace(/[^a-z0-9]+/gi, "-")}-${product.productKey}`,
    merchant: store.merchant,
    seller: store.merchant,
    channel: store.merchant,
    condition: "New",
    price: product.price,
    shippingCost: 0,
    deliveryDays: SERVICE_DELIVERY_DAYS,
    deliveryBasis: "Sample shipping-service estimate",
    returnWindowDays: null,
    returnCost: "not-stated",
    returnPolicySource: "Not stated by seller",
    warrantyMonths: 0,
    sellerRating: 0,
    checkoutItemId: product.itemId,
    description: product.description,
    sampleListingLabel: `Live ${store.merchant} UCP listing`,
    provenance: {
      sourceMerchant: store.merchant,
      acquisitionMethod: "api",
      sourceUrl: product.url,
      retrievedAt,
      policyStatus: "ucp-public-profile",
      policyNote:
        `Live price retrieved ${retrievedAt} from ${store.merchant}'s published UCP profile ` +
        `(https://${store.profileHost}/.well-known/ucp) — the merchant's own authorized agent ` +
        `channel — via its declared MCP catalog (catalog.search, tool discovered by MCP ` +
        `tools/list after an initialize handshake; the search itself is a public catalog ` +
        `read and creates no cart or checkout — a checkout session is created only when the ` +
        `buyer starts checkout, over this same published profile). The price is the ` +
        `merchant's own live figure. The UCP catalog does not state ` +
        `a shipping charge (shipping is calculated by the merchant at checkout and is not ` +
        `included in the total), a delivery estimate (a ${SERVICE_DELIVERY_DAYS}-day standard ` +
        `ground service estimate is used for scoring), return terms (none are stated, so ` +
        `returns are shown as "Not stated by seller" — the merchant's own published ` +
        `policy, on its site, governs), a warranty period, or a seller rating — this is the merchant's own ` +
        `first-party store. Nothing here is stored: the price was fetched in this request.`,
    },
  };
}
