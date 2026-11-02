import type { ProviderId } from "../types";
import type { ProviderNetworkConfig } from "../api-network";
import { FALLBACK_MODEL_OPTIONS, mergeModelOptions, SUPPORTS_ACCOUNT_MODEL_DISCOVERY } from "../provider-catalog";
import { providerFetch } from "./provider-network";
import { ProviderError } from "./providers";
import { isJsonParserErrorMessage } from "../error-message";

interface ProviderModelRequest {
  provider: ProviderId;
  apiKey: string;
  network?: ProviderNetworkConfig;
}

interface ProviderModelRecord {
  id?: string;
  name?: string;
  displayName?: string;
  supportedGenerationMethods?: string[];
  input_modalities?: string[];
  output_modalities?: string[];
  capabilities?: { vision?: boolean; completion_chat?: boolean };
}

const DISCOVERY_URLS: Partial<Record<ProviderId, string>> = {
  openai: "https://api.openai.com/v1/models",
  gemini: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
  deepseek: "https://api.deepseek.com/models",
  minimax: "https://api.minimax.io/v1/models",
  mistral: "https://api.mistral.ai/v1/models",
};

function safeProviderDetail(rawMessage: string, apiKey: string): string {
  let message = rawMessage.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (apiKey) message = message.split(apiKey).join("[کلید]");
  message = message.replace(/AIza[0-9A-Za-z_-]{16,}/g, "[کلید]");
  return message.slice(0, 240);
}

export async function providerResponseError(response: Response, provider: ProviderId, apiKey: string): Promise<ProviderError> {
  const text = await response.text();
  let rawMessage = "";
  try {
    const payload = JSON.parse(text) as { error?: { message?: string } | string; message?: string; base_resp?: { status_msg?: string } };
    rawMessage = typeof payload.error === "string" ? payload.error : payload.error?.message || payload.message || payload.base_resp?.status_msg || "";
  } catch {
    // Provider proxies can return HTML or an empty response; do not expose it.
  }
  const detail = safeProviderDetail(isJsonParserErrorMessage(rawMessage) ? "" : rawMessage, apiKey);
  const lower = detail.toLowerCase();
  const providerName = provider === "gemini" ? "Google Gemini" : "سرویس‌دهنده";

  if (provider === "gemini" && /unrestricted|dormant|blocked.*key|key.*blocked/.test(lower)) {
    return new ProviderError("Google کلید Standard بدون محدودیت یا مسدودشده را نمی‌پذیرد. در Google AI Studio آن را به Gemini API محدود کنید یا یک Auth Key جدید بسازید؛ کلید رایگان هم پشتیبانی می‌شود.", 400);
  }
  if ((response.status === 400 || response.status === 401 || response.status === 403) && /api[ _-]?key|key.*valid|invalid.*key/.test(lower)) {
    return new ProviderError("کلید API پذیرفته نشد. کلید را کامل و بدون فاصله کپی کنید. برای Gemini، کلید باید از نوع Auth یا Standardِ محدودشده به Gemini API باشد؛ رایگان‌بودن کلید مانع ذخیره نیست.", 400);
  }
  if (response.status === 401 || response.status === 403) {
    if (provider === "gemini" && /country|region|location|territor|permission_denied/.test(lower)) {
      return new ProviderError("Google دسترسی از مسیر فعلی سرور را نمی‌پذیرد. شکن را در همین صفحه آزمایش و فعال کنید و سپس اتصال را دوباره بسنجید.", 403);
    }
    return new ProviderError("کلید معتبر نیست یا اجازهٔ استفاده از این سرویس را ندارد. نوع کلید و دسترسی پروژه را بررسی کنید.", response.status);
  }
  if (response.status === 404) {
    return new ProviderError("این مدل برای حساب شما پیدا نشد. «دریافت مدل‌های حساب» را بزنید یا نام به‌روز مدل را وارد کنید.", 400);
  }
  if (response.status === 429) {
    return new ProviderError("سهمیه یا محدودیت سرعت حساب فعال است. در کلید رایگان این خطا به معنی اتمام/تراکم سهمیهٔ رایگان است، نه نامعتبربودن کلید؛ کمی بعد دوباره تلاش کنید.", 429);
  }
  if (response.status === 400) {
    return new ProviderError(`${providerName} درخواست را نپذیرفت.${detail ? ` جزئیات سرویس: ${detail}` : " مدل و نوع کلید را بررسی کنید."}`, 400);
  }
  return new ProviderError(`${providerName} موقتاً پاسخ معتبر نداد (HTTP ${response.status}). کمی بعد دوباره تلاش کنید.`, response.status >= 500 ? 502 : response.status);
}

function modelId(record: ProviderModelRecord, provider: ProviderId): string {
  const raw = (record.id || record.name || "").trim();
  return provider === "gemini" ? raw.replace(/^models\//, "") : raw;
}

function isGradingCandidate(provider: ProviderId, record: ProviderModelRecord): boolean {
  const id = modelId(record, provider);
  if (!id || id.length > 120 || /[\s\u0000-\u001f]/.test(id)) return false;
  if (provider === "gemini") {
    if (!record.supportedGenerationMethods?.includes("generateContent")) return false;
    // These GenerateContent models do not return the text-only JSON required for grading.
    return !/(?:-tts(?:-|$)|-image(?:-|$)|-live(?:-|$)|native-audio|transcribe|embedding|^aqa$|^gemini-omni-)/i.test(id);
  }
  if (provider === "deepseek") {
    if (record.input_modalities?.length && !record.input_modalities.includes("image")) return false;
    if (record.output_modalities?.length && !record.output_modalities.includes("text")) return false;
    return id.startsWith("deepseek-");
  }
  if (provider === "openai") {
    if (!/^(?:gpt-|o\d|chatgpt-)/i.test(id)) return false;
    return !/(?:gpt-image|gpt-live|realtime|audio|transcribe|tts|embedding|moderation)/i.test(id);
  }
  if (provider === "minimax") return /^MiniMax-M/i.test(id);
  if (provider === "mistral") {
    if (record.capabilities?.completion_chat === false || record.capabilities?.vision === false) return false;
    return !/(?:embed|transcri|voxtral|realtime|tts|audio|moderation|classifier|^ocr)/i.test(id);
  }
  return true;
}

async function discoveryJson(url: string, input: ProviderModelRequest): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await providerFetch(url, {
      headers: input.provider === "gemini" ? { "x-goog-api-key": input.apiKey } : { Authorization: `Bearer ${input.apiKey}` },
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    }, input.network);
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") throw new ProviderError("خواندن مدل‌ها بیش از حد طول کشید؛ دوباره تلاش کنید.", 504);
    throw error;
  }
  if (!response.ok) throw await providerResponseError(response, input.provider, input.apiKey);
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    throw new ProviderError("پاسخ فهرست مدل‌های سرویس‌دهنده معتبر نبود.", 502);
  }
}

/** Read current model IDs from the provider account; no model or key is saved. */
export async function discoverProviderModels(input: ProviderModelRequest): Promise<string[]> {
  if (!SUPPORTS_ACCOUNT_MODEL_DISCOVERY[input.provider]) return [...FALLBACK_MODEL_OPTIONS[input.provider]];
  const initialUrl = DISCOVERY_URLS[input.provider];
  if (!initialUrl) return [...FALLBACK_MODEL_OPTIONS[input.provider]];

  const records: ProviderModelRecord[] = [];
  if (input.provider === "gemini") {
    let pageToken = "";
    for (let page = 0; page < 10; page += 1) {
      const url = new URL(initialUrl);
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const payload = await discoveryJson(url.toString(), input);
      if (Array.isArray(payload.models)) records.push(...payload.models as ProviderModelRecord[]);
      pageToken = typeof payload.nextPageToken === "string" ? payload.nextPageToken : "";
      if (!pageToken) break;
    }
  } else {
    const payload = await discoveryJson(initialUrl, input);
    if (Array.isArray(payload.data)) records.push(...payload.data as ProviderModelRecord[]);
  }

  const models = records.filter((record) => isGradingCandidate(input.provider, record)).map((record) => modelId(record, input.provider));
  if (!models.length) throw new ProviderError("سرویس‌دهنده مدل چندوجهی قابل‌استفاده‌ای برای این حساب برنگرداند. می‌توانید نام مدل را دستی وارد و آزمایش کنید.", 400);
  return mergeModelOptions(input.provider, models);
}
