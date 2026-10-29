/**
 * Product and category imagery.
 *
 * Prototype asset store: one image per product, saved under public/images
 * and named by product id, so the same item reuses the same picture on
 * every page (home cards, results rows, product page, cart, orders).
 */

export function productImage(productId: string): string {
  return `/images/${productId}.png`;
}

export const CATEGORY_IMAGES: Record<string, string> = {
  Headphones: "/images/bose-qc-headphones.png",
  TVs: "/images/lg-c5-55.png",
  "Coffee & Kitchen": "/images/breville-barista-express-impress.png",
  Laptops: "/images/category-laptops.png",
  Home: "/images/roborock-s8.png",
  Fitness: "/images/category-fitness.png",
};

export interface CategoryTile {
  label: string;
  image: string;
  /** Search term run when the tile is clicked. */
  searchTerm: string;
}

export const CATEGORY_TILES: CategoryTile[] = [
  { label: "Headphones", image: CATEGORY_IMAGES.Headphones, searchTerm: "headphones" },
  { label: "TVs", image: CATEGORY_IMAGES.TVs, searchTerm: "tv" },
  { label: "Coffee & Kitchen", image: CATEGORY_IMAGES["Coffee & Kitchen"], searchTerm: "coffee" },
  { label: "Laptops", image: CATEGORY_IMAGES.Laptops, searchTerm: "laptop" },
  { label: "Home", image: CATEGORY_IMAGES.Home, searchTerm: "vacuum" },
  { label: "Fitness", image: CATEGORY_IMAGES.Fitness, searchTerm: "running shoes" },
];
