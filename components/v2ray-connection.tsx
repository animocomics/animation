"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, ListPlus, LoaderCircle, LockKeyhole, Network, Play, RefreshCw, ShieldCheck, Square, Trash2, TriangleAlert, Zap } from "lucide-react";
import { useApp } from "../lib/app-context";
import { readJsonResponse } from "../lib/http-response";
import { faDate, faNumber } from "../lib/utils";

type V2RayConfigStatus = {
  id: string;
  label: string;
  protocol: string;
  testStatus: "idle" | "testing" | "success" | "error";
  errorCode?: string;
  latencyMs?: number;
  selected: boolean;
};

type V2RayStatus = {
  configured: boolean;
  enabled: boolean;
  running: boolean;
  selectedId?: string;
  selectedLabel?: string;
  lastTestStatus: "idle" | "testing" | "success" | "error";
  lastTestMessage: string;
  lastTestedAt?: string;
  configs: V2RayConfigStatus[];
  pending: boolean;
  jobError?: string;
};

type Payload = { status?: V2RayStatus; pending?: boolean; error?: string };

export function V2RayConnection() {
  const { notify, user } = useApp();
  const [status, setStatus] = useState<V2RayStatus | null>(null);
  const [configs, setConfigs] = useState("");
  const [busy, setBusy] = useState<"save" | "activate" | "disable" | "clear" | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const apply = useCallback((payload: Payload) => {
    if (payload.status) setStatus(payload.status);
    if (payload.status?.jobError) setError(payload.status.jobError);
    return payload.status;
  }, []);

  const load = useCallback(async () => {
    const response = await fetch("/api/admin/v2ray", { cache: "no-store" });
    const payload = await readJsonResponse<Payload>(response, "دریافت وضعیت V2Ray");
    if (!response.ok) throw new Error(payload.error || "وضعیت V2Ray خوانده نشد.");
    return apply(payload);
  }, [apply]);

  useEffect(() => {
    if (user.role !== "admin") return;
    void load().catch((reason) => setError(reason instanceof Error ? reason.message : "وضعیت V2Ray خوانده نشد.")).finally(() => setLoading(false));
  }, [load, user.role]);

  useEffect(() => {
    if (!status?.pending) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void load().then((next) => {
        if (!cancelled && next && !next.pending) window.clearInterval(timer);
      }).catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "وضعیت تست V2Ray خوانده نشد.");
      });
    }, 2000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [load, status?.pending]);

  if (user.role !== "admin") return null;

  async function action(name: "save" | "activate" | "disable" | "clear") {
    if (name === "clear" && !window.confirm("فهرست رمزنگاری‌شدهٔ V2Ray حذف شود؟ این عمل قابل بازگشت نیست.")) return;
    setBusy(name);
    setError("");
    try {
      const response = await fetch("/api/admin/v2ray", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: name, ...(configs.trim() && ["save", "activate"].includes(name) ? { configs } : {}) }),
      });
      const payload = await readJsonResponse<Payload>(response, "عملیات V2Ray");
      if (!response.ok && response.status !== 202) throw new Error(payload.error || "عملیات V2Ray ناموفق بود.");
      apply(payload);
      if (["save", "activate"].includes(name)) setConfigs("");
      if (name === "save") notify({ title: "فهرست V2Ray ذخیره شد", description: "کانفیگ‌ها رمزنگاری شدند؛ برای انتخاب خودکار، تست و فعال‌سازی را بزنید.", variant: "success" });
      if (name === "activate") notify({ title: "تست خودکار شروع شد", description: "کانفیگ‌ها بدون API Key و فقط با آزمایش مسیر AI بررسی می‌شوند.", variant: "success" });
      if (name === "disable") notify({ title: "V2Ray غیرفعال شد", description: "کانفیگهای رمزنگاری‌شده حفظ شدند.", variant: "success" });
      if (name === "clear") notify({ title: "فهرست V2Ray حذف شد", variant: "success" });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "عملیات V2Ray ناموفق بود.");
    } finally { setBusy(null); }
  }

  const pending = Boolean(status?.pending);
  return <div className="v2ray-connection">
    <div className="v2ray-heading"><span className="settings-heading-icon teal"><Network size={20} /></span><div><h3>اتصال جایگزین V2Ray برای AI</h3><p>چند کانفیگ عمومی یا اشتراکی را وارد کنید؛ Nomreh سالم‌ترین را انتخاب و هنگام قطعی failover می‌کند.</p></div></div>
    <div className="admin-security-note"><ShieldCheck size={18} /><div><strong>فقط ترافیک سرویس‌دهنده‌های AI</strong><p>هستهٔ Xray روی loopback و با احراز هویت داخلی اجرا می‌شود. DNS سرور، ترافیک معلم‌ها، فایل‌ها و سایر سایت‌ها تغییر نمی‌کند؛ درخواست AI هم در صورت قطعی مستقیم ارسال نمی‌شود.</p></div></div>
    <div className="form-field"><label htmlFor="v2ray-configs">فهرست کانفیگ‌ها <small>حداکثر ۶۰ کانفیگ؛ هر خط یک کانفیگ</small></label><textarea id="v2ray-configs" className="input v2ray-config-input" dir="ltr" spellCheck={false} autoComplete="off" value={configs} onChange={(event) => setConfigs(event.target.value)} placeholder={"vless://...\nss://...\nvmess://...\ntrojan://..."} rows={6} disabled={pending} /><span className="form-hint"><LockKeyhole size={11} /> VLESS/REALITY، VMess، Trojan و Shadowsocks بدون plugin. متن فقط برای ذخیره به سرور ارسال و با AES-256-GCM رمزنگاری می‌شود؛ پس از ذخیره، مقدار آن به مرورگر برنمی‌گردد.</span></div>
    <div className="v2ray-actions"><button type="button" className="btn btn-secondary" onClick={() => void action("save")} disabled={pending || busy !== null || !configs.trim()}>{busy === "save" ? <LoaderCircle className="spin-icon" size={16} /> : <ListPlus size={16} />} ذخیرهٔ رمزنگاری‌شده</button><button type="button" className="btn btn-primary" onClick={() => void action("activate")} disabled={pending || busy !== null || (!configs.trim() && !status?.configured)}>{busy === "activate" || pending ? <LoaderCircle className="spin-icon" size={16} /> : <Play size={16} />} {pending ? "تست کانفیگ‌ها…" : "تست خودکار و فعال‌سازی"}</button><button type="button" className="btn btn-secondary" onClick={() => void action("disable")} disabled={pending || busy !== null || !status?.enabled}><Square size={15} /> غیرفعال‌سازی</button><button type="button" className="btn btn-ghost" onClick={() => void load().catch((reason) => setError(reason instanceof Error ? reason.message : "خواندن وضعیت ناموفق بود."))} disabled={loading || pending} aria-label="به‌روزرسانی V2Ray"><RefreshCw size={16} /></button></div>
    {error && <div className="v2ray-error" role="alert"><TriangleAlert size={16} />{error}</div>}
    {loading ? <div className="admin-loading"><LoaderCircle className="spin-icon" size={17} /> در حال خواندن وضعیت V2Ray…</div> : status && <div className="v2ray-status"><div className="v2ray-status-summary"><span className={`status-badge ${status.enabled && status.running ? "success" : status.lastTestStatus === "error" ? "danger" : "neutral"}`}>{status.enabled && status.running ? <CheckCircle2 size={13} /> : <Zap size={13} />}{status.enabled && status.running ? `فعال · ${status.selectedLabel || "کانفیگ انتخاب‌شده"}` : status.lastTestStatus === "testing" ? "در حال تست" : "غیرفعال"}</span><small>{status.lastTestMessage}</small>{status.lastTestedAt && <small>آخرین تست: {faDate(status.lastTestedAt, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</small>}</div>{status.configs.length > 0 && <div className="v2ray-config-list">{status.configs.map((item) => <div className={`v2ray-config-row ${item.selected ? "selected" : ""}`} key={item.id}><span><strong>{item.label}</strong><small dir="ltr">{item.protocol.toUpperCase()}</small></span><span className={`status-badge ${item.testStatus === "success" ? "success" : item.testStatus === "error" ? "danger" : "neutral"}`}>{item.selected ? "انتخاب‌شده · " : ""}{item.testStatus === "success" ? "سالم" : item.testStatus === "error" ? "ناموفق" : item.testStatus === "testing" ? "در حال تست" : "تست‌نشده"}{item.latencyMs ? ` · ${faNumber(item.latencyMs)}ms` : ""}{item.errorCode ? ` · ${item.errorCode}` : ""}</span></div>)}</div>}</div>}
    {status?.configured && !pending && <button type="button" className="btn btn-ghost btn-sm v2ray-clear" onClick={() => void action("clear")} disabled={busy !== null || status.enabled}><Trash2 size={14} /> حذف فهرست ذخیره‌شده</button>}
  </div>;
}
