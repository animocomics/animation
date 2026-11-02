"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Check, ChevronLeft, Database, HardDrive, Info, KeyRound, LockKeyhole, RotateCcw, Save, ShieldCheck, SlidersHorizontal, Sparkles, Trash2, TriangleAlert } from "lucide-react";
import { useApp } from "../lib/app-context";
import { clearStoredFiles } from "../lib/file-store";
import type { WorkspaceSettings } from "../lib/types";
import { faNumber } from "../lib/utils";
import { Modal } from "./ui/primitives";

export function SettingsPage() {
  const { settings, saveSettings, exams, classes, user, providerStatus, resetDemo, clearWorkspace, notify } = useApp();
  const [policy, setPolicy] = useState<WorkspaceSettings>(settings);
  const [clearOpen, setClearOpen] = useState(false);
  const [clearConfirmation, setClearConfirmation] = useState("");
  const [clearing, setClearing] = useState(false);
  useEffect(() => setPolicy(settings), [settings]);

  const savePolicy = () => {
    saveSettings(policy);
    notify({ title: "تنظیمات تصحیح ذخیره شد", description: "این مقادیر برای آزمون‌های جدید استفاده می‌شوند.", variant: "success" });
  };
  const clearAll = async () => {
    setClearing(true);
    try {
      await clearStoredFiles(); clearWorkspace(); setClearOpen(false); setClearConfirmation("");
    } catch { notify({ title: "پاک‌کردن فایل‌ها کامل نشد", description: "دوباره تلاش کنید؛ دادهٔ متنی فضای کاری حفظ شده است.", variant: "error" }); }
    finally { setClearing(false); }
  };

  return <div className="settings-page">
    <section className="page-heading-row"><div><h2>فضای کاری و سیاست‌های تصحیح</h2><p>قواعد پیش‌فرض آزمون‌های شما؛ اتصال API فقط در مدیریت سامانه است.</p></div><span className="badge badge-success"><ShieldCheck size={13} />حساب {user.displayName}</span></section>
    <div className="settings-layout">
      <div className="settings-main-column">
        <section className="card settings-card">
          <div className="settings-card-heading"><span className="settings-heading-icon amber"><SlidersHorizontal size={21} /></span><div><h3>سیاست پیش‌فرض آزمون‌های جدید</h3><p>هر آزمون می‌تواند در گام نخست، تنظیمات مستقل خود را داشته باشد.</p></div></div>
          <div className="settings-card-body policy-settings-body">
            <div className="form-field"><span className="field-label">حالت تصحیح</span><div className="settings-mode-grid">{(["fast", "balanced", "precise"] as const).map((value) => { const content = { fast: ["سریع", "یک ارزیابی", "برای تمرین و آزمون کم‌اهمیت"], balanced: ["متعادل", "ممیزی موارد بحرانی", "تعادل هزینه و کنترل"], precise: ["دقیق", "ممیزی موارد پرچم‌دار", "پیشنهاد برای آزمون رسمی"] }[value]; return <label className={`settings-mode-option ${policy.gradingMode === value ? "selected" : ""}`} key={value}><input type="radio" name="default-mode" checked={policy.gradingMode === value} onChange={() => setPolicy({ ...policy, gradingMode: value })} /><span className="radio-check">{policy.gradingMode === value && <Check size={12} />}</span><strong>{content[0]}</strong><span>{content[1]}</span><small>{content[2]}</small></label>; })}</div></div>
            <div className="settings-policy-grid"><div className="threshold-field"><div><label htmlFor="settings-threshold">آستانهٔ ارجاع به معلم</label><strong>{faNumber(policy.reviewThreshold * 100, 0)}٪</strong></div><input id="settings-threshold" type="range" min="0.5" max="0.95" step="0.05" value={policy.reviewThreshold} onChange={(event) => setPolicy({ ...policy, reviewThreshold: Number(event.target.value) })} /><div><span>آزادتر</span><span>محتاط‌تر</span></div><p>پایین‌تر از این اعتماد، نمره برای بازبینی پرچم می‌شود.</p></div><div className="policy-switches settings-switches"><label className="switch-field"><span><strong>عدم ارسال فهرست هویت</strong><small>فهرست کلاس راهنمای مدل نمی‌شود؛ نام و کد فقط از روی تصویر برگه خوانده می‌شود.</small></span><span className="switch"><input type="checkbox" checked={policy.anonymize} onChange={(event) => setPolicy({ ...policy, anonymize: event.target.checked })} /><span className="switch-slider" /></span></label><label className="switch-field"><span><strong>تأیید الزامی معلم</strong><small>نهایی‌سازی فقط با اقدام انسانی</small></span><span className="switch"><input type="checkbox" checked={policy.requireApproval} onChange={(event) => setPolicy({ ...policy, requireApproval: event.target.checked })} /><span className="switch-slider" /></span></label></div></div>
            <div className="settings-save-row"><span><Info size={14} />تغییر این مقادیر، نتایج قبلی را دوباره تصحیح نمی‌کند.</span><button className="btn btn-primary" onClick={savePolicy}><Save size={16} />ذخیرهٔ سیاست‌ها</button></div>
          </div>
        </section>
        <section className="card settings-card"><div className="settings-card-heading"><span className="settings-heading-icon"><KeyRound size={21} /></span><div><h3>سرویس هوش مصنوعی</h3><p>دسترسی به پیکربندی و کلید فقط برای مدیر سامانه است.</p></div></div><div className="settings-card-body"><div className={`server-provider-status ${providerStatus.configured ? "connected" : "disconnected"}`}><span>{providerStatus.configured ? <Check size={21} /> : <TriangleAlert size={21} />}</span><div><strong>{providerStatus.configured ? "سرویس تصحیح متصل است" : "سرویس تصحیح غیرفعال است"}</strong><p>{providerStatus.configured ? `${providerStatus.providerLabel} · ${providerStatus.model}` : "تا پیکربندی مدیر، امکان اجرای تصحیح واقعی وجود ندارد."}</p></div></div>{user.role === "admin" && <Link href="/admin" className="btn btn-secondary"><KeyRound size={15} /> ورود به پیکربندی مدیر <ChevronLeft size={14} /></Link>}</div></section>
      </div>
      <aside className="settings-side-column">
        <section className="card settings-card security-card"><div className="settings-card-body"><span className="security-illustration"><LockKeyhole size={25} /></span><h3>حریم خصوصی چندکاربره</h3><p>دادهٔ هر حساب از دیگر معلم‌ها جدا است و همهٔ مسیرهای API احراز هویت می‌شوند.</p><ul><li><HardDrive size={15} /><span><strong>آزمون، کلاس و نتایج</strong>در پایگاه‌دادهٔ سرور و فضای اختصاصی کاربر</span></li><li><Database size={15} /><span><strong>عکس و PDF برگه‌ها</strong>در فهرست محافظت‌شدهٔ همان حساب</span></li><li><ShieldCheck size={15} /><span><strong>API Key</strong>رمزنگاری‌شده روی سرور؛ غیرقابل دسترس برای معلم</span></li></ul><div className="notice notice-warning"><TriangleAlert size={16} /><span>ارسال به Provider مشمول سیاست نگهداری و پردازش دادهٔ همان سرویس است.</span></div></div></section>
        <section className="card settings-card data-management-card"><div className="settings-card-heading"><span className="settings-heading-icon violet"><Database size={20} /></span><div><h3>مدیریت داده‌ها</h3><p>{faNumber(exams.length)} آزمون و {faNumber(classes.length)} کلاس در حساب شما</p></div></div><div className="settings-card-body"><button className="btn btn-secondary full-width" onClick={async () => { if (!window.confirm("همهٔ داده‌های فعلی با نمونه‌های آموزشی جایگزین و فایل‌های حساب حذف شوند؟")) return; await clearStoredFiles(); resetDemo(); }}><RotateCcw size={15} />بازیابی داده‌های نمایشی</button><button className="btn btn-danger-soft full-width" onClick={() => setClearOpen(true)}><Trash2 size={15} />پاک‌کردن کامل فضای کاری</button></div></section>
        <section className="card local-version-card"><Sparkles size={19} /><div><strong>نمره · نسخهٔ ۲.۰</strong><span>چندکاربره، کلاس‌بندی و کارنامهٔ تجمیعی</span></div></section>
      </aside>
    </div>
    {clearOpen && <Modal title="پاک‌کردن کامل فضای کاری" description="آزمون‌ها، کلاس‌ها، نتایج و فایل‌های این حساب حذف می‌شوند." onClose={() => { setClearOpen(false); setClearConfirmation(""); }} footer={<><button className="btn btn-secondary" onClick={() => setClearOpen(false)}>انصراف</button><button className="btn btn-danger-soft" disabled={clearConfirmation !== "حذف" || clearing} onClick={clearAll}>{clearing ? <span className="spinner" /> : <Trash2 size={15} />}{clearing ? "در حال حذف…" : "حذف دائم داده‌ها"}</button></>}><div className="notice notice-danger"><TriangleAlert size={20} /><div><strong>این عمل قابل بازگشت نیست</strong><p>پیش از ادامه، از کارنامه‌ها خروجی CSV بگیرید. کلید سراسری API و حساب شما حذف نمی‌شود.</p></div></div><div className="form-field delete-confirm-field"><label htmlFor="clear-confirm">برای تأیید، کلمهٔ «حذف» را بنویسید</label><input id="clear-confirm" className="input" value={clearConfirmation} onChange={(event) => setClearConfirmation(event.target.value)} placeholder="حذف" autoFocus /></div></Modal>}
  </div>;
}
