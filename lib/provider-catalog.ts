import type { ProviderId } from "./types";

/**
 * Every provider id, in one place.
 *
 * This is derived from FALLBACK_MODEL_OPTIONS at the bottom of this file, but the
 * routes import it directly: each route used to carry its own copy of the id list,
 * and a provider missing from even one copy was rejected with a bare 400 before any
 * request was sent. Adding a provider now touches one table, not six enums.
 */

/**
 * Offline suggestions only. The admin UI also reads the account's live model
 * list and accepts a manually entered model ID, so a provider release never
 * waits for a Nomreh release.
 */
export const FALLBACK_MODEL_OPTIONS: Record<ProviderId, string[]> = {
  openai: ["gpt-6.1-terra", "gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra", "gpt-4.1", "gpt-4.1-mini", "gpt-4o"],
  gemini: [
    "gemini-3.8-flash",
    "gemini-4-argon",
    "gemini-3.7-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-3.1-pro-preview",
    "gemini-3-flash-preview",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.5-pro",
  ],
  deepseek: ["deepseek-flash"],
  zai: ["glm-5.3-flash", "glm-5.3-flashx"],
  minimax: ["MiniMax-M3.1-Flash", "MiniMax-M3"],
  inkling: [
    "thinkingmachines/Inkling-Small:peft:262144:sampling-nvfp4",
    "thinkingmachines/Inkling:peft:262144:sampling-nvfp4",
  ],
  mistral: ["mistral-large-4", "mistral-large-4-0"],
  // Kaya AI serves an OpenAI-compatible catalogue; IDs are owner/model strings.
  // Every entry below was read from the live GET /api/chat/completions list.
  // GapGPT is an OpenAI-compatible gateway over several vendors. Only chat models
  // that accept images are listed; the admin panel also reads the live list from
  // the account, and a manually typed ID is always accepted.
  gapgpt: [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-4o",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "claude-sonnet-5.5",
    "claude-3.7-sonnet",
    "deepseek-chat",
  ],
  openrouter: [
    // Free vision models first: the operator's standing rule is that money must not go
    // missing while a problem is still being found. Each is served by a different upstream
    // host, which is the point — a 429 on a free model is usually that one host being full,
    // so the next entry is often free while the first is not.
    "google/gemma-3-27b-it:free",
    "meta-llama/llama-4-scout:free",
    "qwen/qwen2.5-vl-72b-instruct:free",
    "mistralai/mistral-small-3.2-24b-instruct:free",
    // Paid, for when a model has to be reliable rather than free.
    "google/gemini-2.5-flash",
    "google/gemini-2.5-pro",
    "anthropic/claude-sonnet-4.5",
    "openai/gpt-4o",
    "openai/gpt-4.1-mini",
    "qwen/qwen2.5-vl-72b-instruct",
    "mistralai/mistral-large",
    // The router's own free slot: OpenRouter picks whichever free model is available, so it
    // always answers something and never has a single saturated host.
    "openrouter/free",
  ],
  kaya: [
    "deepseek/deepseek-v4.1-flash",
    "deepseek/deepseek-v4-flash",
    "deepseek/deepseek-v4-pro",
    "google/gemini-2.5-flash",
    "google/gemini-3.8-flash",
    "openai/gpt-4o-mini",
    "openai/gpt-5.5",
    "z-ai/glm-5.3-flash",
    "minimax/minimax-m3.1-flash",
    "anthropic/claude-sonnet-5.5",
    "anthropic/claude-opus-5.5",
  ],
};

const PROVIDER_IDS = Object.keys(FALLBACK_MODEL_OPTIONS) as [ProviderId, ...ProviderId[]];

export { PROVIDER_IDS };

export const RECOMMENDED_MODELS: Record<ProviderId, string> = {
  openai: "gpt-6.1-terra",
  // Current stable Flash with a free tier; unlike 2.5 it is open to new projects.
  gemini: "gemini-3.8-flash",
  deepseek: "deepseek-flash",
  zai: "glm-5.3-flash",
  minimax: "MiniMax-M3.1-Flash",
  inkling: "thinkingmachines/Inkling-Small:peft:262144:sampling-nvfp4",
  mistral: "mistral-large-4",
  // Cheapest capable multimodal chat model on the Kaya catalogue.
  kaya: "deepseek/deepseek-v4.1-flash",
  // A general vision model that is reliable on Persian handwriting; the operator
  // can switch to a cheaper Flash model from the same page once grading is proven.
  gapgpt: "gemini-2.5-pro",
  // Vision-capable and cheap enough to use on every sheet; the whole catalogue is one
  // call away in the panel, so this is only the starting point.
  openrouter: "google/gemini-2.5-flash",
};

export const SUPPORTS_ACCOUNT_MODEL_DISCOVERY: Record<ProviderId, boolean> = {
  openai: true,
  gemini: true,
  deepseek: true,
  zai: false,
  minimax: true,
  inkling: false,
  mistral: true,
  // GET /api/chat/completions returns an OpenAI-style { object: "list" }.
  kaya: true,
  // GET /v1/models is part of the OpenAI contract this gateway implements.
  gapgpt: true,
  // GET https://openrouter.ai/api/v1/models is public and lists every model with its
  // modalities and its price, which is exactly what the panel needs.
  openrouter: true,
};

export function mergeModelOptions(provider: ProviderId, ...groups: string[][]): string[] {
  const fallback = FALLBACK_MODEL_OPTIONS[provider];
  const unique = [...new Set(groups.flat().map((item) => item.trim()).filter(Boolean))];
  return unique.sort((left, right) => {
    const leftRank = fallback.indexOf(left);
    const rightRank = fallback.indexOf(right);
    if (leftRank >= 0 || rightRank >= 0) {
      if (leftRank < 0) return 1;
      if (rightRank < 0) return -1;
      return leftRank - rightRank;
    }
    return left.localeCompare(right);
  });
}

/**
 * The free OpenRouter models to try, in order, when the chosen one's host is busy.
 *
 * A 429 on a free model is usually one upstream host being full, and the operator's own
 * quota is untouched — the message even says so. Making them do that manually, model by
 * model, is exactly the work a machine should do: the sheet is already paid for in time.
 * Only *free* entries and the router's own slot are used, so a fallback can never spend
 * money the operator did not choose to spend.
 */
export const OPENROUTER_FREE_FALLBACKS: string[] = [
  "openrouter/free",
  "google/gemma-3-27b-it:free",
  "meta-llama/llama-4-scout:free",
  "qwen/qwen2.5-vl-72b-instruct:free",
  "mistralai/mistral-small-3.2-24b-instruct:free",
];

/** Which free models to try after `model`, never including `model` itself. */
export function openRouterFallbacksFor(model: string): string[] {
  const chosen = String(model || "").trim();
  return OPENROUTER_FREE_FALLBACKS.filter((id) => id !== chosen).slice(0, 3);
}

/**
 * What Gemini's free tier actually gives, and what one read of this app costs.
 *
 * The operator was paying per token while the same key has a no-card free tier — and the
 * reason it "used up all 300,000 tokens" on a single sheet is arithmetic, not bad luck:
 * this app sends a handwritten page as up to 24 line parts, and every part is a separate
 * image the model tokenises at roughly 1,120 input tokens. A single sheet therefore costs
 * on the order of 15,000–20,000 input tokens before one word of output, and a second
 * "precise" verification pass doubles it.
 *
 * These numbers are here so the panel can say them out loud instead of the operator
 * discovering them on a bill. `RPD` differs between published sources (500 vs 1,500);
 * the honest figure is the one in the AI Studio console for that project, so this is
 * labelled approximate in the UI.
 */
export const GEMINI_FREE_TIER = {
  rpm: 15,
  /** Requests per day, approximate: Google no longer publishes a single number. */
  rpd: 1_500,
  tpm: 1_000_000,
  resets: "نیمه‌شب به وقت اقیانوس آرام — نزدیک ساعت ۱۱ صبح تهران",
  noCard: true,
} as const;

/** Input tokens one page costs after the line splitter has cut it into parts. */
export function geminiSheetTokenEstimate(parts: number, tokensPerPart = 1120, promptTokens = 2_500): number {
  return Math.max(1, parts) * tokensPerPart + promptTokens;
}

/**
 * How many sheets a free-tier *minute* allows: the per-minute token ceiling divided by the
 * measured cost of one sheet. The daily limit is a request count, not a token count, so the
 * honest answer to "how many sheets today" is "the requests number, minus the second pass
 * each sheet spends" — and that number is only visible in the operator's own console.
 */
export function sheetsPerFreeMinute(partsPerSheet = 15, tokensPerPart = 1120): number {
  const perSheet = geminiSheetTokenEstimate(partsPerSheet, tokensPerPart);
  return Math.max(1, Math.floor(GEMINI_FREE_TIER.tpm / perSheet));
}
