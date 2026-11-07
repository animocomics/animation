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
