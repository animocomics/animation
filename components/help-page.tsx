"use client";

import Link from "next/link";
import { useState } from "react";
import {
  ArrowLeft,
  BookOpenCheck,
  Camera,
  Check,
  ChevronDown,
  CircleAlert,
  CloudSun,
  Download,
  FileCheck2,
  FileStack,
  Image,
  KeyRound,
  Lightbulb,
  ListChecks,
  LockKeyhole,
  ScanLine,
  ShieldCheck,
  Sparkles,
  UploadCloud,
  UserCheck,
} from "lucide-react";

const faqs = [
  { question: "آیا نمره از OCR جداگانه استفاده می‌کند؟", answer: "نه. عکس مستقیم به مدل چندوجهی داده می‌شود. PDF برای OpenAI و Gemini مستقیم ارسال می‌شود و برای DeepSeek، Z.AI GLM، MiniMax، Inkling-Small و Mistral Large 4 ابتدا داخل سرور «نمره» به تصویر صفحه تبدیل می‌شود؛ این تبدیل فقط Renderer است، نه سرویس OCR جداگانه. مدل دست‌خط و شکل را می‌بیند، اما خطای خواندن ممکن است و رونوشت باید در موارد مبهم با فایل اصلی مقایسه شود." },
  { question: "آیا می‌توان دقت تصحیح را صددرصد تضمین کرد؟", answer: "نه. هیچ مدل چندوجهی‌ای برای همهٔ دست‌خط‌ها و سؤال‌ها صددرصد قابل تضمین نیست. نمره برای کاهش خطا از کلید و بارم دقیق، خروجی ساختاریافته، محاسبهٔ مجدد نمرات، تطبیق قطعی تستی‌ها، هشدار ابهام و ممیزی دوم استفاده می‌کند. برای آزمون مهم، تأیید معلم و کالیبراسیون با نمونهٔ واقعی ضروری است." },
  { question: "API Key کجا و توسط چه کسی مدیریت می‌شود؟", answer: "فقط مدیر سامانه در صفحهٔ مدیریت می‌تواند کلید را وارد، آزمایش و تغییر دهد. کلید با AES-256-GCM روی سرور رمزنگاری می‌شود و هرگز در پاسخ API یا مرورگر معلم قرار نمی‌گیرد. معلم فقط وضعیت متصل یا غیرفعال بودن سرویس را می‌بیند." },
  { question: "نام و کلاس دانش‌آموز چگونه تشخیص داده می‌شود؟", answer: "مدل نام و عنوان کلاس را فقط از مدرک روی برگه استخراج می‌کند. موتور تطبیق، نام نرمال‌شده را با فهرست همان کلاس می‌سنجد و در تطبیق قطعی، نام و کد را خودکار تکمیل می‌کند. نام تکراری، اطمینان پایین، کلاس متفاوت یا ناسازگاری با انتساب قبلی به تأیید معلم ارجاع می‌شود و به‌صورت خودکار روی ردیف دیگری ثبت نمی‌شود." },
  { question: "دادهٔ معلم‌ها از یکدیگر جدا است؟", answer: "بله. هر معلم با نام کاربری و رمز خود وارد می‌شود و کلاس‌ها، آزمون‌ها، نتایج و فایل‌هایش با شناسهٔ همان حساب روی سرور نگه‌داری می‌شود. مسیرهای فایل، فضای کاری و تصحیح نشست معتبر لازم دارند و مدیر نیز در گزارش مصرف فقط متادیتای فنی را می‌بیند، نه محتوای برگه‌ها را." },
  { question: "آیا DeepSeek، Z.AI GLM، MiniMax، Inkling-Small و Mistral هم PDF می‌پذیرند؟", answer: "بله. PDF را همان‌طور بارگذاری و پیش‌نمایش کنید؛ «نمره» صفحات آن را با وضوح مناسب دست‌خط، داخل سرور و بدون سرویس خارجی به JPEG تبدیل و برای مدل انتخابی می‌فرستد. فایل اصلی PDF برای بازبینی حفظ می‌شود. هر PDF تا ۲۰ صفحه و هر تصحیح تا ۳۰ صفحه/فایل پشتیبانی می‌شود؛ PDF رمزدار یا خراب پیش از مصرف مدل خطای واضح می‌دهد." },
  { question: "چطور GLM 5.3 Flash را فعال کنم؟", answer: "مدیر در «مدیریت سامانه»، بخش اتصال هوش مصنوعی، گزینهٔ Z.AI GLM و مدل glm-5.3-flash را انتخاب و کلید API را وارد می‌کند. آزمایش اتصال و ذخیره فقط در دسترس مدیر است؛ معلم‌ها کلید یا تنظیمات سرویس را نمی‌بینند." },
  { question: "MiniMax، Inkling-Small و Mistral Large 4 چطور فعال می‌شوند؟", answer: "مدیر Provider را در «مدیریت سامانه» انتخاب می‌کند و API Key همان سرویس را وارد می‌کند: MiniMax برای M3.1 Flash/M3، Mistral AI برای Large 4 با Reasoning High، و Tinker برای Inkling-Small. Inkling از مسیر رسمی Tinker استفاده می‌کند و ورودی تصویری آن در این مسیر PNG/JPEG است؛ Serverless Inference آن فعلاً Beta است. Mistral Large 4 نیز Public Preview است. آزمایش اتصال قبل از ذخیره، دسترسی واقعی حساب به مدل را بررسی می‌کند." },
  { question: "سؤال‌ها و کلید را از کجا وارد کنم؟", answer: "در «آزمون جدید»، گام ۲ می‌توانید سؤال‌ها را دستی وارد کنید یا چند عکس/PDF سؤال و پاسخ‌نامهٔ معلم را در بخش «خواندن سؤال و کلید از برگه» اضافه کنید. نقش هر فایل را مشخص کنید و پیش‌نویس را بسازید. صورت، نوع، نمره، کلید و جمع بارم هر سؤال را با برگهٔ اصلی مقایسه و ویرایش کنید؛ تا تأیید صریح شما، تصحیح انجام نمی‌شود. متن ناخوانا یا تطبیق مبهم حدس زده نمی‌شود و با خطای قابل مشاهده متوقف می‌شود." },
  { question: "برای چند صفحه یا چند عکس از یک دانش‌آموز چه کنم؟", answer: "ابتدا دانش‌آموز را جدا اضافه کنید و سپس با دکمهٔ «افزودن صفحه / فایل» همهٔ عکس‌ها یا PDFهای همان دانش‌آموز را به کارت او بدهید. در بارگذاری گروهی، هر فایل به‌صورت پیش‌فرض یک دانش‌آموز جدید می‌شود؛ اگر همهٔ صفحات مربوط به یک نفر است، یک PDF چندصفحه‌ای بسازید یا فایل‌ها را در کارت همان نفر اضافه کنید." },
  { question: "اگر مدل دست‌خط را نفهمد چه اتفاقی می‌افتد؟", answer: "دستور موتور تصحیح این است که از [ناخوانا] استفاده کند و هشدار illegible ثبت کند، نه اینکه متن را حدس بزند. نمرهٔ مبهم به‌صورت موقت صفر و نیازمند بازبینی نگه داشته می‌شود؛ این صفر به معنی غلط بودن پاسخ نیست. معلم تصویر اصلی را می‌بیند، نمره را اصلاح می‌کند و هشدار را بررسی‌شده علامت می‌زند." },
  { question: "هزینه و زمان تصحیح به چه چیزی بستگی دارد؟", answer: "به مدل، تعداد و وضوح صفحات، تعداد سؤال‌ها و طول خروجی بستگی دارد. حالت دقیق برای موارد پرچم‌دار یک درخواست ممیزی اضافه می‌کند و هزینهٔ بیشتری دارد. تصویر واضح با اندازهٔ متعارف، بارم کوتاه و دسته‌های دانش‌آموزمحور به کنترل هزینه کمک می‌کند." },
];

export function HelpPage() {
  const [openFaq, setOpenFaq] = useState(0);
  return (
    <div className="help-page">
      <section className="help-hero card"><div><span className="help-hero-badge"><Sparkles size={14} />راهنمای تصحیح قابل اتکا</span><h2>از یک برگهٔ کاغذی تا نمرهٔ قابل دفاع</h2><p>نمره کار تکراری خواندن و ارزیابی را تسریع می‌کند؛ شما با شواهد، معیارها و حق تصمیم نهایی در مرکز فرایند هستید.</p><div className="help-hero-actions"><Link href="/grading" className="btn btn-primary">شروع تصحیح <ArrowLeft size={16} /></Link><a href="/master-plan.fa.md" download className="btn btn-secondary"><Download size={16} />دریافت مسترپلن</a></div></div><div className="help-flow-visual"><div><FileStack size={22} /><span>سؤال و بارم</span></div><i /><div><ScanLine size={22} /><span>خواندن تصویر</span></div><i /><div><ListChecks size={22} /><span>ارزیابی با شاهد</span></div><i /><div><UserCheck size={22} /><span>تأیید معلم</span></div></div></section>

      <section className="help-section"><div className="help-section-title"><span>۰۱</span><div><h3>شروع سریع در چهار گام</h3><p>اولین آزمون واقعی را با همین مسیر بسازید.</p></div></div><div className="help-steps-grid">{[
        { icon: BookOpenCheck, title: "کلاس و مشخصات", text: "ابتدا کلاس و فهرست دانش‌آموزان را بسازید؛ سپس درس، کد یکتای آزمون، حد قبولی و حالت دقت را تعیین کنید." },
        { icon: ListChecks, title: "کلید و بارم ریز", text: "سؤال و کلید را دستی وارد کنید یا از چند تصویر/PDF پیش‌نویس بسازید؛ سپس پاسخ مرجع، پاسخ جایگزین و امتیاز هر گام را بررسی کنید. جمع معیارها باید دقیقاً با نمرهٔ سؤال برابر باشد." },
        { icon: UploadCloud, title: "بارگذاری و تطبیق", text: "برگه‌ها را بارگذاری کنید. نام و کلاس از تصویر خوانده و با فهرست تطبیق داده می‌شود؛ برگهٔ مفقود و انتساب مبهم هشدار می‌گیرد." },
        { icon: UserCheck, title: "بازبینی و انتشار", text: "هشدارها را از روی برگهٔ اصلی بررسی، در صورت نیاز نمره را اصلاح و سپس تأیید نهایی و خروجی بگیرید." },
      ].map((item, index) => { const Icon = item.icon; return <article className="card help-step-card" key={item.title}><span className="help-step-number">{index + 1}</span><Icon size={22} /><h4>{item.title}</h4><p>{item.text}</p></article>; })}</div></section>

      <section className="help-two-columns">
        <article className="card scan-guide-card"><div className="help-card-heading"><span className="settings-heading-icon"><Camera size={21} /></span><div><h3>عکس بهتر، خواندن دقیق‌تر</h3><p>کیفیت ورودی مهم‌ترین اصلاح بدون هزینه است.</p></div></div><div className="scan-guide-body"><div className="scan-do"><h4><Check size={16} />این کارها را بکنید</h4><ul><li>صفحه را صاف، کامل و عمود بر دوربین بگیرید.</li><li>نور یکنواخت و بدون سایهٔ دست یا گوشی داشته باشید.</li><li>کناره‌ها و شمارهٔ سؤال‌ها داخل کادر باشند.</li><li>هر صفحه جدا و با وضوح کافی ذخیره شود.</li></ul></div><div className="scan-dont"><h4><CircleAlert size={16} />از این موارد پرهیز کنید</h4><ul><li>عکس تار، تیره، برش‌خورده یا از زاویهٔ شدید</li><li>فشرده‌سازی شدید و ارسال دوباره در پیام‌رسان</li><li>مخلوط‌کردن برگهٔ دو دانش‌آموز در یک فایل</li><li>پنهان‌کردن بخش خط‌خورده با برش تصویر</li></ul></div></div><div className="scan-formats"><span><Image size={15} />JPG · PNG · WebP</span><span><FileCheck2 size={15} />PDF چندصفحه‌ای</span><span><CloudSun size={15} />حداکثر ۱۰۰ مگابایت هر فایل</span></div></article>

        <article className="card rubric-guide-card"><div className="help-card-heading"><span className="settings-heading-icon amber"><Lightbulb size={21} /></span><div><h3>یک بارم خوب چه شکلی است؟</h3><p>به‌جای «پاسخ صحیح را نمره بده»، معیار قابل مشاهده بنویسید.</p></div></div><div className="rubric-example"><span className="rubric-example-label">نمونه برای یک سؤال ۵ نمره‌ای</span><div><span><b>۱٫۵</b> انتخاب رابطهٔ درست</span><small>رابطه متناسب با صورت سؤال نوشته شده باشد.</small></div><div><span><b>۲</b> جایگذاری و محاسبه</span><small>عددها درست جایگذاری و حاصل محاسبه شود.</small></div><div><span><b>۱٫۵</b> واحد و نتیجه‌گیری</span><small>واحد صحیح و پاسخ نهایی روشن باشد.</small></div></div><div className="notice notice-success"><ShieldCheck size={17} /><span>در محاسبات، «خطای انتقالی» را فعال کنید تا یک اشتباه اولیه در همهٔ گام‌ها دوباره جریمه نشود.</span></div></article>
      </section>

      <section className="help-section faq-section"><div className="help-section-title"><span>۰۲</span><div><h3>پرسش‌های مهم پیش از استفاده</h3><p>شفاف دربارهٔ دقت، داده، هزینه و محدودیت‌ها.</p></div></div><div className="faq-list card">{faqs.map((faq, index) => <article className={`faq-item ${openFaq === index ? "open" : ""}`} key={faq.question}><button onClick={() => setOpenFaq(openFaq === index ? -1 : index)} aria-expanded={openFaq === index}><span>{faq.question}</span><ChevronDown size={18} /></button>{openFaq === index && <p>{faq.answer}</p>}</article>)}</div></section>

      <section className="help-bottom-cta"><span><KeyRound size={22} /></span><div><h3>برای یک تصحیح واقعی آماده‌اید؟</h3><p>ابتدا فهرست کلاس را کامل کنید و با چند برگهٔ نمونه، دقت تطبیق هویت و بارم را بسنجید.</p></div><Link href="/classes" className="btn btn-secondary">مدیریت کلاس‌ها</Link><Link href="/grading" className="btn btn-primary">ساخت آزمون <ArrowLeft size={15} /></Link></section>
    </div>
  );
}
