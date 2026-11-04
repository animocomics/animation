"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type RFB from "@novnc/novnc";
import { OfficialVncHttpChannel } from "./official-vnc-http-channel";
import { CheckCircle2, Expand, Eye, EyeOff, Link2, LoaderCircle, LockKeyhole, MonitorUp, Play, Power, RefreshCw, ShieldCheck, Square, TriangleAlert, Wifi } from "lucide-react";
import { useApp } from "../lib/app-context";
import { readJsonResponse } from "../lib/http-response";
import type { ApiNetworkPublicStatus } from "../lib/types";
import type { OfficialRuntimeStatus } from "../lib/server/shecan-runtime";
import { faDate, faNumber } from "../lib/utils";

type RuntimePayload = {
  runtime?: OfficialRuntimeStatus;
  network?: ApiNetworkPublicStatus;
  error?: string;
};

type NetworkPayload = {
  status?: ApiNetworkPublicStatus;
  pending?: boolean;
  jobError?: string;
  error?: string;
};

const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export function OfficialShecanConsole() {
  const { notify, user } = useApp();
  const [runtime, setRuntime] = useState<OfficialRuntimeStatus | null>(null);
  const [network, setNetwork] = useState<ApiNetworkPublicStatus | null>(null);
  const [busy, setBusy] = useState<"load" | "start" | "stop" | "restart" | "enable" | "disable" | "link" | null>("load");
  const [error, setError] = useState("");
  const [vncConnected, setVncConnected] = useState(false);
  const [vncSession, setVncSession] = useState(0);
  const [updateUrl, setUpdateUrl] = useState("");
  const [showUpdateUrl, setShowUpdateUrl] = useState(false);
  const screenRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setBusy((current) => current || "load");
    try {
      const response = await fetch("/api/admin/shecan-runtime", { cache: "no-store" });
      const payload = await readJsonResponse<RuntimePayload>(response, "خواندن وضعیت برنامهٔ رسمی شکن");
      if (!response.ok || !payload.runtime || !payload.network) throw new Error(payload.error || "وضعیت برنامهٔ رسمی خوانده نشد.");
      setRuntime(payload.runtime);
      setNetwork(payload.network);
      if (!quiet) setError("");
    } catch (reason) {
      if (!quiet) setError(reason instanceof Error ? reason.message : "وضعیت برنامهٔ رسمی خوانده نشد.");
    } finally { setBusy((current) => current === "load" ? null : current); }
  }, []);

  useEffect(() => {
    if (user.role !== "admin") return;
    void load();
  }, [load, user.role]);

  useEffect(() => {
    if (user.role !== "admin") return;
    const timer = window.setInterval(() => void load(true), runtime?.phase === "starting" ? 2000 : 10000);
    return () => window.clearInterval(timer);
  }, [load, runtime?.phase, user.role]);

  useEffect(() => {
    if (!runtime?.appReady || !screenRef.current) {
      rfbRef.current?.disconnect();
      rfbRef.current = null;
      setVncConnected(false);
      return;
    }
    let cancelled = false;
    setVncConnected(false);
    void import("@novnc/novnc").then(({ default: RfbClient }) => {
      if (cancelled || !screenRef.current) return;
      rfbRef.current?.disconnect();
      screenRef.current.replaceChildren();
      const channel = new OfficialVncHttpChannel("/api/admin/shecan-runtime/vnc-http");
      const client = new RfbClient(screenRef.current, channel, { shared: true });
      client.scaleViewport = true;
      client.clipViewport = true;
      client.showDotCursor = true;
      client.addEventListener("connect", () => { if (!cancelled) setVncConnected(true); });
      client.addEventListener("disconnect", () => { if (!cancelled) setVncConnected(false); });
      client.addEventListener("securityfailure", () => { if (!cancelled) setError("اتصال امن تصویر برنامه برقرار نشد؛ صفحه را دوباره بارگذاری کنید."); });
      rfbRef.current = client;
    }).catch(() => { if (!cancelled) setError("بارگذاری نمایش زندهٔ برنامهٔ رسمی انجام نشد."); });
    return () => {
      cancelled = true;
      rfbRef.current?.disconnect();
      rfbRef.current = null;
    };
  }, [runtime?.appReady, vncSession]);

  if (user.role !== "admin") return null;

  async function runtimeAction(action: "start" | "stop" | "restart") {
    setBusy(action);
    setError("");
    try {
      const response = await fetch("/api/admin/shecan-runtime", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
        cache: "no-store",
      });
      const payload = await readJsonResponse<RuntimePayload>(response, "عملیات برنامهٔ رسمی شکن");
      if (!response.ok || !payload.runtime) throw new Error(payload.error || "عملیات محیط رسمی انجام نشد.");
      setRuntime(payload.runtime);
      if (payload.network) setNetwork(payload.network);
      if (action === "stop") setVncConnected(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "عملیات محیط رسمی انجام نشد."); }
    finally { setBusy(null); }
  }

  async function saveNetwork(enabled: boolean, link?: string) {
    if (!network) return;
    setBusy(link ? "link" : enabled ? "enable" : "disable");
    setError("");
    try {
      const request = {
        enabled,
        plan: network.plan,
        servers: network.servers,
        transport: "official-vm",
        ...(link?.trim() ? { updateUrl: link.trim() } : {}),
      };
      const response = await fetch("/api/admin/api-network", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        cache: "no-store",
      });
      let payload = await readJsonResponse<NetworkPayload>(response, "به‌روزرسانی مسیر AI");
      if (!response.ok && !payload.pending) throw new Error(payload.error || "به‌روزرسانی مسیر AI انجام نشد.");
      for (let attempt = 0; payload.pending && attempt < 120; attempt += 1) {
        await wait(2000);
        const poll = await fetch("/api/admin/api-network", { cache: "no-store" });
        payload = await readJsonResponse<NetworkPayload>(poll, "آزمایش مسیر AI");
        if (!poll.ok) throw new Error(payload.error || "آزمایش مسیر AI انجام نشد.");
      }
      if (payload.pending) throw new Error("آزمایش مسیر AI بیش از زمان مجاز طول کشید.");
      if (payload.status) setNetwork(payload.status);
      if (payload.jobError) throw new Error(payload.jobError);
      if (enabled && (!payload.status?.enabled || payload.status.transport !== "official-vm")) throw new Error(payload.status?.lastTestMessage || "مسیر رسمی AI فعال نشد.");
      setUpdateUrl("");
      setShowUpdateUrl(false);
      notify({
        title: link ? "لینک به‌روزرسان رمزنگاری و حفظ شد" : enabled ? "مسیر رسمی AI فعال شد" : "مسیر شکن خاموش شد",
        description: enabled ? "فقط درخواست‌های Provider از محیط برنامهٔ رسمی عبور می‌کنند؛ DNS هاست تغییر نکرده است." : undefined,
        variant: "success",
      });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "به‌روزرسانی مسیر AI انجام نشد."); }
    finally { setBusy(null); }
  }

  const starting = runtime?.phase === "starting";
  const ready = Boolean(runtime?.appReady && runtime.brokerReady);
  const officialEnabled = Boolean(network?.enabled && network.transport === "official-vm");

  return <section className="official-shecan" aria-labelledby="official-shecan-title">
    <div className="official-shecan-heading">
      <span><MonitorUp size={22} /></span>
      <div><h3 id="official-shecan-title">برنامهٔ رسمی شکن در محیط جداگانه</h3><p>این نمایش، خروجی زندهٔ همان برنامهٔ رسمی لینوکس است؛ فرم ورود نمره جایگزین برنامه نیست.</p></div>
      <span className={`status-badge ${ready ? "success" : "neutral"}`}>{ready ? "در حال اجرا" : starting ? "در حال راه‌اندازی" : "متوقف"}</span>
    </div>

    <div className="official-shecan-security"><ShieldCheck size={18} /><p>برنامهٔ رسمی در QEMU جدا اجرا می‌شود و فقط درخواست‌های AI از آن عبور می‌کنند. لینک ذخیره‌شده هنگام فعال‌سازی به‌صورت خودکار و بدون نیاز به تصویر داخل همان محیط اجرا می‌شود؛ DNS هاست تغییر نمی‌کند.</p></div>

    <div className="official-shecan-toolbar">
      {!runtime?.running ? <button className="btn btn-primary" type="button" onClick={() => void runtimeAction("start")} disabled={busy !== null || !runtime?.installed}>{busy === "start" ? <LoaderCircle className="spin-icon" size={16} /> : <Play size={16} />}اجرای برنامهٔ رسمی</button> : <>
        <button className="btn btn-secondary" type="button" onClick={() => setVncSession((value) => value + 1)} disabled={!runtime.appReady}><RefreshCw size={15} />اتصال دوبارهٔ تصویر</button>
        <button className="btn btn-secondary" type="button" onClick={() => void runtimeAction("restart")} disabled={busy !== null}>{busy === "restart" ? <LoaderCircle className="spin-icon" size={15} /> : <RefreshCw size={15} />}راه‌اندازی مجدد</button>
        <button className="btn btn-danger-soft" type="button" onClick={() => void runtimeAction("stop")} disabled={busy !== null}>{busy === "stop" ? <LoaderCircle className="spin-icon" size={15} /> : <Square size={15} />}توقف محیط</button>
      </>}
      <button className="btn btn-ghost" type="button" onClick={() => void load()} disabled={busy !== null}><RefreshCw size={15} />به‌روزرسانی وضعیت</button>
    </div>

    {runtime?.installed ? <div className={`official-shecan-screen ${vncConnected ? "connected" : ""}`}>
      <div className="official-shecan-screen-bar"><span><span className={`live-dot ${vncConnected ? "online" : ""}`} />{vncConnected ? "تصویر زندهٔ برنامهٔ رسمی" : starting ? "در حال بوت محیط ایزوله…" : "در انتظار تصویر برنامه…"}</span><button type="button" className="icon-button" aria-label="تمام‌صفحه" onClick={() => void screenRef.current?.requestFullscreen?.()}><Expand size={16} /></button></div>
      <div className="official-shecan-vnc" ref={screenRef} aria-label="محیط گرافیکی زندهٔ برنامهٔ رسمی شکن" />
      {!vncConnected && <div className="official-shecan-screen-wait">{starting || busy === "start" ? <LoaderCircle className="spin-icon" size={28} /> : <MonitorUp size={28} />}<span>{starting || busy === "start" ? "راه‌اندازی برنامه ممکن است چند دقیقه طول بکشد." : "برای دیدن رابط رسمی، برنامه را اجرا کنید."}</span></div>}
    </div> : <div className="official-shecan-not-installed"><TriangleAlert size={20} /><div><strong>بستهٔ رسمی هنوز روی این سرور نصب نشده است</strong><p>هیچ تصویر یا فرم جایگزینی به‌عنوان برنامهٔ رسمی نمایش داده نمی‌شود.</p></div></div>}

    <div className={`official-ai-route ${officialEnabled ? "enabled" : ""}`}>
      <span>{officialEnabled ? <CheckCircle2 size={19} /> : <Wifi size={19} />}</span>
      <div><strong>{officialEnabled ? "APIهای هوش مصنوعی از برنامهٔ رسمی عبور می‌کنند" : "مسیر AI هنوز از برنامهٔ رسمی فعال نشده است"}</strong><p>{network?.lastTestMessage || "ابتدا برنامه را اجرا و اتصال شکن را در رابط رسمی فعال کنید، سپس آزمایش AI را بزنید."}</p>{network?.lastTestedAt && <small>آخرین آزمایش: {faDate(network.lastTestedAt, { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}{network.lastTestLatencyMs != null ? ` · ${faNumber(network.lastTestLatencyMs)} میلی‌ثانیه` : ""}</small>}</div>
      {officialEnabled ? <button className="btn btn-secondary" type="button" onClick={() => void saveNetwork(false)} disabled={busy !== null}>{busy === "disable" ? <LoaderCircle className="spin-icon" size={15} /> : <Power size={15} />}خاموش‌کردن مسیر</button> : <button className="btn btn-primary" type="button" onClick={() => void saveNetwork(true)} disabled={busy !== null || !ready}>{busy === "enable" ? <LoaderCircle className="spin-icon" size={15} /> : <Wifi size={15} />}آزمایش واقعی و فعال‌سازی AI</button>}
    </div>

    <details className="official-shecan-link-fallback">
      <summary><Link2 size={15} />لینک به‌روزرسان و روش دستی</summary>
      <div><p>{network?.hasUpdateUrl ? "لینک فعلی رمزنگاری‌شده حفظ می‌شود و در وضعیت یا گزارش‌ها نمایش داده نمی‌شود." : "لینک کامل به‌روزرسان سفارش را برای حفظ روش دستی وارد کنید."} هنگام فعال‌سازی AI، همین لینک فقط داخل guest رسمی اجرا و DNS همان guest تنظیم می‌شود؛ وارد کردن آن در تصویر لازم نیست.</p><div className="input-with-icon input-with-action"><LockKeyhole size={16} /><input className="input" dir="ltr" type={showUpdateUrl ? "text" : "password"} value={updateUrl} onChange={(event) => setUpdateUrl(event.target.value)} autoComplete="off" spellCheck={false} placeholder={network?.hasUpdateUrl ? "برای حفظ لینک فعلی خالی بگذارید" : "لینک کامل به‌روزرسان شکن"} /><button className="input-action" type="button" onClick={() => setShowUpdateUrl((value) => !value)} aria-label={showUpdateUrl ? "پنهان‌کردن لینک" : "نمایش لینک"}>{showUpdateUrl ? <EyeOff size={16} /> : <Eye size={16} />}</button></div><button className="btn btn-secondary" type="button" onClick={() => void saveNetwork(officialEnabled, updateUrl)} disabled={busy !== null || !updateUrl.trim()}>{busy === "link" ? <LoaderCircle className="spin-icon" size={15} /> : <LockKeyhole size={15} />}ذخیرهٔ رمزنگاری‌شدهٔ لینک</button></div>
    </details>

    {error && <div className="api-network-error" role="alert"><TriangleAlert size={17} /><span>{error}</span></div>}
  </section>;
}
