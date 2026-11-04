import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { ProxyAgent } from "undici";
import { parseV2RayConfig, parseV2RayConfigList, type ParsedV2RayConfig, type V2RayProtocol } from "./v2ray-config";
import { decryptSecret, encryptSecret } from "./secret-crypto";

const CONFIG_PURPOSE = "nomreh-v2ray-config-v1";
const TEST_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const XRAY_VERSION = "v26.10.31";
const MAX_CONFIGS = 40;
const TEST_CONCURRENCY = 4;
const PROVIDER_DOMAINS = [
  "full:api.openai.com",
  "full:generativelanguage.googleapis.com",
  "full:api.deepseek.com",
  "full:api.z.ai",
  "full:api.minimax.io",
  "full:api.mistral.ai",
  "full:tinker.thinkingmachines.dev",
];

interface V2RayConfigRow {
  id: string;
  slot: number;
  protocol: V2RayProtocol;
  encrypted_config: string;
  fingerprint: string;
  last_test_status: "idle" | "testing" | "success" | "error";
  last_latency_ms?: number;
  last_tested_at?: string;
}

interface V2RaySettingsRow {
  enabled: number;
  selected_config_id?: string;
  last_test_status: "idle" | "testing" | "success" | "error";
  last_test_message: string;
  last_tested_at?: string;
  updated_at?: string;
}

interface RunningV2Ray {
  configId: string;
  child: ChildProcess;
  agent: ProxyAgent;
  configPath: string;
  closed: boolean;
}

interface V2RayJob {
  pending: boolean;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  promise: Promise<void>;
}

interface V2RayGlobal {
  __nomrehV2RayRuntime?: RunningV2Ray;
  __nomrehV2RayStart?: Promise<RunningV2Ray>;
  __nomrehV2RayJob?: V2RayJob;
}

const globalStore = globalThis as typeof globalThis & V2RayGlobal;

export class V2RayError extends Error {
  status: number;
  constructor(message: string, status = 502, options?: ErrorOptions) {
    super(message, options);
    this.name = "V2RayError";
    this.status = status;
  }
}

function db() {
  // Dynamic import avoids initializing the database during unit tests that only parse links.
  return import("./db").then(({ getDb }) => getDb());
}

function dataRoot(): string {
  return path.resolve(process.env.NOMREH_DATA_DIR || path.join(process.cwd(), "data"), "v2ray");
}

function corePath(): string {
  return path.resolve(process.env.NOMREH_XRAY_PATH || path.join(process.cwd(), "nomreh-v2ray", "xray"));
}

function assertRegularFile(file: string): void {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) throw new V2RayError("هستهٔ V2Ray روی سرور به‌صورت امن نصب نشده است.", 503);
}

async function assertCore(): Promise<void> {
  const binary = corePath();
  try {
    assertRegularFile(binary);
    const manifestPath = path.join(path.dirname(binary), "runtime-manifest.json");
    assertRegularFile(manifestPath);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { version?: string; sha256?: string };
    if (manifest.version !== XRAY_VERSION || !/^[a-f0-9]{64}$/.test(manifest.sha256 || "")) throw new Error("manifest");
    const actual = createHash("sha256").update(fs.readFileSync(binary)).digest("hex");
    if (actual !== manifest.sha256) throw new Error("hash");
  } catch (error) {
    if (error instanceof V2RayError) throw error;
    throw new V2RayError("هستهٔ Xray یا اثر انگشت آن معتبر نیست؛ بستهٔ سبک V2Ray را دوباره نصب کنید.", 503, { cause: error });
  }
}

async function rows(): Promise<V2RayConfigRow[]> {
  return (await db()).prepare("SELECT id,slot,protocol,encrypted_config,fingerprint,last_test_status,last_latency_ms,last_tested_at FROM v2ray_configs ORDER BY slot ASC").all() as V2RayConfigRow[];
}

async function settings(): Promise<V2RaySettingsRow | undefined> {
  return (await db()).prepare("SELECT enabled,selected_config_id,last_test_status,last_test_message,last_tested_at,updated_at FROM v2ray_settings WHERE id=1").get() as V2RaySettingsRow | undefined;
}

function publicConfig(row: V2RayConfigRow, selectedId?: string) {
  return {
    id: row.id,
    label: `کانفیگ ${row.slot}`,
    protocol: row.protocol,
    testStatus: row.last_test_status,
    latencyMs: row.last_latency_ms ?? undefined,
    selected: row.id === selectedId,
  };
}

export async function getV2RayStatus() {
  const [configRows, setting] = await Promise.all([rows(), settings()]);
  const job = globalStore.__nomrehV2RayJob;
  return {
    configured: configRows.length > 0,
    enabled: Boolean(setting?.enabled),
    running: Boolean(globalStore.__nomrehV2RayRuntime && !globalStore.__nomrehV2RayRuntime.closed),
    selectedId: setting?.selected_config_id || undefined,
    selectedLabel: setting?.selected_config_id ? configRows.find((row) => row.id === setting.selected_config_id)?.slot ? `کانفیگ ${configRows.find((row) => row.id === setting.selected_config_id)?.slot}` : undefined : undefined,
    lastTestStatus: setting?.last_test_status || "idle",
    lastTestMessage: setting?.last_test_message || "V2Ray خاموش است؛ برای فعال‌سازی، فهرست را ذخیره و تست خودکار را اجرا کنید.",
    lastTestedAt: setting?.last_tested_at || undefined,
    configs: configRows.map((row) => publicConfig(row, setting?.selected_config_id)),
    pending: Boolean(job?.pending),
    jobError: job?.error,
    jobStartedAt: job?.startedAt,
    jobFinishedAt: job?.finishedAt,
  };
}

async function decryptRow(row: V2RayConfigRow): Promise<ParsedV2RayConfig> {
  const value = await decryptSecret(row.encrypted_config, CONFIG_PURPOSE);
  return parseV2RayConfig(value);
}

async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) throw new V2RayError("پورت محلی امن برای Xray پیدا نشد.", 503);
  return port;
}

function xrayConfig(parsed: ParsedV2RayConfig, port: number, user: string, pass: string): string {
  const outbound = { ...parsed.outbound, tag: "nomreh-ai" };
  return JSON.stringify({
    log: { loglevel: "none" },
    inbounds: [{
      tag: "nomreh-loopback-only",
      listen: "127.0.0.1",
      port,
      protocol: "http",
      settings: { accounts: [{ user, pass }], timeout: 60, allowTransparent: false },
    }],
    outbounds: [
      { protocol: "blackhole", tag: "nomreh-blocked", settings: {} },
      outbound,
    ],
    routing: {
      domainStrategy: "AsIs",
      rules: [{ type: "field", network: "tcp", domain: PROVIDER_DOMAINS, outboundTag: "nomreh-ai" }],
    },
  });
}

async function startXray(row: V2RayConfigRow): Promise<RunningV2Ray> {
  await assertCore();
  const parsed = await decryptRow(row);
  const port = await reservePort();
  const user = randomBytes(18).toString("base64url");
  const pass = randomBytes(24).toString("base64url");
  const root = dataRoot();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const configPath = path.join(root, `runtime-${randomUUID()}.json`);
  fs.writeFileSync(configPath, xrayConfig(parsed, port, user, pass), { mode: 0o600 });
  const child = spawn(corePath(), ["run", "-config", configPath], {
    cwd: path.dirname(corePath()),
    env: {
      // Do not pass provider keys, the Nomreh encryption key or session
      // material to a child process that only needs a network namespace-free
      // loopback proxy. The Xray binary is statically linked.
      PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
      HOME: root,
      TMPDIR: process.env.TMPDIR || "/tmp",
      NODE_ENV: process.env.NODE_ENV || "production",
    },
    stdio: "ignore",
  });
  const token = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
  const agent = new ProxyAgent({
    uri: `http://127.0.0.1:${port}`,
    token,
    connect: { timeout: 12_000 },
    requestTls: { timeout: 12_000 },
  });
  const running: RunningV2Ray = { configId: row.id, child, agent, configPath, closed: false };
  child.once("error", () => { running.closed = true; });
  child.once("exit", () => {
    running.closed = true;
    fs.rmSync(configPath, { force: true });
    if (globalStore.__nomrehV2RayRuntime === running) delete globalStore.__nomrehV2RayRuntime;
  });
  return running;
}

async function stopXray(running: RunningV2Ray | undefined): Promise<void> {
  if (!running) return;
  running.closed = true;
  if (globalStore.__nomrehV2RayRuntime === running) delete globalStore.__nomrehV2RayRuntime;
  await running.agent.close().catch(() => undefined);
  if (running.child.exitCode === null && !running.child.killed) running.child.kill("SIGTERM");
  fs.rmSync(running.configPath, { force: true });
}

async function boundedResponseText(response: Response, maximum = 100_000): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (total < maximum) {
      const next = await reader.read();
      if (next.done) break;
      if (!next.value) continue;
      const chunk = Buffer.from(next.value);
      chunks.push(chunk);
      total += chunk.byteLength;
      if (total >= maximum) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).subarray(0, maximum).toString("utf8");
}

async function probeAgent(agent: ProxyAgent, timeoutMs = 12_000): Promise<number> {
  const started = Date.now();
  const response = await fetch(TEST_URL, {
    cache: "no-store",
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { Accept: "application/json" },
    dispatcher: agent,
  } as RequestInit);
  const text = await boundedResponseText(response);
  const contentType = response.headers.get("content-type") || "";
  if (!/json/i.test(contentType)) throw new Error("PROVIDER_PROBE_NOT_JSON");
  let payload: { error?: { message?: unknown; status?: unknown }; models?: unknown };
  try { payload = text ? JSON.parse(text) as typeof payload : {}; }
  catch { throw new Error("PROVIDER_PROBE_INVALID_JSON"); }
  const providerMessage = typeof payload.error?.message === "string" ? payload.error.message : "";
  // A real Gemini endpoint without a key returns a structured API-key error;
  // an arbitrary proxy/block page or generic JSON response is not a pass.
  const expectedKeyResponse = [400, 401, 403].includes(response.status)
    && Boolean(payload.error) && /api[ _-]?key|کلید/i.test(providerMessage);
  const successfulModelResponse = response.ok && Array.isArray(payload.models);
  if (!successfulModelResponse && !expectedKeyResponse) throw new Error("PROVIDER_PROBE_FAILED");
  return Date.now() - started;
}

async function testRow(row: V2RayConfigRow): Promise<number> {
  const running = await startXray(row);
  try {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (running.closed) throw new Error("XRAY_EXITED");
      try { return await probeAgent(running.agent); }
      catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 250)); }
    }
    throw lastError instanceof Error ? lastError : new Error("V2RAY_PROBE_FAILED");
  } finally {
    await stopXray(running);
  }
}

async function mapLimit<T, R>(values: T[], limit: number, worker: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  async function consume(): Promise<void> {
    while (next < values.length) {
      const index = next++;
      results[index] = await worker(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, consume));
  return results;
}

async function updateSetting(values: { enabled?: boolean; selectedId?: string | null; status?: string; message?: string; testedAt?: string | null; userId?: string }): Promise<void> {
  const database = await db();
  const current = await settings();
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO v2ray_settings (id,enabled,selected_config_id,last_test_status,last_test_message,last_tested_at,updated_at,updated_by)
    VALUES (1,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,selected_config_id=excluded.selected_config_id,
      last_test_status=excluded.last_test_status,last_test_message=excluded.last_test_message,last_tested_at=excluded.last_tested_at,
      updated_at=excluded.updated_at,updated_by=excluded.updated_by`).run(
    values.enabled === undefined ? (current?.enabled ? 1 : 0) : values.enabled ? 1 : 0,
    values.selectedId === undefined ? current?.selected_config_id || null : values.selectedId,
    values.status || current?.last_test_status || "idle",
    values.message ?? current?.last_test_message ?? "",
    values.testedAt === undefined ? current?.last_tested_at || null : values.testedAt,
    now,
    values.userId || null,
  );
}

export async function saveV2RayConfigs(input: string, userId: string): Promise<void> {
  const parsed = parseV2RayConfigList(input, MAX_CONFIGS);
  const database = await db();
  const now = new Date().toISOString();
  const encrypted = await Promise.all(parsed.map(async (item) => ({
    item,
    id: randomUUID(),
    fingerprint: createHash("sha256").update(JSON.stringify(item.outbound)).digest("hex"),
    encrypted: await encryptSecret(item.normalized, CONFIG_PURPOSE),
  })));
  await stopXray(globalStore.__nomrehV2RayRuntime);
  const replace = database.transaction(() => {
    database.prepare("UPDATE v2ray_settings SET enabled=0,selected_config_id=NULL WHERE id=1").run();
    database.prepare("DELETE FROM v2ray_configs").run();
    for (const [index, entry] of encrypted.entries()) {
      database.prepare(`INSERT INTO v2ray_configs (id,slot,protocol,encrypted_config,fingerprint,last_test_status,created_at,updated_at)
        VALUES (?,?,?,?,?,'idle',?,?)`).run(entry.id, index + 1, entry.item.protocol, entry.encrypted, entry.fingerprint, now, now);
    }
    database.prepare(`INSERT INTO v2ray_settings (id,enabled,selected_config_id,last_test_status,last_test_message,updated_at,updated_by)
      VALUES (1,0,NULL,'idle',?,?,?) ON CONFLICT(id) DO UPDATE SET enabled=0,selected_config_id=NULL,last_test_status='idle',last_test_message=excluded.last_test_message,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
      .run("فهرست کانفیگ‌ها رمزنگاری و ذخیره شد؛ تست خودکار هنوز اجرا نشده است.", now, userId);
  });
  replace();
}

async function activate(userId: string): Promise<void> {
  const configRows = await rows();
  if (!configRows.length) throw new V2RayError("ابتدا حداقل یک کانفیگ معتبر ذخیره کنید.", 400);
  const startedAt = new Date().toISOString();
  await updateSetting({ enabled: false, selectedId: null, status: "testing", message: "تست خودکار کانفیگ‌ها در حال اجراست؛ هیچ درخواست AI از مسیر مستقیم ارسال نمی‌شود.", testedAt: startedAt, userId });
  await stopXray(globalStore.__nomrehV2RayRuntime);
  const results = await mapLimit(configRows, TEST_CONCURRENCY, async (row) => {
    await db().then((database) => database.prepare("UPDATE v2ray_configs SET last_test_status='testing' WHERE id=?").run(row.id));
    try {
      const latency = await testRow(row);
      const testedAt = new Date().toISOString();
      await db().then((database) => database.prepare("UPDATE v2ray_configs SET last_test_status='success',last_latency_ms=?,last_tested_at=?,updated_at=? WHERE id=?").run(latency, testedAt, testedAt, row.id));
      return { row, latency };
    } catch {
      const testedAt = new Date().toISOString();
      await db().then((database) => database.prepare("UPDATE v2ray_configs SET last_test_status='error',last_latency_ms=NULL,last_tested_at=?,updated_at=? WHERE id=?").run(testedAt, testedAt, row.id));
      return { row, latency: 0 };
    }
  });
  const healthy = results.filter((result) => result.latency > 0).sort((a, b) => a.latency - b.latency);
  let selected: RunningV2Ray | undefined;
  let selectedRow: V2RayConfigRow | undefined;
  for (const candidate of healthy) {
    let running: RunningV2Ray | undefined;
    try {
      running = await startXray(candidate.row);
      await probeAgent(running.agent);
      selected = running;
      selectedRow = candidate.row;
      break;
    } catch {
      await stopXray(running);
      selected = undefined;
    }
  }
  if (!selected || !selectedRow) {
    await updateSetting({ enabled: false, selectedId: null, status: "error", message: "هیچ‌کدام از کانفیگ‌ها اتصال معتبر به Google Gemini برقرار نکرد؛ V2Ray فعال نشد و جزئیات محرمانه ثبت نشد.", testedAt: new Date().toISOString(), userId });
    throw new V2RayError("هیچ‌کدام از کانفیگ‌های V2Ray تست اتصال AI را قبول نکرد؛ کانفیگ‌ها و دسترسی سرور را بررسی کنید.", 502);
  }
  globalStore.__nomrehV2RayRuntime = selected;
  const testedAt = new Date().toISOString();
  await updateSetting({ enabled: true, selectedId: selectedRow.id, status: "success", message: `اتصال V2Ray فعال شد؛ کانفیگ ${selectedRow.slot} با تست واقعی Gemini انتخاب شد و سایر کانفیگ‌ها برای failover آماده‌اند.`, testedAt, userId });
  // Selecting V2Ray is an explicit alternative to Shecan. Preserve Shecan's
  // encrypted settings, but make the mutually-exclusive runtime choice clear.
  await db().then((database) => database.prepare("UPDATE api_network_settings SET enabled=0 WHERE id=1").run());
}

export function startV2RayActivation(input: { configs?: string }, userId: string) {
  const current = globalStore.__nomrehV2RayJob;
  if (current?.pending) return current;
  const job: V2RayJob = { pending: true, startedAt: new Date().toISOString(), promise: Promise.resolve() };
  globalStore.__nomrehV2RayJob = job;
  job.promise = (async () => {
    try {
      if (input.configs?.trim()) await saveV2RayConfigs(input.configs, userId);
      await activate(userId);
      job.error = undefined;
    } catch (error) {
      job.error = error instanceof Error ? error.message : "تست V2Ray ناموفق بود.";
      throw error;
    } finally {
      job.pending = false;
      job.finishedAt = new Date().toISOString();
    }
  })();
  // The API deliberately polls this job; an unhandled rejection must not kill Node.
  job.promise.catch(() => undefined);
  return job;
}

export async function disableV2Ray(userId: string): Promise<void> {
  await stopXray(globalStore.__nomrehV2RayRuntime);
  await updateSetting({ enabled: false, status: "idle", message: "V2Ray خاموش است؛ کانفیگ‌های رمزنگاری‌شده حفظ شدند.", userId });
}

export async function clearV2RayConfigs(userId: string): Promise<void> {
  await stopXray(globalStore.__nomrehV2RayRuntime);
  const database = await db();
  const clear = database.transaction(() => {
    database.prepare("DELETE FROM v2ray_configs").run();
    database.prepare("UPDATE v2ray_settings SET enabled=0,selected_config_id=NULL,last_test_status='idle',last_test_message='فهرست V2Ray حذف شد.',updated_at=?,updated_by=? WHERE id=1").run(new Date().toISOString(), userId);
  });
  clear();
}

export async function getV2RayNetworkConfig(): Promise<{ enabled: true; transport: "v2ray"; plan: "pro"; servers: [string, string] } | null> {
  const setting = await settings();
  if (!setting?.enabled || !setting.selected_config_id) return null;
  return { enabled: true, transport: "v2ray", plan: "pro", servers: ["178.22.122.101", "185.51.200.1"] };
}

async function ensureRunning(): Promise<RunningV2Ray> {
  const current = globalStore.__nomrehV2RayRuntime;
  if (current && !current.closed) return current;
  if (globalStore.__nomrehV2RayStart) return globalStore.__nomrehV2RayStart;
  const promise = (async () => {
    const setting = await settings();
    if (!setting?.enabled) throw new V2RayError("V2Ray فعال نیست؛ ابتدا تست و فعال‌سازی را در مدیریت اجرا کنید.", 503);
    const configRows = await rows();
    const ordered = [...configRows].sort((a, b) => {
      if (a.id === setting.selected_config_id) return -1;
      if (b.id === setting.selected_config_id) return 1;
      return (a.last_latency_ms || 999999) - (b.last_latency_ms || 999999);
    });
    for (const row of ordered) {
      let running: RunningV2Ray | undefined;
      try {
        running = await startXray(row);
        await probeAgent(running.agent);
        globalStore.__nomrehV2RayRuntime = running;
        if (row.id !== setting.selected_config_id) await updateSetting({ selectedId: row.id, status: "success", message: `failover خودکار به کانفیگ ${row.slot} انجام شد.` });
        return running;
      } catch {
        await stopXray(running);
        /* Try the next saved config; never use a direct provider route. */
      }
    }
    throw new V2RayError("هیچ کانفیگ V2Ray سالمی برای مسیر AI در دسترس نیست؛ درخواست مستقیم ارسال نشد.", 502);
  })();
  globalStore.__nomrehV2RayStart = promise;
  try { return await promise; }
  finally { if (globalStore.__nomrehV2RayStart === promise) delete globalStore.__nomrehV2RayStart; }
}

export async function v2rayProviderFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const running = await ensureRunning();
  try {
    return await fetch(url, { ...init, dispatcher: running.agent } as RequestInit);
  } catch (error) {
    await stopXray(running);
    throw new V2RayError("اتصال V2Ray هنگام درخواست AI قطع شد؛ درخواست به‌صورت مستقیم ارسال نشد و درخواست بعدی failover می‌کند.", 502, { cause: error });
  }
}

export async function resumeV2RayIfEnabled(): Promise<void> {
  const setting = await settings().catch(() => undefined);
  if (setting?.enabled) await ensureRunning().then(() => undefined).catch(() => undefined);
}
