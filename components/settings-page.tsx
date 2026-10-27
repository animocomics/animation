"use client";

import { useEffect, useState } from "react";
import {
  Check,
  Database,
  ExternalLink,
  FileKey2,
  HardDrive,
  Info,
  KeyRound,
  LockKeyhole,
  RotateCcw,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useApp } from "../lib/app-context";
import { clearStoredFiles } from "../lib/file-store";
import type { WorkspaceSettings } from "../lib/types";
import { faNumber } from "../lib/utils";
import { ApiConnection } from "./api-connection";
import { Modal } from "./ui/primitives";

export function SettingsPage() {
  const { settings, saveSettings, exams, apiKey, setApiKey, resetDemo, clearWorkspace, notify } = useApp();
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
      await clearStoredFiles();
      clearWorkspace();
      setClearOpen(false);
      setClearConfirmation("");
    } catch {
      notify({ title: "پاک‌کردن فایل‌ها کامل نشد", description: "دوباره تلاش کنید یا دادهٔ سایت را از تنظیمات مرورگر پاک کنید.", variant: "error" });
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="settings-page">
      <section className="page-heading-row"><div><h2>اتصال و سیاست‌های تصحیح</h2><p>کلید، مدل و قواعد پیش‌فرض را یک‌بار تنظیم کنید.</p></div><span className="badge badge-success"><ShieldCheck size={13} />کلید در کد برنامه ذخیره نمی‌شود</span></section>
      <div className="settings-layout">
        <div className="settings-main-column">
          <section className="card settings-card">
            <div className="settings-card-heading"><span className="settings-heading-icon"><KeyRound size={21} /></span><div><h3>اتصال سرویس‌دهندهٔ هوش مصنوعی</h3><p>برگه‌ها مستقیم و بدون OCR جداگانه برای مدل چندوجهی ارسال می‌شوند.</p></div></div>
            <div className="settings-card-body"><ApiConnection /><div className="provider-help-links"><span>کلید ندارید؟</span>{settings.provider === "openai" ? <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">ساخت کلید در OpenAI <ExternalLink size={12} /></a> : <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">ساخت کلید در Google AI Studio <ExternalLink size={12} /></a>}<small>هزینهٔ استفاده طبق تعرفهٔ حساب خودتان محاسبه می‌شود.</small></div></div>
          </section>

          <section className="card settings-card">
            <div className="settings-card-heading"><span className="settings-heading-icon amber"><SlidersHorizontal size={21} /></span><div><h3>سیاست پیش‌فرض آزمون‌های جدید</h3><p>هر آزمون می‌تواند در گام نخست، تنظیمات مستقل خود را داشته باشد.</p></div></div>
            <div className="settings-card-body policy-settings-body">
              <div className="form-field"><span className="field-label">حالت تصحیح</span><div className="settings-mode-grid">{([
                ["fast", "سریع", "یک ارزیابی", "برای تمرین و آزمون کم‌اهمیت"],
                ["balanced", "متعادل", "ممیزی موارد بحرانی", "تعادل هزینه و کنترل"],
                ["precise", "دقیق", "ممیزی موارد پرچم‌دار", "پیشنهاد برای آزمون رسمی"],
              ] as const).map(([value, title, subtitle, description]) => <label className={`settings-mode-option ${policy.gradingMode === value ? "selected" : ""}`} key={value}><input type="radio" name="default-mode" checked={policy.gradingMode === value} onChange={() => setPolicy({ ...policy, gradingMode: value })} /><span className="radio-check">{policy.gradingMode === value && <Check size={12} />}</span><strong>{title}</strong><span>{subtitle}</span><small>{description}</small></label>)}</div></div>
              <div className="settings-policy-grid"><div className="threshold-field"><div><label htmlFor="settings-threshold">آستانهٔ ارجاع به معلم</label><strong>{faNumber(policy.reviewThreshold * 100, 0)}٪</strong></div><input id="settings-threshold" type="range" min="0.5" max="0.95" step="0.05" value={policy.reviewThreshold} onChange={(event) => setPolicy({ ...policy, reviewThreshold: Number(event.target.value) })} /><div><span>آزادتر</span><span>محتاط‌تر</span></div><p>پایین‌تر از این اعتماد، نمره به‌صورت خودکار نهایی نمی‌شود.</p></div><div className="policy-switches settings-switches"><label className="switch-field"><span><strong>تصحیح ناشناس</strong><small>عدم ارسال نام در متن درخواست</small></span><span className="switch"><input type="checkbox" checked={policy.anonymize} onChange={(event) => setPolicy({ ...policy, anonymize: event.target.checked })} /><span className="switch-slider" /></span></label><label className="switch-field"><span><strong>تأیید الزامی معلم</strong><small>نهایی‌سازی فقط با اقدام انسانی</small></span><span className="switch"><input type="checkbox" checked={policy.requireApproval} onChange={(event) => setPolicy({ ...policy, requireApproval: event.target.checked })} /><span className="switch-slider" /></span></label></div></div>
              <div className="settings-save-row"><span><Info size={14} />تغییر این مقادیر، نتایج قبلی را دوباره تصحیح نمی‌کند.</span><button className="btn btn-primary" onClick={savePolicy}><Save size={16} />ذخیرهٔ سیاست‌ها</button></div>
            </div>
          </section>
        </div>

        <aside className="settings-side-column">
          <section className="card settings-card security-card"><div className="settings-card-body"><span className="security-illustration"><LockKeyhole size={25} /></span><h3>حریم خصوصی در نسخهٔ محلی</h3><p>معماری فعلی برای استفادهٔ تک‌کاربره روی مرورگر شما طراحی شده است.</p><ul><li><HardDrive size={15} /><span><strong>آزمون و نتایج</strong>در LocalStorage همین مرورگر</span></li><li><Database size={15} /><span><strong>عکس و PDF برگه‌ها</strong>در IndexedDB همین مرورگر</span></li><li><FileKey2 size={15} /><strong>API Key</strong><span>فقط در SessionStorage این تب</span></li></ul><div className="notice notice-warning"><TriangleAlert size={16} /><span>ارسال به Provider مشمول سیاست نگهداری و پردازش دادهٔ همان سرویس است.</span></div></div></section>
          <section className="card settings-card data-management-card"><div className="settings-card-heading"><span className="settings-heading-icon violet"><Database size={20} /></span><div><h3>مدیریت داده‌ها</h3><p>{faNumber(exams.length)} آزمون در فضای محلی</p></div></div><div className="settings-card-body"><button className="btn btn-secondary full-width" onClick={() => { setApiKey(""); notify({ title: "API Key از این نشست حذف شد", variant: "success" }); }} disabled={!apiKey}><KeyRound size={15} />پاک‌کردن کلید این نشست</button><button className="btn btn-secondary full-width" onClick={async () => { await clearStoredFiles(); resetDemo(); }}><RotateCcw size={15} />بازیابی داده‌های نمایشی</button><button className="btn btn-danger-soft full-width" onClick={() => setClearOpen(true)}><Trash2 size={15} />پاک‌کردن کامل فضای کاری</button></div></section>
          <section className="card local-version-card"><Sparkles size={19} /><div><strong>نمره · نسخهٔ ۱.۰</strong><span>مسیر اصلی تصحیح و بازبینی فعال است</span></div></section>
        </aside>
      </div>

      {clearOpen && <Modal title="پاک‌کردن کامل فضای کاری" description="آزمون‌ها، نتایج، فایل‌ها و API Key این نشست حذف می‌شوند." onClose={() => { setClearOpen(false); setClearConfirmation(""); }} footer={<><button className="btn btn-secondary" onClick={() => setClearOpen(false)}>انصراف</button><button className="btn btn-danger-soft" disabled={clearConfirmation !== "حذف" || clearing} onClick={clearAll}>{clearing ? <span className="spinner" /> : <Trash2 size={15} />}{clearing ? "در حال حذف…" : "حذف دائم داده‌ها"}</button></>}><div className="notice notice-danger"><TriangleAlert size={20} /><div><strong>این عمل قابل بازگشت نیست</strong><p>پیش از ادامه، از آزمون‌های مهم خروجی CSV بگیرید. داده‌هایی که قبلاً برای Provider ارسال شده‌اند از حساب آن سرویس حذف نمی‌شوند.</p></div></div><div className="form-field delete-confirm-field"><label>برای تأیید، کلمهٔ «حذف» را بنویسید</label><input className="input" value={clearConfirmation} onChange={(event) => setClearConfirmation(event.target.value)} placeholder="حذف" autoFocus /></div></Modal>}
    </div>
  );
}
