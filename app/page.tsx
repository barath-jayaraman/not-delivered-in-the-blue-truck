import ShoppingApp from "@/components/ShoppingApp";
import { BRAND } from "@/lib/config";

export default function Home() {
  return (
    <main>
      <header className="hero">
        <p className="brandMark">{BRAND.name}</p>
        <h1>{BRAND.tagline}</h1>
        <p className="heroBlurb">{BRAND.blurb}</p>
        <a className="ctaButton heroCta" href="#app">
          Try the prototype ↓
        </a>
        <p className="betaBanner">{BRAND.betaNote}</p>
      </header>

      <section className="howItWorks">
        <div>
          <h3>1 · Search like retail</h3>
          <p>
            Search broadly to see matching models, or name a specific model to
            open its comparison directly.
          </p>
        </div>
        <div>
          <h3>2 · Compare the top five</h3>
          <p>
            Walmart, Best Buy, and eBay offers each sit in their own merchant
            block — with price, shipping, arrival, returns, warranty, rating,
            and a score. The policy gate routes every merchant first: Walmart
            is browsed under its Agentic Access Terms, Best Buy and eBay use
            official APIs, and Target stays out — authorized-channel only.
          </p>
        </div>
        <div>
          <h3>3 · Try the full journey</h3>
          <p>
            Add an offer to the cart, pass the Walmart human consent gate,
            complete sandbox guest checkout, watch the return countdown, and
            initiate a sample return — all locally, with no real order or
            charge.
          </p>
        </div>
      </section>

      <ShoppingApp />

      <footer className="footer">
        <p>
          Built by {BRAND.company}. {BRAND.betaNote}
        </p>
        <p className="footerSmall">
          {BRAND.name} is a local prototype. It makes no live retailer calls,
          does not scrape merchant websites, and does not automate purchasing.
        </p>
      </footer>
    </main>
  );
}
