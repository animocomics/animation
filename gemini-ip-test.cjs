#!/usr/bin/env node
/**
 * آیا از این IP می‌شود به Gemini وصل شد؟
 *
 * با زبان خود node نوشته شده و به هیچ چیزی نصب‌شده وابسته نیست — همین فایل را روی همان
 * سروری بگذار که برنامه رویش است و اجرا کن:
 *
 *     GEMINI_API_KEY=AIza... node gemini-ip-test.cjs
 *
 * چهار مرحله را جدا گزارش می‌کند، چون سه شکست کاملاً متفاوت در نگاه اول یک‌شکل‌اند:
 * شبکه نرسید / گوگل از نظر کشور رد کرد / کلید یا مدل مشکل دارد.
 * فقط مرحلهٔ ۳ یک تصویر می‌فرستد، و همان چیزی است که واقعاً باید کار کند.
 */

const KEY = process.env.GEMINI_API_KEY || process.argv[2] || "";
const BASE = (process.env.GEMINI_BASE || "https://generativelanguage.googleapis.com").replace(/\/+$/, "");
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 25000);

/** یک تصویر ۱۲۰×۴۸ که فقط عدد «۷» در آن است (۶۷۱ بایت PNG). */
const SEVEN_PNG = "iVBORw0KGgoAAAANSUhEUgAAAHgAAAAwCAYAAADab77TAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAJJSURBVHic7Zq/y0FhGIZvUlIsFilKihgMDJQMZvkDDCYplEGs/g+DQRkYlEWhlEXOYDAxyK/JpJTFoHS+8evrnOEbnPPW8z5XneV+z3BzuU8Ki6qqKhiyWEUXYIyFBROHBROHBROHBROHBROHBROHBROHBROHBROHBROHBROHjODRaASLxfKV63w+i345X4OMYEYfFkwcFqyD3W4XXeFr2EQX+BZ+vx/tdvvf92+3W0ynU01eKpXg8/m+3E4cFhn/0fH5fJDP5zGfzzVnq9UKmUxGSC8jkPIRrSiKrtxcLod0Oi2kk1FIKbjX6+nmlUoFViutt0S6R/Rut0MsFtPk8Xgc6/UaDodDSC+joPVx/QeDwUA3r9fr5ORCtgXfbjcEg0G83+8/udfrxW63g9vtFtbNKKRa8Gg00sgFgEajQVIuZFrw8/lEIpHA5XLRnF2vVwQCASG9jEaaBU8mE125zWaTrFzIIvj9fqPT6eieFYtF0/uYiRSCl8slFEXR5IVCAfF4XEgnsyAvWFVVdLtd3bNyuWx6H7Mh/yVrs9kglUpp8mw2i8ViAZuNzO8tupBfcL/f181rtRp5uaC+4NPphFAopMmj0Sg2mw2cTqeQXmZCesHD4VA3r9frUsgF5QXf73dEIhE8Ho8/ucvlwvF4hMfjEdbNTMgueDwea+QCQKvVkkYuqC749XohmUxiv99rzg6HA8LhsJBeIiC54Nlspiu3Wq1KJRdUF8z8QnLBzC8smDgsmDgsmDgsmDgsmDgsmDgsmDgsmDg/INiyZOCZ1KcAAAAASUVORK5CYII=";

const line = (n, status, text) => console.log(`${n} ${status}  ${text}`);

async function timedFetch(url, init = {}) {
  const started = Date.now();
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { response, ms: Date.now() - started };
  } catch (error) {
    const message = (error && (error.cause?.message || error.message)) || String(error);
    const code = error?.cause?.code || error?.code || "";
    return { error: `${message}${code ? ` (${code})` : ""}`, ms: Date.now() - started };
  }
}

function explainTransport(message) {
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) return "DNS جواب نداد — نام دامنه حل نمی‌شود.";
  if (/ECONNREFUSED/i.test(message)) return "اتصال رد شد (پورت بسته).";
  if (/ECONNRESET|socket hang up/i.test(message)) return "اتصال وسط راه قطع شد — احتمالاً فیلتر مسیر.";
  if (/CERT|TLS|SSL|self.signed/i.test(message)) return "خطای گواهی/رمزنگاری — معمولاً یعنی یک واسطه درخواست را می‌شکند.";
  if (/abort|timeout/i.test(message)) return `در ${Math.round(TIMEOUT_MS / 1000)} ثانیه جوابی نرسید — یعنی بسته‌ها می‌روند و برنمی‌گردند.`;
  return "";
}

async function main() {
  console.log("\n=== آزمون دسترسی به Gemini از این ماشین ===");
  console.log(`آدرس: ${BASE}`);
  console.log(`مدل:  ${MODEL}`);
  console.log(`کلید: ${KEY ? `هست (${KEY.slice(0, 6)}…، ${KEY.length} کاراکتر)` : "ندارد"}`);
  console.log("(کلید هیچ‌جا ذخیره یا ارسال نمی‌شود، جز همان درخواست‌های زیر)\n");

  // ۱. آیا اصلاً به گوگل می‌رسیم؟ بدون کلید، پس مطمئناً رایگان است.
  //    نشانهٔ رسیدن این است که گوگل جواب خودش را بدهد؛ ۴۰۰ «کلید نامعتبر» هم رسیدن است.
  const net = await timedFetch(`${BASE}/v1beta/models?pageSize=1`);
  if (net.error) {
    line("1", "❌", `به ${BASE} نرسیدیم در ${net.ms}ms: ${net.error}`);
    const why = explainTransport(net.error);
    if (why) console.log(`     ${why}`);
    console.log("\nنتیجه: مشکل شبکه است، نه Gemini و نه کلید. هر تلاش دوباره از همین IP همین نتیجه را دارد.");
    return;
  }
  const netBody = await net.response.text().catch(() => "");
  const reachesGoogle = net.response.ok || /api key|API_KEY_INVALID|User location/i.test(netBody);
  line("1", reachesGoogle ? "✅" : "⚠️", `TCP/TLS وصل شد، کد ${net.response.status} در ${net.ms}ms`);
  if (/User location is not supported/i.test(netBody)) {
    console.log("     ⚠️ گوگل صریحاً گفت: «موقعیت این ماشین پشتیبانی نمی‌شود» — یعنی همین حالا بلاک کشور است.");
    console.log("     این جمله فقط از خود گوگل می‌آید و یعنی درخواست واقعاً به گوگل رسیده است.");
  } else if (!reachesGoogle) {
    console.log(`     پاسخ از گوگل نبود: ${netBody.replace(/\s+/g, " ").slice(0, 160)}`);
  }

  // ۲. آیا این IP به گوگل «ایرانی» معرفی می‌شود؟ یک سرویس بی‌طرف.
  const geo = await timedFetch("https://ipinfo.io/json");
  if (!geo.error) {
    const info = await geo.response.json().catch(() => ({}));
    const where = [info.country, info.city, info.org].filter(Boolean).join(" / ");
    line("2", "ℹ️", `گوگل از بیرون، این ماشین را این‌جا می‌بیند: ${where || "نامعلوم"}`);
    if (info.country && !["IR"].includes(String(info.country).toUpperCase())) {
      console.log("     پس IP خروجی این ماشین ایرانی نیست؛ اگر بلاک بگیری، علتش جای دیگری است.");
    }
  } else {
    line("2", "⚠️", `نشد کشور خروجی را دید (${geo.error}) — این مرحله اختیاری است و چیزی را خراب نمی‌کند.`);
  }

  if (!KEY) {
    line("3", "⏭️", "مرحلهٔ خواندن تصویر رد شد: کلید داده نشده. با GEMINI_API_KEY=... دوباره اجرا کن.");
    return;
  }

  // ۳. خودِ کار: یک تصویر واقعی با پاسخ JSON. این تنها مرحله‌ای است که سهمیه مصرف می‌کند
  //    و فقط حدود ۳۰۰ توکن — چون یک تصویر ۱۲۰×۴۸ است، نه یک برگه.
  const read = await timedFetch(`${BASE}/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        role: "user",
        parts: [
          { text: 'این تصویر چه عددی است؟ فقط JSON بده: {"answer":"عدد"}' },
          { inline_data: { mime_type: "image/png", data: SEVEN_PNG } },
        ],
      }],
      generationConfig: { responseMimeType: "application/json", maxOutputTokens: 64, temperature: 0 },
    }),
  });
  if (read.error) {
    line("3", "❌", `درخواست خواندن نرفت: ${read.error}`);
    const why = explainTransport(read.error);
    if (why) console.log(`     ${why}`);
    return;
  }
  const body = await read.response.text().catch(() => "");
  if (!read.response.ok) {
    line("3", "❌", `گوگل درخواست را رد کرد: ${read.response.status} در ${read.ms}ms`);
    let detail = body;
    try {
      const parsed = JSON.parse(body);
      detail = parsed.error?.message || body;
      const reasons = parsed.error?.details?.map((d) => d.reason).filter(Boolean) || [];
      const quota = JSON.stringify(parsed.error?.details || "").match(/"quotaId":"([^"]+)"/)?.[1];
      if (reasons.length) console.log(`     دلیل‌ها: ${reasons.join(", ")}`);
      if (quota) console.log(`     سهمیهٔ درگیر: ${quota}`);
    } catch { /* بدنهٔ غیر-JSON هم قابل نمایش است */ }
    console.log(`     پیام گوگل: ${String(detail).replace(/\s+/g, " ").slice(0, 300)}`);
    if (/location is not supported/i.test(body)) {
      console.log("     ⇒ این همان بلاک کشور است. تنها راه: مسیر خروجی (رله)، نه تغییر کلید و نه تلاش دوباره.");
    } else if (/api key not valid|api_key_invalid/i.test(body)) {
      console.log("     ⇒ خود گوگل گفت کلید معتبر نیست. کلید را از AI Studio برای همان پروژه بساز؛ کلید Gemini با AIza شروع می‌شود.");
    } else if (read.response.status === 429) {
      console.log("     ⇒ سهمیهٔ رایگان همین حساب پر است (نه کلید خراب). سهمیهٔ روزانه نیمه‌شب اقیانوس آرام از نو پر می‌شود.");
    }
    return;
  }
  let answer = "";
  try {
    const parsed = JSON.parse(body);
    answer = parsed.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
    const usage = parsed.usageMetadata || {};
    console.log(`     مصرف: ${usage.promptTokenCount ?? "?"} ورودی / ${usage.candidatesTokenCount ?? "?"} خروجی`);
  } catch { /* بدنهٔ نامنتظره */ }
  const correct = /7|۷|هفت/.test(answer);
  line("3", correct ? "✅" : "⚠️", `تصویر خوانده شد (${read.ms}ms). پاسخ مدل: ${answer.replace(/\s+/g, " ").slice(0, 120)}`);
  console.log(correct
    ? "\nنتیجه: از این IP، Gemini هم وصل می‌شود و هم تصویر می‌خواند. مشکل مسیر نیست."
    : "\nنتیجه: اتصال و کلید سالم‌اند، ولی پاسخ عدد ۷ نبود — این مدل تصویر را درست نخواند.");
  console.log("برای برگه‌های واقعی چند نکته: هر برگهٔ دست‌نویس حدود ۱۹٬۰۰۰ توکن ورودی است، و سهمیهٔ رایگان روزانه محدود است.");
}

main().catch((error) => {
  console.log(`\nخطای پیش‌بینی‌نشده: ${error && error.message ? error.message : error}`);
  process.exitCode = 1;
});
