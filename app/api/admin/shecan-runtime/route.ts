import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, requireAdmin } from "@/lib/server/auth";
import { ensureApiNetworkActivated, getApiNetworkConfig, getApiNetworkStatus, saveAndTestApiNetwork } from "@/lib/server/api-network";
import { ensureOfficialRuntimeSupervisor, getOfficialRuntimeStatus, restartOfficialRuntime, startOfficialRuntime, stopOfficialRuntime } from "@/lib/server/shecan-runtime";
import { getV2RayStatus } from "@/lib/server/v2ray-runtime";

export const runtime = "nodejs";
export const maxDuration = 30;

const schema = z.object({ action: z.enum(["start", "stop", "restart"]) });
let lastAutomaticActivationAttempt = 0;

function scheduleStoredActivation(runtimeStatus: ReturnType<typeof getOfficialRuntimeStatus>, network: Awaited<ReturnType<typeof getApiNetworkStatus>>): void {
  if (!network.enabled || network.transport !== "official-vm" || !runtimeStatus.running || !runtimeStatus.appReady || !runtimeStatus.brokerReady || runtimeStatus.activationReady) return;
  const now = Date.now();
  if (now - lastAutomaticActivationAttempt < 30_000) return;
  lastAutomaticActivationAttempt = now;
  // Keep the admin status response fast. The shared activation promise in
  // api-network deduplicates concurrent polls and provider requests.
  void getApiNetworkConfig()
    .then((config) => ensureApiNetworkActivated(config))
    .catch(() => undefined);
}

async function payload() {
  const [runtimeStatus, network, v2ray] = await Promise.all([Promise.resolve(getOfficialRuntimeStatus()), getApiNetworkStatus(), getV2RayStatus()]);
  if (!v2ray.enabled && !v2ray.pending) scheduleStoredActivation(runtimeStatus, network);
  return { runtime: runtimeStatus, network, v2rayEnabled: Boolean(v2ray.enabled || v2ray.pending) };
}

export async function GET() {
  try {
    await requireAdmin();
    ensureOfficialRuntimeSupervisor();
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
