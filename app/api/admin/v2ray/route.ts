import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, requireAdmin } from "@/lib/server/auth";
import { V2RayError, clearV2RayConfigs, disableV2Ray, getV2RayStatus, saveV2RayConfigs, startV2RayActivation } from "@/lib/server/v2ray-runtime";

export const runtime = "nodejs";
export const maxDuration = 180;

const schema = z.object({
  action: z.enum(["save", "activate", "disable", "clear"]),
  configs: z.string().max(600_000).optional(),
});

export async function GET() {
  try {
    await requireAdmin();
    return NextResponse.json({ status: await getV2RayStatus() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "وضعیت V2Ray خوانده نشد." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const admin = await requireAdmin();
    const input = schema.parse(await request.json());
    if (input.action === "save") {
      if (!input.configs?.trim()) throw new V2RayError("حداقل یک کانفیگ برای ذخیره وارد کنید.", 400);
      await saveV2RayConfigs(input.configs, admin.id);
      return NextResponse.json({ status: await getV2RayStatus() }, { headers: { "Cache-Control": "no-store" } });
    }
    if (input.action === "activate") {
      const job = startV2RayActivation({ configs: input.configs }, admin.id);
      return NextResponse.json({ status: await getV2RayStatus(), pending: job.pending }, { status: 202, headers: { "Cache-Control": "no-store" } });
    }
    if (input.action === "disable") await disableV2Ray(admin.id);
    else await clearV2RayConfigs(admin.id);
    return NextResponse.json({ status: await getV2RayStatus() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "عملیات یا فهرست کانفیگ معتبر نیست." }, { status: 400 });
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof V2RayError) return NextResponse.json({ error: error.message, status: await getV2RayStatus().catch(() => undefined) }, { status: error.status >= 500 ? 400 : error.status });
    return NextResponse.json({ error: error instanceof Error ? error.message : "عملیات V2Ray ناموفق بود." }, { status: 400 });
  }
}
