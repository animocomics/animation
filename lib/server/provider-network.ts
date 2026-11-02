import { isIPv4 } from "node:net";
import { Resolver } from "node:dns/promises";
import type { LookupOptions } from "node:dns";
import type { TcpSocketConnectOpts } from "node:net";
import { Agent } from "undici";
import type { ProviderNetworkConfig } from "../api-network";
import { resolveShecanDoh, type ShecanDohRecord } from "./shecan-doh";

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
}

interface NetworkGlobal {
  __nomrehProviderNetwork?: CachedNetwork;
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
  // official Pro DoH endpoint is a scoped fallback when outbound UDP/53 is blocked.
  const officialDohFallback = dohResolver || (!resolver ? resolveShecanDoh : undefined);
  const cache = new Map<string, { records: ResolveRecord[]; expiresAt: number }>();

  async function resolve(hostname: string): Promise<string[]> {
    const cached = cache.get(hostname);
    if (cached && cached.expiresAt > Date.now()) return cached.records.map((record) => record.address);
    let records: ResolveRecord[] = [];
    try {
      records = await dnsResolver.resolve4(hostname, { ttl: true });
    } catch (udpError) {
      if (!officialDohFallback) {
        throw new ProviderNetworkError("DNS شکن پاسخ نداد؛ آدرس‌های DNS و اجازهٔ ارتباط خروجی هاست را بررسی کنید.", "dns", { cause: udpError });
      }
    }
    if (officialDohFallback && !records.some((record) => isIPv4(record.address))) {
      try {
        records = await officialDohFallback(hostname);
      } catch (dohError) {
        throw new ProviderNetworkError("DNS شکن از مسیر UDP و DoH رسمی Pro پاسخ نداد؛ ارتباط خروجی هاست را بررسی کنید.", "dns", { cause: dohError });
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

function networkKey(config: ProviderNetworkConfig): string {
  return `${config.plan}:${config.servers.join(",")}`;
}

function getNetwork(config: ProviderNetworkConfig): CachedNetwork {
  const key = networkKey(config);
  if (globalStore.__nomrehProviderNetwork?.key === key) return globalStore.__nomrehProviderNetwork;
  if (globalStore.__nomrehProviderNetwork) void globalStore.__nomrehProviderNetwork.agent.close().catch(() => undefined);
  const { lookup, resolve } = createShecanLookup(config.servers);
  const agent = new Agent({
    connect: { lookup, timeout: 20_000 },
    keepAliveTimeout: 10_000,
    keepAliveMaxTimeout: 60_000,
  });
  globalStore.__nomrehProviderNetwork = { key, agent, lookup, resolve };
  return globalStore.__nomrehProviderNetwork;
}

export function isProviderHostname(hostname: string): boolean {
  return PROVIDER_HOSTNAMES.has(hostname.toLowerCase());
}

export function closeProviderNetwork(): void {
  const current = globalStore.__nomrehProviderNetwork;
  if (!current) return;
  delete globalStore.__nomrehProviderNetwork;
  void current.agent.close().catch(() => undefined);
}

/** Fetch only a provider API through Shecan. Other application traffic never receives this dispatcher. */
export async function providerFetch(url: string, init: RequestInit = {}, network?: ProviderNetworkConfig): Promise<Response> {
  const hostname = new URL(url).hostname.toLowerCase();
  if (!network?.enabled || !isProviderHostname(hostname)) {
    if (!network?.enabled && isProviderHostname(hostname)) closeProviderNetwork();
    return fetch(url, init);
  }
  const entry = getNetwork(network);
  // Resolve before fetch so DNS failures remain distinguishable and cannot silently fall back to a direct request.
  await entry.resolve(hostname);
  try {
    const requestInit = { ...init, dispatcher: entry.agent } as RequestInit;
    return await fetch(url, requestInit);
  } catch (error) {
    if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) throw error;
    throw new ProviderNetworkError("ارتباط HTTPS با سرویس‌دهنده از مسیر شکن برقرار نشد؛ وضعیت شکن را در مدیریت سامانه آزمایش کنید.", "connection", { cause: error });
  }
}
