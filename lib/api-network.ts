/**
 * Provider network settings — direct only.
 *
 * This file used to describe a Shecan DNS/V2Ray/official-VM transport. Those
 * routes are gone on purpose: every outbound AI request now leaves this host
 * directly, with the host's own resolver and TLS, exactly as the vendor sees it.
 *
 * Why the removal is not a "configuration option": a bypass makes a failure
 * impossible to diagnose. While traffic could leave through a guest VM, a proxy
 * or a DNS override, a blocked destination and a broken route looked identical,
 * and the fix was always another moving part. Direct-only means the panel can
 * tell the truth: either the destination answers this host, or it does not.
 *
 * Nothing in the application may reintroduce a transport. If the direct path is
 * refused, that is a hosting or vendor decision, and the answer is a request to
 * them — not a tunnel.
 */

/** Kept only so a stored old row can still be read and rewritten without crashing. */
export interface ProviderNetworkConfig {
  /** Always false. Serialized for compatibility with rows written before the cleanup. */
  enabled: false;
  plan: "free" | "pro";
  servers: [string, string];
}

/**
 * Every provider request is direct. Kept as a named function so a future change
 * has exactly one place to justify itself instead of nine call sites.
 */
export function providerTransport(): "direct" {
  return "direct";
}
