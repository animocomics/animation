"use client";

import { useState } from "react";
import { Check, CheckCircle2, Eye, EyeOff, KeyRound, LoaderCircle, LockKeyhole, RefreshCw, ShieldCheck, Sparkles, TriangleAlert, Zap, BrainCircuit, ScanText } from "lucide-react";
import { useApp } from "../lib/app-context";
import type { ProviderId } from "../lib/types";

const MODEL_OPTIONS: Record<ProviderId, string[]> = {
  openai: ["gpt-4.1", "gpt-4.1-mini", "gpt-4o"],
  gemini: ["gemini-2.5-pro", "gemini-2.5-flash"],
  deepseek: ["deepseek-flash"],
  zai: ["glm-5.3-flash", "glm-5.3-flashx"],
};
const PROVIDERS = {
  openai: { label: "OpenAI", hint: "Responses API · تصویر و PDF", icon: Sparkles },
  gemini: { label: "Google Gemini", hint: "GenerateContent · تصویر و PDF", icon: Zap },
  deepseek: { label: "DeepSeek", hint: "Responses API · تصویر و PDF با تبدیل خودکار", icon: BrainCircuit },
  zai: { label: "Z.AI GLM", hint: "GLM 5.3 Flash · تصویر و PDF با تبدیل خودکار", icon: ScanText },
} as const;

export function ApiConnection() {
  const { providerStatus, refreshProviderStatus, notify, user } = useApp();
  const [provider, setProvider] = useState<ProviderId>(providerStatus.provider);
  const [model, setModel] = useState(providerStatus.model);
  const [keyInput, setKeyInput] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [testState, setTestState] = useState<"idle" | "testing" | "saving" | "success" | "error">("idle");
  const [message, setMessage] = useState("");

  if (user.role !== "admin") return null;

  function selectProvider(next: ProviderId) {
    setProvider(next);
    setModel(MODEL_OPTIONS[next][0]);
    setKeyInput("");
    setTestState("idle");
    setMessage("");
  }

  async function testConnection(saveAfter = false) {
    if (!keyInput.trim() && !providerStatus.configured) {
      setTestState("error"); setMessage("ابتدا API Key را وارد کنید."); return;
    }
    setTestState(saveAfter ? "saving" : "testing"); setMessage("");
    try {
      const response = await fetch("/api/provider/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider, model, apiKey: keyInput.trim() || undefined }) });
      const payload = await response.json() as { error?: string; message?: string };
      if (!response.ok) throw new Error(payload.error || "بررسی اتصال ناموفق بود.");
      if (saveAfter) {
        const saved = await fetch("/api/provider", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider, model, apiKey: keyInput.trim() || undefined }) });
        const savedPayload = await saved.json() as { error?: string };
        if (!saved.ok) throw new Error(savedPayload.error || "ذخیرهٔ کلید ناموفق بود.");
        await refreshProviderStatus();
        setKeyInput("");
      }
      setTestState("success");
      setMessage(saveAfter ? "اتصال تأیید و کلید رمزنگاری‌شده روی سرور ذخیره شد." : payload.message || "اتصال برقرار است.");
      notify({ title: saveAfter ? "اتصال سامانه به‌روز شد" : "اتصال API برقرار شد", description: `${PROVIDERS[provider].label} · ${model}`, variant: "success" });
    } catch (error) {
      setTestState("error");
      setMessage(error instanceof Error ? error.message : "ارتباط برقرار نشد.");
    }
  }

  return (
    <div className="api-connection admin-api-connection">
      <div className="provider-options four-providers" role="radiogroup" aria-label="سرویس‌دهندهٔ هوش مصنوعی">
        {(Object.keys(PROVIDERS) as ProviderId[]).map((id) => {
          const item = PROVIDERS[id]; const Icon = item.icon;
          return <button key={id} role="radio" aria-checked={provider === id} className={`provider-option ${provider === id ? "selected" : ""}`} onClick={() => selectProvider(id)}><span className={`provider-logo ${id}`}><Icon size={20} /></span><span><strong>{item.label}</strong><small>{item.hint}</small></span><i>{provider === id && <Check size={12} />}</i></button>;
        })}
      </div>
      <div className="api-fields">
        <div className="form-field"><label htmlFor="admin-model">مدل چندوجهی</label><select id="admin-model" className="select" value={model} onChange={(event) => { setModel(event.target.value); setTestState("idle"); }}>{MODEL_OPTIONS[provider].map((item) => <option key={item} value={item}>{item}</option>)}</select><span className="form-hint">مدل باید در حساب سرویس‌دهنده فعال و از ورودی تصویر پشتیبانی کند.</span></div>
        <div className="form-field"><label htmlFor="admin-api-key">API Key {providerStatus.keyHint && provider === providerStatus.provider ? <small className="key-hint" dir="ltr">{providerStatus.keyHint}</small> : null}</label><div className="input-with-icon input-with-action"><KeyRound size={17} /><input id="admin-api-key" dir="ltr" className="input api-key-input" type={showKey ? "text" : "password"} autoComplete="new-password" spellCheck={false} value={keyInput} onChange={(event) => { setKeyInput(event.target.value); setTestState("idle"); }} placeholder={providerStatus.configured && provider === providerStatus.provider ? "برای حفظ کلید فعلی خالی بگذارید" : "کلید محرمانهٔ سرویس‌دهنده"} /><button className="input-action" type="button" onClick={() => setShowKey((show) => !show)} aria-label={showKey ? "پنهان‌کردن کلید" : "نمایش کلید"}>{showKey ? <EyeOff size={17} /> : <Eye size={17} />}</button></div><span className="form-hint"><LockKeyhole size={11} /> کلید فقط روی سرور و با AES-256-GCM رمزنگاری می‌شود؛ هرگز به مرورگر معلم ارسال نمی‌شود.</span></div>
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
