import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, requireAdmin } from "@/lib/server/auth";
import { getProviderConfig } from "@/lib/server/provider-config";
import { discoverProviderModels } from "@/lib/server/provider-models";
import { ProviderError } from "@/lib/server/providers";
import { ProviderNetworkError } from "@/lib/server/provider-network";
import { invalidProviderJsonMessage, isJsonParserErrorMessage, providerErrorHttpStatus } from "@/lib/error-message";
import { PROVIDER_IDS } from "@/lib/provider-catalog";

export const runtime = "nodejs";
export const maxDuration = 30;

const schema = z.object({
  provider: z.enum(PROVIDER_IDS),
  apiKey: z.string().trim().max(500).optional(),
});

export async function POST(request: Request) {
  try {
    await requireAdmin();
    const input = schema.parse(await request.json());
    let apiKey = input.apiKey || "";
    const stored = await getProviderConfig();
    if (!apiKey) {
      if (stored.provider !== input.provider) throw new ProviderError("برای خواندن مدل‌های این سرویس، کلید همان سرویس را وارد کنید.", 400);
      apiKey = stored.apiKey;
    }
    if (apiKey.length < 12) throw new ProviderError("کلید API کوتاه‌تر از حد انتظار است.", 400);
    // Both host-driven providers must receive the configured host, or discovery
    // reads a hard-coded default while grading uses the operator's setting — so the
    // model list would come from a different place than the grading request.
    const hostDriven = input.provider === "kaya" || input.provider === "gapgpt";
    const models = await discoverProviderModels({ provider: input.provider, apiKey, egress: hostDriven ? stored.egress : undefined });
    return NextResponse.json({ models }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "سرویس‌دهنده و کلید را بررسی کنید." }, { status: 400 });
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (isJsonParserErrorMessage(error)) return NextResponse.json({ error: invalidProviderJsonMessage() }, { status: 502 });
    if (error instanceof ProviderError || error instanceof ProviderNetworkError) return NextResponse.json({ error: error.message }, { status: error instanceof ProviderError ? providerErrorHttpStatus(error.status) : 502 });
    const causeCode = (() => {
      const value = error as { code?: string; cause?: { code?: string } } | undefined;
      return value?.cause?.code || value?.code || "";
    })();
    const message = error instanceof Error && !error.message.includes("fetch")
      ? `${error.message}${causeCode ? ` (${causeCode})` : ""}`
      : `خواندن مدل‌های حساب ناموفق بود${causeCode ? ` (${causeCode})` : ""}؛ این خطا از سمت سرور است نه مرورگر شما.`;
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
