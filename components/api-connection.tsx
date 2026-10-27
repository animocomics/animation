"use client";

import { useEffect, useState } from "react";
import {
  Check,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  Zap,
} from "lucide-react";
import { useApp } from "../lib/app-context";
import type { ProviderId } from "../lib/types";

const MODEL_OPTIONS: Record<ProviderId, string[]> = {
  openai: ["gpt-4.1", "gpt-4.1-mini", "gpt-4o"],
  gemini: ["gemini-2.5-pro", "gemini-2.5-flash"],
};

export function ApiConnection({ compact = false }: { compact?: boolean }) {
  const { settings, saveSettings, apiKey, setApiKey, notify } = useApp();
  const [keyInput, setKeyInput] = useState(apiKey);
  const [showKey, setShowKey] = useState(false);
  const [testState, setTestState] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [testMessage, setTestMessage] = useState("");

  useEffect(() => setKeyInput(apiKey), [apiKey]);

  const changeProvider = (provider: ProviderId) => {
    if (provider === settings.provider) return;
    saveSettings({ ...settings, provider, model: MODEL_OPTIONS[provider][0] });
    setApiKey("");
    setKeyInput("");
    setTestState("idle");
    setTestMessage("");
  };

  const testConnection = async () => {
    const trimmed = keyInput.trim();
    if (trimmed.length < 8) {
      setTestState("error");
      setTestMessage("ابتدا API Key معتبر را وارد کنید.");
      return;
    }
    setApiKey(trimmed);
    setTestState("testing");
    setTestMessage("");
    try {
      const response = await fetch("/api/provider/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: settings.provider, model: settings.model, apiKey: trimmed }),
      });
      const payload = await response.json() as { error?: string; message?: string };
      if (!response.ok) throw new Error(payload.error || "بررسی اتصال ناموفق بود.");
      setTestState("success");
      setTestMessage(payload.message || "اتصال برقرار است.");
      notify({ title: "اتصال API برقرار شد", description: `${settings.provider === "openai" ? "OpenAI" : "Gemini"} · ${settings.model}`, variant: "success" });
    } catch (error) {
      setTestState("error");
      setTestMessage(error instanceof Error ? error.message : "ارتباط برقرار نشد.");
    }
  };

  return (
    <div className={`api-connection ${compact ? "compact" : ""}`}>
      <div className="provider-options" role="radiogroup" aria-label="سرویس‌دهندهٔ هوش مصنوعی">
        <button role="radio" aria-checked={settings.provider === "openai"} className={`provider-option ${settings.provider === "openai" ? "selected" : ""}`} onClick={() => changeProvider("openai")}>
          <span className="provider-logo openai"><Sparkles size={20} /></span>
          <span><strong>OpenAI</strong><small>Responses API · تصویر و PDF</small></span>
          <i>{settings.provider === "openai" && <Check size={12} />}</i>
        </button>
        <button role="radio" aria-checked={settings.provider === "gemini"} className={`provider-option ${settings.provider === "gemini" ? "selected" : ""}`} onClick={() => changeProvider("gemini")}>
          <span className="provider-logo gemini"><Zap size={20} /></span>
          <span><strong>Google Gemini</strong><small>GenerateContent · تصویر و PDF</small></span>
          <i>{settings.provider === "gemini" && <Check size={12} />}</i>
        </button>
      </div>
      <div className="api-fields">
        <div className="form-field">
          <label htmlFor={compact ? "wizard-model" : "settings-model"}>مدل چندوجهی</label>
          <select id={compact ? "wizard-model" : "settings-model"} className="select" value={settings.model} onChange={(event) => { saveSettings({ ...settings, model: event.target.value }); setTestState("idle"); }}>
            {MODEL_OPTIONS[settings.provider].map((model) => <option key={model} value={model}>{model}</option>)}
          </select>
          <span className="form-hint">مدل باید در حساب شما فعال و از ورودی تصویر پشتیبانی کند.</span>
        </div>
        <div className="form-field">
          <label htmlFor={compact ? "wizard-api-key" : "settings-api-key"}>API Key</label>
          <div className="input-with-icon input-with-action">
            <KeyRound size={17} />
            <input id={compact ? "wizard-api-key" : "settings-api-key"} dir="ltr" className="input api-key-input" type={showKey ? "text" : "password"} autoComplete="off" spellCheck={false} value={keyInput} onChange={(event) => { setKeyInput(event.target.value); setApiKey(event.target.value); setTestState("idle"); }} placeholder={settings.provider === "openai" ? "sk-..." : "AIza..."} />
            <button className="input-action" type="button" onClick={() => setShowKey((show) => !show)} aria-label={showKey ? "پنهان‌کردن کلید" : "نمایش کلید"}>{showKey ? <EyeOff size={17} /> : <Eye size={17} />}</button>
          </div>
          <span className="form-hint"><LockKeyhole size={11} /> فقط در SessionStorage همین تب؛ پس از بستن تب پاک می‌شود.</span>
        </div>
      </div>
      <div className="api-test-row">
        <button className="btn btn-secondary" onClick={testConnection} disabled={testState === "testing" || !keyInput.trim()}>
          {testState === "testing" ? <LoaderCircle className="spin-icon" size={16} /> : testState === "success" ? <CheckCircle2 size={16} /> : <RefreshCw size={16} />}
          {testState === "testing" ? "در حال بررسی…" : "آزمایش اتصال"}
        </button>
        {testState === "success" && <span className="api-test-message success"><CheckCircle2 size={15} />{testMessage}</span>}
        {testState === "error" && <span className="api-test-message error"><TriangleAlert size={15} />{testMessage}</span>}
        {testState === "idle" && apiKey && <span className="api-test-message"><ShieldCheck size={15} />کلید برای این نشست آماده است؛ پیش از تصحیح اتصال را آزمایش کنید.</span>}
      </div>
    </div>
  );
}
