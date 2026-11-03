import { isIP } from "node:net";
import { Agent } from "undici";
import type { ShecanOrderPublic } from "../types";
import { SHECAN_DNS } from "../api-network";
import { closeProviderNetwork } from "./provider-network";
import { encryptSecret, decryptSecret } from "./secret-crypto";
import { fixedShecanIpv4Lookup, SHECAN_SNI_FALLBACK_IPV4 } from "./shecan-sni";

const SHECAN_API_ORIGIN = "https://my.shecan.ir";
const ACCOUNT_KEY_PURPOSE = "nomreh-shecan-account-v1";
const UPDATE_URL_PURPOSE = "nomreh-api-network-v1";
const ACTIVE_STATUS_IDS = new Set([3, 10, 9, 23]);
const TIERS: Record<number, string> = { 47: "برنزی", 48: "نقره‌ای", 49: "طلایی" };
const TIER_RANK: Record<number, number> = { 47: 1, 48: 2, 49: 3 };

interface ShecanAccountRow {
  encrypted_update_url: string;
  update_url_source: "manual" | "account";
  encrypted_account_key: string;
  account_login: string;
  account_name: string;
  account_authenticated_at?: string;
  selected_order_id?: number;
}

interface ShecanOrder extends ShecanOrderPublic {
  updateToken: string;
  tierId?: number;
}

interface ShecanAccountIdentity {
  login: string;
  name: string;
}

interface ShecanRequestResult {
  status: number;
  ok: boolean;
  data: unknown;
}

export class ShecanAccountError extends Error {
  status: number;

  constructor(message: string, status = 502, options?: ErrorOptions) {
    super(message, options);
    this.name = "ShecanAccountError";
    this.status = status;
  }
}

function normalizeIdentifier(value: string): string {
  return value.trim()
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)));
}

function safeText(value: unknown, maximum = 160): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maximum) : "";
}

async function shecanRequest(path: string, options: { method?: "GET" | "POST"; body?: unknown; apiKey?: string } = {}): Promise<ShecanRequestResult> {
  const agents: Agent[] = [];
  const execute = (dispatcher?: Agent) => fetch(`${SHECAN_API_ORIGIN}${path}`, {
    method: options.method || "GET",
    headers: {
      Accept: "application/json",
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(options.apiKey ? { "X-Redmine-API-Key": options.apiKey } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    cache: "no-store",
    // A redirect must never forward a password or account key to another host.
    redirect: "manual",
    signal: AbortSignal.timeout(dispatcher ? 7_000 : 15_000),
    ...(dispatcher ? { dispatcher } : {}),
  } as RequestInit);
  try {
    let response: Response | undefined;
    let lastError: unknown;
    try { response = await execute(); }
    catch (error) { lastError = error; }
    if (!response) {
      for (const address of SHECAN_SNI_FALLBACK_IPV4) {
        const agent = new Agent({
          connect: { lookup: fixedShecanIpv4Lookup(address), timeout: 5_000 },
          headersTimeout: 7_000,
          bodyTimeout: 7_000,
        });
        agents.push(agent);
        try {
          response = await execute(agent);
          break;
        } catch (error) {
          lastError = error;
        }
      }
    }
    if (!response) {
      throw new ShecanAccountError("اتصال امن سرور نمره به my.shecan.ir از مسیر مستقیم و گره‌های رسمی شکن برقرار نشد؛ رمز یا کلید تازه‌ای ذخیره نشد.", 502, { cause: lastError });
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new ShecanAccountError("پاسخ تغییرمسیر غیرمنتظره از شکن دریافت شد؛ برای محافظت از رمز و کلید، درخواست دنبال نشد.", 502);
    }
    const text = await response.text();
    if (text.length > 1_000_000) throw new ShecanAccountError("پاسخ شکن بیش از حد مجاز بزرگ بود و پذیرفته نشد.", 502);
    let data: unknown = null;
    if (text) {
      try { data = JSON.parse(text); } catch { /* Status-specific handling below avoids reflecting an HTML body. */ }
    }
    return { status: response.status, ok: response.ok, data };
  } finally {
    await Promise.all(agents.map((agent) => agent.close().catch(() => undefined)));
  }
}

function requireSuccessfulAccountRequest(result: ShecanRequestResult): void {
  if (result.ok) return;
  if (result.status === 401 || result.status === 403) {
    throw new ShecanAccountError("کلید حساب شکن پذیرفته نشد یا منقضی شده است؛ دوباره وارد حساب شوید.", 401);
  }
  if (result.status === 429) throw new ShecanAccountError("شکن موقتاً تعداد درخواست‌ها را محدود کرده است؛ کمی بعد دوباره تلاش کنید.", 429);
  throw new ShecanAccountError(`دریافت اطلاعات حساب شکن ناموفق بود (HTTP ${result.status}).`, 502);
}

async function loadIdentity(apiKey: string): Promise<ShecanAccountIdentity> {
  const result = await shecanRequest("/my/account.json", { apiKey });
  requireSuccessfulAccountRequest(result);
  const user = (result.data as { user?: Record<string, unknown> } | null)?.user;
  if (!user || typeof user !== "object") throw new ShecanAccountError("پاسخ حساب شکن معتبر نبود؛ کلید ذخیره نشد.", 502);
  const login = safeText(user.login) || safeText(user.mail);
  const name = [safeText(user.firstname, 80), safeText(user.lastname, 80)].filter(Boolean).join(" ");
  return { login, name };
}

function customField(issue: Record<string, unknown>, id: number): string {
  if (!Array.isArray(issue.custom_fields)) return "";
  const field = issue.custom_fields.find((candidate) => {
    return typeof candidate === "object" && candidate !== null && (candidate as { id?: unknown }).id === id;
  }) as { value?: unknown } | undefined;
  return typeof field?.value === "string" ? field.value : "";
}

async function loadOrders(apiKey: string): Promise<ShecanOrder[]> {
  const result = await shecanRequest("/issues.json?offset=0&limit=25&query_id=106", { apiKey });
  requireSuccessfulAccountRequest(result);
  const issues = (result.data as { issues?: unknown } | null)?.issues;
  if (!Array.isArray(issues)) throw new ShecanAccountError("فهرست سرویس‌های شکن در پاسخ رسمی پیدا نشد.", 502);
  return issues.flatMap((raw): ShecanOrder[] => {
    if (typeof raw !== "object" || raw === null) return [];
    const issue = raw as Record<string, unknown>;
    const id = Number(issue.id);
    if (!Number.isSafeInteger(id) || id <= 0) return [];
    const status = typeof issue.status === "object" && issue.status !== null ? issue.status as Record<string, unknown> : {};
    const tierId = Number(customField(issue, 58)) || undefined;
    const updateToken = customField(issue, 95).trim();
    const lastIp = customField(issue, 36).trim();
    const subject = safeText(issue.subject, 180);
    return [{
      id,
      product: subject.split(" - ")[0]?.trim().slice(0, 120) || "سرویس شکن",
      tier: tierId ? TIERS[tierId] : undefined,
      tierId,
      active: ACTIVE_STATUS_IDS.has(Number(status.id)),
      statusName: safeText(status.name, 100),
      due: typeof issue.due_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(issue.due_date) ? issue.due_date : undefined,
      hasUpdateToken: updateToken.length > 0,
      lastRegisteredIp: isIP(lastIp) ? lastIp : undefined,
      updateToken,
    }];
  });
}

function publicOrder(order: ShecanOrder): ShecanOrderPublic {
  const { updateToken: _updateToken, tierId: _tierId, ...publicFields } = order;
  return publicFields;
}

function orderLabel(order: ShecanOrder): string {
  return [order.product, order.tier].filter(Boolean).join(" · ");
}

function pickOfficialOrder(orders: ShecanOrder[]): ShecanOrder | undefined {
  const active = orders.filter((order) => order.active);
  const pool = active.length ? active : orders;
  return pool.reduce<ShecanOrder | undefined>((best, current) => {
    if (!best) return current;
    return (TIER_RANK[current.tierId || 0] || 0) > (TIER_RANK[best.tierId || 0] || 0) ? current : best;
  }, undefined);
}

function buildUpdateUrl(order: ShecanOrder): string {
  if (!order.active) throw new ShecanAccountError("سرویس انتخاب‌شده فعال نیست؛ یک سرویس فعال را انتخاب کنید.", 400);
  if (!order.updateToken || order.updateToken.length > 2048 || /[\u0000-\u001f\u007f]/.test(order.updateToken)) {
    throw new ShecanAccountError("این سرویس توکن معتبر برای ثبت IP ندارد؛ سرویس دیگری را انتخاب کنید یا لینک سفارش را دستی وارد کنید.", 400);
  }
  const url = new URL("https://ddns.shecan.ir/update");
  url.searchParams.set("password", order.updateToken);
  return url.toString();
}

async function findAccountRow(): Promise<ShecanAccountRow | undefined> {
  return (await import("./db")).getDb().prepare(`SELECT encrypted_update_url, update_url_source, encrypted_account_key,
    account_login, account_name, account_authenticated_at, selected_order_id FROM api_network_settings WHERE id=1`).get() as ShecanAccountRow | undefined;
}

async function persistLogin(identity: ShecanAccountIdentity, apiKey: string, selected: ShecanOrder | undefined, userId: string, freshLogin: boolean): Promise<void> {
  const previous = await findAccountRow();
  const now = new Date().toISOString();
  const usable = Boolean(selected?.active && selected.updateToken);
  const updateUrl = usable && selected ? buildUpdateUrl(selected) : "";
  const [encryptedAccountKey, encryptedUpdateUrl] = await Promise.all([
    encryptSecret(apiKey, ACCOUNT_KEY_PURPOSE),
    usable ? encryptSecret(updateUrl, UPDATE_URL_PURPOSE) : Promise.resolve(""),
  ]);
  const authenticatedAt = freshLogin ? now : previous?.account_authenticated_at || now;
  const selectedId = usable ? selected?.id || null : null;
  const selectedLabel = usable && selected ? orderLabel(selected) : "";
  const selectedDue = usable ? selected?.due || "" : "";
  const message = usable && selected
    ? `سرویس «${orderLabel(selected)}» از حساب شکن دریافت شد؛ برای فعال‌سازی، ثبت IP و آزمایش را اجرا کنید.`
    : "حساب شکن متصل شد؛ یک سرویس فعال با قابلیت ثبت IP انتخاب کنید.";
  const db = (await import("./db")).getDb();
  if (!previous) {
    db.prepare(`INSERT INTO api_network_settings
      (id, plan, dns_primary, dns_secondary, enabled, encrypted_update_url, update_url_source,
       encrypted_account_key, account_login, account_name, account_authenticated_at,
       selected_order_id, selected_order_label, selected_order_due,
       last_test_status, last_test_message, last_tested_at, last_test_latency_ms, last_activated_at, updated_at, updated_by)
      VALUES (1, 'pro', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, NULL, NULL, NULL, ?, ?)`)
      .run(SHECAN_DNS.pro[0], SHECAN_DNS.pro[1], encryptedUpdateUrl, usable ? "account" : "manual",
        encryptedAccountKey, identity.login, identity.name, authenticatedAt, selectedId, selectedLabel, selectedDue, message, now, userId);
  } else if (usable) {
    db.prepare(`UPDATE api_network_settings SET plan='pro', enabled=0, encrypted_update_url=?, update_url_source='account',
      encrypted_account_key=?, account_login=?, account_name=?, account_authenticated_at=?,
      selected_order_id=?, selected_order_label=?, selected_order_due=?,
      last_test_status='idle', last_test_message=?, last_tested_at=NULL, last_test_latency_ms=NULL, last_activated_at=NULL,
      updated_at=?, updated_by=? WHERE id=1`)
      .run(encryptedUpdateUrl, encryptedAccountKey, identity.login, identity.name, authenticatedAt,
        selectedId, selectedLabel, selectedDue, message, now, userId);
  } else {
    db.prepare(`UPDATE api_network_settings SET encrypted_account_key=?, account_login=?, account_name=?, account_authenticated_at=?,
      selected_order_id=NULL, selected_order_label='', selected_order_due='', last_test_message=?, updated_at=?, updated_by=? WHERE id=1`)
      .run(encryptedAccountKey, identity.login, identity.name, authenticatedAt, message, now, userId);
  }
  if (usable) closeProviderNetwork();
}

async function storedAccountKey(): Promise<{ key: string; row: ShecanAccountRow }> {
  const row = await findAccountRow();
  if (!row?.encrypted_account_key) throw new ShecanAccountError("ابتدا با نام کاربری و رمز عبور وارد حساب شکن شوید.", 400);
  try {
    return { key: await decryptSecret(row.encrypted_account_key, ACCOUNT_KEY_PURPOSE), row };
  } catch (error) {
    throw new ShecanAccountError("کلید رمزنگاری‌شدهٔ حساب شکن باز نشد؛ دوباره وارد حساب شوید.", 500, { cause: error });
  }
}

export async function probeShecanAccountService(): Promise<{ reachable: true; httpStatus: number }> {
  const result = await shecanRequest("/my/account.json");
  if (result.status >= 500) throw new ShecanAccountError(`سرویس ورود شکن با خطای HTTP ${result.status} پاسخ داد؛ بعداً دوباره تلاش کنید.`, 502);
  // An unauthenticated 401/403 is the expected proof that the exact official
  // account service answered. No identifier, password, key or cookie is sent.
  return { reachable: true, httpStatus: result.status };
}

export async function loginShecanAccount(identifierInput: string, password: string, userId: string): Promise<{ orders: ShecanOrderPublic[] }> {
  const identifier = normalizeIdentifier(identifierInput);
  if (!identifier || !password) throw new ShecanAccountError("نام کاربری و رمز عبور حساب شکن را وارد کنید.", 400);
  const trimmedPassword = password.trim();
  let result = await shecanRequest("/api/auth/login", { method: "POST", body: { identifier, password: trimmedPassword } });
  // This is the same trimmed-password then original-password behavior as the official desktop app.
  if (!result.ok && result.status !== 429 && trimmedPassword !== password) {
    result = await shecanRequest("/api/auth/login", { method: "POST", body: { identifier, password } });
  }
  if (!result.ok) {
    if (result.status === 401 || result.status === 403 || result.status === 400) {
      throw new ShecanAccountError("نام کاربری یا رمز عبور شکن پذیرفته نشد؛ اطلاعات را بررسی کنید. هیچ رمزی ذخیره نشد.", 401);
    }
    if (result.status === 429) throw new ShecanAccountError("شکن موقتاً تعداد تلاش‌های ورود را محدود کرده است؛ کمی بعد دوباره تلاش کنید.", 429);
    throw new ShecanAccountError(`ورود به حساب شکن ناموفق بود (HTTP ${result.status})؛ رمز ذخیره نشد.`, 502);
  }
  const apiKey = (result.data as { api_key?: unknown } | null)?.api_key;
  if (typeof apiKey !== "string" || !/^[A-Za-z0-9]{20,64}$/.test(apiKey)) {
    throw new ShecanAccountError("پاسخ رسمی ورود، کلید حساب معتبر نداشت؛ رمز یا پاسخ حساب ذخیره نشد.", 502);
  }
  const identity = await loadIdentity(apiKey);
  const orders = await loadOrders(apiKey);
  await persistLogin(identity, apiKey, pickOfficialOrder(orders), userId, true);
  return { orders: orders.map(publicOrder) };
}

export async function refreshShecanOrders(userId: string): Promise<{ orders: ShecanOrderPublic[] }> {
  const { key } = await storedAccountKey();
  const identity = await loadIdentity(key);
  const orders = await loadOrders(key);
  const now = new Date().toISOString();
  (await import("./db")).getDb().prepare("UPDATE api_network_settings SET account_login=?, account_name=?, updated_at=?, updated_by=? WHERE id=1")
    .run(identity.login, identity.name, now, userId);
  return { orders: orders.map(publicOrder) };
}

export async function selectShecanOrder(orderId: number, userId: string): Promise<{ orders: ShecanOrderPublic[] }> {
  if (!Number.isSafeInteger(orderId) || orderId <= 0) throw new ShecanAccountError("سرویس معتبر را انتخاب کنید.", 400);
  const { key } = await storedAccountKey();
  const identity = await loadIdentity(key);
  const orders = await loadOrders(key);
  const selected = orders.find((order) => order.id === orderId);
  if (!selected) throw new ShecanAccountError("این سرویس در حساب شکن پیدا نشد؛ فهرست را به‌روزرسانی کنید.", 404);
  buildUpdateUrl(selected);
  await persistLogin(identity, key, selected, userId, false);
  return { orders: orders.map(publicOrder) };
}

export async function logoutShecanAccount(userId: string): Promise<void> {
  const now = new Date().toISOString();
  (await import("./db")).getDb().prepare(`UPDATE api_network_settings SET encrypted_account_key='', account_login='', account_name='',
    account_authenticated_at=NULL, selected_order_id=NULL, selected_order_label='', selected_order_due='',
    update_url_source='manual', updated_at=?, updated_by=? WHERE id=1`).run(now, userId);
}
