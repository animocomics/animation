import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { cloudflareFirst, cloudflareRun, getCloudflareDb, isCloudflareRuntime } from "./cloudflare";
import type { ProviderId, ProviderPublicStatus } from "@/lib/types";
import { DEFAULT_MODELS, PROVIDER_LABELS } from "./providers";

interface ProviderRow {
  provider: ProviderId;
  model: string;
  encrypted_api_key: string;
  key_hint: string;
  updated_at: string;
}

async function encryptionKey(): Promise<Buffer> {
  const configured = process.env.NOMREH_SECRET_KEY;
  if (configured) return createHash("sha256").update(configured).digest();
  if (isCloudflareRuntime()) throw new Error("NOMREH_SECRET_KEY برای رمزنگاری کلید سرویس‌دهنده تنظیم نشده است.");
  const [{ readFileSync, writeFileSync }, { default: path }, { DATA_DIRECTORY }] = await Promise.all([import("fs"), import("path"), import("./db")]);
  const keyPath = path.join(DATA_DIRECTORY, ".provider-secret");
  try {
    return Buffer.from(readFileSync(keyPath, "utf8").trim(), "hex");
  } catch {
    const key = randomBytes(32);
    writeFileSync(keyPath, key.toString("hex"), { mode: 0o600 });
    return key;
  }
}

async function encrypt(value: string): Promise<string> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", await encryptionKey(), iv);
  cipher.setAAD(Buffer.from("nomreh-provider-v1"));
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
}

async function decrypt(payload: string): Promise<string> {
  const [iv, tag, encrypted] = payload.split(".");
  if (!iv || !tag || !encrypted) throw new Error("فرمت کلید ذخیره‌شده معتبر نیست.");
  const decipher = createDecipheriv("aes-256-gcm", await encryptionKey(), Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from("nomreh-provider-v1"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
}

async function findProviderRow(): Promise<ProviderRow | undefined> {
  const cloud = await getCloudflareDb();
  return cloud
    ? cloudflareFirst<ProviderRow>(cloud, "SELECT * FROM provider_settings WHERE id = 1")
    : (await import("./db")).getDb().prepare("SELECT * FROM provider_settings WHERE id = 1").get() as ProviderRow | undefined;
}

export async function getProviderStatus(includeKeyHint = false): Promise<ProviderPublicStatus> {
  const row = await findProviderRow();
  if (!row) return { configured: false, provider: "openai", model: DEFAULT_MODELS.openai, providerLabel: PROVIDER_LABELS.openai };
  return {
    configured: Boolean(row.encrypted_api_key),
    provider: row.provider,
    model: row.model,
    providerLabel: PROVIDER_LABELS[row.provider],
    keyHint: includeKeyHint ? row.key_hint || undefined : undefined,
    updatedAt: row.updated_at,
  };
}

export async function getProviderConfig(): Promise<{ provider: ProviderId; model: string; apiKey: string }> {
  const row = await findProviderRow();
  if (!row?.encrypted_api_key) throw new Error("اتصال هوش مصنوعی هنوز توسط مدیر سامانه پیکربندی نشده است.");
  return { provider: row.provider, model: row.model, apiKey: await decrypt(row.encrypted_api_key) };
}

export async function saveProviderConfig(input: { provider: ProviderId; model?: string; apiKey?: string }, userId: string): Promise<ProviderPublicStatus> {
  if (!["openai", "gemini", "deepseek", "zai"].includes(input.provider)) throw new Error("ارائه‌دهنده انتخاب‌شده معتبر نیست.");
  const previous = await findProviderRow();
  const providerChanged = previous && previous.provider !== input.provider;
  const apiKey = input.apiKey?.trim() || (!providerChanged && previous ? await decrypt(previous.encrypted_api_key) : "");
  if (!apiKey) throw new Error("کلید API را وارد کنید.");
  if (apiKey.length < 12) throw new Error("کلید API کوتاه‌تر از حد انتظار است.");
  const model = input.model?.trim() || DEFAULT_MODELS[input.provider];
  const hint = `•••• ${apiKey.slice(-4)}`;
  const values = [input.provider, model, await encrypt(apiKey), hint, new Date().toISOString(), userId];
  const cloud = await getCloudflareDb();
  const sql = `INSERT INTO provider_settings (id, provider, model, encrypted_api_key, key_hint, updated_at, updated_by)
    VALUES (1, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET provider=excluded.provider, model=excluded.model,
      encrypted_api_key=excluded.encrypted_api_key, key_hint=excluded.key_hint,
      updated_at=excluded.updated_at, updated_by=excluded.updated_by`;
  if (cloud) await cloudflareRun(cloud, sql, values);
  else (await import("./db")).getDb().prepare(sql).run(...values);
  return getProviderStatus(true);
}
