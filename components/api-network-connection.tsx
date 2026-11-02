"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Eye, EyeOff, Globe2, Link2, LoaderCircle, LockKeyhole, Power, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import { SHECAN_DNS } from "../lib/api-network";
import { useApp } from "../lib/app-context";
import { readJsonResponse } from "../lib/http-response";
import type { ApiNetworkPublicStatus } from "../lib/types";
import { faDate, faNumber } from "../lib/utils";

type ApiNetworkPayload = {
  status?: ApiNetworkPublicStatus;
  error?: string;
  pending?: boolean;
  jobError?: string;
};

async function resolveNetworkJob(initial: ApiNetworkPayload, onPayload: (payload: ApiNetworkPayload) => void): Promise<ApiNetworkPayload> {
  let current = initial;
  onPayload(current);
  for (let attempt = 0; current.pending && attempt < 240; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 2000));
    const response = await fetch("/api/admin/api-network", { cache: "no-store" });
    current = await readJsonResponse<ApiNetworkPayload>(response, "دریافت وضعیت آزمایش شکن");
    if (!response.ok) throw new Error(current.error || "وضعیت آزمایش شکن خوانده نشد.");
    onPayload(current);
  }
  if (current.pending) throw new Error("آزمایش شکن بیش از زمان مجاز در حال اجراست؛ صفحه را دوباره بارگذاری کنید.");
  return current;
}

export function ApiNetworkConnection() {
  const { notify, user } = useApp();
  const [status, setStatus] = useState<ApiNetworkPublicStatus | null>(null);
  const [plan, setPlan] = useState<"free" | "pro">("free");
  const [servers, setServers] = useState<[string, string]>([...SHECAN_DNS.free]);
  const [updateUrl, setUpdateUrl] = useState("");
  const [showUpdateUrl, setShowUpdateUrl] = useState(false);
  const [busy, setBusy] = useState<"loading" | "enabling" | "disabling" | null>("loading");
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);

  function applyPayload(payload: ApiNetworkPayload) {
    if (!payload.status) return;
    setStatus(payload.status);
    setPlan(payload.status.plan);
    setServers(payload.status.servers);
  }

  useEffect(() => {
    if (user.role !== "admin") return;
    void fetch("/api/admin/api-network", { cache: "no-store" }).then(async (response) => {
      const payload = await readJsonResponse<ApiNetworkPayload>(response, "دریافت وضعیت شکن");
      if (!response.ok || !payload.status) throw new Error(payload.error || "وضعیت شکن خوانده نشد.");
      const completed = await resolveNetworkJob(payload, applyPayload);
      if (completed.jobError) setError(completed.jobError);
    }).catch((reason) => setError(reason instanceof Error ? reason.message : "وضعیت شکن خوانده نشد.")).finally(() => setBusy(null));
  }, [user.role]);

  if (user.role !== "admin") return null;

  function selectPlan(next: "free" | "pro") {
    setPlan(next);
    setServers([...SHECAN_DNS[next]]);
    setUpdateUrl("");
    setDirty(true);
    setError("");
  }

  async function save(enabled: boolean) {
    setBusy(enabled ? "enabling" : "disabling");
    setError("");
    try {
      const response = await fetch("/api/admin/api-network", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled, plan, servers, updateUrl: updateUrl.trim() || undefined }),
      });
      const payload = await readJsonResponse<ApiNetworkPayload>(response, "به‌روزرسانی شکن");
      applyPayload(payload);
      if (!response.ok) throw new Error(payload.error || "آزمایش اتصال ناموفق بود.");
      const completed = await resolveNetworkJob(payload, applyPayload);
      if (completed.jobError) throw new Error(completed.jobError);
      if (enabled && (!completed.status?.enabled || completed.status.lastTestStatus === "error")) {
        throw new Error(completed.status?.lastTestMessage || "آزمایش اتصال ناموفق بود و شکن فعال نشد.");
      }
      if (!enabled && completed.status?.enabled) throw new Error("شکن هنوز فعال است؛ غیرفعال‌سازی تأیید نشد.");
      setUpdateUrl("");
      setShowUpdateUrl(false);
      setDirty(false);
      notify({
        title: enabled ? "شکن برای APIها فعال شد" : "شکن خاموش شد",
        description: enabled ? "DNS و دسترسی Google آزمایش شد؛ سایر ترافیک سایت تغییری نکرد." : "درخواست‌های AI دوباره مستقیم به سرویس‌دهنده ارسال می‌شوند.",
        variant: "success",
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "ارتباط برقرار نشد.");
    } finally { setBusy(null); }
  }

  const isBusy = busy !== null;
  const enabled = Boolean(status?.enabled);

  return <div className="api-network-connection">
    <div className={`api-network-status ${enabled ? "enabled" : ""} ${status?.lastTestStatus === "error" ? "has-error" : ""}`}>
      <span className="api-network-status-icon">{enabled ? <CheckCircle2 size={20} /> : <Globe2 size={20} />}</span>
      <div>
        <strong>{enabled ? "شکن برای APIهای هوش مصنوعی فعال است" : "اتصال مستقیم؛ شکن خاموش است"}</strong>
        <p>{status?.lastTestMessage || "در حال خواندن وضعیت…"}</p>
        {status?.lastTestedAt && <small>آخرین آزمایش: {faDate(status.lastTestedAt, { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}{status.lastTestLatencyMs != null ? ` · ${faNumber(status.lastTestLatencyMs)} میلی‌ثانیه` : ""}</small>}
      </div>
      {enabled && <span className="badge badge-success">فقط AI</span>}
    </div>

    <div className="api-network-explainer"><ShieldCheck size={18} /><p>فقط درخواست‌های سرور به OpenAI، Gemini، DeepSeek، GLM و سایر Providerها از این مسیر عبور می‌کند. بازدید سایت، مرورگر معلم، آپلودها و DNS هاست تغییر نمی‌کنند.</p></div>

    <div className="api-network-plan" role="radiogroup" aria-label="نوع اشتراک شکن">
      <button type="button" role="radio" aria-checked={plan === "free"} className={plan === "free" ? "selected" : ""} onClick={() => selectPlan("free")} disabled={isBusy}><strong>شکن رایگان</strong><span>DNS رسمی، بدون لینک اشتراک</span><small dir="ltr">{SHECAN_DNS.free.join(" · ")}</small></button>
      <button type="button" role="radio" aria-checked={plan === "pro"} className={plan === "pro" ? "selected" : ""} onClick={() => selectPlan("pro")} disabled={isBusy}><strong>شکن حرفه‌ای</strong><span>ثبت IP با لینک اختصاصی سفارش</span><small dir="ltr">{SHECAN_DNS.pro.join(" · ")}</small></button>
    </div>

    {plan === "pro" && <div className="form-field api-network-update-field">
      <label htmlFor="shecan-update-url">لینک به‌روزرسان اشتراک <small>اختیاری، برای ثبت خودکار IP سرور</small></label>
      <div className="input-with-icon input-with-action"><Link2 size={17} /><input id="shecan-update-url" dir="ltr" className="input api-key-input" type={showUpdateUrl ? "text" : "password"} value={updateUrl} onChange={(event) => { setUpdateUrl(event.target.value); setDirty(true); }} autoComplete="off" spellCheck={false} placeholder={status?.hasUpdateUrl ? "لینک رمزنگاری‌شده ذخیره است؛ برای حفظ آن خالی بگذارید" : "لینک کامل به‌روزرسان از صفحهٔ سفارش شکن"} /><button className="input-action" type="button" onClick={() => setShowUpdateUrl((value) => !value)} aria-label={showUpdateUrl ? "پنهان‌کردن لینک" : "نمایش لینک"}>{showUpdateUrl ? <EyeOff size={17} /> : <Eye size={17} />}</button></div>
      <span className="form-hint"><LockKeyhole size={11} /> این لینک محرمانه با AES-256-GCM ذخیره می‌شود. رمز حساب شکن لازم نیست. لینک در <a href="https://my.shecan.ir/panel" target="_blank" rel="noreferrer">پنل شکن ← سفارش ← اطلاعات سرویس</a> قرار دارد.</span>
    </div>}

    <details className="api-network-dns-details">
      <summary>نمایش یا ویرایش DNS</summary>
      <div className="api-fields">
        <div className="form-field"><label htmlFor="shecan-dns-one">DNS اول</label><input id="shecan-dns-one" className="input" dir="ltr" inputMode="decimal" value={servers[0]} onChange={(event) => { setServers([event.target.value, servers[1]]); setDirty(true); }} /></div>
        <div className="form-field"><label htmlFor="shecan-dns-two">DNS دوم</label><input id="shecan-dns-two" className="input" dir="ltr" inputMode="decimal" value={servers[1]} onChange={(event) => { setServers([servers[0], event.target.value]); setDirty(true); }} /></div>
      </div>
    </details>

    {error && <div className="api-network-error" role="alert"><TriangleAlert size={17} /><span>{error}</span></div>}
    <div className="api-test-row api-network-actions">
      <button className="btn btn-primary" type="button" onClick={() => void save(true)} disabled={isBusy || busy === "loading"}>{busy === "enabling" ? <LoaderCircle className="spin-icon" size={16} /> : <RefreshCw size={16} />}{busy === "enabling" ? "در حال ثبت IP و آزمایش…" : enabled && !dirty ? "آزمایش مجدد اتصال" : "آزمایش، ذخیره و فعال‌سازی"}</button>
      {enabled && <button className="btn btn-secondary" type="button" onClick={() => void save(false)} disabled={isBusy}>{busy === "disabling" ? <LoaderCircle className="spin-icon" size={16} /> : <Power size={16} />}غیرفعال‌کردن شکن</button>}
      <a className="api-network-help" href="https://shecan.ir/tutorials/tutorials-pro/" target="_blank" rel="noreferrer">راهنمای رسمی شکن</a>
    </div>
    <p className="api-network-footnote">فعال‌سازی فقط پس از پاسخ معتبر DNS و Google انجام می‌شود. ثبت IP و توقف یک‌دقیقه‌ای در پس‌زمینه ادامه می‌یابد و وضعیت همین‌جا تا پایان به‌روزرسانی می‌شود. این تست بدون API Key است؛ صحت کلید و مدل را با دکمهٔ «آزمایش اتصال» در بخش بالا بسنجید.</p>
  </div>;
}
