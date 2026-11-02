import { isIPv4 } from "node:net";
import https from "node:https";
import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupOptions } from "node:dns";
import type { TcpSocketConnectOpts } from "node:net";
import { Agent } from "undici";
import type { ApiNetworkPublicStatus } from "../types";
import { SHECAN_DNS, type ProviderNetworkConfig } from "../api-network";
import { closeProviderNetwork, createShecanLookup, providerFetch, ProviderNetworkError } from "./provider-network";
import { decryptSecret, encryptSecret } from "./secret-crypto";

const UPDATE_URL_PURPOSE = "nomreh-api-network-v1";
const ACTIVATION_INTERVAL_MS = 6 * 60 * 60 * 1000;
const TEST_HOST = "generativelanguage.googleapis.com";

export type { ProviderNetworkConfig } from "../api-network";

interface ApiNetworkRow {
  plan: "free" | "pro";
  dns_primary: string;
  dns_secondary: string;
  enabled: number;
  encrypted_update_url: string;
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

interface ActivationGlobal {
  __nomrehShecanActivation?: { key: string; promise: Promise<string> };
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
    lastTestStatus: "idle",
    lastTestMessage: "شکن خاموش است؛ درخواست‌های AI مستقیم به سرویس‌دهنده ارسال می‌شوند.",
  };
  return {
    configured: true,
    enabled: Boolean(row.enabled),
    plan: row.plan,
    servers: [row.dns_primary, row.dns_secondary],
    hasUpdateUrl: Boolean(row.encrypted_update_url),
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
    if (current instanceof Error && current.name === "TimeoutError") return "TIMEOUT";
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

async function probeUpdateService(updateUrl: string): Promise<string> {
  // On failure only, check the same official origin without the secret path.
  // The result distinguishes host connectivity from an update-link failure.
  try {
    const response = await fetch(new URL(updateUrl).origin, {
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
      headers: { "User-Agent": "Nomreh-Shecan-IP-Activation/1.0" },
    });
    await discardResponse(response);
    return `HTTP ${response.status}`;
  } catch (error) {
    return safeNetworkCode(error) || "NO_RESPONSE";
  }
}

async function activateUpdateUrlWithFetch(updateUrl: string, servers: [string, string]): Promise<void> {
  let response: Response | undefined;
  const agents: Agent[] = [];
  const shecan = createShecanLookup(servers);
  const request = async (address?: string, useShecan = false) => {
    let lookup: NonNullable<TcpSocketConnectOpts["lookup"]> | undefined;
    if (address) {
      lookup = (_hostname, options: LookupOptions, callback) => {
        if (options.all) callback(null, [{ address, family: 4 }]);
        else callback(null, address, 4);
      };
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
      const retryable = ["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "TIMEOUT", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"];
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
    throw new ApiNetworkError(`فراخوانی لینک به‌روزرسان شکن ناموفق بود؛ لینک و دسترسی خروجی سرور به shecan.ir را بررسی کنید.${code ? ` کد فنی: ${code}.` : ""} بررسی بدون لینک محرمانه: ${serviceProbe}.`, 502, { cause: error });
  } finally {
    await Promise.all(agents.map((agent) => agent.close().catch(() => undefined)));
  }
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

async function activateUpdateUrl(updateUrl: string, servers: [string, string], settleMs = 60_000): Promise<string> {
  try {
    await activateUpdateUrlWithFetch(updateUrl, servers);
  } catch (error) {
    if (!(error instanceof ApiNetworkError) || error.status !== 502) throw error;
    // Match the documented curl/WebRequest behavior with Node's independent
    // native HTTPS stack. This is still scoped to Shecan's own resolver.
    try {
      const shecan = createShecanLookup(servers);
      const status = await nativeUpdateStatus(updateUrl, shecan.lookup);
      if (status < 200 || status >= 300) {
        throw new ApiNetworkError(`شکن لینک به‌روزرسان را نپذیرفت (HTTP ${status}). لینک را از همان سفارش فعال دوباره کپی کنید.`, 400);
      }
    } catch (nativeError) {
      if (nativeError instanceof ApiNetworkError) throw nativeError;
      const code = safeNetworkCode(nativeError) || "NO_RESPONSE";
      throw new ApiNetworkError(`روش مستقل HTTPS نیز به شکن نرسید؛ کد فنی: ${code}. ${error.message}`, 502, { cause: nativeError });
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
    signal: AbortSignal.timeout(20_000),
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

export async function saveAndTestApiNetwork(input: SaveApiNetworkInput, userId: string, options: { activationSettleMs?: number } = {}): Promise<ApiNetworkPublicStatus> {
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
      if (updateUrl) activatedAt = await activateUpdateUrl(updateUrl, input.servers, options.activationSettleMs ?? 60_000);
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
  if (!enabled) closeProviderNetwork();
  if (failure) {
    if (failure instanceof ApiNetworkError || failure instanceof ProviderNetworkError) throw failure;
    if (failure instanceof Error && failure.name === "TimeoutError") throw new ApiNetworkError("آزمایش اتصال بیش از حد طول کشید؛ شکن خاموش ماند و درخواست‌های AI همچنان مستقیم ارسال می‌شوند.", 504);
    throw new ApiNetworkError("آزمایش شکن ناموفق بود و فعال‌سازی انجام نشد.", 502, { cause: failure });
  }
  return getApiNetworkStatus();
}
