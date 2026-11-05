import { NextResponse } from "next/server";
import { AuthError, requireAdmin } from "@/lib/server/auth";
import { disconnectProviderConfig } from "@/lib/server/provider-config";

export async function POST() {
  try {
    await requireAdmin();
    return NextResponse.json({ status: await disconnectProviderConfig() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "قطع اتصال ناموفق بود." }, { status });
  }
}
