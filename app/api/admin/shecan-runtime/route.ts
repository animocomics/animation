import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, requireAdmin } from "@/lib/server/auth";
import { getApiNetworkStatus, saveAndTestApiNetwork } from "@/lib/server/api-network";
import { getOfficialRuntimeStatus, restartOfficialRuntime, startOfficialRuntime, stopOfficialRuntime } from "@/lib/server/shecan-runtime";

export const runtime = "nodejs";
export const maxDuration = 30;

const schema = z.object({ action: z.enum(["start", "stop", "restart"]) });

async function payload() {
  const [runtimeStatus, network] = await Promise.all([Promise.resolve(getOfficialRuntimeStatus()), getApiNetworkStatus()]);
  return { runtime: runtimeStatus, network };
}

export async function GET() {
  try {
    await requireAdmin();
    return NextResponse.json(await payload(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 500;
    return NextResponse.json({ error: error instanceof AuthError ? error.message : "وضعیت محیط رسمی خوانده نشد." }, { status });
  }
}

export async function POST(request: Request) {
  try {
    const admin = await requireAdmin();
    const { action } = schema.parse(await request.json());
    if (action === "stop") {
      const network = await getApiNetworkStatus();
      if (network.configured && network.enabled && network.transport === "official-vm") {
        await saveAndTestApiNetwork({ enabled: false, plan: network.plan, servers: network.servers, transport: "official-vm" }, admin.id);
      }
      await stopOfficialRuntime();
    } else if (action === "restart") {
      await restartOfficialRuntime();
    } else {
      await startOfficialRuntime();
    }
    const result = await payload();
    return NextResponse.json(result, { status: result.runtime.phase === "ready" ? 200 : 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "عملیات محیط رسمی معتبر نیست." }, { status: 400 });
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: error instanceof Error ? error.message : "اجرای محیط رسمی انجام نشد." }, { status: 400 });
  }
}
