"use client";

import { useEffect, useState } from "react";
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
  const [usage, setUsage] = useState<{
    windowMinutes: number;
    maxPerWindow: number;
    maxConcurrency: number;
    usage: Array<{ hostname: string; used: number; limit: number; remaining: number; percentUsed: number; active: number; breakerOpen: boolean; breakerMinutesLeft: number }>;
    totalUsed: number;
    anyBreakerOpen: boolean;
    recentFailures: Array<{ at: string; hostname: string; code: string; detail: string }>;
    kaya: { at: string; reachable: boolean; address: string; blockedSince: string | null; tcp: { detail: string }; http: { status: number; code?: string } } | null;
    loaded: boolean;
  }>({ windowMinutes: 20, maxPerWindow: 120, maxConcurrency: 2, usage: [], totalUsed: 0, anyBreakerOpen: false, recentFailures: [], kaya: null, loaded: false });
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

  /**
   * The deep test sends the real request with the real key, so it answers the one
   * question the network probes cannot: is our request rejected, or is the path
   * closed? It is deliberately manual and one press at a time, because every step
   * spends a slot of the 20-minute outbound budget.
   */
  /**
   * The source address Kaya sees. Kaya's firewall drops this server's default
   * egress, so choosing another local address is the only in-app way to make it
   * work directly. The panel asks the server which addresses actually exist here,
   * because a made-up one fails every request.
   */
  const [egress, setEgress] = useState<{
    bindAddress: string;
    host: string;
    localAddresses: string[];
    addressMissing: boolean;
    loading: boolean;
    saving: boolean;
    message: string;
    error: string;
  }>({ bindAddress: "", host: "", localAddresses: [], addressMissing: false, loading: true, saving: false, message: "", error: "" });
  const [defaultEgress, setDefaultEgress] = useState("");

  async function loadEgress() {
    try {
      const response = await fetch("/api/admin/kaya-egress", { cache: "no-store" });
      if (!response.ok) return;
      const payload = (await response.json()) as {
        bindAddress?: string;
        host?: string;
        localAddresses?: string[];
        addressMissing?: boolean;
        defaultAddress?: string;
      };
      setDefaultEgress(payload.defaultAddress || "");
      setEgress((current) => ({
        ...current,
        bindAddress: payload.bindAddress || "",
        host: payload.host || "",
        localAddresses: payload.localAddresses || [],
        addressMissing: Boolean(payload.addressMissing),
        loading: false,
      }));
    } catch {
      setEgress((current) => ({ ...current, loading: false }));
    }
  }

  async function saveEgress() {
    setEgress((current) => ({ ...current, saving: true, message: "", error: "" }));
    try {
      const response = await fetch("/api/admin/kaya-egress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bindAddress: egress.bindAddress.trim(), host: egress.host.trim() }),
      });
      const payload = (await response.json()) as { error?: string; addressMissing?: boolean };
      if (!response.ok) throw new Error(payload.error || "ذخیره ناموفق بود.");
      setEgress((current) => ({ ...current, saving: false, message: "ذخیره شد. حالا «آزمون واقعی کایا» را بزنید.", addressMissing: Boolean(payload.addressMissing) }));
      // Re-test with the new path immediately: the point is to learn whether Kaya
      // now accepts us, not to leave the operator guessing.
      void runDeepTest();
    } catch (error) {
      setEgress((current) => ({ ...current, saving: false, error: error instanceof Error ? error.message : "ذخیره ناموفق بود." }));
    }
  }

  const [deepTest, setDeepTest] = useState<{
    running: boolean;
    conclusion: string;
    error: string;
    steps: Array<{ step: string; ok: boolean; status: number; ms: number; sentBytes: number; reading: string; detail: string }>;
    budget?: { usedAfter: number; limit: number; remaining: number; windowMinutes: number };
  }>({ running: false, conclusion: "", error: "", steps: [] });

  async function runDeepTest() {
    setDeepTest({ running: true, conclusion: "", error: "", steps: [] });
    try {
      const response = await fetch("/api/admin/kaya-live-test", { method: "POST", cache: "no-store" });
      const payload = (await response.json()) as {
        error?: string;
        conclusion?: string;
        steps?: Array<{ step: string; ok: boolean; status: number; ms: number; sentBytes: number; reading: string; detail: string }>;
        budget?: { usedAfter: number; limit: number; remaining: number; windowMinutes: number };
      };
      if (!response.ok) throw new Error(payload.error || "آزمون انجام نشد.");
      setDeepTest({ running: false, conclusion: payload.conclusion || "", error: "", steps: payload.steps || [], budget: payload.budget });
    } catch (error) {
      setDeepTest({ running: false, conclusion: "", error: error instanceof Error ? error.message : "آزمون انجام نشد.", steps: [] });
    }
  }

  // Named per layer, because "failed" alone is what made this take days.
  function stepLabel(step: string): string {
    if (step === "catalogue") return "کاتالوگ";
    if (step === "text") return "درخواست متنی";
    if (step === "image") return "درخواست با تصویر";
    return step;
  }

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

  // Poll the cheap counter every 20s so the operator can always see the outbound
  // budget without pressing a button. This endpoint reads in-process counters only.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch("/api/admin/outbound-usage", { cache: "no-store" });
        if (!response.ok) return;
        const payload = await response.json();
        if (cancelled) return;
        setUsage({
          windowMinutes: payload.windowMinutes ?? 20,
          maxPerWindow: payload.maxPerWindow ?? 120,
          maxConcurrency: payload.maxConcurrency ?? 2,
          usage: payload.usage ?? [],
          totalUsed: payload.totalUsed ?? 0,
          anyBreakerOpen: Boolean(payload.anyBreakerOpen),
          recentFailures: payload.recentFailures ?? [],
          kaya: payload.kaya ?? null,
          loaded: true,
        });
      } catch {
        /* the counter is cosmetic; never break the panel over it */
      }
    };
    void load();
    void loadEgress();
    const timer = setInterval(() => { void load(); }, 20_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

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
      <div className="notice notice-info outbound-usage-card" dir="rtl" style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <strong>محدودیت درخواست خروجی — پنجرهٔ {faNumber(usage.windowMinutes)} دقیقه‌ای</strong>
          <span className="form-hint">
            سقف {faNumber(usage.maxPerWindow)} درخواست · هم‌زمانی {faNumber(usage.maxConcurrency)} · برای جلوگیری از مسدودشدن سرور توسط میزبان
          </span>
        </div>
        {usage.usage.length === 0 ? (
          <div className="form-hint" style={{ marginTop: 6 }}>{usage.loaded ? "هنوز در این اجرا درخواستی به سرویس‌دهنده ارسال نشده است." : "در حال خواندن…"}</div>
        ) : (
          <div style={{ marginTop: 6 }}>
            {usage.usage.map((row) => (
              <div key={`usage-${row.hostname}`} style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
                <span dir="ltr" style={{ minWidth: 180 }}>{row.hostname}</span>
                <span style={{ display: "inline-block", width: 150, height: 8, background: "#e5e7eb", borderRadius: 4 }}>
                  <span style={{ display: "block", width: `${Math.min(100, row.percentUsed)}%`, height: 8, borderRadius: 4, background: row.percentUsed > 80 ? "#dc2626" : row.percentUsed > 50 ? "#f59e0b" : "#16a34a" }} />
                </span>
                <span>{faNumber(row.used)} از {faNumber(row.limit)} ({faNumber(row.percentUsed)}٪) · باقی‌مانده {faNumber(row.remaining)}</span>
                {row.active > 0 ? <span className="form-hint">{faNumber(row.active)} در حال ارسال</span> : null}
                {row.breakerOpen ? <span style={{ color: "#dc2626" }}>متوقف تا {faNumber(row.breakerMinutesLeft)} دقیقه</span> : null}
              </div>
            ))}
          </div>
        )}
        {usage.kaya ? (
          <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid #e5e7eb" }}>
            <strong>وضعیت مسیر Kaya: </strong>
            {usage.kaya.reachable ? (
              <span style={{ color: "#16a34a", fontWeight: 600 }}>
                باز است — الان می‌توانید «آزمایش اتصال» را بزنید
              </span>
            ) : (
              <span style={{ color: "#dc2626" }}>
                بسته است ({usage.kaya.tcp?.detail || "بدون پاسخ"}) — مقصد{" "}
                <span dir="ltr">{usage.kaya.address}</span> از این سرور در دسترس نیست
              </span>
            )}
            <span className="form-hint">
              {" "}· آخرین بررسی: {new Date(usage.kaya.at).toLocaleTimeString("fa-IR")}
              {!usage.kaya.reachable && usage.kaya.blockedSince
                ? ` · از ${new Date(usage.kaya.blockedSince).toLocaleTimeString("fa-IR")} قطع است`
                : ""}
              {" "}· هر ۱۰ دقیقه خودکار بررسی می‌شود
            </span>
            {!usage.kaya.reachable ? (
              <div className="form-hint" style={{ marginTop: 4 }}>
                نیازی به تست دستی نیست: به‌محض باز شدن مسیر، همین خط سبز می‌شود. تا آن زمان هر تلاش فقط سهمیهٔ درخواست خروجی را مصرف می‌کند.
                {" "}برای فعال‌کردن نگهبان: <code dir="ltr">npm run kaya:watch</code>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="form-hint" style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid #e5e7eb" }}>
            وضعیت مسیر Kaya هنوز ثبت نشده است. برای فعال‌کردن بررسی خودکار: <code dir="ltr">npm run kaya:watch</code>
          </div>
        )}
        {usage.anyBreakerOpen ? (
          <div className="form-hint" style={{ marginTop: 6, color: "#dc2626" }}>
            ارسال به یکی از سرویس‌دهنده‌ها موقتاً متوقف شده است؛ دلیلش را در «آخرین خطاها» پایین همین صفحه ببینید.
          </div>
        ) : null}
        {usage.recentFailures.length > 0 ? (
          <div className="form-hint" style={{ marginTop: 6 }}>
            آخرین خطا: <span dir="ltr">{usage.recentFailures[0].code} · {usage.recentFailures[0].hostname}</span> — {new Date(usage.recentFailures[0].at).toLocaleTimeString("fa-IR")}
          </div>
        ) : null}
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
        <div className="form-field">
          <label htmlFor="admin-kaya-egress">آدرس خروجی برای کایا <small className="key-hint">اختیاری</small></label>
          <div className="input-with-action">
            <Globe size={17} />
            <input
              id="admin-kaya-egress"
              dir="ltr"
              className="input"
              value={egress.bindAddress}
              onChange={(event) => setEgress((current) => ({ ...current, bindAddress: event.target.value, message: "", error: "" }))}
              placeholder="185.192.112.49"
              spellCheck={false}
            />
            <button className="input-action" type="button" onClick={() => void saveEgress()} disabled={egress.saving} aria-label="ذخیرهٔ آدرس خروجی">
              {egress.saving ? <LoaderCircle className="spin-icon" size={17} /> : <Check size={17} />}
            </button>
          </div>
          <span className="form-hint">
            <Globe size={11} /> اگر کایا آدرس فعلی سرور را نمی‌پذیرد، همان IP ایرانی خودتان را اینجا بگذارید تا درخواست‌ها با آن آدرس خارج شوند. خالی بگذارید تا سرور خودش انتخاب کند.
          </span>
          <span className="form-hint">
            <Globe size={11} /> این آدرس کدام است؟ آدرسی که سرور با آن به اینترنت می‌رود و کایا آن را رد می‌کند
            {defaultEgress ? <b dir="ltr"> {defaultEgress}</b> : null}
            {" — "}اگر آدرس ایرانی دیگری دارید که روی همین کارت شبکه است، همان را بگذارید؛ اگر ندارید، از هاستینگ بخواهید آدرس ایرانی را روی کارت شبکهٔ سرور بگذارد.
          </span>
          {egress.localAddresses.length > 0 && (
            <span className="form-hint">
              آدرس‌های موجود روی این سرور (برای انتخاب کلیک کنید):
              {egress.localAddresses.map((address) => (
                <button
                  key={address}
                  type="button"
                  className="chip-button"
                  dir="ltr"
                  onClick={() => setEgress((current) => ({ ...current, bindAddress: address, message: "", error: "" }))}
                >
                  {address}
                </button>
              ))}
            </span>
          )}
          {egress.addressMissing && (
            <span className="api-test-message error"><TriangleAlert size={15} />این آدرس روی سرور وجود ندارد؛ درخواست‌ها با خطای EADDRNOTAVAIL رد می‌شوند.</span>
          )}
          {egress.message && <span className="api-test-message success"><CheckCircle2 size={15} />{egress.message}</span>}
          {egress.error && <span className="api-test-message error"><TriangleAlert size={15} />{egress.error}</span>}
        </div>
        <div className="form-field"><label htmlFor="admin-api-key">API Key {providerStatus.keyHint && provider === providerStatus.provider ? <small className="key-hint" dir="ltr">{providerStatus.keyHint}</small> : null}</label><div className="input-with-icon input-with-action"><KeyRound size={17} /><input id="admin-api-key" dir="ltr" className="input api-key-input" type={showKey ? "text" : "password"} autoComplete="new-password" spellCheck={false} value={keyInput} onChange={(event) => { setKeyInput(event.target.value); resetResult(); setDiscoveryState("idle"); setDiscoveryMessage(""); }} placeholder={hasStoredProviderKey ? "برای حفظ کلید فعلی خالی بگذارید" : "کلید محرمانهٔ سرویس‌دهنده؛ کلید رایگان هم پذیرفته می‌شود"} /><button className="input-action" type="button" onClick={() => setShowKey((show) => !show)} aria-label={showKey ? "پنهان‌کردن کلید" : "نمایش کلید"}>{showKey ? <EyeOff size={17} /> : <Eye size={17} />}</button></div><span className="form-hint"><LockKeyhole size={11} /> کلید فقط روی سرور و با AES-256-GCM رمزنگاری می‌شود؛ هرگز به مرورگر معلم ارسال نمی‌شود.</span></div>
      </div>
      <div className="api-test-row">
        <button className="btn btn-secondary" type="button" onClick={() => void runDiagnostics()} disabled={diagnostics.loading}>{diagnostics.loading ? <LoaderCircle className="spin-icon" size={16} /> : <ShieldCheck size={16} />}{diagnostics.loading ? "در حال تشخیص…" : "تشخیص شبکه"}</button>
        <button className="btn btn-secondary" type="button" onClick={() => void runDeepTest()} disabled={deepTest.running}>{deepTest.running ? <LoaderCircle className="spin-icon" size={16} /> : <BrainCircuit size={16} />}{deepTest.running ? "در حال آزمون واقعی…" : "آزمون واقعی کایا"}</button>
        <button className="btn btn-secondary" onClick={() => testConnection(false)} disabled={["testing", "saving"].includes(testState)}>{testState === "testing" ? <LoaderCircle className="spin-icon" size={16} /> : <RefreshCw size={16} />}{testState === "testing" ? "در حال بررسی…" : "آزمایش اتصال"}</button>
        <button className="btn btn-primary" onClick={() => testConnection(true)} disabled={["testing", "saving"].includes(testState)}>{testState === "saving" ? <LoaderCircle className="spin-icon" size={16} /> : <ShieldCheck size={16} />}{testState === "saving" ? "در حال ذخیره…" : "آزمایش و ذخیرهٔ امن"}</button>
        {testState === "success" && <span className="api-test-message success"><CheckCircle2 size={15} />{message}</span>}
        {testState === "error" && <span className="api-test-message error"><TriangleAlert size={15} />{message}</span>}
        {testState === "idle" && providerStatus.configured && <span className="api-test-message"><ShieldCheck size={15} />اتصال فعال سامانه: {providerStatus.providerLabel} · {providerStatus.model}</span>}
      </div>
      {(deepTest.steps.length > 0 || deepTest.error) && (
        <div className="diagnostics-block">
          {deepTest.error && <div className="api-test-message error"><TriangleAlert size={15} />{deepTest.error}</div>}
          {deepTest.steps.map((step) => (
            <div key={step.step} className={step.ok ? "api-test-message success" : "api-test-message error"}>
              {step.ok ? <CheckCircle2 size={15} /> : <TriangleAlert size={15} />}
              <span>
                <b>{stepLabel(step.step)}</b>
                {" · "}{step.status ? `HTTP ${step.status}` : "بی‌پاسخ"}{" · "}{(step.sentBytes / 1024).toFixed(1)} KB{" · "}{step.ms}ms
                {" — "}{step.reading}
                {step.detail ? <span dir="ltr" className="diagnostics-detail"> · {step.detail}</span> : null}
              </span>
            </div>
          ))}
          {deepTest.conclusion && <div className="diagnostics-conclusion">{deepTest.conclusion}</div>}
          {deepTest.budget && (
            <div className="diagnostics-conclusion">
              مصرف پنجرهٔ ۲۰ دقیقه‌ای: {deepTest.budget.usedAfter} از {deepTest.budget.limit} · باقی‌مانده {deepTest.budget.remaining}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
