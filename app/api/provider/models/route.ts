import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, requireAdmin } from "@/lib/server/auth";
import { getProviderConfig, getProviderNetworkConfig } from "@/lib/server/provider-config";
import { discoverProviderModels } from "@/lib/server/provider-models";
import { ProviderError } from "@/lib/server/providers";
import { ProviderNetworkError } from "@/lib/server/provider-network";

export const runtime = "nodejs";
export const maxDuration = 30;

const schema = z.object({
  provider: z.enum(["openai", "gemini", "deepseek", "zai", "minimax", "inkling", "mistral"]),
  apiKey: z.string().trim().max(500).optional(),
});

export async function POST(request: Request) {
  try {
    await requireAdmin();
    const input = schema.parse(await request.json());
    let apiKey = input.apiKey || "";
    let network;
    if (!apiKey) {
      const stored = await getProviderConfig();
      if (stored.provider !== input.provider) throw new ProviderError("برای خواندن مدل‌های این سرویس، کلید همان سرویس را وارد کنید.", 400);
      apiKey = stored.apiKey;
      network = stored.network;
    } else {
      network = await getProviderNetworkConfig();
    }
    if (apiKey.length < 12) throw new ProviderError("کلید API کوتاه‌تر از حد انتظار است.", 400);
    const models = await discoverProviderModels({ provider: input.provider, apiKey, network });
    return NextResponse.json({ models }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "سرویس‌دهنده و کلید را بررسی کنید." }, { status: 400 });
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof ProviderError || error instanceof ProviderNetworkError) return NextResponse.json({ error: error.message }, { status: error instanceof ProviderError ? error.status : 502 });
    const message = error instanceof Error && !error.message.includes("fetch") ? error.message : "خواندن مدل‌های حساب ناموفق بود؛ اتصال سرور را بررسی کنید.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
