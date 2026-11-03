import { isIPv4 } from "node:net";
import https from "node:https";
import childProcess from "node:child_process";
import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupOptions } from "node:dns";
import type { TcpSocketConnectOpts } from "node:net";
import { Agent } from "undici";
import type { ApiNetworkPublicStatus } from "../types";
import { SHECAN_DNS, type ProviderNetworkConfig } from "../api-network";
import { closeProviderNetwork, createShecanLookup, providerFetch, ProviderNetworkError } from "./provider-network";
import { resolveShecanDoh } from "./shecan-doh";
import { resolveShecanDot } from "./shecan-dot";
import { resolveShecanDns5353 } from "./shecan-dns5353";
import { decryptSecret, encryptSecret } from "./secret-crypto";

const UPDATE_URL_PURPOSE = "nomreh-api-network-v1";
// Official Pro cron/systemd examples renew the exact update link every five minutes.
const ACTIVATION_INTERVAL_MS = 5 * 60 * 1000;
const TEST_HOST = "generativelanguage.googleapis.com";
// Last-resort transport addresses for the exact official update host, verified
// against current public DNS. The original secret URL, SNI and certificate
// checks remain unchanged; stale answers are still tried and reported first.
const DDNS_SHECAN_IPV4 = ["185.143.234.133", "185.143.233.133"] as const;

export type { ProviderNetworkConfig } from "../api-network";

interface ApiNetworkRow {
  plan: "free" | "pro";
  dns_primary: string;
  dns_secondary: string;
  enabled: number;
  encrypted_update_url: string;
  update_url_source: "manual" | "account";
  encrypted_account_key: string;
  account_login: string;
  account_name: string;
  account_authenticated_at?: string;
  selected_order_id?: number;
  selected_order_label: string;
  selected_order_due: string;
  last_test_status: "idle" | "success" | "error";
  last_test_message: string;
  last_tested_at?: string;
  last_test_latency_ms?: number;
  last_activated_at?: string;
  updated_at: string;
}

export interface ApiNetworkConfig extends ProviderNetworkConfig {
  updateUrl: string;
  lastActivatedAt?: string;
}

export interface SaveApiNetworkInput {
  enabled: boolean;
  plan: "free" | "pro";
  servers: [string, string];
  updateUrl?: string;
}

interface ApiNetworkSaveJob {
  pending: boolean;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  promise: Promise<void>;
}

interface ActivationGlobal {
  __nomrehShecanActivation?: { key: string; promise: Promise<string> };
  __nomrehShecanSaveJob?: ApiNetworkSaveJob;
}

const globalStore = globalThis as typeof globalThis & ActivationGlobal;

export class ApiNetworkError extends Error {
  status: number;

  constructor(message: string, status = 502, options?: ErrorOptions) {
    super(message, options);
    this.name = "ApiNetworkError";
    this.status = status;
  }
}

async function findRow(): Promise<ApiNetworkRow | undefined> {
  return (await import("./db")).getDb().prepare("SELECT * FROM api_network_settings WHERE id = 1").get() as ApiNetworkRow | undefined;
}

export async function getApiNetworkStatus(): Promise<ApiNetworkPublicStatus> {
  const row = await findRow();
  if (!row) return {
    configured: false,
    enabled: false,
    plan: "free",
    servers: [...SHECAN_DNS.free],
    hasUpdateUrl: false,
    updateUrlSource: "none",
    hasAccountKey: false,
    lastTestStatus: "idle",
    lastTestMessage: "شکن خاموش است؛ درخواست‌های AI مستقیم به سرویس‌دهنده ارسال می‌شوند.",
  };
  return {
    configured: true,
    enabled: Boolean(row.enabled),
    plan: row.plan,
    servers: [row.dns_primary, row.dns_secondary],
    hasUpdateUrl: Boolean(row.encrypted_update_url),
    updateUrlSource: row.encrypted_update_url ? row.update_url_source : "none",
    hasAccountKey: Boolean(row.encrypted_account_key),
    accountLogin: row.account_login || undefined,
    accountName: row.account_name || undefined,
    accountAuthenticatedAt: row.account_authenticated_at || undefined,
    selectedOrderId: row.selected_order_id || undefined,
    selectedOrderLabel: row.selected_order_label || undefined,
    selectedOrderDue: row.selected_order_due || undefined,
    lastTestStatus: row.last_test_status,
    lastTestMessage: row.last_test_message,
    lastTestedAt: row.last_tested_at || undefined,
    lastTestLatencyMs: row.last_test_latency_ms ?? undefined,
    lastActivatedAt: row.last_activated_at || undefined,
    updatedAt: row.updated_at,
  };
}

export async function getApiNetworkConfig(): Promise<ApiNetworkConfig> {
  const row = await findRow();
  if (!row) return { enabled: false, plan: "free", servers: [...SHECAN_DNS.free], updateUrl: "" };
  let updateUrl = "";
  if (row.enabled && row.encrypted_update_url) {
    try {
      updateUrl = await decryptSecret(row.encrypted_update_url, UPDATE_URL_PURPOSE);
    } catch (error) {
      throw new ApiNetworkError("لینک به‌روزرسان ذخیره‌شده باز نشد؛ آن را دوباره در مدیریت سامانه وارد و ذخیره کنید.", 500, { cause: error });
    }
  }
  return {
    enabled: Boolean(row.enabled),
    plan: row.plan,
    servers: [row.dns_primary, row.dns_secondary],
    updateUrl,
    lastActivatedAt: row.last_activated_at || undefined,
  };
}

function validateUpdateUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new ApiNetworkError("لینک به‌روزرسان معتبر نیست؛ همان لینک کامل داخل سفارش شکن را کپی کنید.", 400); }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || !(hostname === "shecan.ir" || hostname.endsWith(".shecan.ir")) || url.username || url.password) {
    throw new ApiNetworkError("لینک به‌روزرسان باید HTTPS و متعلق به دامنهٔ رسمی shecan.ir باشد.", 400);
  }
  return url.toString();
}

function safeNetworkCode(error: unknown): string {
  let current = error;
  for (let depth = 0; depth < 3 && current; depth += 1) {
    if (current instanceof Error && ["TimeoutError", "AbortError"].includes(current.name)) return "TIMEOUT";
    const code = typeof current === "object" && "code" in current ? (current as { code?: unknown }).code : undefined;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{2,30}$/.test(code)) return code;
    current = typeof current === "object" && "cause" in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return "";
}

async function discardResponse(response: Response): Promise<void> {
  // Activation depends on the HTTP status, not on a response payload. Waiting
  // for an unterminated response body can otherwise produce a false timeout.
  if (response.body) await response.body.cancel().catch(() => undefined);
}

async function probeOfficialService(url: string): Promise<string> {
  try {
    const response = await fetch(url, {
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
      headers: { "User-Agent": "Nomreh-Shecan-IP-Activation/1.0" },
    });
    await discardResponse(response);
    return `HTTP_${response.status}`;
  } catch (error) {
    return (safeNetworkCode(error) || "NO_RESPONSE").replace(/\s+/g, "_");
  }
}

async function probeUpdateService(updateUrl: string): Promise<string> {
  // Never include the secret path. Check both the exact update origin and the
  // official status/IP endpoint documented by Shecan's DDNS application.
  const ddns = await probeOfficialService(new URL(updateUrl).origin);
  const status = await probeOfficialService("https://shecan.ir/ip");
  return `DDNS=${ddns};IP=${status}`;
}

function fixedIpv4Lookup(address: string): NonNullable<TcpSocketConnectOpts["lookup"]> {
  return (_hostname, options: LookupOptions, callback) => {
    if (options.all) callback(null, [{ address, family: 4 }]);
    else callback(null, address, 4);
  };
}

function verifiedUpdateAddresses(hostname: string): string[] {
  return hostname.toLowerCase() === "ddns.shecan.ir" ? [...DDNS_SHECAN_IPV4] : [];
}

async function activateUpdateUrlWithFetch(updateUrl: string, servers: [string, string]): Promise<void> {
  let response: Response | undefined;
  const agents: Agent[] = [];
  const shecan = createShecanLookup(servers);
  const request = async (address?: string, useShecan = false) => {
    let lookup: NonNullable<TcpSocketConnectOpts["lookup"]> | undefined;
    if (address) {
      lookup = fixedIpv4Lookup(address);
    } else if (useShecan) {
      lookup = shecan.lookup;
    }
    const agent = new Agent({
      connect: { ...(lookup ? { lookup } : {}), timeout: 8_000 },
      headersTimeout: 8_000,
      bodyTimeout: 8_000,
    });
    agents.push(agent);
    const init: RequestInit & { dispatcher?: Agent } = {
      cache: "no-store",
      redirect: "follow",
      signal: AbortSignal.timeout(address ? 10_000 : 15_000),
      headers: { "User-Agent": "Nomreh-Shecan-IP-Activation/1.0" },
      dispatcher: agent,
    };
    return fetch(updateUrl, init);
  };
  try {
    try {
      // Official Shecan setup configures its DNS before invoking the update
      // link. Keep that order scoped to this request, not to the whole host.
      response = await request(undefined, true);
    } catch (error) {
      // Try every resolved IPv4 address after a transient network failure.
      // This remains scoped to the Shecan update URL and changes no host DNS.
      const retryable = ["DNS_NO_IPV4", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "TIMEOUT", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"];
      if (!retryable.includes(safeNetworkCode(error))) throw error;
      const hostname = new URL(updateUrl).hostname;
      const addresses = await dnsLookup(hostname, { all: true, verbatim: true })
        .then((records) => records.filter((record) => isIPv4(record.address)).map((record) => record.address))
        .catch(() => [] as string[]);
      let lastError: unknown = error;
      for (const address of [...new Set(addresses)]) {
        try {
          response = await request(address);
          lastError = undefined;
          break;
        } catch (retryError) {
          lastError = retryError;
        }
      }
      if (lastError) throw lastError;
    }
    if (!response) throw new Error("Shecan update connection was not established");
    const finalUrl = new URL(response.url || updateUrl);
    const finalHost = finalUrl.hostname.toLowerCase();
    if (finalUrl.protocol !== "https:" || !(finalHost === "shecan.ir" || finalHost.endsWith(".shecan.ir"))) {
      await discardResponse(response);
      throw new ApiNetworkError("لینک به‌روزرسان به مقصد غیرمنتظره‌ای هدایت شد و پذیرفته نشد.", 400);
    }
    if (!response.ok) {
      await discardResponse(response);
      throw new ApiNetworkError(`شکن لینک به‌روزرسان را نپذیرفت (HTTP ${response.status}). لینک را از همان سفارش فعال دوباره کپی کنید.`, 400);
    }
    await discardResponse(response);
  } catch (error) {
    if (error instanceof ApiNetworkError) throw error;
    const code = safeNetworkCode(error);
    const serviceProbe = await probeUpdateService(updateUrl);
    throw new ApiNetworkError(`فراخوانی لینک به‌روزرسان شکن ناموفق بود. بررسی بدون لینک محرمانه: ${serviceProbe}. لینک و دسترسی خروجی سرور به shecan.ir را بررسی کنید.${code ? ` کد فنی: ${code}.` : ""}`, 502, { cause: error });
  } finally {
    await Promise.all(agents.map((agent) => agent.close().catch(() => undefined)));
  }
}

function curlConfig(updateUrl: string, address?: string): string {
  const current = new URL(updateUrl);
  const quote = (value: string) => `"${value.replace(/(["\\])/g, "\\$1")}"`;
  const lines = [
    "disable",
    "silent",
    "show-error",
    "no-buffer",
    `request = ${quote("GET")}`,
    `dump-header = ${quote("-")}`,
    `output = ${quote("/dev/null")}`,
    "connect-timeout = 6",
    "max-time = 12",
    `proto = ${quote("=https")}`,
  ];
  if (address) lines.push(`resolve = ${quote(`${current.hostname}:${current.port || 443}:${address}`)}`);
  // The secret URL is written to stdin, never exposed in process arguments.
  lines.push(`url = ${quote(current.toString())}`);
  return `${lines.join("\n")}\n`;
}

async function curlUpdateHeaders(updateUrl: string, address?: string): Promise<{ status: number; location?: string }> {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn("/usr/bin/curl", ["--config", "-"], { stdio: ["pipe", "pipe", "pipe"] });
    let settled = false;
    let buffered = Buffer.alloc(0);
    let timer: NodeJS.Timeout | undefined;
    const finish = (error?: Error, result?: { status: number; location?: string }) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) {
        child.kill("SIGKILL");
        reject(error);
      } else if (result) {
        child.kill("SIGTERM");
        resolve(result);
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      buffered = Buffer.concat([buffered, chunk]);
      while (!settled) {
        const crlfEnd = buffered.indexOf("\r\n\r\n");
        const lfEnd = buffered.indexOf("\n\n");
        const useCrlf = crlfEnd >= 0 && (lfEnd < 0 || crlfEnd <= lfEnd);
        const end = useCrlf ? crlfEnd : lfEnd;
        if (end < 0) {
          if (buffered.length > 65_536) finish(Object.assign(new Error("Shecan curl returned oversized headers"), { code: "CURL_HEADERS_TOO_LARGE" }));
          return;
        }
        const text = buffered.subarray(0, end).toString("latin1");
        buffered = buffered.subarray(end + (useCrlf ? 4 : 2));
        const match = text.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+([^\r\n]*))?/i);
        if (!match) {
          finish(Object.assign(new Error("Shecan curl returned invalid HTTP headers"), { code: "CURL_BAD_HEADERS" }));
          return;
        }
        const status = Number(match[1]);
        // Proxy CONNECT and interim HTTP responses are followed by another
        // complete header block. Only the final response determines activation.
        if ((status >= 100 && status < 200) || /connection established/i.test(match[2] || "")) continue;
        const location = text.match(/^location:\s*([^\r\n]+)/im)?.[1]?.trim();
        finish(undefined, { status, location });
      }
    });
    child.stderr.on("data", () => undefined);
    child.stdin.on("error", () => undefined);
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (settled) return;
      if (code === 28) {
        const error = new Error("Shecan curl request timed out");
        error.name = "TimeoutError";
        finish(error);
        return;
      }
      const codes: Record<number, string> = { 6: "CURL_DNS_FAILED", 7: "CURL_CONNECT_FAILED", 35: "CURL_TLS_FAILED", 60: "CURL_CERT_FAILED" };
      finish(Object.assign(new Error("Shecan curl exited before HTTP headers"), { code: codes[code || 0] || "CURL_NO_RESPONSE" }));
    });
    timer = setTimeout(() => {
      const error = new Error("Shecan curl request timed out");
      error.name = "TimeoutError";
      finish(error);
    }, 15_000);
    child.stdin.end(curlConfig(updateUrl, address));
  });
}

async function curlUpdateStatus(updateUrl: string, servers: [string, string], address?: string, redirectCount = 0): Promise<number> {
  const current = new URL(updateUrl);
  const { status, location } = await curlUpdateHeaders(updateUrl, address);
  if (status >= 300 && status < 400 && location) {
    if (redirectCount >= 3) throw new ApiNetworkError("تعداد تغییرمسیرهای لینک شکن بیش از حد مجاز است.", 400);
    const next = new URL(location, current);
    validateUpdateUrl(next.toString());
    let nextAddress = address;
    if (next.hostname !== current.hostname || (next.port || "443") !== (current.port || "443")) {
      nextAddress = await createShecanLookup(servers).resolve(next.hostname).then((addresses) => addresses[0]).catch(() => undefined);
    }
    return curlUpdateStatus(next.toString(), servers, nextAddress, redirectCount + 1);
  }
  return status;
}

async function curlUpdateStatusWithFallback(
  updateUrl: string,
  servers: [string, string],
  dns5353Resolver: typeof resolveShecanDns5353 = resolveShecanDns5353,
  dotResolver: typeof resolveShecanDot = resolveShecanDot,
): Promise<number> {
  const hostname = new URL(updateUrl).hostname;
  const shecan = createShecanLookup(servers);
  const attempted = new Set<string>();
  let lastError: unknown;
  let dohNote = "";
  let dotNote = "";
  let dns5353Note = "";
  let directCurlNote = "";
  let verifiedDdnsNote = "";
  let verifiedDdnsFailure = "";
  const shecanAddresses = await shecan.resolve(hostname).catch(() => [] as string[]);
  for (const address of shecanAddresses) {
    attempted.add(address);
    try { return await curlUpdateStatus(updateUrl, servers, address); }
    catch (error) {
      if (error instanceof ApiNetworkError) throw error;
      lastError = error;
    }
  }
  // Shecan's FAQ warns that ISP DNS caching can leave an apparently valid but
  // stale UDP answer. Cross-check through the official Pro DoH service after a
  // transport failure, and retry only addresses not already attempted above.
  // Missing curl is handled by native HTTPS instead of an unnecessary DoH call.
  if (safeNetworkCode(lastError) !== "ENOENT") {
    let dohAddresses: string[] | undefined;
    try {
      dohAddresses = await resolveShecanDoh(hostname).then((records) => records.map((record) => record.address).filter(isIPv4));
    } catch (error) {
      dohNote = ["TIMEOUT", "DOH_DUAL_TIMEOUT"].includes(safeNetworkCode(error)) ? "TIMEOUT" : "FAILED";
    }
    if (dohAddresses) {
      const freshAddresses = [...new Set(dohAddresses)].filter((address) => !attempted.has(address));
      dohNote = freshAddresses.length ? "RETRIED" : "SAME";
      for (const address of freshAddresses) {
        attempted.add(address);
        try { return await curlUpdateStatus(updateUrl, servers, address); }
        catch (error) {
          if (error instanceof ApiNetworkError) throw error;
          lastError = error;
        }
      }
    }
  }
  // The official Pro mobile profile also specifies DNS-over-TLS on
  // pro.shecan.ir:853. Keep certificate/SNI validation while testing this
  // independent encrypted transport and retry only fresh addresses.
  if (safeNetworkCode(lastError) !== "ENOENT") {
    let dotAddresses: string[] | undefined;
    try {
      dotAddresses = await dotResolver(hostname).then((records) => records.map((record) => record.address).filter(isIPv4));
    } catch (error) {
      dotNote = ["TIMEOUT", "DOT_DUAL_TIMEOUT"].includes(safeNetworkCode(error)) ? "TIMEOUT" : "FAILED";
    }
    if (dotAddresses) {
      const freshAddresses = [...new Set(dotAddresses)].filter((address) => !attempted.has(address));
      dotNote = freshAddresses.length ? "RETRIED" : "SAME";
      for (const address of freshAddresses) {
        attempted.add(address);
        try { return await curlUpdateStatus(updateUrl, servers, address); }
        catch (error) {
          if (error instanceof ApiNetworkError) throw error;
          lastError = error;
        }
      }
    }
  }
  // The official DNS-cache guide forwards to Shecan on port 5353. Query that
  // service directly inside this process, without installing a DNS server or
  // changing the host resolver, and retry only fresh addresses with curl.
  if (safeNetworkCode(lastError) !== "ENOENT") {
    let dns5353Addresses: string[] | undefined;
    try {
      dns5353Addresses = await dns5353Resolver(hostname, servers).then((records) => records.map((record) => record.address).filter(isIPv4));
    } catch (error) {
      const code = safeNetworkCode(error);
      dns5353Note = ["TIMEOUT", "DNS_5353_TIMEOUT"].includes(code) ? "TIMEOUT" : "FAILED";
    }
    if (dns5353Addresses) {
      const freshAddresses = [...new Set(dns5353Addresses)].filter((address) => !attempted.has(address));
      dns5353Note = freshAddresses.length ? "RETRIED" : "SAME";
      for (const address of freshAddresses) {
        attempted.add(address);
        try { return await curlUpdateStatus(updateUrl, servers, address); }
        catch (error) {
          if (error instanceof ApiNetworkError) throw error;
          lastError = error;
        }
      }
    }
  }
  // If every resolver is unavailable or cached, still exercise the current
  // official addresses of the exact update host. This is not a replacement URL
  // and never relaxes TLS; attempted addresses are not repeated.
  const verifiedDdnsAddresses = verifiedUpdateAddresses(hostname).filter((address) => !attempted.has(address));
  if (verifiedUpdateAddresses(hostname).length) verifiedDdnsNote = verifiedDdnsAddresses.length ? "RETRIED" : "SAME";
  for (const address of verifiedDdnsAddresses) {
    attempted.add(address);
    try { return await curlUpdateStatus(updateUrl, servers, address); }
    catch (error) {
      if (error instanceof ApiNetworkError) throw error;
      lastError = error;
    }
  }
  if (verifiedDdnsNote) {
    verifiedDdnsFailure = verifiedDdnsNote === "SAME" ? "SAME" : safeNetworkCode(lastError) === "TIMEOUT" ? "TIMEOUT" : "FAILED";
  }
  // Native HTTPS handles the next independent attempt after connection errors.
  // System resolution is needed here only when no address has failed yet.
  if (!lastError) {
    const systemAddresses = await dnsLookup(hostname, { all: true, verbatim: true })
      .then((records) => records.filter((record) => isIPv4(record.address)).map((record) => record.address))
      .catch(() => [] as string[]);
    for (const address of systemAddresses) {
      if (attempted.has(address)) continue;
      attempted.add(address);
      try { return await curlUpdateStatus(updateUrl, servers, address); }
      catch (error) {
        if (error instanceof ApiNetworkError) throw error;
        lastError = error;
      }
    }
  }
  // The official Linux tutorial literally invokes `curl YourLink`. Exercise
  // that exact command as well, with no --resolve override and no secret log.
  if (safeNetworkCode(lastError) !== "ENOENT") {
    try { return await curlUpdateStatus(updateUrl, servers); }
    catch (error) {
      if (error instanceof ApiNetworkError) throw error;
      lastError = error;
      directCurlNote = safeNetworkCode(error) || "FAILED";
    }
  }
  const details = `DoH=${dohNote || "SKIP"};DoT=${dotNote || "SKIP"};DNS5353=${dns5353Note || "SKIP"};direct=${directCurlNote || "SKIP"};DDNS=${verifiedDdnsNote || "SKIP"}`;
  if (lastError && verifiedDdnsNote) {
    throw Object.assign(new Error("Shecan curl and verified official update-address fallback failed"), {
      code: `CURL_DDNS_${verifiedDdnsFailure}`, cause: lastError, shecanTransportDetails: details,
    });
  }
  if (lastError && dns5353Note) {
    throw Object.assign(new Error("Shecan curl and documented port-5353 DNS fallback failed"), {
      code: `CURL_5353_${dns5353Note}`, cause: lastError, shecanTransportDetails: details,
    });
  }
  if (lastError && dohNote) {
    const baseCode = safeNetworkCode(lastError);
    const prefix = baseCode === "TIMEOUT" ? "CURL_TIMEOUT" : baseCode === "CURL_CONNECT_FAILED" ? "CURL_CONNECT" : "CURL";
    throw Object.assign(new Error("Shecan curl and official DoH fallback failed"), {
      code: `${prefix}_DOH_${dohNote}`, cause: lastError, shecanTransportDetails: details,
    });
  }
  throw lastError || Object.assign(new Error("Shecan curl did not return a response"), {
    code: dns5353Note ? `CURL_5353_${dns5353Note}` : dohNote ? `CURL_DOH_${dohNote}` : "NO_RESPONSE",
    shecanTransportDetails: details,
  });
}

async function nativeUpdateStatus(updateUrl: string, lookup: NonNullable<TcpSocketConnectOpts["lookup"]>, redirectCount = 0): Promise<number> {
  const current = new URL(updateUrl);
  return new Promise<number>((resolve, reject) => {
    const request = https.request(current, {
      method: "GET",
      agent: false,
      lookup,
      servername: current.hostname,
      timeout: 10_000,
      signal: AbortSignal.timeout(12_000),
      headers: { "User-Agent": "Nomreh-Shecan-IP-Activation/1.0", Accept: "*/*" },
    }, (response) => {
      const status = response.statusCode || 0;
      const location = response.headers.location;
      // Only headers and the status are needed; never wait for response EOF.
      response.destroy();
      if (status >= 300 && status < 400 && location) {
        if (redirectCount >= 3) {
          reject(new ApiNetworkError("تعداد تغییرمسیرهای لینک شکن بیش از حد مجاز است.", 400));
          return;
        }
        try {
          const next = new URL(location, current);
          validateUpdateUrl(next.toString());
          resolve(nativeUpdateStatus(next.toString(), lookup, redirectCount + 1));
        } catch (error) {
          reject(error);
        }
        return;
      }
      resolve(status);
    });
    request.on("timeout", () => {
      const error = new Error("Shecan native request timed out");
      error.name = "TimeoutError";
      request.destroy(error);
    });
    request.on("error", reject);
    request.end();
  });
}

async function nativeUpdateStatusWithFallback(updateUrl: string, servers: [string, string]): Promise<number> {
  const shecan = createShecanLookup(servers);
  let lastError: unknown;
  try {
    return await nativeUpdateStatus(updateUrl, shecan.lookup);
  } catch (error) {
    if (error instanceof ApiNetworkError) throw error;
    lastError = error;
  }
  const hostname = new URL(updateUrl).hostname;
  // Try every current Shecan answer (including DoH), retaining TLS/SNI. If
  // Shecan returns no usable address, the update service still gets a bounded
  // native attempt through the host resolver; provider traffic never uses it.
  const attempted = new Set<string>();
  const shecanAddresses = await shecan.resolve(hostname).catch(() => [] as string[]);
  for (const address of shecanAddresses) {
    attempted.add(address);
    try {
      return await nativeUpdateStatus(updateUrl, fixedIpv4Lookup(address));
    } catch (error) {
      if (error instanceof ApiNetworkError) throw error;
      lastError = error;
    }
  }
  const systemAddresses = await dnsLookup(hostname, { all: true, verbatim: true })
    .then((records) => records.filter((record) => isIPv4(record.address)).map((record) => record.address))
    .catch(() => [] as string[]);
  for (const address of systemAddresses) {
    if (attempted.has(address)) continue;
    attempted.add(address);
    try {
      return await nativeUpdateStatus(updateUrl, fixedIpv4Lookup(address));
    } catch (error) {
      if (error instanceof ApiNetworkError) throw error;
      lastError = error;
    }
  }
  for (const address of verifiedUpdateAddresses(hostname)) {
    if (attempted.has(address)) continue;
    attempted.add(address);
    try {
      return await nativeUpdateStatus(updateUrl, fixedIpv4Lookup(address));
    } catch (error) {
      if (error instanceof ApiNetworkError) throw error;
      lastError = error;
    }
  }
  throw lastError || Object.assign(new Error("Shecan native HTTPS did not return a response"), { code: "NO_RESPONSE" });
}

async function activateUpdateUrl(
  updateUrl: string,
  servers: [string, string],
  settleMs = 60_000,
  dns5353Resolver: typeof resolveShecanDns5353 = resolveShecanDns5353,
  dotResolver: typeof resolveShecanDot = resolveShecanDot,
): Promise<string> {
  try {
    await activateUpdateUrlWithFetch(updateUrl, servers);
  } catch (error) {
    if (!(error instanceof ApiNetworkError) || error.status !== 502) throw error;
    // Follow the official Linux curl path with scoped --resolve addresses.
    // Native Node HTTPS remains an independent fallback if libcurl is absent
    // or cannot establish the update connection either.
    try {
      const status = await curlUpdateStatusWithFallback(updateUrl, servers, dns5353Resolver, dotResolver);
      if (status < 200 || status >= 300) {
        throw new ApiNetworkError(`شکن لینک به‌روزرسان را نپذیرفت (HTTP ${status}). لینک را از همان سفارش فعال دوباره کپی کنید.`, 400);
      }
    } catch (curlError) {
      if (curlError instanceof ApiNetworkError) throw curlError;
      try {
        const status = await nativeUpdateStatusWithFallback(updateUrl, servers);
        if (status < 200 || status >= 300) {
          throw new ApiNetworkError(`شکن لینک به‌روزرسان را نپذیرفت (HTTP ${status}). لینک را از همان سفارش فعال دوباره کپی کنید.`, 400);
        }
      } catch (nativeError) {
        if (nativeError instanceof ApiNetworkError) throw nativeError;
        const curlCode = safeNetworkCode(curlError) || "NO_RESPONSE";
        const nativeCode = safeNetworkCode(nativeError) || "NO_RESPONSE";
        const rawDetails = typeof curlError === "object" && curlError !== null && "shecanTransportDetails" in curlError
          ? curlError.shecanTransportDetails : undefined;
        const details = typeof rawDetails === "string" && /^[A-Za-z0-9_=;.-]{1,300}$/.test(rawDetails) ? ` مسیرها: ${rawDetails}.` : "";
        throw new ApiNetworkError(`روش رسمی curl (${curlCode}) و HTTPS مستقل (${nativeCode}) به شکن نرسیدند.${details} ${error.message}`, 502, { cause: nativeError });
      }
    }
  }
  // Shecan's official Linux/Windows instructions ask for about one minute of
  // propagation time after IP registration and before testing the connection.
  if (settleMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, settleMs));
  return new Date().toISOString();
}

export async function ensureApiNetworkActivated(network: ApiNetworkConfig): Promise<void> {
  if (!network.enabled || network.plan !== "pro" || !network.updateUrl) return;
  if (network.lastActivatedAt && Date.now() - Date.parse(network.lastActivatedAt) < ACTIVATION_INTERVAL_MS) return;
  const key = network.updateUrl;
  if (!globalStore.__nomrehShecanActivation || globalStore.__nomrehShecanActivation.key !== key) {
    globalStore.__nomrehShecanActivation = { key, promise: activateUpdateUrl(key, network.servers) };
  }
  const activation = globalStore.__nomrehShecanActivation;
  try {
    const activatedAt = await activation.promise;
    (await import("./db")).getDb().prepare("UPDATE api_network_settings SET last_activated_at=? WHERE id=1").run(activatedAt);
  } finally {
    if (globalStore.__nomrehShecanActivation === activation) delete globalStore.__nomrehShecanActivation;
  }
}

async function testGoogleThroughShecan(network: ProviderNetworkConfig): Promise<number> {
  const startedAt = Date.now();
  const response = await providerFetch(`https://${TEST_HOST}/v1beta/models`, {
    cache: "no-store",
    signal: AbortSignal.timeout(60_000),
  }, { ...network, enabled: true });
  const text = await response.text();
  let payload: { error?: { message?: string }; models?: unknown[] } = {};
  try { payload = text ? JSON.parse(text) as typeof payload : {}; } catch { /* An HTML response is not a successful API check. */ }
  const providerMessage = payload.error?.message || "";
  const expectedKeyResponse = [400, 401, 403].includes(response.status) && /api[ _-]?key|کلید/i.test(providerMessage);
  if ((response.ok && Array.isArray(payload.models)) || expectedKeyResponse) return Date.now() - startedAt;
  if (response.status === 403) {
    throw new ApiNetworkError("Google هنوز دسترسی سرور را نمی‌پذیرد. برای شکن حرفه‌ای لینک به‌روزرسان را بررسی کنید و یک دقیقه پس از ثبت IP دوباره آزمایش کنید.", 502);
  }
  if (response.status === 429) throw new ApiNetworkError("سقف درخواست آزمایشی فعال است؛ کمی بعد دوباره تلاش کنید.", 429);
  throw new ApiNetworkError(`پاسخ Google برای آزمایش شبکه معتبر نبود (HTTP ${response.status})؛ شکن فعال‌سازی نمی‌شود.`, 502);
}

export async function saveAndTestApiNetwork(
  input: SaveApiNetworkInput,
  userId: string,
  options: { activationSettleMs?: number; dns5353Resolver?: typeof resolveShecanDns5353; dotResolver?: typeof resolveShecanDot } = {},
): Promise<ApiNetworkPublicStatus> {
  if (!input.servers.every((server) => isIPv4(server))) throw new ApiNetworkError("هر دو آدرس DNS باید IPv4 معتبر باشند.", 400);
  const previous = await findRow();
  const now = new Date().toISOString();
  const suppliedUpdateUrl = input.updateUrl?.trim() || "";
  if (suppliedUpdateUrl) validateUpdateUrl(suppliedUpdateUrl);
  const encryptedUpdateUrl = input.plan === "free" ? "" : suppliedUpdateUrl
    ? await encryptSecret(suppliedUpdateUrl, UPDATE_URL_PURPOSE)
    : previous?.encrypted_update_url || "";
  let updateUrl = "";
  if (input.enabled && input.plan === "pro" && encryptedUpdateUrl) {
    try {
      updateUrl = suppliedUpdateUrl || await decryptSecret(encryptedUpdateUrl, UPDATE_URL_PURPOSE);
    } catch (error) {
      throw new ApiNetworkError("لینک ذخیره‌شده باز نشد؛ لینک به‌روزرسان را دوباره وارد کنید.", 400, { cause: error });
    }
  }
  const network: ProviderNetworkConfig = { enabled: false, plan: input.plan, servers: input.servers };
  let enabled = false;
  let testStatus: "idle" | "success" | "error" = "idle";
  let testMessage = "شکن خاموش است؛ درخواست‌های AI مستقیم به سرویس‌دهنده ارسال می‌شوند.";
  let testedAt: string | undefined;
  let latency: number | undefined;
  let activatedAt = previous?.last_activated_at || undefined;
  let failure: unknown;

  if (input.enabled) {
    try {
      if (updateUrl) activatedAt = await activateUpdateUrl(updateUrl, input.servers, options.activationSettleMs ?? 60_000, options.dns5353Resolver, options.dotResolver);
      latency = await testGoogleThroughShecan(network);
      enabled = true;
      testStatus = "success";
      testMessage = "DNS شکن و دسترسی Google Gemini از سرور تأیید شد. این تست بدون API Key انجام شده است.";
      testedAt = now;
    } catch (error) {
      failure = error;
      testStatus = "error";
      testMessage = error instanceof Error ? error.message : "آزمایش شکن ناموفق بود و فعال‌سازی انجام نشد.";
      testedAt = now;
    }
  }

  const values = [input.plan, input.servers[0], input.servers[1], enabled ? 1 : 0, encryptedUpdateUrl, testStatus, testMessage, testedAt || null, latency ?? null, activatedAt || null, now, userId];
  (await import("./db")).getDb().prepare(`INSERT INTO api_network_settings
    (id, plan, dns_primary, dns_secondary, enabled, encrypted_update_url, last_test_status, last_test_message, last_tested_at, last_test_latency_ms, last_activated_at, updated_at, updated_by)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET plan=excluded.plan, dns_primary=excluded.dns_primary, dns_secondary=excluded.dns_secondary,
      enabled=excluded.enabled, encrypted_update_url=excluded.encrypted_update_url, last_test_status=excluded.last_test_status,
      last_test_message=excluded.last_test_message, last_tested_at=excluded.last_tested_at,
      last_test_latency_ms=excluded.last_test_latency_ms, last_activated_at=excluded.last_activated_at,
      updated_at=excluded.updated_at, updated_by=excluded.updated_by`).run(...values);
  if (suppliedUpdateUrl) {
    (await import("./db")).getDb().prepare(`UPDATE api_network_settings
      SET update_url_source='manual', selected_order_id=NULL, selected_order_label='', selected_order_due='' WHERE id=1`).run();
  }
  if (!enabled) closeProviderNetwork();
  if (failure) {
    if (failure instanceof ApiNetworkError || failure instanceof ProviderNetworkError) throw failure;
    if (failure instanceof Error && failure.name === "TimeoutError") throw new ApiNetworkError("آزمایش اتصال بیش از حد طول کشید؛ شکن خاموش ماند و درخواست‌های AI همچنان مستقیم ارسال می‌شوند.", 504);
    throw new ApiNetworkError("آزمایش شکن ناموفق بود و فعال‌سازی انجام نشد.", 502, { cause: failure });
  }
  return getApiNetworkStatus();
}

export function getApiNetworkJobStatus(): { pending: boolean; startedAt?: string; finishedAt?: string; error?: string } {
  const job = globalStore.__nomrehShecanSaveJob;
  if (!job) return { pending: false };
  return { pending: job.pending, startedAt: job.startedAt, finishedAt: job.finishedAt, error: job.error };
}

export function clearApiNetworkJob(): void {
  if (!globalStore.__nomrehShecanSaveJob?.pending) delete globalStore.__nomrehShecanSaveJob;
}

export function startApiNetworkJob(
  input: SaveApiNetworkInput,
  userId: string,
  options: { activationSettleMs?: number } = {},
): { pending: boolean; startedAt?: string; finishedAt?: string; error?: string } {
  const current = globalStore.__nomrehShecanSaveJob;
  if (current?.pending) return getApiNetworkJobStatus();
  const job: ApiNetworkSaveJob = { pending: true, startedAt: new Date().toISOString(), promise: Promise.resolve() };
  globalStore.__nomrehShecanSaveJob = job;
  job.promise = (async () => {
    try {
      await saveAndTestApiNetwork(input, userId, options);
      job.error = undefined;
    } catch (error) {
      job.error = error instanceof ApiNetworkError || error instanceof ProviderNetworkError
        ? error.message
        : "آزمایش شکن ناموفق بود و فعال‌سازی انجام نشد.";
    } finally {
      job.pending = false;
      job.finishedAt = new Date().toISOString();
    }
  })();
  return getApiNetworkJobStatus();
}
