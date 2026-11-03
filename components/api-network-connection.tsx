"use client";

import { type FormEvent, useEffect, useState } from "react";
import { CheckCircle2, Eye, EyeOff, Globe2, KeyRound, Link2, LoaderCircle, LockKeyhole, LogIn, LogOut, Power, RefreshCw, ShieldCheck, TriangleAlert, UserRound } from "lucide-react";
import { SHECAN_DNS } from "../lib/api-network";
import { useApp } from "../lib/app-context";
import { readJsonResponse } from "../lib/http-response";
import type { ApiNetworkPublicStatus, ShecanOrderPublic } from "../lib/types";
import { faDate, faNumber } from "../lib/utils";

type ApiNetworkPayload = {
  status?: ApiNetworkPublicStatus;
  orders?: ShecanOrderPublic[];
  error?: string;
  pending?: boolean;
  jobError?: string;
  accountProbe?: { reachable: boolean; httpStatus: number };
};

type AccountBusy = "login" | "probe" | "refresh" | "select" | "logout" | null;

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
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [orders, setOrders] = useState<ShecanOrderPublic[]>([]);
  const [selectedOrderId, setSelectedOrderId] = useState(0);
  const [accountBusy, setAccountBusy] = useState<AccountBusy>(null);
  const [busy, setBusy] = useState<"loading" | "enabling" | "disabling" | null>("loading");
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);

  function applyPayload(payload: ApiNetworkPayload) {
    if (payload.orders) setOrders(payload.orders);
    if (!payload.status) return;
    setStatus(payload.status);
    setPlan(payload.status.plan);
    setServers(payload.status.servers);
    setSelectedOrderId(payload.status.selectedOrderId || 0);
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

  async function accountRequest(body: object, method: "POST" | "DELETE" = "POST"): Promise<ApiNetworkPayload> {
    const response = await fetch("/api/admin/shecan-account", {
      method,
      headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
      body: method === "POST" ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    const payload = await readJsonResponse<ApiNetworkPayload>(response, "عملیات حساب شکن");
    applyPayload(payload);
    if (!response.ok) throw new Error(payload.error || "عملیات حساب شکن ناموفق بود.");
    return payload;
  }

  async function probeAccountService() {
    setAccountBusy("probe");
    setError("");
    try {
      const payload = await accountRequest({ action: "probe" });
      if (!payload.accountProbe?.reachable) throw new Error("پاسخ سرویس ورود شکن تأیید نشد.");
      notify({ title: "دسترسی به سرویس ورود شکن تأیید شد", description: "سرور نمره پاسخ رسمی شکن را دریافت کرد؛ این آزمایش بدون نام کاربری، رمز یا کلید انجام شد.", variant: "success" });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "دسترسی به سرویس ورود شکن برقرار نشد."); }
    finally { setAccountBusy(null); }
  }

  async function login(event: FormEvent) {
    event.preventDefault();
    setAccountBusy("login");
    setError("");
    try {
      const payload = await accountRequest({ action: "login", identifier, password });
      setPassword("");
      setShowPassword(false);
      setUpdateUrl("");
      setDirty(false);
      notify({
        title: "ورود به حساب شکن انجام شد",
        description: payload.status?.selectedOrderId
          ? `سرویس «${payload.status.selectedOrderLabel || "انتخاب‌شده"}» آماده است؛ اکنون آزمایش و فعال‌سازی را بزنید. رمز ذخیره نشد.`
          : "رمز ذخیره نشد؛ یک سرویس فعال را از فهرست انتخاب کنید.",
        variant: "success",
      });
    } catch (reason) {
      setPassword("");
      setError(reason instanceof Error ? reason.message : "ورود به حساب شکن انجام نشد.");
    } finally { setAccountBusy(null); }
  }

  async function refreshOrders() {
    setAccountBusy("refresh");
    setError("");
    try {
      await accountRequest({ action: "refresh" });
      notify({ title: "فهرست سرویس‌های شکن به‌روزرسانی شد", variant: "success" });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "فهرست سرویس‌ها خوانده نشد."); }
    finally { setAccountBusy(null); }
  }

  async function selectOrder() {
    if (!selectedOrderId) return;
    setAccountBusy("select");
    setError("");
    try {
      const payload = await accountRequest({ action: "select", orderId: selectedOrderId });
      setUpdateUrl("");
      setDirty(false);
      notify({ title: "سرویس شکن انتخاب شد", description: `${payload.status?.selectedOrderLabel || "سرویس"} آمادهٔ ثبت IP و آزمایش است.`, variant: "success" });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "انتخاب سرویس انجام نشد."); }
    finally { setAccountBusy(null); }
  }

  async function logout() {
    setAccountBusy("logout");
    setError("");
    try {
      await accountRequest({}, "DELETE");
      setOrders([]);
      setSelectedOrderId(0);
      setPassword("");
      notify({ title: "کلید حساب شکن حذف شد", description: "لینک ذخیره‌شده و وضعیت فعلی اتصال AI تغییری نکرد.", variant: "success" });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "خروج از حساب شکن انجام نشد."); }
    finally { setAccountBusy(null); }
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

  const isBusy = busy !== null || accountBusy !== null;
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
      <button type="button" role="radio" aria-checked={plan === "pro"} className={plan === "pro" ? "selected" : ""} onClick={() => selectPlan("pro")} disabled={isBusy}><strong>شکن حرفه‌ای</strong><span>ورود به حساب یا لینک اختصاصی سفارش</span><small dir="ltr">{SHECAN_DNS.pro.join(" · ")}</small></button>
    </div>

    {plan === "pro" && <section className="shecan-account-panel" aria-labelledby="shecan-account-title">
      <div className="shecan-account-heading">
        <span><UserRound size={19} /></span>
        <div><h4 id="shecan-account-title">ورود به حساب شکن</h4><p>همان روش اپ رسمی؛ دریافت سرویس و ساخت لینک ثبت IP بدون کپی‌کردن توکن.</p></div>
        {status?.hasAccountKey && <span className="status-badge success"><CheckCircle2 size={12} /> حساب متصل</span>}
      </div>

      {!status?.hasAccountKey ? <form className="shecan-login-form" onSubmit={login}>
        <div className="form-field"><label htmlFor="shecan-account-identifier">نام کاربری، ایمیل یا شمارهٔ شکن</label><div className="input-with-icon"><UserRound size={17} /><input id="shecan-account-identifier" className="input" dir="ltr" required autoComplete="username" spellCheck={false} value={identifier} onChange={(event) => setIdentifier(event.target.value)} placeholder="همان اطلاعات ورود به اپ شکن" /></div></div>
        <div className="form-field"><label htmlFor="shecan-account-password">رمز عبور شکن</label><div className="input-with-icon input-with-action"><LockKeyhole size={17} /><input id="shecan-account-password" className="input" dir="ltr" type={showPassword ? "text" : "password"} required autoComplete="current-password" spellCheck={false} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="رمز ذخیره نمی‌شود" /><button className="input-action" type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? "پنهان‌کردن رمز شکن" : "نمایش رمز شکن"}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></div></div>
        <div className="shecan-login-submit"><button className="btn btn-secondary" type="submit" disabled={isBusy}>{accountBusy === "login" ? <LoaderCircle className="spin-icon" size={16} /> : <LogIn size={16} />}{accountBusy === "login" ? "در حال ورود امن…" : "ورود و دریافت سرویس‌ها"}</button><button className="btn btn-ghost" type="button" onClick={() => void probeAccountService()} disabled={isBusy}>{accountBusy === "probe" ? <LoaderCircle className="spin-icon" size={15} /> : <Globe2 size={15} />}{accountBusy === "probe" ? "در حال آزمایش…" : "آزمایش مسیر ورود"}</button><span><ShieldCheck size={12} /> رمز فقط با HTTPS مستقیم به شکن می‌رود و در نمره ذخیره نمی‌شود.</span></div>
      </form> : <div className="shecan-account-connected">
        <div className="shecan-account-identity"><span><KeyRound size={17} /></span><div><strong>{status.accountName || "حساب شکن"}</strong><small dir="ltr">{status.accountLogin || "حساب تأییدشده"}</small></div><p>کلید حساب رمزنگاری شده است؛ رمز عبور نزد نمره نیست.</p></div>
        <div className="shecan-account-actions"><button className="btn btn-ghost btn-sm" type="button" onClick={() => void refreshOrders()} disabled={isBusy}>{accountBusy === "refresh" ? <LoaderCircle className="spin-icon" size={14} /> : <RefreshCw size={14} />}به‌روزرسانی سرویس‌ها</button><button className="btn btn-ghost btn-sm" type="button" onClick={() => void logout()} disabled={isBusy}>{accountBusy === "logout" ? <LoaderCircle className="spin-icon" size={14} /> : <LogOut size={14} />}خروج و حذف کلید</button></div>
        {status.selectedOrderLabel && <div className="shecan-selected-order"><CheckCircle2 size={15} /><div><strong>{status.selectedOrderLabel}</strong><span>{status.selectedOrderId ? `سفارش ${faNumber(status.selectedOrderId)}` : ""}{status.selectedOrderDue ? ` · اعتبار تا ${faDate(`${status.selectedOrderDue}T12:00:00`, { year: "numeric", month: "long", day: "numeric" })}` : ""}</span></div></div>}
        {orders.length > 0 && <div className="shecan-order-picker"><div className="form-field"><label htmlFor="shecan-order-select">سرویس مورد استفاده برای ثبت IP سرور</label><select id="shecan-order-select" className="select" value={selectedOrderId || ""} onChange={(event) => setSelectedOrderId(Number(event.target.value))} disabled={isBusy}><option value="" disabled>یک سرویس را انتخاب کنید</option>{orders.map((order) => <option key={order.id} value={order.id}>{[order.product, order.tier].filter(Boolean).join(" · ")} — {order.active ? "فعال" : order.statusName || "غیرفعال"}{order.hasUpdateToken ? "" : " — بدون توکن ثبت IP"}</option>)}</select></div><button className="btn btn-secondary" type="button" onClick={() => void selectOrder()} disabled={isBusy || !selectedOrderId}>{accountBusy === "select" ? <LoaderCircle className="spin-icon" size={15} /> : <CheckCircle2 size={15} />}{accountBusy === "select" ? "در حال انتخاب…" : "انتخاب این سرویس"}</button></div>}
      </div>}
    </section>}

    {plan === "pro" && <div className="form-field api-network-update-field">
      <label htmlFor="shecan-update-url">لینک به‌روزرسان اشتراک <small>{status?.updateUrlSource === "account" ? "از حساب شکن ساخته و رمزنگاری شده است" : "روش قبلی؛ بدون ورود به حساب"}</small></label>
      <div className="input-with-icon input-with-action"><Link2 size={17} /><input id="shecan-update-url" dir="ltr" className="input api-key-input" type={showUpdateUrl ? "text" : "password"} value={updateUrl} onChange={(event) => { setUpdateUrl(event.target.value); setDirty(true); }} autoComplete="off" spellCheck={false} placeholder={status?.hasUpdateUrl ? "لینک رمزنگاری‌شده ذخیره است؛ برای حفظ آن خالی بگذارید" : "لینک کامل به‌روزرسان از صفحهٔ سفارش شکن"} /><button className="input-action" type="button" onClick={() => setShowUpdateUrl((value) => !value)} aria-label={showUpdateUrl ? "پنهان‌کردن لینک" : "نمایش لینک"}>{showUpdateUrl ? <EyeOff size={17} /> : <Eye size={17} />}</button></div>
      <span className="form-hint"><LockKeyhole size={11} /> لینک با AES-256-GCM ذخیره می‌شود. با ورود به حساب نیازی به کپی آن نیست؛ مسیر دستی در <a href="https://my.shecan.ir/panel" target="_blank" rel="noreferrer">پنل شکن ← سفارش ← اطلاعات سرویس</a> هم حفظ شده است.</span>
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
    <p className="api-network-footnote">فعال‌سازی فقط پس از پاسخ معتبر DNS و Google انجام می‌شود. ثبت IP و توقف یک‌دقیقه‌ای در پس‌زمینه ادامه می‌یابد و وضعیت همین‌جا به‌روزرسانی می‌شود. رمز شکن ذخیره نمی‌شود؛ تست شبکه بدون API Key است و صحت کلید و مدل را با دکمهٔ «آزمایش اتصال» در بخش بالا بسنجید.</p>
  </div>;
}
