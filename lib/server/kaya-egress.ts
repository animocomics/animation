// Which local address and which path the Kaya request leaves from.
//
// Why this exists: the server has two ways out. The one Kaya sees is decided by
// the routing table, and on this host it is the wrong one — Kaya's own server
// accepts nothing from it (`213.176.6.243:443` times out while the same address
// answers other sites, and the router answers `ECONNREFUSED`, so the path exists
// and the client address is what is being dropped).
//
// A socket can choose its source address. When the operator knows the address
// Kaya accepts — the subscription's own Iranian IP, or an interface the host
// added — setting it here changes what Kaya sees without touching the routing
// table, without root, and without a tunnel. If it works, Kaya works directly.
//
// Nothing here is automatic: a wrong source address on a shared host breaks
// every request, so it is off by default and always reported in /admin.

import { Agent, buildConnector } from "undici";

export interface KayaEgressConfig {
  /**
   * Hostname Kaya requests go to. Empty means Kaya's own address; a custom host
   * exists for one legitimate case: an egress service or proxy the operator
   * runs, which is reached by name.
   */
  host: string;
  /**
   * Local IPv4 address the socket binds before connecting. Empty means "let the
   * kernel choose", which is the default and what every earlier version did.
   * A value that is not a local address fails immediately with EADDRNOTAVAIL,
   * which is reported honestly instead of looking like a Kaya outage.
   */
  bindAddress: string;
}

export const DEFAULT_KAYA_EGRESS: KayaEgressConfig = { host: "", bindAddress: "" };

const globalStore = globalThis as typeof globalThis & { __nomrehKayaAgent?: { key: string; agent: Agent } };

function keyOf(config: KayaEgressConfig): string {
  return `${config.host}|${config.bindAddress}`;
}

export function isEgressConfigured(config: KayaEgressConfig | undefined): config is KayaEgressConfig {
  return Boolean(config && (config.host || config.bindAddress));
}

/**
 * Builds the dispatcher used only for Kaya. No other traffic is affected, so a
 * mistake here cannot take the panel or the rest of the site offline.
 */
export function kayaAgent(config: KayaEgressConfig | undefined): Agent | undefined {
  if (!isEgressConfigured(config)) return undefined;
  const key = keyOf(config);
  if (globalStore.__nomrehKayaAgent?.key === key) return globalStore.__nomrehKayaAgent.agent;

  const address = config.bindAddress.trim();

  // undici hands the request's own `localAddress: null` down to its connector,
  // which silently overrides anything set in `connect`. Wrapping its connector is
  // therefore the only reliable way to force a source address: with the obvious
  // `connect: { localAddress }` an impossible address still "worked", so the
  // setting would have looked applied while Kaya kept seeing the old IP. Verified
  // against undici 6.29: a non-local address now fails with EADDRNOTAVAIL.
  type Connector = ReturnType<typeof buildConnector>;
  type ConnectorOptions = Parameters<Connector>[0];
  type ConnectorCallback = Parameters<Connector>[1];
  const base = buildConnector({ timeout: 20_000 });
  const connect = (options: ConnectorOptions, callback: ConnectorCallback) =>
    base(Object.assign({}, options, address ? { localAddress: address } : {}), callback);

  const agent = new Agent({
    connect: connect as unknown as Agent.Options["connect"],
    keepAliveTimeout: 10_000,
    keepAliveMaxTimeout: 60_000,
  });

  const previous = globalStore.__nomrehKayaAgent;
  if (previous) void previous.agent.close().catch(() => undefined);
  globalStore.__nomrehKayaAgent = { key, agent };
  return agent;
}

export function closeKayaAgent(): void {
  const current = globalStore.__nomrehKayaAgent;
  if (!current) return;
  delete globalStore.__nomrehKayaAgent;
  void current.agent.close().catch(() => undefined);
}

/** The base URL Kaya requests use, honouring the custom host when one is set. */
export function kayaBaseUrl(config: KayaEgressConfig | undefined): string {
  const host = (config?.host || "").trim();
  if (!host) return "https://kayaai.ir/api";
  // A custom host is expected to be https and to carry the /api prefix already,
  // because it is something the operator configured deliberately.
  const trimmed = host.replace(/\/+$/, "");
  if (/^https?:\/\//.test(trimmed)) return trimmed;
  return `https://${trimmed}/api`;
}

/**
 * Turns a socket-level failure into the sentence that names the real cause.
 * These three are worth separating: they look identical in the panel otherwise.
 */
export function describeEgressFailure(code: string, config: KayaEgressConfig | undefined): string {
  switch (code) {
    case "EADDRNOTAVAIL":
      return config?.bindAddress
        ? `آدرس محلی «${config.bindAddress}» روی این سرور وجود ندارد. آدرس را در بخش «آدرس خروجی کایا» اصلاح کنید.`
        : "آدرس محلی انتخاب‌شده روی این سرور وجود ندارد.";
    case "EADDRINUSE":
      return "آدرس محلی انتخاب‌شده در حال استفاده است؛ آدرس دیگری برگزینید.";
    case "ENETUNREACH":
    case "EHOSTUNREACH":
      return "آدرس محلی انتخاب‌شده مسیری به کایا ندارد؛ آن را در «آدرس خروجی کایا» اصلاح کنید.";
    default:
      return "";
  }
}
