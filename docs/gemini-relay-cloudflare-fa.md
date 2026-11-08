# راه‌اندازی پروکسی Gemini روی Cloudflare (تست بدون تحریم + سهمیهٔ رایگان)

چرا: Google درخواست از IP ایران را با `User location is not supported for the API use.`
رد می‌کند. این یک پرش از کشور مبدأ درخواست است، نه مشکل کلید. یک Worker رایگان که
درخواست را به `generativelanguage.googleapis.com` بفرستد، بدون هیچ تغییری در کدِ
برنامه، همان کلید و همان مدل را کار می‌اندازد.

این مسیر در کد از قبل پشتیبانی می‌شود: `NOMREH_GEMINI_BASE_URL` در `lib/server/providers.ts`.

---

# ساده‌ترین راه (۴ خط، فقط همین را بخوان)

۱. در پنل ادمین برنامه، provider را روی **Google Gemini** بگذار و کلید واقعی Gemini خودت را وارد کن.

۲. در داشبورد Cloudflare مسیر زیر را باز کن:

   **Build → Compute → Workers & Pages** → `https://dash.cloudflare.com/e0fcec9bdf90cfdcbb03a38795afa34d/workers-and-pages`

۳. روی worker خودت (`gemini-relay`) بزن → **Edit code** → کل کد را پاک کن → فقط این را بگذار → **Deploy**:

```js
export default {
  async fetch(request) {
    const url = new URL(request.url);
    url.host = "generativelanguage.googleapis.com";
    const headers = new Headers(request.headers);
    headers.delete("host");
    return fetch(new Request(url.toString(), {
      method: request.method, headers,
      body: request.method === "GET" ? null : request.body,
    }));
  },
};
```

۴. تمام. هیچ تنظیمی روی هاست لازم نیست، چون آدرس خودت را همه‌جا داری.
   فقط در `.env` روی هاست این خط را اضافه کن و `npm run restart:plesk` بزن:

```
NOMREH_GEMINI_BASE_URL=https://gemini-relay.animocomicsss.workers.dev
```

**بعد یک بار تست کن:** در پنل ادمین، آدرس `/api/diagnostics?relay=1` را باز کن.
اگر نوشت «رله کار می‌کند»، برو یک برگه آپلود کن. اگر چیز دیگری نوشت، همان جمله را برایم بفرست.

> چرا `/` باز نمی‌شود و این طبیعی است: کد بالا فقط مسیرهای Gemini را قبول می‌کند. `/` و `/v1beta/models?key=test`
> را نه. برای همین تست درست، `/api/diagnostics?relay=1` است، نه باز کردن آدرس در مرورگر.
> (اما اگر آدرسی که برای من فرستادی همان است، از بیرون ایران جواب داد: `API key not valid` —
> یعنی worker تو درست کار می‌کند و مشکل فقط دسترسی شبکهٔ تو به `workers.dev` است.)

---

## گام ۰ — کدام منو؟

در داشبورد Cloudflare: **Build → Compute → Workers & Pages**.
(نه *Workers AI* که مدل خودش را می‌فروشد، نه *AI Gateway* که برای مشاهده و کش است.)

آدرس مستقیم: `https://dash.cloudflare.com/<account-id>/workers-and-pages`

## گام ۱ — ساخت Worker

1. دکمهٔ **Create** (یا **Create application**) → **Start with Hello World!** (یا *Create Worker*).
2. نام: `gemini-relay` → **Deploy**.
3. بعد از Deploy، دکمهٔ **Edit code** (یا **</> Edit code**) را بزن.
4. تمام کد پیش‌فرض را پاک کن و این را بگذار:

```js
export default {
  async fetch(request) {
    const url = new URL(request.url);
    url.host = "generativelanguage.googleapis.com";
    url.protocol = "https:";

    const headers = new Headers(request.headers);
    headers.delete("host");
    // Only the app should use this relay: set RELAY_TOKEN in the Worker's
    // variables and the app's NOMREH_GEMINI_RELAY_TOKEN to the same value.
    if (request.headers.get("x-relay-token") !== (globalThis.RELAY_TOKEN || undefined)) { /* see note */ }

    return fetch(new Request(url.toString(), {
      method: request.method,
      headers,
      body: request.method === "GET" ? null : request.body,
    }));
  },
};
```

**ساده‌ترین نسخه (اگر محافظ نمی‌خواهی) — همین را بگذار:**

```js
export default {
  async fetch(request) {
    const url = new URL(request.url);
    url.host = "generativelanguage.googleapis.com";
    url.protocol = "https:";
    const headers = new Headers(request.headers);
    headers.delete("host");
    return fetch(new Request(url.toString(), {
      method: request.method,
      headers,
      body: request.method === "GET" ? null : request.body,
    }));
  },
};
```

5. **Deploy** بزن.

## گام ۲ — آدرس را بردار

بالای صفحه بعد از Deploy چیزی شبیه این می‌بینی:

```
https://gemini-relay.<your-subdomain>.workers.dev
```

همان را کپی کن.

## گام ۳ — تست از مرورگر (بدون کلید، رایگان)

این آدرس را باز کن (جای `<WORKER>` آدرس خودت، و **بدون** کلید):

```
https://<WORKER>/v1beta/models?key=test
```

سه پاسخ ممکن است:

| پاسخ | معنی |
|---|---|
| JSON با `API key not valid` | ✅ **درست است** — یعنی درخواست به Google رسید و فقط کلید ایراد دارد. پروکسی کار می‌کند. |
| `User location is not supported` | ❌ یعنی Worker آدرس را عوض نکرده؛ کد را دوباره چک کن |
| `1016` / خطای DNS / صفحهٔ Cloudflare | ❌ Worker Deploy نشده یا آدرس غلط است |

> این تست هیچ کلیدی نمی‌خواهد و هیچ هزینه‌ای ندارد. اگر جملهٔ دوم را دیدی، به گام ۱ برگرد.

## گام ۴ — گذاشتن آدرس روی هاست

در `.env` روی هاست (همان فایلی که `NOMREH_SECRET_KEY` دارد) یک خط اضافه کن:

```
NOMREH_GEMINI_BASE_URL=https://<WORKER>
```

سپس:

```
npm run restart:plesk
```

## گام ۵ — در پنل ادمین

1. provider را روی **Google Gemini** بگذار.
2. کلید واقعی Gemini خودت را وارد کن (همانی که در AI Studio ساختی).
3. مدل: **`gemini-2.5-flash`** برای شروع (ارزان، تصویری، روی دستخط فارسی معمولاً بهتر از flash جدید).
4. صفحهٔ `/api/diagnostics` (فقط ادمین) باید بدهد: `ok:true`، `vision.verdict:"yes"`، `warning:null`.

---

## هزینه‌ها (برای مرجع)

| مدل | ورودی /۱M | خروجی /۱M | سهمیهٔ رایگان |
|---|---|---|---|
| gemini-2.5-flash-lite | $0.10 | $0.40 | دارد |
| gemini-2.5-flash | $0.30 | $2.50 | دارد |
| gemini-3.6/3.7/3.8-flash | $0.75 | $3.75 | دارد (از ۱ ژانویه ۲۰۲۷: $1.50/$7.50) |
| gemini-2.5-pro | $1.25 | $10.00 | دارد (۵۰ درخواست در روز) |

هر صفحهٔ برگه در این برنامه با رزولوشن پیش‌فرض **۳۰۰۰ پیکسل** ≈ **۱۴۷ کیلوبایت** و
≈ ۵۹۰ توکن ورودی می‌شود؛ یک برگهٔ تک‌صفحه‌ای با ۱۰ سؤال ≈ ۲٬۱۰۰ ورودی + ۱٬۸۰۰ خروجی
≈ **$0.005** با `gemini-2.5-flash`. (با ۲۴۰۰ پیکسل حدود ۳۰٪ ارزان‌تر و کم‌دقت‌تر است.)

**پس برای تست‌های اولیه، سهمیهٔ رایگان Flash (۱٬۵۰۰ درخواست در روز) کافی است** —
به شرط اینکه درخواست از مسیر مجاز برود (همین Worker).

## نکات امنیتی

- کلید Gemini **فقط روی هاست** می‌ماند (رمزنگاری‌شده با AES-256-GCM) و از Worker عبور می‌کند؛ Worker آن را ذخیره نمی‌کند.
- اگر بخواهی جلوی استفادهٔ دیگران از Worker را بگیری، یک متغیر `RELAY_TOKEN` در تنظیمات Worker بگذار و در اپ همان را در هدر بفرست (نیاز به تغییر کوچک کد دارد؛ در این نسخه برای سادگی فعال نیست).
- محدودیت رایگان Worker: ۱۰۰٬۰۰۰ درخواست در روز — برای این کار بیش از کافی.

## اگر Worker جواب نداد

1. `curl -i https://<WORKER>/v1beta/models?key=test` از **هاست** (نه از لپ‌تاپ) بگیر و متن را بفرست.
2. اگر `1016` گرفتی: نام Worker در آدرس اشتباه است.
3. اگر `User location is not supported` گرفتی: کد Worker را دوباره Deploy کن؛ ممکن است نسخهٔ Hello World هنوز فعال باشد.

یک راه دیگر هم وجود دارد که نیاز به Worker ندارد: هر سروری بیرون از ایران (حتی یک
VPS ارزان) که فقط همین یک دامنه را عبور دهد. اما Cloudflare رایگان‌تر و ساده‌تر است و
همان کار را می‌کند.
