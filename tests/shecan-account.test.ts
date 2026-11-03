import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const dataDirectory = mkdtempSync(path.join(tmpdir(), "nomreh-shecan-account-"));
process.env.NOMREH_DATA_DIR = dataDirectory;
process.env.NOMREH_SECRET_KEY = "shecan-account-test-secret-with-enough-entropy";

const originalFetch = globalThis.fetch;
const apiKey = "aBcD0123456789aBcD0123456789aBcD01234567";

function order(id: number, tierId: number, token: string, statusId = 3) {
  return {
    id,
    subject: `شکن حرفه‌ای ${id} - یک ساله`,
    status: { id: statusId, name: statusId === 3 ? "فعال" : "بسته" },
    due_date: "2027-01-20",
    custom_fields: [
      { id: 58, value: String(tierId) },
      { id: 95, value: token },
      { id: 36, value: "203.0.113.80" },
    ],
  };
}

function mockAccountEndpoints(orders = [order(101, 47, "bronze-token-secret"), order(202, 49, "gold-token-secret")], onLogin?: (body: string, count: number) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let loginCount = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === "https://my.shecan.ir/api/auth/login") {
      loginCount += 1;
      const body = String(init?.body || "");
      if (onLogin) return onLogin(body, loginCount);
      return Response.json({ api_key: apiKey, identifier: "shecan-user" });
    }
    if (url === "https://my.shecan.ir/my/account.json") {
      assert.equal((init?.headers as Record<string, string>)["X-Redmine-API-Key"], apiKey);
      return Response.json({ user: { login: "shecan-user", firstname: "کاربر", lastname: "شکن" } });
    }
    if (url === "https://my.shecan.ir/issues.json?offset=0&limit=25&query_id=106") {
      assert.equal((init?.headers as Record<string, string>)["X-Redmine-API-Key"], apiKey);
      return Response.json({ issues: orders });
    }
    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;
  return calls;
}

async function adminId(): Promise<string> {
  const { getDb } = await import("../lib/server/db");
  return (getDb().prepare("SELECT id FROM users WHERE role='admin' ORDER BY created_at LIMIT 1").get() as { id: string }).id;
}

test.beforeEach(async () => {
  const { getDb } = await import("../lib/server/db");
  getDb().prepare("DELETE FROM api_network_settings").run();
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("official password login stores only encrypted account/update secrets and selects the official best active order", async () => {
  const calls = mockAccountEndpoints();
  const { loginShecanAccount } = await import("../lib/server/shecan-account");
  const { getApiNetworkConfig, getApiNetworkStatus } = await import("../lib/server/api-network");
  const { getDb } = await import("../lib/server/db");
  const result = await loginShecanAccount("  shecan-user  ", "account-password", await adminId());
  assert.equal(result.orders.length, 2);
  assert.equal(result.orders[1].hasUpdateToken, true);
  const serialized = JSON.stringify(result);
  assert(!serialized.includes("gold-token-secret"));
  assert(!serialized.includes("bronze-token-secret"));
  assert(!serialized.includes(apiKey));
  assert(!serialized.includes("account-password"));
  assert(calls.every((call) => call.init?.redirect === "manual"));
  assert(calls.every((call) => !(call.init as RequestInit & { dispatcher?: unknown }).dispatcher), "account traffic must not use the AI-only Shecan dispatcher");

  const status = await getApiNetworkStatus();
  assert.equal(status.hasAccountKey, true);
  assert.equal(status.accountLogin, "shecan-user");
  assert.equal(status.accountName, "کاربر شکن");
  assert.equal(status.selectedOrderId, 202);
  assert.equal(status.updateUrlSource, "account");
  assert.equal(status.hasUpdateUrl, true);
  assert.equal(status.enabled, false, "selecting a new account service must require a fresh activation test");
  assert(!JSON.stringify(status).includes("gold-token-secret"));

  const raw = getDb().prepare(`SELECT encrypted_account_key, encrypted_update_url, update_url_source, selected_order_id
    FROM api_network_settings WHERE id=1`).get() as Record<string, string | number>;
  assert(!String(raw.encrypted_account_key).includes(apiKey));
  assert(!String(raw.encrypted_update_url).includes("gold-token-secret"));
  assert.equal(raw.update_url_source, "account");
  assert.equal(raw.selected_order_id, 202);
  getDb().prepare("UPDATE api_network_settings SET enabled=1 WHERE id=1").run();
  assert.equal((await getApiNetworkConfig()).updateUrl, "https://ddns.shecan.ir/update?password=gold-token-secret");
  getDb().prepare("UPDATE api_network_settings SET enabled=0 WHERE id=1").run();
});

test("login matches the official trimmed-password fallback and normalizes Persian identifier digits", async () => {
  const bodies: string[] = [];
  mockAccountEndpoints([order(303, 48, "silver-token-secret")], (body, count) => {
    bodies.push(body);
    return count === 1 ? Response.json({ error: "invalid" }, { status: 401 }) : Response.json({ api_key: apiKey });
  });
  const { loginShecanAccount } = await import("../lib/server/shecan-account");
  await loginShecanAccount("  ۰۹۱۲۳۴۵۶۷۸۹  ", "  password-with-space  ", await adminId());
  assert.deepEqual(bodies.map((body) => JSON.parse(body)), [
    { identifier: "09123456789", password: "password-with-space" },
    { identifier: "09123456789", password: "  password-with-space  " },
  ]);
});

test("service selection re-fetches authoritative orders, disables stale routing, and logout preserves only the update link", async () => {
  mockAccountEndpoints();
  const { loginShecanAccount, logoutShecanAccount, selectShecanOrder } = await import("../lib/server/shecan-account");
  const { getApiNetworkStatus } = await import("../lib/server/api-network");
  const { getDb } = await import("../lib/server/db");
  const userId = await adminId();
  await loginShecanAccount("shecan-user", "password", userId);
  getDb().prepare("UPDATE api_network_settings SET enabled=1 WHERE id=1").run();
  const selected = await selectShecanOrder(101, userId);
  assert(!JSON.stringify(selected).includes("bronze-token-secret"));
  let status = await getApiNetworkStatus();
  assert.equal(status.selectedOrderId, 101);
  assert.equal(status.enabled, false);
  assert.equal(status.hasAccountKey, true);
  const updateBeforeLogout = (getDb().prepare("SELECT encrypted_update_url FROM api_network_settings WHERE id=1").get() as { encrypted_update_url: string }).encrypted_update_url;
  await logoutShecanAccount(userId);
  status = await getApiNetworkStatus();
  assert.equal(status.hasAccountKey, false);
  assert.equal(status.accountLogin, undefined);
  assert.equal(status.selectedOrderId, undefined);
  assert.equal(status.hasUpdateUrl, true, "logout removes the account key without silently changing the current AI connection");
  assert.equal(status.updateUrlSource, "manual");
  const raw = getDb().prepare("SELECT encrypted_account_key, encrypted_update_url FROM api_network_settings WHERE id=1").get() as { encrypted_account_key: string; encrypted_update_url: string };
  assert.equal(raw.encrypted_account_key, "");
  assert.equal(raw.encrypted_update_url, updateBeforeLogout);
});

test("rejected credentials and unsafe redirects never create an account row or expose password material", async () => {
  globalThis.fetch = (async () => Response.json({ error: "invalid credentials" }, { status: 401 })) as typeof fetch;
  const { loginShecanAccount } = await import("../lib/server/shecan-account");
  const { getApiNetworkStatus } = await import("../lib/server/api-network");
  await assert.rejects(loginShecanAccount("shecan-user", "never-store-this-password", await adminId()), (error: unknown) => {
    assert(error instanceof Error);
    assert.match(error.message, /نام کاربری یا رمز عبور/);
    assert(!error.message.includes("never-store-this-password"));
    return true;
  });
  assert.equal((await getApiNetworkStatus()).configured, false);

  globalThis.fetch = (async () => new Response(null, { status: 307, headers: { Location: "https://example.com/credential-capture" } })) as typeof fetch;
  await assert.rejects(loginShecanAccount("shecan-user", "never-store-this-password", await adminId()), /تغییرمسیر غیرمنتظره/);
  assert.equal((await getApiNetworkStatus()).configured, false);
});

test("account-service probe proves the official host answered without sending credentials or AI routing", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return Response.json({ error: "API key is missing" }, { status: 401 });
  }) as typeof fetch;
  const { probeShecanAccountService } = await import("../lib/server/shecan-account");
  assert.deepEqual(await probeShecanAccountService(), { reachable: true, httpStatus: 401 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://my.shecan.ir/my/account.json");
  assert.equal(calls[0].init?.body, undefined);
  assert(!JSON.stringify(calls[0].init?.headers).includes("X-Redmine-API-Key"));
  assert(!(calls[0].init as RequestInit & { dispatcher?: unknown }).dispatcher);
});

test("an account without a usable active order can log in but cannot fabricate an update link", async () => {
  mockAccountEndpoints([order(404, 49, "", 1)]);
  const { loginShecanAccount } = await import("../lib/server/shecan-account");
  const { getApiNetworkStatus } = await import("../lib/server/api-network");
  const result = await loginShecanAccount("shecan-user", "password", await adminId());
  assert.equal(result.orders[0].active, false);
  assert.equal(result.orders[0].hasUpdateToken, false);
  const status = await getApiNetworkStatus();
  assert.equal(status.hasAccountKey, true);
  assert.equal(status.hasUpdateUrl, false);
  assert.equal(status.selectedOrderId, undefined);
  assert.equal(status.enabled, false);
});

test("account probe can use an official SNI node without changing the Shecan hostname", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    if (calls.length === 1) throw Object.assign(new Error("mock direct timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" });
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }) as typeof fetch;
  try {
    const { probeShecanAccountService } = await import("../lib/server/shecan-account");
    assert.deepEqual(await probeShecanAccountService(), { reachable: true, httpStatus: 401 });
    assert.equal(calls.length, 2);
    assert(calls.every((call) => new URL(call.url).hostname === "my.shecan.ir"));
    assert.equal(calls[0].init?.redirect, "manual");
    assert.equal((calls[0].init as RequestInit & { dispatcher?: unknown }).dispatcher, undefined);
    assert.ok((calls[1].init as RequestInit & { dispatcher?: unknown }).dispatcher);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test.after(async () => {
  try { (globalThis as typeof globalThis & { __nomrehDatabase?: { close: () => void } }).__nomrehDatabase?.close(); } catch { /* already closed */ }
  rmSync(dataDirectory, { recursive: true, force: true });
});
