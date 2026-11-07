/**
 * Outbound provider transport — direct, with a shared budget.
 *
 * What this file is not: it is not a router. Earlier versions wrapped a DNS
 * override, an official guest VM and a V2Ray client here, and every one of them
 * made a blocked destination look like a configuration bug. This version does
 * one thing: it sends the request the application built, from this host, to the
 * destination in the URL, and it refuses to send more than the whole server's
 * share of outbound requests.
 *
 * The budget is the other half of the same lesson. A retry loop once pushed 3612
 * requests through this function and the hosting provider blocked the whole
 * subscription's egress — which then looked exactly like a broken API key. The
 * count lives in `outbound-window.ts`, shared by every destination and every
 * process, so no code path can spend another part of the budget by accident.
 */

import { withProviderBudget } from "./provider-rate-limit";
import { noteProviderOutcome, recordProviderFailure } from "./provider-failure-log";

/**
 * Hosts whose traffic used to be routed through a bypass. The list survives only
 * so failure records keep a stable name; routing does not depend on it.
 */
export const PROVIDER_HOSTNAMES = new Set([
  "api.openai.com",
  "generativelanguage.googleapis.com",
  "api.deepseek.com",
  "api.z.ai",
  "api.minimax.io",
  "api.mistral.ai",
  "tinker.thinkingmachines.dev",
]);

export class ProviderNetworkError extends Error {
  stage: "dns" | "connection";

  constructor(message: string, stage: "dns" | "connection", options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderNetworkError";
    this.stage = stage;
  }
}

export function isProviderHostname(hostname: string): boolean {
  return PROVIDER_HOSTNAMES.has(hostname.toLowerCase());
}

/**
 * Turns a socket-level failure into a sentence that points at the layer that
 * actually failed. These look identical in a UI otherwise, and the difference
 * decides whether the operator changes a setting or telephones the host.
 */
export function describeTransportFailure(code: string): string {
  switch (code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "نام دامنهٔ سرویس‌دهنده روی این سرور حل نشد؛ DNS هاست پاسخ نمی‌دهد. این خطا با کد برنامه رفع نمی‌شود.";
    case "ECONNREFUSED":
      return "سرویس‌دهنده روی این آدرس اتصال را رد کرد؛ آدرس یا درگاه را بررسی کنید.";
    case "ECONNRESET":
      return "سرویس‌دهنده پس از اتصال، ارتباط را بست. همین جمله را با زمان دقیق به پشتیبانی سرویس‌دهنده بدهید.";
    case "ETIMEDOUT":
    case "UND_ERR_CONNECT_TIMEOUT":
    case "TimeoutError":
      return "اتصال به سرویس‌دهنده بی‌پاسخ ماند (timeout). درخواست ما هرگز پاسخ نگرفت؛ مقصد یا مسیر خروجی این سرور را بسته است.";
    case "EADDRNOTAVAIL":
      return "آدرس خروجی انتخاب‌شده روی این سرور وجود ندارد.";
    case "CERT_HAS_EXPIRED":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "ERR_TLS_CERT_ALTNAME_INVALID":
      return "گواهی TLS سرویس‌دهنده پذیرفته نشد؛ ارتباط دستکاری می‌شود یا گواهی منقضی است.";
    default:
      return "";
  }
}

/**
 * The single exit point for provider traffic. Direct fetch, shared budget,
 * failure recorded for the administrator only.
 */
export async function providerFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const parsed = new URL(url);
  const hostname = parsed.hostname.toLowerCase();
  // A hard requirement, not a preference: a request to an address that is not an
  // absolute https URL cannot be audited, and redirecting one is how a bypass
  // gets reintroduced without anyone noticing.
  //
  // The single exception is loopback. A stand-in on 127.0.0.1 is how the grading
  // pipeline is validated in a sandbox that cannot reach the vendor; it carries no
  // traffic off this machine, so it cannot become a detour, and it must not spend
  // the real egress allowance either.
  const loopback = parsed.protocol === "http:" && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname);
  if (parsed.protocol !== "https:" && !loopback) {
    throw new ProviderNetworkError("درخواست سرویس‌دهنده باید با HTTPS باشد.", "connection");
  }
  if (loopback) return fetch(url, init);
  try {
    const response = await withProviderBudget(hostname, () => fetch(url, init));
    noteProviderOutcome(hostname, true);
    return response;
  } catch (error) {
    const value = error as { code?: string; cause?: { code?: string }; message?: string; name?: string; status?: number };
    const code = value?.cause?.code || value?.code || value?.name || (value?.status ? `HTTP_${value.status}` : "unknown");
    noteProviderOutcome(hostname, false);
    // Recorded for the administrator only; teachers never see this.
    recordProviderFailure({
      hostname,
      model: "",
      provider: hostname,
      code: String(code),
      detail: value?.message || String(error),
      attempt: 1,
    });
    const explained = describeTransportFailure(String(code));
    if (explained) throw new ProviderNetworkError(explained, "connection", { cause: error });
    throw error;
  }
}

/** No dispatcher, no agent, no cached route to close. Kept for call-site symmetry. */
export function closeProviderNetwork(): void {
  /* Nothing to close: every request uses the platform's own agent. */
}
