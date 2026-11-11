import type { ProviderId } from "../types";
import { FALLBACK_MODEL_OPTIONS, mergeModelOptions, SUPPORTS_ACCOUNT_MODEL_DISCOVERY } from "../provider-catalog";
import { providerFetch } from "./provider-network";
import { kayaBaseUrl, type KayaEgressConfig } from "./kaya-egress";
import { gapgptBaseUrl, openrouterBaseUrl, providerHttpRefusal } from "./providers";
import { ProviderError } from "./providers";
import { isJsonParserErrorMessage } from "../error-message";

interface ProviderModelRequest {
  provider: ProviderId;
  apiKey: string;
  /** Only Kaya honours this: it is where the request is actually sent. */
  egress?: KayaEgressConfig;
}

interface ProviderModelRecord {
  id?: string;
  name?: string;
  displayName?: string;
  supportedGenerationMethods?: string[];
  input_modalities?: string[];
  output_modalities?: string[];
  capabilities?: { vision?: boolean; completion_chat?: boolean };
  /**
   * OpenRouter publishes modalities here rather than at the top level:
   * `{ architecture: { input_modalities: ["text", "image"] } }`. Reading only the
   * top-level field made every model look undeclared, and an undeclared model is
   * deliberately kept — so the picker would have offered text-only models, which is
   * exactly the mistake that costs a sheet (a blind model invents one).
   */
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
}

const DISCOVERY_URLS: Partial<Record<ProviderId, string>> = {
  openai: "https://api.openai.com/v1/models",
  gemini: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
  deepseek: "https://api.deepseek.com/models",
  minimax: "https://api.minimax.io/v1/models",
  mistral: "https://api.mistral.ai/v1/models",
  // Kaya returns an OpenAI-style list; the same URL also accepts POST.
  kaya: "https://kayaai.ir/api/chat/completions",
  // Standard OpenAI catalogue endpoint.
  gapgpt: "https://api.gapgpt.app/v1/models",
  // Public catalogue: no key needed, and it carries modalities and price per model.
  openrouter: "https://openrouter.ai/api/v1/models",
};

/** Providers whose discovery URL depends on the operator's configured host. */
const HOST_DRIVEN_DISCOVERY: Partial<Record<ProviderId, (egress: KayaEgressConfig | undefined) => string>> = {
  kaya: (egress) => `${kayaBaseUrl(egress)}/chat/completions`,
  gapgpt: (egress) => `${gapgptBaseUrl(egress)}/models`,
  openrouter: (egress) => `${openrouterBaseUrl(egress)}/models`,
};

/**
 * `providerHttpRefusal` lives in providers.ts with the rest of the provider table; this
 * thin wrapper keeps the import graph one-way (provider-models already imports providers).
 */


function safeProviderDetail(rawMessage: string, apiKey: string): string {
  let message = rawMessage.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (apiKey) message = message.split(apiKey).join("[کلید]");
  message = message.replace(/AIza[0-9A-Za-z_-]{16,}/g, "[کلید]");
  return message.slice(0, 240);
}

export async function providerResponseError(response: Response, provider: ProviderId, apiKey: string, model = ""): Promise<ProviderError> {
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
  // OpenRouter first, and through the shared table: this is the exact line that told the
  // operator "the key is not valid" for a key that had just listed 274 models. OpenRouter
  // uses 403 for a content-policy refusal and for some key-scope limits; a bad key is 401.
  if (provider === "openrouter") return providerHttpRefusal("openrouter", response.status, rawMessage, model);
  if (response.status === 401 || response.status === 403) {
    if (provider === "gemini" && /country|region|location|territor|permission_denied/.test(lower)) {
      return new ProviderError("Google دسترسی از مسیر فعلی سرور را نمی‌پذیرد. شکن را در همین صفحه آزمایش و فعال کنید و سپس اتصال را دوباره بسنجید.", 400);
    }
    return new ProviderError("کلید معتبر نیست یا اجازهٔ استفاده از این سرویس را ندارد. نوع کلید و دسترسی پروژه را بررسی کنید.", 400);
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

/**
 * The models from a catalogue that can actually grade a photographed sheet.
 *
 * Exported because this is the decision that costs money when it is wrong: a text-only
 * model does not fail loudly on a vision task, it invents a page. The tests feed it a
 * fake catalogue that contains exactly the traps — a text-only Llama, an image
 * generator, an embedding model — so the filter is proven rather than assumed.
 */
export function filterGradingCandidates(provider: ProviderId, records: ProviderModelRecord[]): string[] {
  return records.map(flattenArchitecture).filter((record) => isGradingCandidate(provider, record)).map((record) => modelId(record, provider));
}

/** Copies the `architecture` modalities onto the plain fields the filter reads. */
function flattenArchitecture(record: ProviderModelRecord): ProviderModelRecord {
  if (!record.architecture) return record;
  return {
    ...record,
    input_modalities: record.input_modalities ?? record.architecture.input_modalities,
    output_modalities: record.output_modalities ?? record.architecture.output_modalities,
  };
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
  if (provider === "kaya") {
    // Kaya catalogue ids are "<owner>/<model>" or a short Claude alias.
    if (record.output_modalities?.length && !record.output_modalities.includes("text")) return false;
    return /^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id) || /^claude-/.test(id);
  }
  if (provider === "openrouter") {
    // One catalogue covers every vendor, so ids are "owner/model" and carry no shared
    // prefix. Only two things disqualify a model here: it cannot emit text, or it does
    // not declare image input. The second is the one that costs money — a text-only model
    // "reads" a sheet by inventing it — so a declared-modality list without "image" is a
    // refusal, exactly as on GapGPT.
    if (record.output_modalities?.length && !record.output_modalities.includes("text")) return false;
    if (record.input_modalities?.length && !record.input_modalities.includes("image")) return false;
    if (record.capabilities?.vision === false) return false;
    return !/(?:image|imagen|embed|whisper|tts|audio|video|veo|kling|sora|midjourney|rerank|moderation)/i.test(id);
  }
  if (provider === "gapgpt") {
    // One catalogue covers many vendors, so the ids carry no shared prefix. Drop
    // only what cannot return a text grade: image/video/audio/embedding models.
    if (record.output_modalities?.length && !record.output_modalities.includes("text")) return false;
    // A model that declares its input modalities and cannot take an image is the
    // most common reason a sheet "reads" but never produces a draft: every request
    // is refused for carrying a picture, and nothing in the panel said so. Grading
    // and importing are always vision tasks, so such a model is not a candidate.
    if (record.input_modalities?.length && !record.input_modalities.includes("image")) return false;
    return !/(?:image|imagen|embed|whisper|tts|audio|video|veo|kling|sora|midjourney|rerank|moderation)/i.test(id);
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
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") throw new ProviderError("خواندن مدل‌ها بیش از حد طول کشید؛ دوباره تلاش کنید.", 504);
    // A socket failure has no HTTP status; report the code instead of letting the
    // route fall back to a generic "check the server connection" sentence.
    const value = error as { code?: string; cause?: { code?: string }; message?: string } | undefined;
    const code = value?.cause?.code || value?.code || "";
    if (code) {
      throw new ProviderError(
        `اتصال به ${new URL(url).hostname} برقرار نشد (${code}). اگر ETIMEDOUT/ECONNRESET است، شبکهٔ خروجی سرور این مقصد را می‌بندد؛ از «تشخیص شبکه» لایهٔ ناموفق را ببینید.`,
        502,
      );
    }
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
  const resolveUrl = HOST_DRIVEN_DISCOVERY[input.provider];
  const initialUrl = resolveUrl ? resolveUrl(input.egress) : DISCOVERY_URLS[input.provider];
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

  if (input.provider === "kaya") {
    // The operator asked for the whole catalogue. Return every interactive chat
    // model, keeping the raw gateway order and dropping only the entries that are
    // not usable for interactive grading:
    //   "~"    floating aliases that can change under the same name
    //   ":batch" batch-only variants that are not served on the chat path
    const catalogue = records
      .map((record) => modelId(record, "kaya"))
      .filter((id) => id && !id.startsWith("~") && !id.endsWith(":batch"));
    const unique = [...new Set(catalogue)];
    if (!unique.length) throw new ProviderError("Kaya AI فهرست مدل‌ها را برنگرداند؛ نام مدل را دستی وارد کنید.", 400);
    const discovered = mergeModelOptions("kaya", unique);
    const verified = FALLBACK_MODEL_OPTIONS.kaya.filter((id) => !discovered.includes(id));
    return [...verified, ...discovered];
  }
  const models = filterGradingCandidates(input.provider, records);
  if (!models.length) throw new ProviderError("سرویس‌دهنده مدل چندوجهی قابل‌استفاده‌ای برای این حساب برنگرداند. می‌توانید نام مدل را دستی وارد و آزمایش کنید.", 400);
  return mergeModelOptions(input.provider, models);
}
