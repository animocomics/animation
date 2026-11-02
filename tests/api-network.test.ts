import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import https from "node:https";
import { EventEmitter } from "node:events";
import { Resolver } from "node:dns/promises";
import test from "node:test";
import { createShecanLookup, providerFetch, ProviderNetworkError } from "../lib/server/provider-network";

const dataDirectory = mkdtempSync(path.join(tmpdir(), "nomreh-api-network-"));
process.env.NOMREH_DATA_DIR = dataDirectory;
process.env.NOMREH_SECRET_KEY = "api-network-test-secret-with-enough-entropy";

function lookupOne(lookup: ReturnType<typeof createShecanLookup>["lookup"], hostname: string, all = false): Promise<string | Array<{ address: string; family: number }>> {
  return new Promise((resolve, reject) => {
    lookup(hostname, { all }, (error, address) => {
      if (error) reject(error);
      else resolve(address as string | Array<{ address: string; family: number }>);
    });
  });
}

test("Shecan lookup uses only its own resolvers, caches TTL and supports lookup all", async () => {
  const calls: string[] = [];
  let servers: string[] = [];
  const { lookup, resolve } = createShecanLookup(["178.22.122.100", "185.51.200.2"], {
    setServers: (value) => { servers = value; },
    resolve4: async (hostname) => {
      calls.push(hostname);
      return [{ address: "203.0.113.10", ttl: 60 }, { address: "203.0.113.11", ttl: 60 }];
    },
  });
  assert.deepEqual(servers, ["178.22.122.100", "185.51.200.2"]);
  assert.deepEqual(await resolve("generativelanguage.googleapis.com"), ["203.0.113.10", "203.0.113.11"]);
  assert.equal(await lookupOne(lookup, "generativelanguage.googleapis.com"), "203.0.113.10");
  assert.deepEqual(await lookupOne(lookup, "generativelanguage.googleapis.com", true), [{ address: "203.0.113.10", family: 4 }, { address: "203.0.113.11", family: 4 }]);
  assert.equal(calls.length, 1, "TTL cache should prevent repeated DNS requests");
});

test("Shecan DNS failures are explicit and never become direct lookups", async () => {
  const { resolve } = createShecanLookup(["178.22.122.101", "185.51.200.1"], {
    resolve4: async () => { throw Object.assign(new Error("mock DNS unavailable"), { code: "ETIMEOUT" }); },
  });
  await assert.rejects(resolve("api.z.ai"), (error: unknown) => error instanceof ProviderNetworkError && error.stage === "dns");
});

test("providerFetch attaches an AI-only dispatcher when enabled and stays direct otherwise", async () => {
  const originalFetch = globalThis.fetch;
  const originalResolve = Resolver.prototype.resolve4;
  const seen: Array<{ url: string; dispatcher: unknown }> = [];
  Resolver.prototype.resolve4 = (async () => [{ address: "203.0.113.20", ttl: 60 }]) as unknown as typeof Resolver.prototype.resolve4;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, dispatcher: (init as RequestInit & { dispatcher?: unknown } | undefined)?.dispatcher });
    return Response.json({ ok: true });
  }) as typeof fetch;
  const network = { enabled: true, plan: "free" as const, servers: ["198.51.100.10", "198.51.100.11"] as [string, string] };
  try {
    await providerFetch("https://api.z.ai/api/paas/v4/chat/completions", {}, network);
    await providerFetch("https://example.com/ordinary-site", {}, network);
    await providerFetch("https://api.openai.com/v1/responses", {}, { ...network, enabled: false });
    assert.ok(seen[0].dispatcher, "enabled provider call should have a dedicated dispatcher");
    assert.equal(seen[1].dispatcher, undefined, "ordinary traffic must not inherit the provider dispatcher");
    assert.equal(seen[2].dispatcher, undefined, "disabled network must preserve direct provider behavior");
  } finally {
    globalThis.fetch = originalFetch;
    Resolver.prototype.resolve4 = originalResolve;
  }
});

test("Pro update link is encrypted, activation and Google are tested before enable, and disable is immediate", async () => {
  const originalFetch = globalThis.fetch;
  const originalResolve = Resolver.prototype.resolve4;
  const updateUrl = "https://my.shecan.ir/panel/order/update/test-secret";
  const requested: string[] = [];
  Resolver.prototype.resolve4 = (async () => [{ address: "203.0.113.30", ttl: 60 }]) as unknown as typeof Resolver.prototype.resolve4;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    if (url === updateUrl) return new Response("updated", { status: 200 });
    if (url === "https://generativelanguage.googleapis.com/v1beta/models") {
      return Response.json({ error: { message: "API key not valid. Please pass a valid API key." } }, { status: 400 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;
  try {
    const { getApiNetworkConfig, getApiNetworkStatus, saveAndTestApiNetwork } = await import("../lib/server/api-network");
    const { getDb } = await import("../lib/server/db");
    const admin = getDb().prepare("SELECT id FROM users WHERE role='admin' ORDER BY created_at LIMIT 1").get() as { id: string };
    const status = await saveAndTestApiNetwork({ enabled: true, plan: "pro", servers: ["198.51.100.20", "198.51.100.21"], updateUrl }, admin.id, { activationSettleMs: 0 });
    assert.equal(status.enabled, true);
    assert.equal(status.lastTestStatus, "success");
    assert.equal(status.hasUpdateUrl, true);
    assert.deepEqual(requested, [updateUrl, "https://generativelanguage.googleapis.com/v1beta/models"]);
    assert.ok(!JSON.stringify(status).includes("test-secret"), "public status must never expose the update link");
    const stored = await getApiNetworkConfig();
    assert.equal(stored.updateUrl, updateUrl);
    const raw = getDb().prepare("SELECT encrypted_update_url FROM api_network_settings WHERE id=1").get() as { encrypted_update_url: string };
    assert.ok(!raw.encrypted_update_url.includes(updateUrl));

    const disabled = await saveAndTestApiNetwork({ enabled: false, plan: "pro", servers: ["198.51.100.20", "198.51.100.21"] }, admin.id, { activationSettleMs: 0 });
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.hasUpdateUrl, true, "disabling should not discard the encrypted subscription link");
    assert.equal((await getApiNetworkStatus()).enabled, false);
    getDb().prepare("UPDATE api_network_settings SET encrypted_update_url='damaged-disabled-secret' WHERE id=1").run();
    const directConfig = await getApiNetworkConfig();
    assert.equal(directConfig.enabled, false);
    assert.equal(directConfig.updateUrl, "", "a disabled connection must not depend on decrypting its stored link");
  } finally {
    globalThis.fetch = originalFetch;
    Resolver.prototype.resolve4 = originalResolve;
  }
});

test("Pro activation accepts HTTP headers without waiting for an unterminated body", async () => {
  const originalFetch = globalThis.fetch;
  const originalResolve = Resolver.prototype.resolve4;
  const updateUrl = "https://ddns.shecan.ir/update/test-unterminated-body";
  let cancelled = 0;
  Resolver.prototype.resolve4 = (async () => [{ address: "203.0.113.35", ttl: 60 }]) as unknown as typeof Resolver.prototype.resolve4;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === updateUrl) {
      const body = new ReadableStream<Uint8Array>({
        pull: () => undefined,
        cancel: () => { cancelled += 1; },
      });
      return new Response(body, { status: 200 });
    }
    if (url === "https://generativelanguage.googleapis.com/v1beta/models") {
      return Response.json({ error: { message: "API key not valid. Please pass a valid API key." } }, { status: 400 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;
  try {
    const { getApiNetworkStatus, saveAndTestApiNetwork } = await import("../lib/server/api-network");
    const { getDb } = await import("../lib/server/db");
    const admin = getDb().prepare("SELECT id FROM users WHERE role='admin' ORDER BY created_at LIMIT 1").get() as { id: string };
    const status = await saveAndTestApiNetwork({ enabled: true, plan: "pro", servers: ["198.51.100.24", "198.51.100.25"], updateUrl }, admin.id, { activationSettleMs: 0 });
    assert.equal(status.enabled, true);
    assert.equal(status.lastTestStatus, "success");
    assert.equal(cancelled, 1, "the update response body should be cancelled, not consumed until EOF");
    assert.equal((await getApiNetworkStatus()).hasUpdateUrl, true);
  } finally {
    globalThis.fetch = originalFetch;
    Resolver.prototype.resolve4 = originalResolve;
  }
});

test("native HTTPS fallback activates through the scoped Shecan lookup after fetch failure", async () => {
  const originalFetch = globalThis.fetch;
  const originalRequest = https.request;
  const originalResolve = Resolver.prototype.resolve4;
  const updateUrl = "https://ddns.shecan.ir/update/test-native-fallback";
  let nativeLookup = false;
  let responseDestroyed = 0;
  Resolver.prototype.resolve4 = (async () => [{ address: "203.0.113.36", ttl: 60 }]) as unknown as typeof Resolver.prototype.resolve4;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === updateUrl) throw Object.assign(new Error("mock fetch transport failure"), { code: "FETCH_FAILED" });
    if (url === "https://ddns.shecan.ir") return new Response(null, { status: 404 });
    if (url === "https://generativelanguage.googleapis.com/v1beta/models") {
      return Response.json({ error: { message: "API key not valid. Please pass a valid API key." } }, { status: 400 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;
  https.request = ((input: URL, options: { lookup?: unknown }, callback: (response: EventEmitter) => void) => {
    assert.equal(String(input), updateUrl);
    nativeLookup = typeof options.lookup === "function";
    const request = new EventEmitter() as EventEmitter & { end: () => void; destroy: (error?: Error) => void };
    request.end = () => {
      const response = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string>; destroy: () => void };
      response.statusCode = 200;
      response.headers = {};
      response.destroy = () => { responseDestroyed += 1; };
      callback(response);
    };
    request.destroy = (error?: Error) => { if (error) request.emit("error", error); };
    return request as unknown as ReturnType<typeof https.request>;
  }) as typeof https.request;
  try {
    const { saveAndTestApiNetwork } = await import("../lib/server/api-network");
    const { getDb } = await import("../lib/server/db");
    const admin = getDb().prepare("SELECT id FROM users WHERE role='admin' ORDER BY created_at LIMIT 1").get() as { id: string };
    const status = await saveAndTestApiNetwork({ enabled: true, plan: "pro", servers: ["198.51.100.26", "198.51.100.27"], updateUrl }, admin.id, { activationSettleMs: 0 });
    assert.equal(status.enabled, true);
    assert.equal(status.lastTestStatus, "success");
    assert.equal(nativeLookup, true, "native activation must use Shecan DNS without changing host DNS");
    assert.equal(responseDestroyed, 1, "native activation must not wait for the response body");
  } finally {
    globalThis.fetch = originalFetch;
    https.request = originalRequest;
    Resolver.prototype.resolve4 = originalResolve;
  }
});

test("failed Google validation saves an actionable error and never enables Shecan", async () => {
  const originalFetch = globalThis.fetch;
  const originalResolve = Resolver.prototype.resolve4;
  Resolver.prototype.resolve4 = (async () => [{ address: "203.0.113.40", ttl: 60 }]) as unknown as typeof Resolver.prototype.resolve4;
  globalThis.fetch = (async () => Response.json({ error: { message: "Requests from this country are blocked." } }, { status: 403 })) as typeof fetch;
  try {
    const { getApiNetworkStatus, saveAndTestApiNetwork } = await import("../lib/server/api-network");
    const { getDb } = await import("../lib/server/db");
    const admin = getDb().prepare("SELECT id FROM users WHERE role='admin' ORDER BY created_at LIMIT 1").get() as { id: string };
    await assert.rejects(saveAndTestApiNetwork({ enabled: true, plan: "free", servers: ["198.51.100.30", "198.51.100.31"] }, admin.id, { activationSettleMs: 0 }), /Google هنوز دسترسی/);
    const status = await getApiNetworkStatus();
    assert.equal(status.enabled, false);
    assert.equal(status.lastTestStatus, "error");
    assert.match(status.lastTestMessage, /یک دقیقه/);
  } finally {
    globalThis.fetch = originalFetch;
    Resolver.prototype.resolve4 = originalResolve;
  }
});

test.after(() => {
  try { (globalThis as typeof globalThis & { __nomrehDatabase?: { close: () => void } }).__nomrehDatabase?.close(); } catch { /* already closed */ }
  rmSync(dataDirectory, { recursive: true, force: true });
});
