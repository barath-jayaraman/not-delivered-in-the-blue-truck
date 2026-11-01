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
 * these merchants "ucp-authorized-channel" (route: api). Public catalog
 * reads only: no auth, no cart/checkout calls are made here.
 *
 * LIVE-ONLY (Barath's rule, Oct 31, 2026): every search runs the full
 * protocol flow IN THIS REQUEST — read the store's live profile, MCP
 * initialize handshake, tools/list discovery (the catalog tool is found
 * in the server's own tool list, never hardcoded), one catalog search —
 * and maps ONLY the figures the merchant's response carries. Nothing is
 * cached or stored between requests; a store that does not answer
 * yields no offers, never a stored or invented price.
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

const AGENT_PROFILE =
  process.env.UCP_AGENT_PROFILE ??
  "https://shopify.dev/ucp/agent-profiles/2026-04-08/valid-with-capabilities.json";

const PROFILE_TIMEOUT_MS = 8_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;
const CATALOG_TIMEOUT_MS = 40_000;
const CATALOG_LIMIT = 5;
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
];

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
  const selected: UcpStore[] = [];
  for (const store of UCP_STORES) {
    const policy = getMerchantPolicy(store.merchant);
    if (
      policy.status !== "ucp-authorized-channel" ||
      !policy.allowedAcquisitionMethods.includes("api")
    ) {
      continue;
    }
    if (
      store.brandAliases.some(matches) ||
      store.keywords.some(matches)
    ) {
      selected.push(store);
    }
    if (selected.length >= MAX_UCP_STORES_PER_QUERY) break;
  }
  return selected;
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

async function mcpPost(
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
async function readProfileEndpoint(store: UcpStore): Promise<{
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
}

const CURRENCY_EXPONENTS: Record<string, number> = {
  JPY: 0, KRW: 0, VND: 0, BHD: 3, JOD: 3, KWD: 3, OMR: 3, TND: 3,
};

function moneyFromMinor(amount: number, currency: string): number {
  const exponent = CURRENCY_EXPONENTS[currency] ?? 2;
  return amount / 10 ** exponent;
}

interface RawUcpVariant {
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
/* One live catalog search against one store                           */
/* ------------------------------------------------------------------ */

/**
 * Run the full UCP flow for one store, live, in this request. Returns
 * the priced products the store's catalog returned for `query` — []
 * on any failure (profile, handshake, discovery, or catalog). Never
 * throws, never caches, never invents.
 */
export async function searchUcpStore(
  store: UcpStore,
  query: string,
): Promise<UcpProduct[]> {
  try {
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
        try {
          await mcpPost(
            endpoint,
            sessionId,
            { jsonrpc: "2.0", method: "notifications/initialized" },
            HANDSHAKE_TIMEOUT_MS,
          );
        } catch {
          /* fire-and-forget */
        }
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
    if (!Array.isArray(tools)) return [];
    const searchTool =
      tools.find((t) => t.name === "search_catalog") ??
      tools.find((t) => /catalog/i.test(t.name) && /search/i.test(t.name)) ??
      tools.find((t) => /search/i.test(t.name) && !/lookup/i.test(t.name)) ??
      null;
    if (!searchTool) return [];

    // Argument shape follows the tool's own inputSchema.
    const schemaProps = searchTool.inputSchema?.properties ?? {};
    const args: Record<string, unknown> = {
      meta: { "ucp-agent": { profile: AGENT_PROFILE } },
    };
    if ("catalog" in schemaProps) {
      args.catalog = { query, pagination: { limit: CATALOG_LIMIT } };
    } else if ("query" in schemaProps) {
      args.query = query;
      if ("pagination" in schemaProps) args.pagination = { limit: CATALOG_LIMIT };
      if ("limit" in schemaProps) args.limit = CATALOG_LIMIT;
    } else {
      args.catalog = { query, pagination: { limit: CATALOG_LIMIT } };
    }
    if ("context" in schemaProps) {
      args.context = { address_country: "US", currency: "USD" };
    }

    const call = await mcpPost(
      endpoint,
      sessionId,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: searchTool.name, arguments: args },
      },
      CATALOG_TIMEOUT_MS,
    );
    if (!call.message?.result || call.message.error) return [];
    const result = call.message.result;
    if ((result as { isError?: boolean }).isError) return [];
    return extractUcpProducts(result);
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
        `tools/list after an initialize handshake; public catalog read only, no cart/checkout ` +
        `calls). The price is the merchant's own live figure. The UCP catalog does not state ` +
        `a shipping charge (shipping is calculated by the merchant at checkout and is not ` +
        `included in the total), a delivery estimate (a ${SERVICE_DELIVERY_DAYS}-day standard ` +
        `ground service estimate is used for scoring), return terms (a conservative curated ` +
        `${CURATED_RETURN_WINDOW_DAYS}-day buyer-paid pattern is shown, not the merchant's ` +
        `stated policy), a warranty period, or a seller rating — this is the merchant's own ` +
        `first-party store. Nothing here is stored: the price was fetched in this request.`,
    },
  };
}
