import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, requireAdmin } from "@/lib/server/auth";
import { getProviderConfig } from "@/lib/server/provider-config";
import { kayaBaseUrl, assertKayaHostAllowed } from "@/lib/server/kaya-egress";
import { isChatCompletionsProvider } from "@/lib/server/provider-traits";
import { providerFetch, ProviderNetworkError } from "@/lib/server/provider-network";
import { providerResponseError } from "@/lib/server/provider-models";
import { gapgptBaseUrl, ProviderError } from "@/lib/server/providers";
import { invalidProviderJsonMessage, isJsonParserErrorMessage, providerErrorHttpStatus } from "@/lib/error-message";
import { PROVIDER_IDS } from "@/lib/provider-catalog";

export const runtime = "nodejs";
export const maxDuration = 30;

const schema = z.object({
  provider: z.enum(PROVIDER_IDS),
  model: z.string().min(2).max(120),
  apiKey: z.string().max(500).optional(),
});

export async function POST(request: Request) {
  try {
    await requireAdmin();
    const input = schema.parse(await request.json());
    let apiKey = input.apiKey?.trim() || "";
    // Read the stored config even when a key is typed: it carries the Kaya host,
    // which decides where this test is actually sent.
    const stored = await getProviderConfig();
    if (!apiKey) {
      if (stored.provider !== input.provider) throw new ProviderError("برای آزمایش این سرویس، کلید همان سرویس را وارد کنید.", 400);
      apiKey = stored.apiKey;
    }
    const isChat = isChatCompletionsProvider(input.provider);
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
                : input.provider === "gapgpt"
                  // Same rule as Kaya: test the host the grading request will use,
                  // not a hard-coded default, or a green test proves nothing.
                  ? `${gapgptBaseUrl(stored.egress)}/chat/completions`
                  : input.provider === "kaya"
                    // Honour the configured Kaya host: when the operator points the
                    // app at a local stand-in for validation, the test must reach the
                    // same place a real grading request would.
                    ? `${kayaBaseUrl(stored.egress)}/chat/completions`
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
            : input.provider === "kaya" || input.provider === "gapgpt"
              ? {
                  // Exercise the same Chat Completions path grading uses, so a
                  // green test means the key and this exact model really work.
                  model: input.model,
                  messages: [{ role: "user", content: "فقط OK بنویس." }],
                  max_tokens: 64,
                  stream: false,
                }
              : undefined;
    // The configured host decides where this test is sent, so it passes exactly the
    // same guard grading does: a remote plain-HTTP host is refused either way.
    if (input.provider === "kaya" || input.provider === "gapgpt") assertKayaHostAllowed(stored.egress);
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
    if (!response.ok) throw await providerResponseError(response, input.provider, apiKey);
    if (input.provider === "deepseek") {
      const payload = await response.json() as { data?: Array<{ id?: string }> };
      if (!payload.data?.some((item) => item.id === input.model)) {
        return NextResponse.json({ error: "کلید معتبر است اما این مدل در فهرست مدل‌های حساب DeepSeek دیده نمی‌شود." }, { status: 400 });
      }
    } else if (input.provider === "kaya" || input.provider === "gapgpt") {
      const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
      const content = payload.choices?.[0]?.message?.content;
      const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text?: unknown }).text ?? "") : "")).join("") : "";
      if (!text.trim()) {
        return NextResponse.json({ error: "سرویس‌دهنده پاسخ خالی برگرداند؛ ممکن است سهمیهٔ استدلال توکن را مصرف کرده باشد. دوباره تلاش کنید." }, { status: 502 });
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
    if (isJsonParserErrorMessage(error)) return NextResponse.json({ error: invalidProviderJsonMessage() }, { status: 502 });
    if (error instanceof ProviderError) return NextResponse.json({ error: error.message }, { status: providerErrorHttpStatus(error.status) });
    if (error instanceof ProviderNetworkError) return NextResponse.json({ error: error.message }, { status: 502 });
    // Node reports every socket failure as "fetch failed"; the real cause is in
    // cause.code. Keep the code so the operator can tell a blocked route from a
    // bad key instead of reading a misleading "check your internet" sentence.
    const causeCode = (() => {
      const value = error as { code?: string; cause?: { code?: string } ; name?: string } | undefined;
      return value?.cause?.code || value?.code || (value?.name === "TimeoutError" ? "ETIMEDOUT" : "");
    })();
    const message = error instanceof Error && error.name === "TimeoutError"
      ? "بررسی اتصال بیش از حد طول کشید."
      : error instanceof Error && !error.message.includes("fetch") ? `${error.message}${causeCode ? ` (${causeCode})` : ""}`
      : `ارتباط با سرویس‌دهنده برقرار نشد${causeCode ? ` (${causeCode})` : ""}؛ اگر ETIMEDOUT/ECONNRESET است شبکهٔ خروجی سرور این مقصد را می‌بندد، نه اینترنت شما. از «تشخیص شبکه» لایهٔ ناموفق را ببینید.`;
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
