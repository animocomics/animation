import type { ProviderId } from "./types";

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
};

export const RECOMMENDED_MODELS: Record<ProviderId, string> = {
  openai: "gpt-6.1-terra",
  // Current stable Flash with a free tier; unlike 2.5 it is open to new projects.
  gemini: "gemini-3.8-flash",
  deepseek: "deepseek-flash",
  zai: "glm-5.3-flash",
  minimax: "MiniMax-M3.1-Flash",
  inkling: "thinkingmachines/Inkling-Small:peft:262144:sampling-nvfp4",
  mistral: "mistral-large-4",
};

export const SUPPORTS_ACCOUNT_MODEL_DISCOVERY: Record<ProviderId, boolean> = {
  openai: true,
  gemini: true,
  deepseek: true,
  zai: false,
  minimax: true,
  inkling: false,
  mistral: true,
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
