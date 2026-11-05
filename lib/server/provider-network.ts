import { isIPv4 } from "node:net";
import { Resolver } from "node:dns/promises";
import type { LookupOptions } from "node:dns";
import type { TcpSocketConnectOpts } from "node:net";
import { Agent, ProxyAgent } from "undici";
import type { ProviderNetworkConfig } from "../api-network";
import { resolveShecanDoh, type ShecanDohRecord } from "./shecan-doh";
import { resolveShecanDot } from "./shecan-dot";
import { resolveShecanDns5353 } from "./shecan-dns5353";
import { fixedShecanIpv4Lookup } from "./shecan-sni";

const PROVIDER_HOSTNAMES = new Set([
  "api.openai.com",
  "generativelanguage.googleapis.com",
  "api.deepseek.com",
  "api.z.ai",
  "api.minimax.io",
  "api.mistral.ai",
  "tinker.thinkingmachines.dev",
]);

type Lookup = NonNullable<TcpSocketConnectOpts["lookup"]>;
type LookupCallback = Parameters<Lookup>[2];

interface ResolveRecord {
  address: string;
  ttl: number;
}

export interface ShecanResolver {
  setServers?: (servers: string[]) => void;
  resolve4: (hostname: string, options: { ttl: true }) => Promise<ResolveRecord[]>;
}

interface CachedNetwork {
  key: string;
  agent: Agent;
  lookup: Lookup;
  resolve: (hostname: string) => Promise<string[]>;
  fallbackAgents: Map<string, Agent>;
}

interface NetworkGlobal {
  __nomrehProviderNetwork?: CachedNetwork;
  __nomrehOfficialProxyAgent?: ProxyAgent;
}

const globalStore = globalThis as typeof globalThis & NetworkGlobal;

export class ProviderNetworkError extends Error {
  stage: "dns" | "connection";

  constructor(message: string, stage: "dns" | "connection", options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderNetworkError";
    this.stage = stage;
  }
}

async function resolveOfficialEncryptedDns(hostname: string): Promise<ShecanDohRecord[]> {
  try {
    const records = await resolveShecanDoh(hostname);
    if (records.some((record) => isIPv4(record.address))) return records;
  } catch { /* DoT remains an independent official encrypted transport. */ }
  try { return await resolveShecanDot(hostname); }
  catch (dotError) {
    throw Object.assign(new Error("Shecan DoH and DoT did not return usable addresses"), {
      code: "ENCRYPTED_DNS_FAILED",
      cause: dotError,
    });
  }
}

function asErrnoError(error: unknown): NodeJS.ErrnoException {
  if (error instanceof Error) return error as NodeJS.ErrnoException;
  return new Error("DNS resolution failed");
}

export function createShecanLookup(
  servers: [string, string],
  resolver?: ShecanResolver,
  dohResolver?: (hostname: string) => Promise<ShecanDohRecord[]>,
): {
  lookup: Lookup;
  resolve: (hostname: string) => Promise<string[]>;
} {
  const dnsResolver = resolver || new Resolver();
  dnsResolver.setServers?.(servers);
  // Injected test resolvers stay fully deterministic. On the real host, the
  // official Pro DoH/DoT endpoints are scoped fallbacks when UDP/53 is blocked.
  const officialEncryptedFallback = dohResolver || (!resolver ? resolveOfficialEncryptedDns : undefined);
  const cache = new Map<string, { records: ResolveRecord[]; expiresAt: number }>();

  async function resolve(hostname: string): Promise<string[]> {
    const cached = cache.get(hostname);
    if (cached && cached.expiresAt > Date.now()) return cached.records.map((record) => record.address);
    let records: ResolveRecord[] = [];
    try {
      records = await dnsResolver.resolve4(hostname, { ttl: true });
    } catch (udpError) {
      if (!officialEncryptedFallback) {
        throw new ProviderNetworkError("DNS شکن پاسخ نداد؛ آدرس‌های DNS و اجازهٔ ارتباط خروجی هاست را بررسی کنید.", "dns", { cause: udpError });
      }
    }
    if (officialEncryptedFallback && !records.some((record) => isIPv4(record.address))) {
      try {
        records = await officialEncryptedFallback(hostname);
      } catch (encryptedError) {
        throw new ProviderNetworkError("DNS شکن از مسیرهای UDP، DoH و DoT رسمی Pro پاسخ نداد؛ ارتباط خروجی هاست را بررسی کنید.", "dns", { cause: encryptedError });
      }
    }
    records = records.filter((record) => isIPv4(record.address));
    if (!records.length) {
      throw Object.assign(new ProviderNetworkError("DNS شکن برای دامنهٔ سرویس‌دهنده آدرس IPv4 معتبر برنگرداند.", "dns"), { code: "DNS_NO_IPV4" });
    }
    const ttl = Math.min(...records.map((record) => Math.max(0, record.ttl || 0)));
    // A short minimum also covers the immediate pre-resolve + socket lookup pair when a server returns TTL=0.
    cache.set(hostname, { records, expiresAt: Date.now() + Math.min(Math.max(ttl, 5), 300) * 1000 });
    return records.map((record) => record.address);
  }

  const lookup: Lookup = (hostname: string, options: LookupOptions, callback: LookupCallback) => {
    if (isIPv4(hostname)) {
      if (options.all) callback(null, [{ address: hostname, family: 4 }]);
      else callback(null, hostname, 4);
      return;
    }
    void resolve(hostname).then((addresses) => {
      if (options.all) callback(null, addresses.map((address) => ({ address, family: 4 })));
      else callback(null, addresses[0], 4);
    }).catch((error) => callback(asErrnoError(error), "", 4));
  };

  return { lookup, resolve };
}

function closeCachedNetwork(network: CachedNetwork): void {
  void network.agent.close().catch(() => undefined);
  for (const agent of network.fallbackAgents.values()) void agent.close().catch(() => undefined);
  network.fallbackAgents.clear();
}

function networkKey(config: ProviderNetworkConfig): string {
  return `${config.plan}:${config.servers.join(",")}`;
}

function getNetwork(config: ProviderNetworkConfig): CachedNetwork {
  const key = networkKey(config);
  if (globalStore.__nomrehProviderNetwork?.key === key) return globalStore.__nomrehProviderNetwork;
  if (globalStore.__nomrehProviderNetwork) closeCachedNetwork(globalStore.__nomrehProviderNetwork);
  const { lookup, resolve } = createShecanLookup(config.servers);
  const agent = new Agent({
    connect: { lookup, timeout: 20_000 },
    keepAliveTimeout: 10_000,
    keepAliveMaxTimeout: 60_000,
  });
  globalStore.__nomrehProviderNetwork = { key, agent, lookup, resolve, fallbackAgents: new Map() };
  return globalStore.__nomrehProviderNetwork;
}

export function isProviderHostname(hostname: string): boolean {
  return PROVIDER_HOSTNAMES.has(hostname.toLowerCase());
}

async function officialProviderAgent(): Promise<ProxyAgent> {
  const { getOfficialRuntimeStatus, officialRuntimePorts } = await import("./shecan-runtime");
  const runtime = getOfficialRuntimeStatus();
  if (!runtime.running || !runtime.appReady || !runtime.brokerReady || !runtime.activationReady) {
    throw new ProviderNetworkError("محیط رسمی شکن یا فعال‌سازی اختصاصی آن آماده نیست؛ درخواست AI از مسیر دیگری ارسال نمی‌شود.", "connection");
  }
  if (!globalStore.__nomrehOfficialProxyAgent) {
    const { proxy } = officialRuntimePorts();
    globalStore.__nomrehOfficialProxyAgent = new ProxyAgent({
      uri: `http://127.0.0.1:${proxy}`,
      connect: { timeout: 20_000 },
      requestTls: { timeout: 20_000 },
    });
  }
  return globalStore.__nomrehOfficialProxyAgent;
}

export function closeProviderNetwork(): void {
  const current = globalStore.__nomrehProviderNetwork;
  if (current) {
    delete globalStore.__nomrehProviderNetwork;
    closeCachedNetwork(current);
  }
  const official = globalStore.__nomrehOfficialProxyAgent;
  if (official) {
    delete globalStore.__nomrehOfficialProxyAgent;
    void official.close().catch(() => undefined);
  }
}

/** Fetch only a provider API through Shecan. Other application traffic never receives this dispatcher. */
export async function providerFetch(
  url: string,
  init: RequestInit = {},
  network?: ProviderNetworkConfig,
  dns5353Resolver: typeof resolveShecanDns5353 = resolveShecanDns5353,
): Promise<Response> {
  const hostname = new URL(url).hostname.toLowerCase();
  if (!network?.enabled || !isProviderHostname(hostname)) {
    if (!network?.enabled && isProviderHostname(hostname)) closeProviderNetwork();
    return fetch(url, init);
  }
  if (network.transport === "v2ray") {
    try {
      const { v2rayProviderFetch } = await import("./v2ray-runtime");
      return await v2rayProviderFetch(url, init);
    } catch (error) {
      if (error instanceof ProviderNetworkError) throw error;
      throw new ProviderNetworkError("ارتباط AI از کانفیگ V2Ray برقرار نشد؛ درخواست مستقیم یا از مسیر شکن ارسال نشد.", "connection", { cause: error });
    }
  }
  if (network.transport === "official-vm") {
    try {
      const dispatcher = await officialProviderAgent();
      // ProxyAgent preserves the provider hostname for CONNECT, SNI and TLS.
      // There is deliberately no direct/DNS fallback from the official guest.
      return await fetch(url, { ...init, dispatcher } as RequestInit);
    } catch (error) {
      if (error instanceof ProviderNetworkError) throw error;
      throw new ProviderNetworkError("ارتباط سرویس‌دهنده از برنامهٔ رسمی شکن برقرار نشد؛ درخواست به‌صورت مستقیم ارسال نشد.", "connection", { cause: error });
    }
  }
  const entry = getNetwork(network);
  let lastError: unknown;
  try {
    // Resolve before fetch so DNS failures remain distinguishable and cannot silently fall back to a direct request.
    await entry.resolve(hostname);
    return await fetch(url, { ...init, dispatcher: entry.agent } as RequestInit);
  } catch (error) {
    lastError = error;
  }
  // Shecan documents port 5353 for ISP DNS-cache cases. Retry Pro provider
  // traffic only with fresh, explicitly resolved addresses and a scoped agent.
  if (network.plan === "pro") {
    const addresses = await dns5353Resolver(hostname, network.servers)
      .then((records) => [...new Set(records.map((record) => record.address).filter(isIPv4))])
      .catch(() => [] as string[]);
    for (const address of addresses) {
      let agent = entry.fallbackAgents.get(address);
      if (!agent) {
        agent = new Agent({
          connect: { lookup: fixedShecanIpv4Lookup(address), timeout: 20_000 },
          keepAliveTimeout: 10_000,
          keepAliveMaxTimeout: 60_000,
        });
        entry.fallbackAgents.set(address, agent);
      }
      try {
        return await fetch(url, { ...init, dispatcher: agent } as RequestInit);
      } catch (error) {
        lastError = error;
      }
    }
  }
  if (lastError instanceof Error && ["TimeoutError", "AbortError"].includes(lastError.name)) throw lastError;
  throw new ProviderNetworkError("ارتباط HTTPS با سرویس‌دهنده از مسیر شکن برقرار نشد؛ وضعیت شکن را در مدیریت سامانه آزمایش کنید.", "connection", { cause: lastError });
}
