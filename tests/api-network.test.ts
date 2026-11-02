import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import https from "node:https";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { Resolver } from "node:dns/promises";
import test from "node:test";
import { closeProviderNetwork, createShecanLookup, providerFetch, ProviderNetworkError } from "../lib/server/provider-network";
import { parseShecanDohMessage, resolveShecanDoh } from "../lib/server/shecan-doh";

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

test("Shecan DNS falls back to the official Pro DoH resolver without losing TTL caching", async () => {
  let dohCalls = 0;
  const { resolve } = createShecanLookup(["178.22.122.101", "185.51.200.1"], {
    resolve4: async () => { throw Object.assign(new Error("mock UDP blocked"), { code: "ETIMEOUT" }); },
  }, async (hostname) => {
    dohCalls += 1;
    assert.equal(hostname, "ddns.shecan.ir");
    return [{ address: "185.143.234.133", ttl: 180 }, { address: "185.143.233.133", ttl: 180 }];
  });
  assert.deepEqual(await resolve("ddns.shecan.ir"), ["185.143.234.133", "185.143.233.133"]);
  assert.deepEqual(await resolve("ddns.shecan.ir"), ["185.143.234.133", "185.143.233.133"]);
  assert.equal(dohCalls, 1);
});

test("an empty Shecan UDP answer also falls back to official Pro DoH", async () => {
  const { resolve } = createShecanLookup(["178.22.122.101", "185.51.200.1"], {
    resolve4: async () => [],
  }, async () => [{ address: "185.143.234.133", ttl: 180 }]);
  assert.deepEqual(await resolve("ddns.shecan.ir"), ["185.143.234.133"]);
  const noAnswer = createShecanLookup(["178.22.122.101", "185.51.200.1"], { resolve4: async () => [] });
  await assert.rejects(noAnswer.resolve("ddns.shecan.ir"), (error: unknown) => {
    return error instanceof ProviderNetworkError && (error as ProviderNetworkError & { code?: string }).code === "DNS_NO_IPV4";
  });
});

test("Shecan DoH parser reads compressed A answers and rejects DNS errors", () => {
  const question = Buffer.from([
    4, 100, 100, 110, 115, 6, 115, 104, 101, 99, 97, 110, 2, 105, 114, 0,
    0, 1, 0, 1,
  ]);
  const answer = (third: number) => Buffer.from([
    0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 180, 0, 4, 185, 143, third, 133,
  ]);
  const header = Buffer.from([0, 0, 0x81, 0x80, 0, 1, 0, 2, 0, 0, 0, 0]);
  assert.deepEqual(parseShecanDohMessage(Buffer.concat([header, question, answer(234), answer(233)])), [
    { address: "185.143.234.133", ttl: 180 },
    { address: "185.143.233.133", ttl: 180 },
  ]);
  const failed = Buffer.from(header);
  failed[3] = 0x82;
  assert.throws(() => parseShecanDohMessage(Buffer.concat([failed, question])), /DNS status 2/);
});

test("Shecan DoH pins only the official transport address, preserves TLS identity, then tries system resolution", async () => {
  const originalRequest = https.request;
  const calls: Array<{ input: URL; options: { lookup?: (hostname: string, options: { all: boolean }, callback: (error: Error | null, address: unknown, family?: number) => void) => void; servername?: string; rejectUnauthorized?: boolean } }> = [];
  const question = Buffer.from([4, 100, 100, 110, 115, 6, 115, 104, 101, 99, 97, 110, 2, 105, 114, 0, 0, 1, 0, 1]);
  const answer = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 180, 0, 4, 185, 143, 233, 133]);
  const header = Buffer.from([0, 0, 0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0]);
  const packet = Buffer.concat([header, question, answer]);
  https.request = ((input: URL, options: (typeof calls)[number]["options"], callback: (response: EventEmitter) => void) => {
    calls.push({ input, options });
    const request = new EventEmitter() as EventEmitter & { end: () => void; destroy: (error?: Error) => void };
    request.end = () => process.nextTick(() => {
      if (calls.length === 1) {
        request.emit("error", Object.assign(new Error("mock pinned transport timeout"), { name: "TimeoutError" }));
        return;
      }
      const response = new EventEmitter() as EventEmitter & { statusCode: number; destroy: (error?: Error) => void };
      response.statusCode = 200;
      response.destroy = (error?: Error) => { if (error) response.emit("error", error); };
      callback(response);
      response.emit("data", packet);
      response.emit("end");
    });
    request.destroy = (error?: Error) => { if (error) request.emit("error", error); };
    return request as unknown as ReturnType<typeof https.request>;
  }) as typeof https.request;
  try {
    assert.deepEqual(await resolveShecanDoh("ddns.shecan.ir"), [{ address: "185.143.233.133", ttl: 180 }]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].input.hostname, "pro.shecan.ir");
    assert.equal(calls[0].options.servername, "pro.shecan.ir");
    assert.notEqual(calls[0].options.rejectUnauthorized, false);
    assert.equal(calls[1].options.lookup, undefined, "the fallback must allow ordinary system resolution");
    const pinned = await new Promise<unknown>((resolve, reject) => {
      calls[0].options.lookup?.("pro.shecan.ir", { all: false }, (error, address) => error ? reject(error) : resolve(address));
    });
    assert.equal(pinned, "185.51.200.1");
    const pinnedAll = await new Promise<unknown>((resolve, reject) => {
      calls[0].options.lookup?.("pro.shecan.ir", { all: true }, (error, address) => error ? reject(error) : resolve(address));
    });
    assert.deepEqual(pinnedAll, [{ address: "185.51.200.1", family: 4 }]);
  } finally {
    https.request = originalRequest;
  }
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

test("Pro provider fetch retries through documented DNS 5353 without direct fallback", async () => {
  const originalFetch = globalThis.fetch;
  const originalResolve = Resolver.prototype.resolve4;
  const dispatchers: unknown[] = [];
  let dns5353Calls = 0;
  Resolver.prototype.resolve4 = (async () => [{ address: "203.0.113.50", ttl: 60 }]) as unknown as typeof Resolver.prototype.resolve4;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    dispatchers.push((init as RequestInit & { dispatcher?: unknown } | undefined)?.dispatcher);
    if (dispatchers.length === 1) throw Object.assign(new Error("mock cached route timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" });
    return Response.json({ ok: true });
  }) as typeof fetch;
  const network = { enabled: true, plan: "pro" as const, servers: ["198.51.100.40", "198.51.100.41"] as [string, string] };
  try {
    const response = await providerFetch("https://generativelanguage.googleapis.com/v1beta/models", {}, network, async (hostname, servers) => {
      dns5353Calls += 1;
      assert.equal(hostname, "generativelanguage.googleapis.com");
      assert.deepEqual(servers, network.servers);
      return [{ address: "203.0.113.51", ttl: 180 }];
    });
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(dns5353Calls, 1);
    assert.equal(dispatchers.length, 2);
    assert.ok(dispatchers[0]);
    assert.ok(dispatchers[1]);
    assert.notEqual(dispatchers[0], dispatchers[1]);
  } finally {
    closeProviderNetwork();
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

test("official curl fallback uses scoped resolve and stdin config without waiting for the body", async () => {
  const originalFetch = globalThis.fetch;
  const originalRequest = https.request;
  const originalSpawn = childProcess.spawn;
  const originalResolve = Resolver.prototype.resolve4;
  const updateUrl = "https://ddns.shecan.ir/update/test-curl-fallback";
  let curlCalls = 0;
  let nativeCalls = 0;
  let suppliedConfig = "";
  Resolver.prototype.resolve4 = (async () => [{ address: "203.0.113.39", ttl: 60 }]) as unknown as typeof Resolver.prototype.resolve4;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === updateUrl) throw Object.assign(new Error("mock fetch transport failure"), { code: "FETCH_FAILED" });
    if (url === "https://ddns.shecan.ir") return new Response(null, { status: 404 });
    if (url === "https://generativelanguage.googleapis.com/v1beta/models") {
      return Response.json({ error: { message: "API key not valid. Please pass a valid API key." } }, { status: 400 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;
  https.request = (() => { nativeCalls += 1; throw new Error("native HTTPS should not run after curl succeeds"); }) as typeof https.request;
  childProcess.spawn = ((command: string, args: string[]) => {
    assert.equal(command, "/usr/bin/curl");
    assert.deepEqual(args, ["--config", "-"]);
    curlCalls += 1;
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: EventEmitter & { end: (value: string) => void };
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), {
      end: (value: string) => {
        suppliedConfig = value;
        process.nextTick(() => child.stdout.emit("data", Buffer.from("HTTP/1.1 200 Connection established\r\n\r\nHTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 999\r\n\r\n")));
      },
    });
    child.kill = () => undefined;
    return child as unknown as ReturnType<typeof childProcess.spawn>;
  }) as typeof childProcess.spawn;
  try {
    const { saveAndTestApiNetwork } = await import("../lib/server/api-network");
    const { getDb } = await import("../lib/server/db");
    const admin = getDb().prepare("SELECT id FROM users WHERE role='admin' ORDER BY created_at LIMIT 1").get() as { id: string };
    const status = await saveAndTestApiNetwork({ enabled: true, plan: "pro", servers: ["198.51.100.32", "198.51.100.33"], updateUrl }, admin.id, { activationSettleMs: 0 });
    assert.equal(status.enabled, true);
    assert.equal(curlCalls, 1);
    assert.equal(nativeCalls, 0);
    assert.match(suppliedConfig, /resolve = "ddns\.shecan\.ir:443:203\.0\.113\.39"/);
    assert.match(suppliedConfig, /output = "\/dev\/null"/);
    assert.ok(suppliedConfig.includes(updateUrl), "the secret belongs only in stdin config, not process arguments");
  } finally {
    globalThis.fetch = originalFetch;
    https.request = originalRequest;
    childProcess.spawn = originalSpawn;
    Resolver.prototype.resolve4 = originalResolve;
  }
});

test("curl activation follows only validated Shecan redirects and retains scoped DNS", async () => {
  const originalFetch = globalThis.fetch;
  const originalRequest = https.request;
  const originalSpawn = childProcess.spawn;
  const originalResolve = Resolver.prototype.resolve4;
  const updateUrl = "https://ddns.shecan.ir/update/test-curl-redirect";
  const redirectedUrl = "https://ddns.shecan.ir/update/test-curl-redirected";
  const configs: string[] = [];
  Resolver.prototype.resolve4 = (async () => [{ address: "203.0.113.40", ttl: 60 }]) as unknown as typeof Resolver.prototype.resolve4;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === updateUrl) throw Object.assign(new Error("mock fetch transport failure"), { code: "FETCH_FAILED" });
    if (url === "https://generativelanguage.googleapis.com/v1beta/models") {
      return Response.json({ error: { message: "API key not valid. Please pass a valid API key." } }, { status: 400 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;
  https.request = (() => { throw new Error("native HTTPS should not run after redirected curl succeeds"); }) as typeof https.request;
  childProcess.spawn = (() => {
    const call = configs.length;
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: EventEmitter & { end: (value: string) => void };
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), {
      end: (value: string) => {
        configs.push(value);
        process.nextTick(() => child.stdout.emit("data", Buffer.from(call === 0
          ? `HTTP/1.1 302 Found\r\nLocation: ${redirectedUrl}\r\n\r\n`
          : "HTTP/1.1 204 No Content\r\n\r\n")));
      },
    });
    child.kill = () => undefined;
    return child as unknown as ReturnType<typeof childProcess.spawn>;
  }) as typeof childProcess.spawn;
  try {
    const { saveAndTestApiNetwork } = await import("../lib/server/api-network");
    const { getDb } = await import("../lib/server/db");
    const admin = getDb().prepare("SELECT id FROM users WHERE role='admin' ORDER BY created_at LIMIT 1").get() as { id: string };
    const status = await saveAndTestApiNetwork({ enabled: true, plan: "pro", servers: ["198.51.100.34", "198.51.100.35"], updateUrl }, admin.id, { activationSettleMs: 0 });
    assert.equal(status.enabled, true);
    assert.equal(configs.length, 2);
    assert.ok(configs[1].includes(redirectedUrl));
    assert.equal((configs[1].match(/resolve = /g) || []).length, 1);
    assert.match(configs[1], /ddns\.shecan\.ir:443:203\.0\.113\.40/);
  } finally {
    globalThis.fetch = originalFetch;
    https.request = originalRequest;
    childProcess.spawn = originalSpawn;
    Resolver.prototype.resolve4 = originalResolve;
  }
});

test("curl timeout retries a fresh official DoH address without using native HTTPS", async () => {
  const originalFetch = globalThis.fetch;
  const originalRequest = https.request;
  const originalSpawn = childProcess.spawn;
  const originalResolve = Resolver.prototype.resolve4;
  const updateUrl = "https://ddns.shecan.ir/update/test-curl-doh-retry";
  const configs: string[] = [];
  let dohCalls = 0;
  Resolver.prototype.resolve4 = (async () => [{ address: "203.0.113.41", ttl: 60 }]) as unknown as typeof Resolver.prototype.resolve4;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === updateUrl) throw Object.assign(new Error("mock fetch transport failure"), { code: "FETCH_FAILED" });
    if (url === "https://ddns.shecan.ir") return new Response(null, { status: 404 });
    if (url === "https://generativelanguage.googleapis.com/v1beta/models") {
      return Response.json({ error: { message: "API key not valid. Please pass a valid API key." } }, { status: 400 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;
  https.request = ((input: URL, _options: unknown, callback: (response: EventEmitter) => void) => {
    assert.equal(new URL(String(input)).hostname, "pro.shecan.ir");
    dohCalls += 1;
    const request = new EventEmitter() as EventEmitter & { end: () => void; destroy: (error?: Error) => void };
    request.end = () => {
      const response = new EventEmitter() as EventEmitter & { statusCode: number };
      response.statusCode = 200;
      const question = Buffer.from([4, 100, 100, 110, 115, 6, 115, 104, 101, 99, 97, 110, 2, 105, 114, 0, 0, 1, 0, 1]);
      const answer = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 180, 0, 4, 185, 143, 234, 133]);
      const header = Buffer.from([0, 0, 0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0]);
      callback(response);
      process.nextTick(() => {
        response.emit("data", Buffer.concat([header, question, answer]));
        response.emit("end");
      });
    };
    request.destroy = (error?: Error) => { if (error) request.emit("error", error); };
    return request as unknown as ReturnType<typeof https.request>;
  }) as typeof https.request;
  childProcess.spawn = (() => {
    const call = configs.length;
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: EventEmitter & { end: (value: string) => void };
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), {
      end: (value: string) => {
        configs.push(value);
        process.nextTick(() => {
          if (call === 0) child.emit("close", 28);
          else child.stdout.emit("data", Buffer.from("HTTP/1.1 200 OK\r\n\r\n"));
        });
      },
    });
    child.kill = () => undefined;
    return child as unknown as ReturnType<typeof childProcess.spawn>;
  }) as typeof childProcess.spawn;
  try {
    const { saveAndTestApiNetwork } = await import("../lib/server/api-network");
    const { getDb } = await import("../lib/server/db");
    const admin = getDb().prepare("SELECT id FROM users WHERE role='admin' ORDER BY created_at LIMIT 1").get() as { id: string };
    const status = await saveAndTestApiNetwork({ enabled: true, plan: "pro", servers: ["198.51.100.36", "198.51.100.37"], updateUrl }, admin.id, { activationSettleMs: 0 });
    assert.equal(status.enabled, true);
    assert.equal(dohCalls, 1);
    assert.equal(configs.length, 2);
    assert.match(configs[0], /ddns\.shecan\.ir:443:203\.0\.113\.41/);
    assert.match(configs[1], /ddns\.shecan\.ir:443:185\.143\.234\.133/);
  } finally {
    globalThis.fetch = originalFetch;
    https.request = originalRequest;
    childProcess.spawn = originalSpawn;
    Resolver.prototype.resolve4 = originalResolve;
  }
});

test("curl timeout uses a fresh documented DNS 5353 address after a stale DoH answer", async () => {
  const originalFetch = globalThis.fetch;
  const originalRequest = https.request;
  const originalSpawn = childProcess.spawn;
  const originalResolve = Resolver.prototype.resolve4;
  const updateUrl = "https://ddns.shecan.ir/update/test-curl-5353-retry";
  const configs: string[] = [];
  let dns5353Calls = 0;
  Resolver.prototype.resolve4 = (async () => [{ address: "203.0.113.41", ttl: 60 }]) as unknown as typeof Resolver.prototype.resolve4;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === updateUrl) throw Object.assign(new Error("mock fetch transport failure"), { code: "FETCH_FAILED" });
    if (url === "https://ddns.shecan.ir") return new Response(null, { status: 404 });
    if (url === "https://generativelanguage.googleapis.com/v1beta/models") {
      return Response.json({ error: { message: "API key not valid. Please pass a valid API key." } }, { status: 400 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;
  https.request = ((input: URL, _options: unknown, callback: (response: EventEmitter) => void) => {
    assert.equal(new URL(String(input)).hostname, "pro.shecan.ir");
    const request = new EventEmitter() as EventEmitter & { end: () => void; destroy: (error?: Error) => void };
    request.end = () => {
      const response = new EventEmitter() as EventEmitter & { statusCode: number };
      response.statusCode = 200;
      const question = Buffer.from([4, 100, 100, 110, 115, 6, 115, 104, 101, 99, 97, 110, 2, 105, 114, 0, 0, 1, 0, 1]);
      const answer = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 180, 0, 4, 203, 0, 113, 41]);
      const header = Buffer.from([0, 0, 0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0]);
      callback(response);
      process.nextTick(() => {
        response.emit("data", Buffer.concat([header, question, answer]));
        response.emit("end");
      });
    };
    request.destroy = (error?: Error) => { if (error) request.emit("error", error); };
    return request as unknown as ReturnType<typeof https.request>;
  }) as typeof https.request;
  childProcess.spawn = (() => {
    const call = configs.length;
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: EventEmitter & { end: (value: string) => void };
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), {
      end: (value: string) => {
        configs.push(value);
        process.nextTick(() => {
          if (call === 0) child.emit("close", 28);
          else child.stdout.emit("data", Buffer.from("HTTP/1.1 200 OK\r\n\r\n"));
        });
      },
    });
    child.kill = () => undefined;
    return child as unknown as ReturnType<typeof childProcess.spawn>;
  }) as typeof childProcess.spawn;
  try {
    const { saveAndTestApiNetwork } = await import("../lib/server/api-network");
    const { getDb } = await import("../lib/server/db");
    const admin = getDb().prepare("SELECT id FROM users WHERE role='admin' ORDER BY created_at LIMIT 1").get() as { id: string };
    const status = await saveAndTestApiNetwork(
      { enabled: true, plan: "pro", servers: ["198.51.100.42", "198.51.100.43"], updateUrl },
      admin.id,
      {
        activationSettleMs: 0,
        dns5353Resolver: async (hostname, servers) => {
          dns5353Calls += 1;
          assert.equal(hostname, "ddns.shecan.ir");
          assert.deepEqual(servers, ["198.51.100.42", "198.51.100.43"]);
          return [{ address: "185.143.233.133", ttl: 180 }];
        },
      },
    );
    assert.equal(status.enabled, true);
    assert.equal(dns5353Calls, 1);
    assert.equal(configs.length, 2);
    assert.match(configs[1], /ddns\.shecan\.ir:443:185\.143\.233\.133/);
  } finally {
    globalThis.fetch = originalFetch;
    https.request = originalRequest;
    childProcess.spawn = originalSpawn;
    Resolver.prototype.resolve4 = originalResolve;
  }
});

test("native HTTPS fallback tries every scoped Shecan IPv4 address after fetch failure", async () => {
  const originalFetch = globalThis.fetch;
  const originalRequest = https.request;
  const originalSpawn = childProcess.spawn;
  const originalResolve = Resolver.prototype.resolve4;
  const updateUrl = "https://ddns.shecan.ir/update/test-native-fallback";
  let nativeLookup = false;
  let nativeRequests = 0;
  let responseDestroyed = 0;
  Resolver.prototype.resolve4 = (async () => [{ address: "203.0.113.36", ttl: 60 }, { address: "203.0.113.37", ttl: 60 }]) as unknown as typeof Resolver.prototype.resolve4;
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
    nativeLookup = nativeLookup || typeof options.lookup === "function";
    const request = new EventEmitter() as EventEmitter & { end: () => void; destroy: (error?: Error) => void };
    request.end = () => {
      nativeRequests += 1;
      if (nativeRequests < 3) {
        request.emit("error", Object.assign(new Error("mock native address unreachable"), { code: "ECONNRESET" }));
        return;
      }
      const response = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string>; destroy: () => void };
      response.statusCode = 200;
      response.headers = {};
      response.destroy = () => { responseDestroyed += 1; };
      callback(response);
    };
    request.destroy = (error?: Error) => { if (error) request.emit("error", error); };
    return request as unknown as ReturnType<typeof https.request>;
  }) as typeof https.request;
  childProcess.spawn = (() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: EventEmitter & { end: () => void };
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), { end: () => process.nextTick(() => child.emit("error", Object.assign(new Error("mock curl unavailable"), { code: "ENOENT" }))) });
    child.kill = () => undefined;
    return child as unknown as ReturnType<typeof childProcess.spawn>;
  }) as typeof childProcess.spawn;
  try {
    const { saveAndTestApiNetwork } = await import("../lib/server/api-network");
    const { getDb } = await import("../lib/server/db");
    const admin = getDb().prepare("SELECT id FROM users WHERE role='admin' ORDER BY created_at LIMIT 1").get() as { id: string };
    const status = await saveAndTestApiNetwork({ enabled: true, plan: "pro", servers: ["198.51.100.26", "198.51.100.27"], updateUrl }, admin.id, { activationSettleMs: 0 });
    assert.equal(status.enabled, true);
    assert.equal(status.lastTestStatus, "success");
    assert.equal(nativeLookup, true, "native activation must use Shecan DNS without changing host DNS");
    assert.equal(nativeRequests, 3, "native activation must retry every scoped Shecan IPv4 address");
    assert.equal(responseDestroyed, 1, "native activation must not wait for the response body");
  } finally {
    globalThis.fetch = originalFetch;
    https.request = originalRequest;
    childProcess.spawn = originalSpawn;
    Resolver.prototype.resolve4 = originalResolve;
  }
});

test("background activation is deduplicated and exposes its final status without waiting for the HTTP request", async () => {
  const originalFetch = globalThis.fetch;
  const originalResolve = Resolver.prototype.resolve4;
  const updateUrl = "https://ddns.shecan.ir/update/test-background-activation";
  let updateCalls = 0;
  Resolver.prototype.resolve4 = (async () => [{ address: "203.0.113.38", ttl: 60 }]) as unknown as typeof Resolver.prototype.resolve4;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === updateUrl) {
      updateCalls += 1;
      return new Response("updated", { status: 200 });
    }
    if (url === "https://generativelanguage.googleapis.com/v1beta/models") {
      return Response.json({ error: { message: "API key not valid. Please pass a valid API key." } }, { status: 400 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;
  try {
    const { getApiNetworkJobStatus, getApiNetworkStatus, saveAndTestApiNetwork, startApiNetworkJob } = await import("../lib/server/api-network");
    const { getDb } = await import("../lib/server/db");
    const admin = getDb().prepare("SELECT id FROM users WHERE role='admin' ORDER BY created_at LIMIT 1").get() as { id: string };
    const input = { enabled: true, plan: "pro" as const, servers: ["198.51.100.28", "198.51.100.29"] as [string, string], updateUrl };
    const started = startApiNetworkJob(input, admin.id, { activationSettleMs: 0 });
    assert.equal(started.pending, true);
    assert.equal(startApiNetworkJob(input, admin.id, { activationSettleMs: 0 }).startedAt, started.startedAt, "a duplicate click must reuse the active job");
    for (let attempt = 0; getApiNetworkJobStatus().pending && attempt < 100; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    const completed = getApiNetworkJobStatus();
    assert.equal(completed.pending, false);
    assert.equal(completed.error, undefined);
    assert.equal(updateCalls, 1);
    assert.equal((await getApiNetworkStatus()).enabled, true);
    await saveAndTestApiNetwork({ ...input, enabled: false, updateUrl: undefined }, admin.id, { activationSettleMs: 0 });
  } finally {
    globalThis.fetch = originalFetch;
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
