#!/usr/bin/env node
/**
 * WALMART LIVE-OFFER FETCHER — producer side of the fetch relay.
 *
 * Why this exists: Walmart serves its search pages to this machine's
 * network but blocks/challenges fetches from the production host
 * (Vercel's serverless egress), so the deployed app cannot fetch Walmart
 * directly. This script runs where the fetch works, reuses the app's own
 * adapter (lib/adapters/walmart-browse.ts — same extraction, matching,
 * rate limiting, self-identifying user agent, and stop-on-block rules;
 * nothing here re-implements or loosens them), and writes the extracted
 * offers to data/live-offers.json. That document is committed to the
 * public repo, and the app reads it back over HTTPS as its relay source
 * (see lib/adapters/walmart-relay.ts). Every offer in the document keeps
 * the price, sourceUrl, and retrievedAt exactly as extracted at fetch
 * time; a product whose fetch fails or is blocked is OMITTED — stale
 * prices are never carried forward silently.
 *
 * How it reuses the TypeScript adapter without a build step in the app:
 * it compiles the adapter's module graph (lib/adapters/walmart-browse.ts,
 * lib/adapters.ts, lib/data.ts, lib/types.ts — no Next/React code) to
 * CommonJS in a temp dir with the project's own TypeScript, then requires
 * the compiled modules. The committed app code is untouched by this.
 *
 * Usage: node scripts/fetch-walmart-offers.mjs
 * Exit code is 0 when the document was written (even if some products
 * found no live offer); it is non-zero only on infrastructure failure.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/* ------------------------------------------------------------------ */
/* Compile the app's adapter + catalog modules to CommonJS             */
/* ------------------------------------------------------------------ */

const buildDir = mkdtempSync(path.join(tmpdir(), "ndibt-fetcher-"));
const tscBin = path.join(projectRoot, "node_modules", ".bin", "tsc");

console.log(
  `[fetcher] compiling lib/adapters/walmart-browse.ts module graph → ${buildDir}`,
);
execFileSync(
  tscBin,
  [
    path.join(projectRoot, "lib", "adapters", "walmart-browse.ts"),
    "--module",
    "commonjs",
    "--target",
    "es2022",
    "--moduleResolution",
    "node",
    "--esModuleInterop",
    "--skipLibCheck",
    "--rootDir",
    path.join(projectRoot, "lib"),
    "--outDir",
    buildDir,
  ],
  { stdio: "inherit", cwd: projectRoot },
);

const require = createRequire(import.meta.url);
const { PRODUCTS } = require(path.join(buildDir, "data.js"));
const { fetchLiveWalmartOffers } = require(
  path.join(buildDir, "adapters", "walmart-browse.js"),
);

/* ------------------------------------------------------------------ */
/* Fetch one live offer per catalog product                            */
/* ------------------------------------------------------------------ */

const offers = {};
for (const product of PRODUCTS) {
  let live = [];
  try {
    live = await fetchLiveWalmartOffers(product);
  } catch (error) {
    console.warn(
      `[fetcher] ${product.id}: fetch threw (${String(error)}); omitting.`,
    );
    continue;
  }
  if (live.length > 0) {
    offers[product.id] = live[0];
    console.log(
      `[fetcher] ${product.id}: $${live[0].price} — ${live[0].sampleListingLabel} — ${live[0].provenance.sourceUrl}`,
    );
  } else {
    console.log(
      `[fetcher] ${product.id}: no live offer (blocked, unserved, or no confident match); omitting.`,
    );
  }
}

const doc = { generatedAt: new Date().toISOString(), offers };
const outPath = path.join(projectRoot, "data", "live-offers.json");
mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`);
console.log(
  `[fetcher] wrote ${outPath} with ${Object.keys(offers).length}/${PRODUCTS.length} live offers (generatedAt ${doc.generatedAt}).`,
);
