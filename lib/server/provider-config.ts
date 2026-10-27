import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { DATA_DIRECTORY, getDb } from "./db";
import type { ProviderId, ProviderPublicStatus } from "@/lib/types";
import { DEFAULT_MODELS, PROVIDER_LABELS } from "./providers";

interface ProviderRow {
  provider: ProviderId;
  model: string;
  encrypted_api_key: string;
  key_hint: string;
  updated_at: string;
}

function encryptionKey(): Buffer {
  const configured = process.env.NOMREH_SECRET_KEY;
  if (configured) return createHash("sha256").update(configured).digest();
  const keyPath = path.join(DATA_DIRECTORY, ".provider-secret");
  try {
    return Buffer.from(readFileSync(keyPath, "utf8").trim(), "hex");
  } catch {
    const key = randomBytes(32);
    writeFileSync(keyPath, key.toString("hex"), { mode: 0o600 });
    return key;
  }
}

function encrypt(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from("nomreh-provider-v1"));
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
}

function decrypt(payload: string): string {
  const [iv, tag, encrypted] = payload.split(".");
  if (!iv || !tag || !encrypted) throw new Error("فرمت کلید ذخیره‌شده معتبر نیست.");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from("nomreh-provider-v1"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
}

export function getProviderStatus(includeKeyHint = false): ProviderPublicStatus {
  const row = getDb().prepare("SELECT * FROM provider_settings WHERE id = 1").get() as ProviderRow | undefined;
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

export function getProviderConfig(): { provider: ProviderId; model: string; apiKey: string } {
  const row = getDb().prepare("SELECT * FROM provider_settings WHERE id = 1").get() as ProviderRow | undefined;
  if (!row?.encrypted_api_key) throw new Error("اتصال هوش مصنوعی هنوز توسط مدیر سامانه پیکربندی نشده است.");
  return { provider: row.provider, model: row.model, apiKey: decrypt(row.encrypted_api_key) };
}

export function saveProviderConfig(input: { provider: ProviderId; model?: string; apiKey?: string }, userId: string): ProviderPublicStatus {
  if (!["openai", "gemini", "deepseek"].includes(input.provider)) throw new Error("ارائه‌دهنده انتخاب‌شده معتبر نیست.");
  const previous = getDb().prepare("SELECT * FROM provider_settings WHERE id = 1").get() as ProviderRow | undefined;
  const providerChanged = previous && previous.provider !== input.provider;
  const apiKey = input.apiKey?.trim() || (!providerChanged && previous ? decrypt(previous.encrypted_api_key) : "");
  if (!apiKey) throw new Error("کلید API را وارد کنید.");
  if (apiKey.length < 12) throw new Error("کلید API کوتاه‌تر از حد انتظار است.");
  const model = input.model?.trim() || DEFAULT_MODELS[input.provider];
  const hint = `•••• ${apiKey.slice(-4)}`;
  getDb().prepare(`INSERT INTO provider_settings (id, provider, model, encrypted_api_key, key_hint, updated_at, updated_by)
    VALUES (1, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET provider=excluded.provider, model=excluded.model,
      encrypted_api_key=excluded.encrypted_api_key, key_hint=excluded.key_hint,
      updated_at=excluded.updated_at, updated_by=excluded.updated_by`).run(
    input.provider,
    model,
    encrypt(apiKey),
    hint,
    new Date().toISOString(),
    userId,
  );
  return getProviderStatus(true);
}
