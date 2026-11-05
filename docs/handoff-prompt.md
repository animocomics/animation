# پرامپت آماده برای ایجنت جدید

متن زیر را کپی کنید و به‌عنوان **پیام اول** به ایجنت جدید بدهید.

---

## نسخهٔ فارسی

```
تو ایجنتی هستی که باید یک مشکل واقعی روی یک هاست زنده (Plesk) را حل کنی و بعد پروژهٔ «نمره» را تا کارکرد کامل ببری.

مخزن: https://github.com/animocomics/animation (عمومی)
شاخهٔ کاری: arena/dfdcef22-animation
اپ: پلتفرم فارسی تصحیح برگهٔ امتحان با AI — Next.js 16، RTL، Vazirmatn
آدرس سایت: https://nomreh.arounidea.com

اول این فایل را کامل بخوان، بعد دست به کار شو:
docs/handoff-agent-brief.md

خلاصهٔ وضعیت: سرور هیچ اتصال خروجی به اینترنت ندارد. حتی 1.1.1.1:443 و 1.1.1.1:80 هم timeout می‌شوند، در حالی که DNS سالم است و سایت بالا است. قبلاً همین سرور از GitHub کلون می‌کرد و بعد از نصب v2ray/شکن قطع شد. در پنل، یک محیط QEMU شکن در حال اجراست و اولین مشکوک همان است.

قوانین:
- من فقط به کنسول npm در پنل Plesk دسترسی دارم، نه SSH. هر چیزی که root می‌خواهد باید از هاستینگ درخواست شود؛ متن آماده‌اش در بریف هست.
- هرگز رمز یا کلید یا توکن را چاپ نکن و از من نپرس.
- پوشهٔ ../nomreh-data دادهٔ من است؛ به آن دست نزن.
- هاست Node 17 دارد؛ برای بیلد از npm run setup:plesk استفاده کن که Node 22 می‌سازد.
- بدون اندازه‌گیری واقعی ادعای موفقیت نکن. اگر چیزی را ندیده‌ای، صریح بگو ندیده‌ام.

ترتیب کار:
1. بستهٔ nomreh-deploy-2026-11-05-v9.zip را نصب کن و مطمئن شو diagnosticsVersion در /api/admin/network-diagnostics برابر v9 است.
2. محیط شکن را از پنل کامل متوقف کن، بعد npm run diagnose بزن و نتیجه را با من چک کن.
3. اگر خروجی هنوز بسته بود، IP عمومی سرور را از بیرون بررسی کن و بعد متن تیکت هاستینگ را بده تا بفرستم.
4. به من بگو در هر مرحله دقیقاً چه چیزی می‌بینی، بدون خوش‌بینی.

مهم: مسئله کدنویسی نیست. کد تست‌شده و آماده است. مشکل یک اتصال شبکهٔ بسته در لایهٔ زیرساخت است. اگر شروع کنی به تغییر کد برای حل این، مسیر را اشتباه رفته‌ای.
```

---

## English version

```
You are taking over a live deployment problem on a Plesk host, and then finishing
the Nomreh project end to end.

Repository: https://github.com/animocomics/animation (public)
Working branch: arena/dfdcef22-animation
App: Persian AI exam-grading platform — Next.js 16, RTL, Vazirmatn
Live site: https://nomreh.arounidea.com

Read this first, in full, then start:
docs/handoff-agent-brief.md

Current state: the server has no outbound internet. Even 1.1.1.1:443 and
1.1.1.1:80 time out, while DNS resolves correctly and the site is up. The same
host used to clone from GitHub and stopped after v2ray/Shecan were installed. A
QEMU Shecan guest is currently running in the admin panel and is the first
suspect.

Hard rules:
- I have only the npm console in the Plesk panel, no SSH. Anything requiring root
  must be requested from the hosting provider; the ready-made ticket text is in
  the brief.
- Never print or ask for a password, API key or token.
- ../nomreh-data is my data; do not touch it.
- The host runs Node 17; build with npm run setup:plesk, which provisions Node 22.
- Never claim success without a real measurement. If you have not seen it, say so.

Order of work:
1. Install nomreh-deploy-2026-11-05-v9.zip and confirm diagnosticsVersion is "v9"
   in /api/admin/network-diagnostics.
2. Fully stop the Shecan environment from the panel, then run npm run diagnose and
   review the result with me.
3. If egress is still closed, check the host's public IP from outside, then hand me
   the hosting ticket text so I can send it.
4. Tell me exactly what you see at each step. No optimism without evidence.

Important: this is not a coding problem. The code is tested and ready. The blocker
is a closed network path at the infrastructure layer. If you start editing
application code to work around it, you are on the wrong path.
```

---

## چه چیزی را در پرامپت **نگنجانید** (عمداً)

- ❌ رمز ادمین، کلید Kaya، یا هر secret دیگری.
- ❌ آدرس IP سرور یا اطلاعات ورود Plesk.
- ❌ «لطفاً درستش کن» بدون ترتیب کار — ایجنت بدون ترتیب، کد را دستکاری می‌کند.
- ❌ تاریخچهٔ کامل تلاش‌های قبلی — بریف فقط نتیجه‌ها را دارد، نه مسیرهای بسته.
