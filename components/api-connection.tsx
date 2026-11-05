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
            {SUPPORTS_ACCOUNT_MODEL_DISCOVERY[provider] && <button type="button" className="btn btn-secondary model-discovery-button" onClick={() => void discoverModels()} disabled={discoveryState === "loading" || ["testing", "saving"].includes(testState)}>{discoveryState === "loading" ? <LoaderCircle className="spin-icon" size={15} /> : <RefreshCw size={15} />}{discoveryState === "loading" ? "در حال خواندن…" : "دریافت مدل‌های حساب"}</button>}
          </div>
          <datalist id="admin-model-options">{modelOptions.map((item) => <option key={item} value={item} />)}</datalist>
          <span className="form-hint">مدل‌های قبلی حفظ می‌شوند و فهرست حساب به آن‌ها اضافه می‌شود؛ نام هر مدل قدیمی یا تازه را هم می‌توانید دستی وارد کنید. برای تصحیح، ورودی تصویر و خروجی متن لازم است.</span>
          {provider === "gemini" && model.trim() === "gemini-3.7-flash" && <span className="form-hint model-alias-hint">Gemini 3.7 Flash منسوخ شده و Google آن را به ۳٫۸ هدایت می‌کند؛ برای تنظیم پایدار، ۳٫۸ پیشنهاد می‌شود.</span>}
          {discoveryMessage && <span className={`form-hint model-discovery-message ${discoveryState}`} aria-live="polite">{discoveryState === "success" ? <CheckCircle2 size={12} /> : discoveryState === "error" ? <TriangleAlert size={12} /> : null}{discoveryMessage}</span>}
        </div>
        <div className="form-field"><label htmlFor="admin-api-key">API Key {providerStatus.keyHint && provider === providerStatus.provider ? <small className="key-hint" dir="ltr">{providerStatus.keyHint}</small> : null}</label><div className="input-with-icon input-with-action"><KeyRound size={17} /><input id="admin-api-key" dir="ltr" className="input api-key-input" type={showKey ? "text" : "password"} autoComplete="new-password" spellCheck={false} value={keyInput} onChange={(event) => { setKeyInput(event.target.value); resetResult(); setDiscoveryState("idle"); setDiscoveryMessage(""); }} placeholder={hasStoredProviderKey ? "برای حفظ کلید فعلی خالی بگذارید" : "کلید محرمانهٔ سرویس‌دهنده؛ کلید رایگان هم پذیرفته می‌شود"} /><button className="input-action" type="button" onClick={() => setShowKey((show) => !show)} aria-label={showKey ? "پنهان‌کردن کلید" : "نمایش کلید"}>{showKey ? <EyeOff size={17} /> : <Eye size={17} />}</button></div><span className="form-hint"><LockKeyhole size={11} /> کلید فقط روی سرور و با AES-256-GCM رمزنگاری می‌شود؛ هرگز به مرورگر معلم ارسال نمی‌شود.</span></div>
      </div>
      <div className="api-test-row">
        <button className="btn btn-secondary" onClick={() => testConnection(false)} disabled={["testing", "saving"].includes(testState)}>{testState === "testing" ? <LoaderCircle className="spin-icon" size={16} /> : <RefreshCw size={16} />}{testState === "testing" ? "در حال بررسی…" : "آزمایش اتصال"}</button>
        <button className="btn btn-primary" onClick={() => testConnection(true)} disabled={["testing", "saving"].includes(testState)}>{testState === "saving" ? <LoaderCircle className="spin-icon" size={16} /> : <ShieldCheck size={16} />}{testState === "saving" ? "در حال ذخیره…" : "آزمایش و ذخیرهٔ امن"}</button>
        {testState === "success" && <span className="api-test-message success"><CheckCircle2 size={15} />{message}</span>}
        {testState === "error" && <span className="api-test-message error"><TriangleAlert size={15} />{message}</span>}
        {testState === "idle" && providerStatus.configured && <span className="api-test-message"><ShieldCheck size={15} />اتصال فعال سامانه: {providerStatus.providerLabel} · {providerStatus.model}</span>}
      </div>
    </div>
  );
}
