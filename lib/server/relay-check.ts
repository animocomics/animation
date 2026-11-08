/**
 * Does the Gemini relay actually relay?
 *
 * The country block is what stops this app on an Iranian host: Google answers
 * "User location is not supported for the API use." and no amount of trying the key
 * again changes that. The documented way out is `NOMREH_GEMINI_BASE_URL` pointing at
 * something outside the block that forwards to Google.
 *
 * Once that address is set, three very different failures look the same to the
 * operator — a wrong worker name, a worker that never redeployed its code, a path
 * that is being rewritten — and all three surface as one opaque error on an upload
 * that has already cost a request. This check separates them with a request that
 * sends no key, so it is free: the catalogue endpoint of Gemini answers a junk key
 * with 400 "API key not valid", and that refusal is the proof we are looking for —
 * it can only come from Google itself.
 */

export type RelayLayer = "none" | "unset" | "network" | "cloudflare" | "google";

export type RelayCheck = {
  configured: boolean;
  baseUrl: string | null;
  /** Did a request to Gemini's catalogue come back, whatever it answered? */
  reachable: boolean;
  /** Where the request died, or "google" when Google answered through the relay. */
  layer: RelayLayer;
  status: number;
  /** Plain-language sentence for the panel, already in Persian. */
  detail: string;
};

const DEFAULT_TIMEOUT_MS = 8_000;

function normalise(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

/**
 * The worker the operator deployed is the one address we cannot know in advance, so
 * it is read from the environment at call time rather than captured at import time.
 */
export function relayBaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = String(env.NOMREH_GEMINI_BASE_URL || "").trim();
  return raw ? normalise(raw) : null;
}

export async function checkGeminiRelay(options: {
  baseUrl?: string | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
} = {}): Promise<RelayCheck> {
  const baseUrl = options.baseUrl === undefined ? relayBaseUrl() : options.baseUrl ? normalise(options.baseUrl) : null;
  if (!baseUrl) {
    return {
      configured: false,
      baseUrl: null,
      reachable: false,
      layer: "unset",
      status: 0,
      detail: "آدرس رله تنظیم نشده؛ برنامه مستقیم به گوگل وصل می‌شود و از ایران بلاک است.",
    };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(`${baseUrl}/v1beta/models`, {
      method: "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    const timedOut = /abort|timeout/i.test(cause);
    return {
      configured: true,
      baseUrl,
      reachable: false,
      layer: "network",
      status: 0,
      detail: timedOut
        ? `رله در ${Math.round(timeoutMs / 1000)} ثانیه پاسخ نداد؛ نام worker یا مسیر خروجی سرور را بررسی کنید.`
        : `به رله نرسیدیم (${cause.slice(0, 120)}). نام worker را با آدرس واقعی مقایسه کنید.`,
    };
  }

  const body = await response.text().catch(() => "");
  const trimmed = body.slice(0, 4_000);

  // Google answered through the relay: exactly what a working relay looks like.
  if (/API_KEY_INVALID|API key not valid/i.test(trimmed)) {
    return {
      configured: true,
      baseUrl,
      reachable: true,
      layer: "google",
      status: response.status,
      detail: "رله کار می‌کند: درخواست به گوگل رسید و فقط کلیدِ عمداً نامعتبر رد شد.",
    };
  }

  // The relay is answering, but Google still refuses this origin: the worker is not
  // rewriting the host, so it is proxying to itself and never leaving Cloudflare.
  if (/User location is not supported/i.test(trimmed)) {
    return {
      configured: true,
      baseUrl,
      reachable: false,
      layer: "google",
      status: response.status,
      detail: "گوگل هنوز مبدأ را رد می‌کند؛ کد worker آدرس مقصد را عوض نمی‌کند. کد را دوباره Deploy کنید.",
    };
  }

  // Cloudflare's own error pages: reserved name, no such worker, DNS not configured.
  if (/^\s*<(!doctype|html)/i.test(trimmed) || response.status === 1016 || response.status === 522 || response.status === 523 || response.status === 530) {
    return {
      configured: true,
      baseUrl,
      reachable: false,
      layer: "cloudflare",
      status: response.status,
      detail: `Cloudflare پاسخ داد (${response.status}) نه گوگل؛ نام worker درست نیست یا Deploy نشده است.`,
    };
  }

  if (response.status === 404) {
    return {
      configured: true,
      baseUrl,
      reachable: false,
      layer: "cloudflare",
      status: response.status,
      detail: "مسیر /v1beta/models روی رله ۴۰۴ داد؛ worker مسیرها را به گوگل منتقل نمی‌کند.",
    };
  }

  return {
    configured: true,
    baseUrl,
    reachable: response.status > 0,
    layer: response.status > 0 ? "google" : "network",
    status: response.status,
    detail: trimmed
      ? `پاسخ غیرمنتظره از رله (${response.status}): ${trimmed.replace(/\s+/g, " ").slice(0, 140)}`
      : `رله پاسخ خالی داد (${response.status}).`,
  };
}
