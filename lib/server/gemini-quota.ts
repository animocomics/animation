/**
 * Asking Google "is my free tier alive right now?" without sending a page.
 *
 * Every attempt with page images costs 15,000–20,000 tokens on Gemini, so the last thing a
 * free-tier operator should do is discover an exhausted quota by uploading the sheet again.
 * Gemini's own model catalogue answers a GET with no file and no generation, which is a
 * request against the same key and the same project — enough to see a country block or a
 * key that was disabled, but not enough to prove the free-tier quota is spent. Said plainly
 * in the result, because a green light here is not a promise that a read will succeed.
 */
import { geminiBaseUrl } from "./providers";

export type GeminiQuotaProbe = {
  reachable: boolean;
  status: number;
  /** "ok" | "key" | "quota" | "region" | "network" | "other" */
  verdict: "ok" | "key" | "quota" | "region" | "network" | "other";
  models: number;
  detail: string;
};

const TIMEOUT_MS = 8_000;

export async function probeGeminiKey(options: { apiKey: string; timeoutMs?: number }): Promise<GeminiQuotaProbe> {
  const apiKey = String(options.apiKey || "").trim();
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  if (!apiKey) {
    return { reachable: false, status: 0, verdict: "key", models: 0, detail: "کلید Gemini وارد نشده است." };
  }
  let response: Response;
  try {
    response = await fetch(`${geminiBaseUrl()}/v1beta/models?pageSize=1`, {
      method: "GET",
      headers: { "x-goog-api-key": apiKey },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const timeout = /abort|timeout/i.test(message);
    return {
      reachable: false,
      status: 0,
      verdict: "network",
      models: 0,
      detail: timeout
        ? `به Google Gemini نرسیدیم (${Math.round(timeoutMs / 1000)} ثانیه بدون پاسخ). اگر سرور در ایران است، این همان بلاک کشور است که با NOMREH_GEMINI_BASE_URL حل می‌شود.`
        : `به Google Gemini نرسیدیم: ${message.slice(0, 140)}`,
    };
  }
  const body = await response.text().catch(() => "");
  const lower = body.toLowerCase();
  if (response.ok) {
    let models = 0;
    try {
      models = (JSON.parse(body) as { models?: unknown[] }).models?.length ?? 0;
    } catch {
      models = 0;
    }
    return {
      reachable: true,
      status: response.status,
      verdict: "ok",
      models,
      detail:
        "کلید کار می‌کند و به Google رسیدیم. این آزمون هیچ تصویری نمی‌فرستد، پس سهمیهٔ روزانهٔ رایگان را مصرف نمی‌کند و دربارهٔ آن هم چیزی نمی‌گوید؛ اگر خواندن برگه ۴۲۹ داد، همان سهمیه تمام شده است.",
    };
  }
  if (/location is not supported|user location/.test(lower)) {
    return { reachable: true, status: response.status, verdict: "region", models: 0, detail: "Google درخواست این سرور را از نظر کشور مبدأ رد کرد؛ مسیر خروجی باید عوض شود." };
  }
  if (response.status === 429 || /resource_exhausted|quota/.test(lower)) {
    return { reachable: true, status: response.status, verdict: "quota", models: 0, detail: "سهمیهٔ درخواست‌های این کلید همین حالا پر است (حتی برای فهرست مدل‌ها). تا پر شدن دوباره صبر کنید." };
  }
  if (response.status === 401 || response.status === 403) {
    return { reachable: true, status: response.status, verdict: "key", models: 0, detail: "Google این کلید را نپذیرفت. کلید باید از AI Studio باشد و با AIza شروع شود." };
  }
  return { reachable: true, status: response.status, verdict: "other", models: 0, detail: `پاسخ نامنتظره از Google (${response.status}): ${body.replace(/\s+/g, " ").slice(0, 160)}` };
}
