import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 30;

const schema = z.object({
  provider: z.enum(["openai", "gemini"]),
  model: z.string().min(2).max(120),
  apiKey: z.string().min(8).max(500),
});

export async function POST(request: Request) {
  try {
    const { provider, model, apiKey } = schema.parse(await request.json());
    const url = provider === "openai"
      ? `https://api.openai.com/v1/models/${encodeURIComponent(model)}`
      : `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}`;
    const response = await fetch(url, {
      headers: provider === "openai"
        ? { Authorization: `Bearer ${apiKey}` }
        : { "x-goog-api-key": apiKey },
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
    await response.arrayBuffer();
    return NextResponse.json({ ok: true, message: "اتصال برقرار است و مدل در دسترس شماست." });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Provider، مدل و API Key را کامل وارد کنید." }, { status: 400 });
    }
    const message = error instanceof Error && error.name === "TimeoutError"
      ? "بررسی اتصال بیش از حد طول کشید."
      : "ارتباط با سرویس‌دهنده برقرار نشد؛ اتصال اینترنت سرور را بررسی کنید.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
