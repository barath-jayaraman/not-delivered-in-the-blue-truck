import { NextResponse } from "next/server";
import { getPolicyGateEntries } from "@/lib/adapters";

/**
 * GET /api/policy-gate
 *
 * Returns the per-merchant policy-gate outcomes (lib/adapters.ts registry)
 * that route all data acquisition in this prototype: Walmart is browsed
 * under its Agentic Access Terms, Best Buy and eBay are official-API only,
 * and Target is authorized-channel only and is never browsed or scraped.
 */
export async function GET() {
  return NextResponse.json({
    entries: getPolicyGateEntries(),
    dataSource: "sample",
  });
}
