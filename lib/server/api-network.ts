/**
 * Provider network state — direct only.
 *
 * Every outbound AI request leaves this host directly. There is no Shecan DNS
 * override, no guest VM, no V2Ray client and no proxy, and this module exists to
 * make that a fact the panel can report instead of a setting someone can change.
 *
 * What it replaced: a 950-line controller that stored two DNS servers, an update
 * link and a transport choice, then booted a virtual machine to carry the
 * request. When the destination refused this host, all of that made the failure
 * harder — not easier — to see, because a blocked route and a broken tunnel
 * produced the same sentence. Nothing here is switchable, so there is no state to
 * get wrong.
 */

export interface ApiNetworkStatus {
  /** Always false: nothing is routed through a third party any more. */
  enabled: false;
  plan: "direct";
  transport: "direct";
  servers: [];
  lastTestStatus: "ok" | "failed" | "untested";
  lastTestMessage: string;
  updatedAt?: string;
}

/** The panel shows this sentence verbatim; keep it free of technical detail. */
export const DIRECT_TRANSPORT_NOTE =
  "درخواست‌ها مستقیم از همین سرور به سرویس‌دهنده می‌رود؛ هیچ واسطه‌ای در مسیر نیست.";

export async function getApiNetworkStatus(): Promise<ApiNetworkStatus> {
  return {
    enabled: false,
    plan: "direct",
    transport: "direct",
    servers: [],
    lastTestStatus: "untested",
    lastTestMessage: DIRECT_TRANSPORT_NOTE,
  };
}
