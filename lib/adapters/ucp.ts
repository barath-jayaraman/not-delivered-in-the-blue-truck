import { getMerchantPolicy } from "../adapters";
import { normalizeSearch } from "../data";
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
 * What the UCP catalog does NOT state (verified from live responses,
 * Oct 31, 2026): shipping charges, delivery estimates, return terms,
 * warranty, seller ratings. Following the codebase's existing pattern
 * for API gaps (cf. the curated eBay return pattern and the Best Buy
 * shipping-service estimate in lib/adapters.ts), those Offer fields use
 * clearly labelled curated/service estimates, disclosed in every
 * offer's provenance note:
 * - shippingCost 0 means "not stated by the catalog — calculated by the
 *   merchant at checkout", NOT free shipping (lib/scoring.ts does not
 *   attach its "Free shipping" flag to UCP offers);
 * - deliveryDays is a standard ground service-level estimate;
 * - return terms are a conservative curated pattern (30 days,
 *   buyer-paid), not the merchant's stated policy;
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

/** Curated/service estimates for fields the UCP catalog does not state. */
const SERVICE_DELIVERY_DAYS = 5;
const CURATED_RETURN_WINDOW_DAYS = 30;

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

  return {
    title: raw.title,
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
    returnWindowDays: CURATED_RETURN_WINDOW_DAYS,
    returnCost: "buyer-paid",
    returnPolicySource: "Curated retailer-policy sample",
    warrantyMonths: 0,
    sellerRating: 0,
    checkoutItemId: product.itemId,
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
        `ground service estimate is used for scoring), return terms (a conservative curated ` +
        `${CURATED_RETURN_WINDOW_DAYS}-day buyer-paid pattern is shown, not the merchant's ` +
        `stated policy), a warranty period, or a seller rating — this is the merchant's own ` +
        `first-party store. Nothing here is stored: the price was fetched in this request.`,
    },
  };
}
