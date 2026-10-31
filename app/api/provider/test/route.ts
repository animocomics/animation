import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, requireAdmin } from "@/lib/server/auth";
import { getProviderConfig, getProviderNetworkConfig } from "@/lib/server/provider-config";
import { providerFetch } from "@/lib/server/provider-network";

export const runtime = "nodejs";
export const maxDuration = 30;

const schema = z.object({
  provider: z.enum(["openai", "gemini", "deepseek", "zai", "minimax", "inkling", "mistral"]),
  model: z.string().min(2).max(120),
  apiKey: z.string().max(500).optional(),
});

export async function POST(request: Request) {
  try {
    await requireAdmin();
    const input = schema.parse(await request.json());
    const network = await getProviderNetworkConfig();
    let apiKey = input.apiKey?.trim() || "";
    if (!apiKey) {
      const stored = await getProviderConfig();
      if (stored.provider !== input.provider || stored.model !== input.model) throw new Error("برای مدل جدید، کلید را دوباره وارد کنید یا ابتدا تنظیمات را ذخیره کنید.");
      apiKey = stored.apiKey;
    }
    const isChat = ["zai", "minimax", "mistral"].includes(input.provider);
    const isInkling = input.provider === "inkling";
    const url = isInkling
      ? "https://tinker.thinkingmachines.dev/services/tinker-prod/anthropic/api/v1/messages"
      : input.provider === "zai"
        ? "https://api.z.ai/api/paas/v4/chat/completions"
        : input.provider === "minimax"
          ? "https://api.minimax.io/v1/chat/completions"
          : input.provider === "mistral"
            ? "https://api.mistral.ai/v1/chat/completions"
            : input.provider === "openai"
              ? `https://api.openai.com/v1/models/${encodeURIComponent(input.model)}`
              : input.provider === "deepseek"
                ? "https://api.deepseek.com/models"
                : `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}`;
    const testBody = isInkling
      ? {
          model: input.model,
          messages: [{ role: "user", content: "فقط OK بنویس." }],
          output_config: { effort: "low" },
          max_tokens: 32,
        }
      : input.provider === "minimax"
        ? {
            model: input.model,
            messages: [{ role: "user", content: "فقط OK بنویس." }],
            thinking: { type: "adaptive" },
            ...(input.model.startsWith("MiniMax-M3.1") ? { reasoning_effort: "low" } : {}),
            reasoning_split: true,
            max_completion_tokens: 32,
            stream: false,
          }
        : input.provider === "mistral"
          ? {
              model: input.model,
              messages: [{ role: "user", content: "فقط OK بنویس." }],
              reasoning_effort: "low",
              max_tokens: 32,
              stream: false,
            }
          : input.provider === "zai"
            ? {
                model: input.model,
                messages: [{ role: "user", content: "فقط OK بنویس." }],
                max_tokens: 8,
                stream: false,
              }
            : undefined;
    const response = await providerFetch(url, {
      method: isChat || isInkling ? "POST" : "GET",
      headers: isInkling
        ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" }
        : isChat
          ? { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...(input.provider === "zai" ? { "Accept-Language": "en-US,en" } : {}) }
          : input.provider === "gemini" ? { "x-goog-api-key": apiKey } : { Authorization: `Bearer ${apiKey}` },
      body: testBody ? JSON.stringify(testBody) : undefined,
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
    if (!response.ok) {
      await response.arrayBuffer();
      const message = response.status === 401 || response.status === 403
        ? "کلید معتبر نیست یا اجازهٔ استفاده از این مدل را ندارد."
        : response.status === 404
          ? "این مدل برای حساب شما پیدا نشد؛ نام مدل را بررسی کنید."
          : response.status === 429
            ? "سهمیه یا محدودیت درخواست سرویس‌دهنده فعال است."
            : "بررسی اتصال ناموفق بود؛ کمی بعد دوباره تلاش کنید.";
      return NextResponse.json({ error: message }, { status: response.status === 404 ? 400 : response.status });
    }
    if (input.provider === "deepseek") {
      const payload = await response.json() as { data?: Array<{ id?: string }> };
      if (!payload.data?.some((item) => item.id === input.model)) {
        return NextResponse.json({ error: "کلید معتبر است اما این مدل در فهرست مدل‌های حساب DeepSeek دیده نمی‌شود." }, { status: 400 });
      }
    } else if (input.provider === "minimax") {
      const payload = await response.json() as { base_resp?: { status_code?: number; status_msg?: string } };
      if (payload.base_resp?.status_code && payload.base_resp.status_code !== 0) {
        return NextResponse.json({ error: `MiniMax درخواست آزمایشی را قبول نکرد${payload.base_resp.status_msg ? `: ${payload.base_resp.status_msg.slice(0, 180)}` : "."}` }, { status: 400 });
      }
    } else await response.arrayBuffer();
    return NextResponse.json({ ok: true, message: "اتصال برقرار است و مدل در دسترس شماست." });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "Provider و مدل را کامل وارد کنید." }, { status: 400 });
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    const message = error instanceof Error && error.name === "TimeoutError"
      ? "بررسی اتصال بیش از حد طول کشید."
      : error instanceof Error && !error.message.includes("fetch") ? error.message : "ارتباط با سرویس‌دهنده برقرار نشد؛ اتصال اینترنت سرور را بررسی کنید.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
