import type { ProviderId } from "../types";

/**
 * What each provider can be asked to do, in one place.
 *
 * These three traits used to be spread over five files as inline arrays and
 * ternaries. Every new provider meant remembering all five, and forgetting one
 * failed silently in a way that looked like a vendor problem:
 *
 *  - `chatOnly` sends everything through Chat Completions. A provider in this set
 *    is routed through the Kaya-style call, which is genuinely the same wire
 *    format, so the two share one implementation instead of two copies.
 *  - `convertsPdf` rasterises PDF pages before sending, because the vendor will
 *    not take a raw PDF upload.
 *  - `byteLimit` is the request size that vendor is known to accept.
 */
export interface ProviderTraits {
  chatOnly: boolean;
  convertsPdf: boolean;
  byteLimit: number;
}

const MB = 1024 * 1024;

export const PROVIDER_TRAITS: Record<ProviderId, ProviderTraits> = {
  openai: { chatOnly: false, convertsPdf: false, byteLimit: 40 * MB },
  gemini: { chatOnly: false, convertsPdf: false, byteLimit: 14 * MB },
  deepseek: { chatOnly: false, convertsPdf: true, byteLimit: 24 * MB },
  zai: { chatOnly: true, convertsPdf: true, byteLimit: 24 * MB },
  minimax: { chatOnly: true, convertsPdf: true, byteLimit: 24 * MB },
  inkling: { chatOnly: false, convertsPdf: true, byteLimit: 24 * MB },
  mistral: { chatOnly: true, convertsPdf: true, byteLimit: 24 * MB },
  kaya: { chatOnly: true, convertsPdf: true, byteLimit: 24 * MB },
  // GapGPT is an OpenAI-compatible gateway: one key, one endpoint, many vendors.
  // It does not accept a raw PDF on the chat path, so pages are rasterised first.
  gapgpt: { chatOnly: true, convertsPdf: true, byteLimit: 24 * MB },
  // OpenRouter is an OpenAI-compatible router over hundreds of models. It accepts the
  // Chat Completions contract, and a raw PDF only on providers that support it, so pages
  // are rasterised first — the same rule as every other gateway here.
  openrouter: { chatOnly: true, convertsPdf: true, byteLimit: 24 * MB },
};

/** True when the provider is reached over Chat Completions rather than Responses. */
export function isChatCompletionsProvider(provider: ProviderId): boolean {
  return PROVIDER_TRAITS[provider].chatOnly;
}

/** True when PDF pages must be rendered to images before they are sent. */
export function providerNeedsPdfRaster(provider: ProviderId): boolean {
  return PROVIDER_TRAITS[provider].convertsPdf;
}

/** The largest request body this provider is known to accept. */
export function providerByteLimit(provider: ProviderId): number {
  return PROVIDER_TRAITS[provider].byteLimit;
}
