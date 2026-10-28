import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, requireAdmin } from "@/lib/server/auth";
import { getProviderConfig } from "@/lib/server/provider-config";

export const runtime = "nodejs";
export const maxDuration = 30;

const schema = z.object({
  provider: z.enum(["openai", "gemini", "deepseek"]),
  model: z.string().min(2).max(120),
  apiKey: z.string().max(500).optional(),
});

export async function POST(request: Request) {
  try {
    await requireAdmin();
    const input = schema.parse(await request.json());
    let apiKey = input.apiKey?.trim() || "";
    if (!apiKey) {
      const stored = await getProviderConfig();
      if (stored.provider !== input.provider || stored.model !== input.model) throw new Error("برای مدل جدید، کلید را دوباره وارد کنید یا ابتدا تنظیمات را ذخیره کنید.");
      apiKey = stored.apiKey;
    }
    const url = input.provider === "openai"
      ? `https://api.openai.com/v1/models/${encodeURIComponent(input.model)}`
      : input.provider === "deepseek"
        ? "https://api.deepseek.com/models"
        : `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}`;
    const response = await fetch(url, {
      headers: input.provider === "gemini" ? { "x-goog-api-key": apiKey } : { Authorization: `Bearer ${apiKey}` },
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
