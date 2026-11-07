# چرا کایا از این سرور جواب نمی‌دهد — تشخیص با دستور، بدون حدس

تاریخ: ۲۰۲۶-۱۱-۰۷

## نتیجهٔ کوتاه

یک دستور روی همان هاست اجرا کنید؛ اگر خط ۴ جواب بدهد و خط ۳ نه، یعنی **همان IP و همان پورت
برای یک نام دیگر کار می‌کند ولی برای نام `kayaai.ir` سرویس‌دهندهٔ شما/مسیر شبکه اتصال را می‌بندد**.
این با کد و با نسخهٔ جدید برنامه حل نمی‌شود؛ باید مسیر عوض شود.

## ۱) دستور اصلی (یک خط، بدون نصب چیزی)

در Plesk → Node.js → دکمهٔ ترمینال/اجرای npm، این خط را کامل کپی کنید:

```
node -e 'const h=require("https"),t=require("tls"),n=require("net"),d=require("dns").promises;const T=9000;const get=u=>new Promise(r=>{const s=Date.now(),U=new URL(u);const q=h.request({host:U.hostname,port:443,path:U.pathname,rejectUnauthorized:false,timeout:T,headers:{"User-Agent":"nomreh"}},x=>{let b="";x.on("data",c=>{if(b.length<2000)b+=c});x.on("end",()=>r({st:x.statusCode,ms:Date.now()-s,b:b}))});q.on("timeout",()=>q.destroy(Object.assign(new Error("t"),{code:"TIMEOUT"})));q.on("error",e=>r({st:0,ms:Date.now()-s,code:e.code}));q.end()});const tcp=(a,p)=>new Promise(r=>{const s=Date.now();const k=n.createConnection({host:a,port:p||443});let f=0;const z=v=>{if(f)return;f=1;k.destroy();r(v+" "+(Date.now()-s)+"ms")};k.setTimeout(T);k.once("connect",()=>z("CONNECTED"));k.once("timeout",()=>z("TIMEOUT"));k.once("error",e=>z(e.code))});const hs=(name,a)=>new Promise(r=>{const s=Date.now();const k=t.connect({host:a,port:443,servername:name,rejectUnauthorized:false,timeout:T},()=>{const p=k.getPeerCertificate()||{};r("OK issuer="+((p.issuer||{}).O||"?")+" "+(Date.now()-s)+"ms");k.destroy()});k.setTimeout(T,()=>k.destroy(Object.assign(new Error("t"),{code:"TIMEOUT"})));k.once("error",e=>r("FAILED "+e.code+" "+(Date.now()-s)+"ms"))});(async()=>{const o=[];try{o.push("1 dns      kayaai.ir = "+(await d.resolve4("kayaai.ir")).join(","))}catch(e){o.push("1 dns      FAILED "+e.code)}o.push("2 tcp      kayaai.ir:443 = "+await tcp("213.176.6.243"));o.push("3 tls      name=kayaai.ir = "+await hs("kayaai.ir","213.176.6.243"));o.push("4 tls      name=www.bing.com on same ip = "+await hs("www.bing.com","213.176.6.243"));o.push("5 http     GET https://kayaai.ir/ = "+await (async()=>{const g=await get("https://kayaai.ir/");return g.st?("HTTP "+g.st+" "+g.b.length+"B"):("FAILED "+g.code)})());o.push("6 http     GET /api/chat/completions = "+await (async()=>{const g=await get("https://kayaai.ir/api/chat/completions");const ok=g.st===200&&(g.b||"").indexOf("\"list\"")>0;return ok?"HTTP 200 catalogue OK":(g.st?("HTTP "+g.st):("FAILED "+g.code))})());console.log(o.join("\n"))})()'
```

اسم API Key نمی‌خواهد، چیزی روی دیسک نمی‌نویسد، و جمعاً ۶ درخواست است — یک‌بار اجرا کنید و
خروجی را بفرستید. اگر خواستید دفعهٔ بعد باز اجرا کنید مشکلی نیست.

## ۲) نسخهٔ آماده در خود پروژه

اگر v17 را نصب کرده‌اید:

```
npm run kaya:diag
```

فایلش: `scripts/nomreh-kaya-diag.cjs` — همان ۶ بررسی به‌اضافهٔ IP خروجی و بررسی POST.

## ۳) چطور خروجی را بخوانیم

| خط | معنی |
| --- | --- |
| ۱ dns آدرسی جز `213.176.6.243` | DNS یک مسیر دیگر داده؛ باید همان را بررسی کنیم |
| ۲ tcp = `CONNECTED` | شبکه تا خود سرور کایا باز است (پس فیلتر DNS/آدرس نیست) |
| ۳ tls کایا `ECONNRESET` و ۴ هم `ECONNRESET` | همه‌چیز روی همان IP بسته است ⇒ فیلتر سمت کایا/مسیر ما، نه اسم |
| ۳ کایا `ECONNRESET` ولی ۴ `OK issuer=…` | **مهم‌ترین حالت**: نام `kayaai.ir` در مسیر شناسایی و قطع می‌شود |
| ۵ یا ۶ کد `HTTP 200/401/429` | مسیر باز است؛ مشکل در کلید یا مدل است، نه شبکه |

## ۴) دو نامهٔ کوتاه

**به کایا** (پشتیبانی، کوتاه):

> سلام. از سرور ما (IP خروجی: `185.192.112.49`، گاهی `51.81.168.118`) به `kayaai.ir`
> اتصال TCP روی ۴۴۳ برقرار می‌شود ولی بلافاصله `ECONNRESET` می‌گیریم؛ حتی `GET /` هم جواب
> نمی‌دهد. `GET /api/chat/completions` از IPهای دیگر (آمریکا/اروپا) ۲۰۰ می‌دهد، پس سرویس
> سالم است. آیا IP ما بلاک شده؟ لطفاً allowlist کنید یا بفرمایید چه چیزی را باید تغییر دهیم.

**به Radcom** (کوتاه — نه گزارش بلند):

> از سرور ما (`185.192.112.49`) به `213.176.6.243:443` اتصال TCP برقرار می‌شود اما
> handshake بلافاصله `ECONNRESET` می‌شود؛ همان IP و همان پورت با نام دیگر هم `ECONNRESET`
> می‌شود. سایت‌های دیگر (GitHub، DigiKala) سالم‌اند. آیا برای این مقصد فیلتر یا MTU/IPS
> خاصی روی مسیر ما فعال است؟

## ۵) آنچه ثابت شده و دیگر لازم نیست دوباره آزموده شود

- TLS واقعی است (Google Trust Services / Sectigo) ⇒ MITM نیست.
- `ip rule` و `ip route` تمیز است، پروکسی‌ای در کار نیست ⇒ تنظیمات شبکهٔ سرور مقصر نیست.
- `213.176.6.1:443` جواب `ECONNREFUSED` می‌دهد ⇒ کل رنج `213.176.6.0/24` از سمت ما بسته نیست.
- IP خروجی بسته به مقصد فرق می‌کند (`51.81.168.118` یا `185.192.112.49`).
- کایا خودش را «بدون VPN، مخصوص ایران» معرفی می‌کند و از IPهای غیرایرانی هم جواب می‌دهد،
  پس «تحریم شدن کایا برای IP خارجی» توضیح این خطا نیست.
