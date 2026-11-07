// Turns a raw Kaya reply into a sentence that names the layer.
//
// Why this is separate from the route: the route does the network work, but the
// value of the deep test is entirely in this mapping. "HTTP 401" and "no answer"
// mean opposite things — a rejected key versus a closed path — and the operator
// spent days on a generic "connection failed" that could mean either. Keeping the
// mapping here makes it testable without a network.

export type KayaProbeStep = "catalogue" | "text" | "image";

export interface KayaProbeReply {
  status: number;
  code: string;
}

/** Removes anything key-shaped from a message that will be shown or stored. */
export function scrubUpstreamText(text: string): string {
  return String(text)
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, "[کلید]")
    .replace(/Bearer\s+[A-Za-z0-9._-]{10,}/gi, "Bearer [کلید]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

/** The upstream message, or an empty string when the reply carries none. */
export function upstreamMessage(text: string): string {
  if (!text) return "";
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    const message = typeof parsed.error === "string" ? parsed.error : parsed.error?.message || parsed.message || "";
    if (message) return scrubUpstreamText(message);
  } catch {
    /* html or truncated body */
  }
  return scrubUpstreamText(text.replace(/<[^>]+>/g, " "));
}

/**
 * What a reply proves. A transport failure and an HTTP error are deliberately
 * worded differently, because only one of them can be fixed here.
 */
export function readingFor(step: KayaProbeStep, reply: KayaProbeReply): string {
  if (!reply.status) {
    if (reply.code === "PROVIDER_BREAKER_OPEN" || reply.code === "PROVIDER_RATE_LIMITED") {
      return "درخواستی ارسال نشد: سقف خروجی این پنجره پر شده است. چند دقیقه بعد تلاش کنید.";
    }
    if (step === "catalogue") return `کاتالوگ هم بی‌پاسخ ماند (${reply.code}) — لایهٔ شبکه، نه کد ما.`;
    if (step === "text") return `درخواست متنی بی‌پاسخ ماند (${reply.code}) — نوشتن به کایا مسدود می‌شود.`;
    return `با تصویر بی‌پاسخ ماند (${reply.code}) — حجم یا نوع بدنه مشکل دارد.`;
  }
  if (reply.status >= 200 && reply.status < 300) {
    if (step === "catalogue") return "آدرس و IP ما پذیرفته شد؛ کاتالوگ خوانده شد.";
    if (step === "text") return "کلید، مدل و درخواست متنی سالم است.";
    return "تصویر هم پذیرفته شد.";
  }
  switch (reply.status) {
    case 401:
      return "کلید پذیرفته نشد (یا منقضی شده).";
    case 402:
      return "اعتبار حساب برای این مدل کافی نیست.";
    case 403:
      return "دسترسی این کلید به این مدل بسته است.";
    case 404:
      return "مدل با این شناسه در حساب شما موجود نیست.";
    case 413:
      return "بدنه از سقف کایا بزرگ‌تر است؛ برگه را سبک‌تر کنید.";
    case 429:
      return "محدودیت نرخ از سمت کایا؛ چند دقیقه صبر کنید.";
    default:
      return `کایا پاسخ ${reply.status} داد؛ متن پایین علت را می‌گوید.`;
  }
}

/** One sentence for the whole run, given the steps that actually executed. */
export function conclusionFor(steps: Array<{ step: KayaProbeStep; ok: boolean }>): string {
  const failed = steps.find((step) => !step.ok);
  if (!failed) {
    return "همهٔ لایه‌ها سالم‌اند: شبکه، کلید، مدل، متن و تصویر. اگر تصحیح واقعی خطا می‌دهد، تفاوت در حجم درخواست واقعی است؛ «اندازهٔ درخواست» در همین صفحه آن را می‌سنجد.";
  }
  if (failed.step === "catalogue") {
    return "حتی کاتالوگ هم جواب نداد، پس درخواست ما هرگز به کایا نمی‌رسد. این خطای شبکه/مسیر است و در کد ما قابل رفع نیست.";
  }
  if (failed.step === "text") {
    return "کاتالوگ جواب می‌دهد ولی درخواست نوشتن بی‌پاسخ می‌ماند. همین جمله را برای پشتیبانی کایا بفرستید.";
  }
  return "متن پذیرفته شد ولی تصویر نه؛ سقف حجم یا نوع بدنه را بررسی کنید.";
}
