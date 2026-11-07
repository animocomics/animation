import { NextResponse } from "next/server";
import { AuthError, requireAdmin } from "@/lib/server/auth";
import { providerBudgetAll, PROVIDER_BUDGET } from "@/lib/server/provider-rate-limit";
import { providerStreaks, recentProviderFailures } from "@/lib/server/provider-failure-log";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A cheap status endpoint for the always-visible counter in the admin panel.
 *
 * The full diagnostics run probes and takes about four seconds, which is far too
 * expensive to run on a timer. This reads in-process counters only: no network,
 * no disk, no secret.
 */
export async function GET() {
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }

  // The Kaya path opens and closes on its own schedule; the watcher writes this file
  // every 10 minutes so the panel can show the current state without probing.
  let kayaStatus: unknown = null;
  try {
    const dataDirectory = process.env.NOMREH_DATA_DIR || path.join(process.cwd(), "data");
    kayaStatus = JSON.parse(await readFile(path.join(dataDirectory, "kaya-status.json"), "utf8"));
  } catch {
    kayaStatus = null;
  }

  const usage = providerBudgetAll();
  return NextResponse.json(
    {
      version: "v22",
      windowMinutes: PROVIDER_BUDGET.windowMs / 60_000,
      maxPerWindow: PROVIDER_BUDGET.maxPerWindow,
      maxConcurrency: PROVIDER_BUDGET.maxConcurrency,
      usage,
      totalUsed: usage.reduce((sum, row) => sum + row.used, 0),
      anyBreakerOpen: usage.some((row) => row.breakerOpen),
      streaks: providerStreaks(),
      recentFailures: recentProviderFailures().slice(0, 5),
      kaya: kayaStatus,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
