"use client";

import { useState } from "react";
import { Check, CheckCircle2, Eye, EyeOff, KeyRound, LoaderCircle, LockKeyhole, RefreshCw, ShieldCheck, Sparkles, TriangleAlert, Zap, BrainCircuit, ScanText, Cpu, AudioLines, Layers, Globe } from "lucide-react";
import { useApp } from "../lib/app-context";
import { readJsonResponse } from "../lib/http-response";
import { FALLBACK_MODEL_OPTIONS, mergeModelOptions, RECOMMENDED_MODELS, SUPPORTS_ACCOUNT_MODEL_DISCOVERY } from "../lib/provider-catalog";
import type { ProviderId } from "../lib/types";
import { faNumber } from "../lib/utils";

const PROVIDERS = {
  openai: { label: "OpenAI", hint: "GPT-6 · Responses API · تصویر و PDF", icon: Sparkles },
  gemini: { label: "Google Gemini", hint: "Gemini 3.8 / 4 · تصویر و PDF", icon: Zap },
  deepseek: { label: "DeepSeek", hint: "Responses API · تصویر و PDF با تبدیل خودکار", icon: BrainCircuit },
  zai: { label: "Z.AI GLM", hint: "GLM 5.3 Flash · تصویر و PDF با تبدیل خودکار", icon: ScanText },
  minimax: { label: "MiniMax", hint: "M3.1 Flash / M3 · تصویر و PDF با تبدیل خودکار", icon: Cpu },
  inkling: { label: "Inkling", hint: "Tinker 256K · PNG/JPEG و PDF · سرویس بتا", icon: AudioLines },
  mistral: { label: "Mistral Large 4", hint: "Reasoning High · Public Preview · تصویر و PDF", icon: Layers },
  kaya: { label: "Kaya AI (ایران · بدون تحریم)", hint: "سازگار با OpenAI · بدون نیاز به شکن · تصویر و PDF با تبدیل خودکار", icon: Globe },
} as const;

export function ApiConnection() {
  const { providerStatus, refreshProviderStatus, notify, user } = useApp();
  const [provider, setProvider] = useState<ProviderId>(providerStatus.provider);
  const [model, setModel] = useState(providerStatus.model);
  const [accountModels, setAccountModels] = useState<string[]>([]);
  const [keyInput, setKeyInput] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [testState, setTestState] = useState<"idle" | "testing" | "saving" | "success" | "error">("idle");
  const [message, setMessage] = useState("");
  const [discoveryState, setDiscoveryState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [discoveryMessage, setDiscoveryMessage] = useState("");
  const [diagnostics, setDiagnostics] = useState<{
    loading: boolean;
    conclusion: string;
    egressConclusion: string;
    egress: Array<{ step: string; ok: boolean; detail: string; ms: number }>;
    host?: { verdict: string; lines: Array<{ label: string; value: string; ok: boolean | null; hint?: string }>; suggestions: string[] };
    outboundUsage?: Array<{ hostname: string; used: number; limit: number; remaining: number; windowMinutes: number; active: number; breakerOpen: boolean; breakerMinutesLeft: number; nextSlotInSeconds: number; percentUsed: number }>;
    recentFailures?: Array<{ at: string; hostname: string; provider: string; code: string; detail: string; model: string }>;
    rows: Array<{ label: string; hostname: string; step: string; ok: boolean; detail: string; ms: number }>;
  }>({ loading: false, conclusion: "", egressConclusion: "", egress: [], rows: [] });

  if (user.role !== "admin") return null;

  const modelOptions = mergeModelOptions(provider, FALLBACK_MODEL_OPTIONS[provider], accountModels, [model]);
  const hasStoredProviderKey = providerStatus.configured && provider === providerStatus.provider;

  function resetResult() {
    setTestState("idle");
    setMessage("");
  }

  function selectProvider(next: ProviderId) {
    setProvider(next);
    setModel(RECOMMENDED_MODELS[next]);
    setAccountModels([]);
    setKeyInput("");
    setDiscoveryState("idle");
    setDiscoveryMessage("");
    resetResult();
  }

  async function runDiagnostics() {
    setDiagnostics({ loading: true, conclusion: "", egressConclusion: "", egress: [], rows: [] });
    try {
      const response = await fetch("/api/admin/network-diagnostics", { cache: "no-store" });
      const payload = await readJsonResponse<{
        conclusion?: string;
        error?: string;
        egressConclusion?: string;
        egress?: Array<{ step: string; ok: boolean; detail: string; ms: number }>;
        outboundUsage?: Array<{ hostname: string; used: number; limit: number; remaining: number; windowMinutes: number; active: number; breakerOpen: boolean; breakerMinutesLeft: number; nextSlotInSeconds: number; percentUsed: number }>;
        recentFailures?: Array<{ at: string; hostname: string; provider: string; code: string; detail: string; model: string }>;
        host?: { verdict: string; lines: Array<{ label: string; value: string; ok: boolean | null; hint?: string }>; suggestions: string[] };
        results?: Array<{ label: string; hostname: string; probes: Array<{ step: string; ok: boolean; detail: string; ms: number }> }>;
      }>(response, "تشخیص شبکه");
      if (!response.ok) throw new Error(payload.error || "تشخیص شبکه انجام نشد.");
      const rows = (payload.results || []).flatMap((entry) =>
        entry.probes.map((probe) => ({ label: entry.label, hostname: entry.hostname, step: probe.step, ok: probe.ok, detail: probe.detail, ms: probe.ms })),
      );
      setDiagnostics({
        loading: false,
        conclusion: payload.conclusion || "",
        egressConclusion: payload.egressConclusion || "",
        egress: payload.egress || [],
        host: (payload as { host?: { verdict: string; lines: Array<{ label: string; value: string; ok: boolean | null; hint?: string }>; suggestions: string[] } }).host,
        outboundUsage: (payload as { outboundUsage?: Array<{ hostname: string; used: number; limit: number; remaining: number; windowMinutes: number; active: number; breakerOpen: boolean; breakerMinutesLeft: number; nextSlotInSeconds: number; percentUsed: number }> }).outboundUsage,
        recentFailures: (payload as { recentFailures?: Array<{ at: string; hostname: string; provider: string; code: string; detail: string; model: string }> }).recentFailures,
        rows,
      });
    } catch (error) {
      setDiagnostics({ loading: false, conclusion: error instanceof Error ? error.message : "تشخیص شبکه انجام نشد.", egressConclusion: "", egress: [], rows: [] });
    }
  }

  async function discoverModels() {
    if (!keyInput.trim() && !hasStoredProviderKey) {
      setDiscoveryState("error");
      setDiscoveryMessage("برای خواندن مدل‌های حساب، ابتدا API Key همین سرویس را وارد کنید.");
      return;
    }
    setDiscoveryState("loading");
    setDiscoveryMessage("");
    resetResult();
    try {
      const response = await fetch("/api/provider/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, apiKey: keyInput.trim() || undefined }),
      });
      const payload = await readJsonResponse<{ models?: string[]; error?: string }>(response, "دریافت مدل‌های حساب");
      if (!response.ok) throw new Error(payload.error || "خواندن مدل‌های حساب ناموفق بود.");
      if (!Array.isArray(payload.models) || !payload.models.length) throw new Error("فهرست مدل‌های دریافتی خالی است.");
      setAccountModels(payload.models);
      setDiscoveryState("success");
      setDiscoveryMessage(`${faNumber(payload.models.length)} مدل از حساب خوانده شد. هیچ کلید یا تنظیمی ذخیره نشد.`);
    } catch (error) {
      setDiscoveryState("error");
      setDiscoveryMessage(error instanceof Error ? error.message : "خواندن مدل‌های حساب ناموفق بود.");
    }
  }

  async function testConnection(saveAfter = false) {
    const selectedModel = model.trim();
    if (!selectedModel) {
      setTestState("error"); setMessage("نام مدل را وارد کنید."); return;
    }
    if (!keyInput.trim() && !hasStoredProviderKey) {
      setTestState("error"); setMessage("ابتدا API Key همین سرویس را وارد کنید."); return;
    }
    setTestState(saveAfter ? "saving" : "testing"); setMessage("");
    try {
      const response = await fetch("/api/provider/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider, model: selectedModel, apiKey: keyInput.trim() || undefined }) });
      const payload = await readJsonResponse<{ error?: string; message?: string }>(response, "آزمایش اتصال");
      if (!response.ok) throw new Error(payload.error || "بررسی اتصال ناموفق بود.");
      if (saveAfter) {
        const saved = await fetch("/api/provider", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider, model: selectedModel, apiKey: keyInput.trim() || undefined }) });
        const savedPayload = await readJsonResponse<{ error?: string }>(saved, "ذخیرهٔ اتصال");
        if (!saved.ok) throw new Error(savedPayload.error || "ذخیرهٔ کلید ناموفق بود.");
        await refreshProviderStatus();
        setKeyInput("");
      }
      setTestState("success");
      setMessage(saveAfter ? "اتصال تأیید و کلید رمزنگاری‌شده روی سرور ذخیره شد." : payload.message || "اتصال برقرار است.");
      notify({ title: saveAfter ? "اتصال سامانه به‌روز شد" : "اتصال API برقرار شد", description: `${PROVIDERS[provider].label} · ${selectedModel}`, variant: "success" });
    } catch (error) {
      setTestState("error");
      setMessage(error instanceof Error ? error.message : "ارتباط برقرار نشد.");
    }
  }

  return (
    <div className="api-connection admin-api-connection">
      <div className="provider-options many-providers" role="radiogroup" aria-label="سرویس‌دهندهٔ هوش مصنوعی">
        {(Object.keys(PROVIDERS) as ProviderId[]).map((id) => {
          const item = PROVIDERS[id]; const Icon = item.icon;
          return <button key={id} role="radio" aria-checked={provider === id} className={`provider-option ${provider === id ? "selected" : ""}`} onClick={() => selectProvider(id)}><span className={`provider-logo ${id}`}><Icon size={20} /></span><span><strong>{item.label}</strong><small>{item.hint}</small></span><i>{provider === id && <Check size={12} />}</i></button>;
        })}
      </div>
      <div className="api-fields">
        <div className="form-field">
          <label htmlFor="admin-model">مدل چندوجهی</label>
          <div className="model-input-row">
            <input id="admin-model" dir="ltr" className="input model-name-input" list="admin-model-options" autoComplete="off" spellCheck={false} value={model} onChange={(event) => { setModel(event.target.value); resetResult(); }} placeholder="نام دقیق مدل" />
            {/* A datalist only suggests as you type, which reads as "there is no
                list" especially in a right-to-left layout. The select exposes every
                known model for this provider, newest first. */}
            <select
              aria-label="انتخاب مدل از فهرست"
              className="input model-select"
              dir="ltr"
              value={modelOptions.includes(model) ? model : ""}
              onChange={(event) => { if (event.target.value) { setModel(event.target.value); resetResult(); } }}
            >
              <option value="">— انتخاب از فهرست ({modelOptions.length} مدل) —</option>
              {modelOptions.map((item) => <option key={`sel-${item}`} value={item}>{item}</option>)}
            </select>
            {SUPPORTS_ACCOUNT_MODEL_DISCOVERY[provider] && <button type="button" className="btn btn-secondary model-discovery-button" onClick={() => void discoverModels()} disabled={discoveryState === "loading" || ["testing", "saving"].includes(testState)}>{discoveryState === "loading" ? <LoaderCircle className="spin-icon" size={15} /> : <RefreshCw size={15} />}{discoveryState === "loading" ? "در حال خواندن…" : "دریافت مدل‌های حساب"}</button>}
          </div>
          <datalist id="admin-model-options">{modelOptions.map((item) => <option key={item} value={item} />)}</datalist>
          <span className="form-hint">فهرست بالا مدل‌های شناخته‌شده و مدل‌های خوانده‌شده از حساب شما را نشان می‌دهد ({faNumber(modelOptions.length)} مورد). برای دیدن همهٔ مدل‌های حساب، «دریافت مدل‌های حساب» را بزنید؛ هر نامی را هم می‌توانید دستی وارد کنید.</span>
          {provider === "gemini" && model.trim() === "gemini-3.7-flash" && <span className="form-hint model-alias-hint">Gemini 3.7 Flash منسوخ شده و Google آن را به ۳٫۸ هدایت می‌کند؛ برای تنظیم پایدار، ۳٫۸ پیشنهاد می‌شود.</span>}
          {discoveryMessage && <span className={`form-hint model-discovery-message ${discoveryState}`} aria-live="polite">{discoveryState === "success" ? <CheckCircle2 size={12} /> : discoveryState === "error" ? <TriangleAlert size={12} /> : null}{discoveryMessage}</span>}

        {(diagnostics.conclusion || diagnostics.rows.length > 0 || diagnostics.egress.length > 0) && (
          <div className="notice notice-info network-diagnostics" dir="ltr" style={{ gridColumn: "1 / -1", fontFamily: "monospace", fontSize: 12 }}>
            {diagnostics.host?.verdict && (
              <div dir="rtl" style={{ marginBottom: 8 }}>
                <strong>بازرسی سرور: </strong>
                {diagnostics.host.verdict}
                {diagnostics.host.lines?.length ? (
                  <div style={{ marginTop: 6 }}>
                    {diagnostics.host.lines.map((line) => (
                      <div key={line.label}>
                        {line.ok === null ? "?" : line.ok ? "OK  " : "FAIL"} {line.label}: {line.value}
                        {line.hint ? ` (${line.hint})` : ""}
                      </div>
                    ))}
                  </div>
                ) : null}
                {diagnostics.host.suggestions?.length ? (
                  <div style={{ marginTop: 6 }}>
                    <div>دستورهای پیشنهادی (در ترمینال سرور با دسترسی root):</div>
                    {diagnostics.host.suggestions.map((command) => (
                      <div key={command} dir="ltr" style={{ userSelect: "all" }}>{command}</div>
                    ))}
                  </div>
                ) : null}
              </div>
            )}
            <div dir="rtl" style={{ marginBottom: 8 }}>
              <strong>مصرف درخواست خروجی (پنجرهٔ {diagnostics.outboundUsage?.[0]?.windowMinutes ?? 20} دقیقه‌ای):</strong>
              {diagnostics.outboundUsage && diagnostics.outboundUsage.length > 0 ? (
                <div style={{ marginTop: 4 }}>
                  {diagnostics.outboundUsage.map((row) => (
                    <div key={`budget-${row.hostname}`}>
                      <span dir="ltr">{row.hostname}</span>: {faNumber(row.used)} از {faNumber(row.limit)}
                      {" "}({faNumber(row.percentUsed)}٪) — باقی‌مانده {faNumber(row.remaining)}
                      {row.active > 0 ? ` — ${faNumber(row.active)} در حال ارسال` : ""}
                      {row.breakerOpen ? ` — متوقف تا ${faNumber(row.breakerMinutesLeft)} دقیقه` : ""}
                      <span style={{ display: "inline-block", width: 90, height: 6, background: "#e5e7eb", borderRadius: 3, marginInlineStart: 6, verticalAlign: "middle" }}>
                        <span style={{ display: "block", width: `${Math.min(100, row.percentUsed)}%`, height: 6, borderRadius: 3, background: row.percentUsed > 80 ? "#dc2626" : row.percentUsed > 50 ? "#f59e0b" : "#16a34a" }} />
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <div>هنوز هیچ درخواست خروجی در این اجرا ثبت نشده است.</div>
              )}
            </div>
            {diagnostics.recentFailures && diagnostics.recentFailures.length > 0 && (
              <div dir="rtl" style={{ marginBottom: 8 }}>
                <strong>آخرین خطاهای سرویس‌دهنده (فقط برای مدیر):</strong>
                <div style={{ marginTop: 4 }}>
                  {diagnostics.recentFailures.map((row) => (
                    <div key={`${row.at}-${row.code}`} dir="ltr">
                      {new Date(row.at).toLocaleTimeString("fa-IR")} · {row.hostname} · {row.code} · {row.detail}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {diagnostics.egressConclusion && <p dir="rtl"><strong>{diagnostics.egressConclusion}</strong></p>}
            {diagnostics.egress.map((probe) => (
              <div key={`egress-${probe.step}`}>
                {probe.ok ? "OK  " : "FAIL"} خروجی · {probe.step} · {probe.ms}ms · {probe.detail}
              </div>
            ))}
            {diagnostics.conclusion && <p dir="rtl">{diagnostics.conclusion}</p>}
            {diagnostics.rows.map((row) => (
              <div key={`${row.hostname}-${row.step}`}>
                {row.ok ? "OK  " : "FAIL"} {row.label} · {row.hostname} · {row.step} · {row.ms}ms · {row.detail}
              </div>
            ))}
          </div>
        )}
        </div>
        <div className="form-field"><label htmlFor="admin-api-key">API Key {providerStatus.keyHint && provider === providerStatus.provider ? <small className="key-hint" dir="ltr">{providerStatus.keyHint}</small> : null}</label><div className="input-with-icon input-with-action"><KeyRound size={17} /><input id="admin-api-key" dir="ltr" className="input api-key-input" type={showKey ? "text" : "password"} autoComplete="new-password" spellCheck={false} value={keyInput} onChange={(event) => { setKeyInput(event.target.value); resetResult(); setDiscoveryState("idle"); setDiscoveryMessage(""); }} placeholder={hasStoredProviderKey ? "برای حفظ کلید فعلی خالی بگذارید" : "کلید محرمانهٔ سرویس‌دهنده؛ کلید رایگان هم پذیرفته می‌شود"} /><button className="input-action" type="button" onClick={() => setShowKey((show) => !show)} aria-label={showKey ? "پنهان‌کردن کلید" : "نمایش کلید"}>{showKey ? <EyeOff size={17} /> : <Eye size={17} />}</button></div><span className="form-hint"><LockKeyhole size={11} /> کلید فقط روی سرور و با AES-256-GCM رمزنگاری می‌شود؛ هرگز به مرورگر معلم ارسال نمی‌شود.</span></div>
      </div>
      <div className="api-test-row">
        <button className="btn btn-secondary" type="button" onClick={() => void runDiagnostics()} disabled={diagnostics.loading}>{diagnostics.loading ? <LoaderCircle className="spin-icon" size={16} /> : <ShieldCheck size={16} />}{diagnostics.loading ? "در حال تشخیص…" : "تشخیص شبکه"}</button>
        <button className="btn btn-secondary" onClick={() => testConnection(false)} disabled={["testing", "saving"].includes(testState)}>{testState === "testing" ? <LoaderCircle className="spin-icon" size={16} /> : <RefreshCw size={16} />}{testState === "testing" ? "در حال بررسی…" : "آزمایش اتصال"}</button>
        <button className="btn btn-primary" onClick={() => testConnection(true)} disabled={["testing", "saving"].includes(testState)}>{testState === "saving" ? <LoaderCircle className="spin-icon" size={16} /> : <ShieldCheck size={16} />}{testState === "saving" ? "در حال ذخیره…" : "آزمایش و ذخیرهٔ امن"}</button>
        {testState === "success" && <span className="api-test-message success"><CheckCircle2 size={15} />{message}</span>}
        {testState === "error" && <span className="api-test-message error"><TriangleAlert size={15} />{message}</span>}
        {testState === "idle" && providerStatus.configured && <span className="api-test-message"><ShieldCheck size={15} />اتصال فعال سامانه: {providerStatus.providerLabel} · {providerStatus.model}</span>}
      </div>
    </div>
  );
}
