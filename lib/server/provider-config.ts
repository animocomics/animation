import type { ProviderId, ProviderPublicStatus } from "@/lib/types";
import { ApiNetworkError, ensureApiNetworkActivated, getApiNetworkConfig, type ProviderNetworkConfig } from "./api-network";
import { DEFAULT_MODELS, PROVIDER_LABELS, ProviderError } from "./providers";
import { decryptSecret, encryptSecret } from "./secret-crypto";
import type { KayaEgressConfig } from "./kaya-egress";

const PROVIDER_SECRET_PURPOSE = "nomreh-provider-v1";

interface ProviderRow {
  provider: ProviderId;
  model: string;
  encrypted_api_key: string;
  key_hint: string;
  updated_at: string;
}

async function findProviderRow(): Promise<ProviderRow | undefined> {
  return (await import("./db")).getDb().prepare("SELECT * FROM provider_settings WHERE id = 1").get() as ProviderRow | undefined;
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

export async function getProviderNetworkConfig(): Promise<ProviderNetworkConfig> {
  try {
    const { getV2RayNetworkConfig } = await import("./v2ray-runtime");
    const v2ray = await getV2RayNetworkConfig();
    if (v2ray) return v2ray;
    const network = await getApiNetworkConfig();
    if (network.enabled) await ensureApiNetworkActivated(network);
    return { enabled: network.enabled, plan: network.plan, servers: network.servers, transport: network.transport };
  } catch (error) {
    if (error instanceof ApiNetworkError) throw new ProviderError(error.message, error.status);
    throw error;
  }
}

export async function getProviderConfig(): Promise<{
  provider: ProviderId;
  model: string;
  apiKey: string;
  network: ProviderNetworkConfig;
  /** Source address and host override for Kaya, empty when unset. */
  egress: KayaEgressConfig;
}> {
  const [row, network] = await Promise.all([findProviderRow(), getProviderNetworkConfig()]);
  if (!row?.encrypted_api_key) throw new Error("اتصال هوش مصنوعی هنوز توسط مدیر سامانه پیکربندی نشده است.");
  // Read the egress setting on every call: it changes only when the operator
  // saves it, and a stale source address is exactly the failure it exists to fix.
  const { getKayaEgress } = await import("./kaya-egress-store");
  const egressStatus = await getKayaEgress();
  const egress: KayaEgressConfig = { bindAddress: egressStatus.bindAddress, host: egressStatus.host };
  return { provider: row.provider, model: row.model, apiKey: await decryptSecret(row.encrypted_api_key, PROVIDER_SECRET_PURPOSE), network, egress };
}

export async function disconnectProviderConfig(): Promise<ProviderPublicStatus> {
  (await import("./db")).getDb().prepare("DELETE FROM provider_settings WHERE id = 1").run();
  return getProviderStatus(true);
}

export async function saveProviderConfig(input: { provider: ProviderId; model?: string; apiKey?: string }, userId: string): Promise<ProviderPublicStatus> {
  if (!["openai", "gemini", "deepseek", "zai", "minimax", "inkling", "mistral", "kaya"].includes(input.provider)) throw new Error("ارائه‌دهنده انتخاب‌شده معتبر نیست.");
  const previous = await findProviderRow();
  const providerChanged = previous && previous.provider !== input.provider;
  const apiKey = input.apiKey?.trim() || (!providerChanged && previous ? await decryptSecret(previous.encrypted_api_key, PROVIDER_SECRET_PURPOSE) : "");
  if (!apiKey) throw new Error("کلید API را وارد کنید.");
  if (apiKey.length < 12) throw new Error("کلید API کوتاه‌تر از حد انتظار است.");
  const model = input.model?.trim() || DEFAULT_MODELS[input.provider];
  const hint = `•••• ${apiKey.slice(-4)}`;
  const values = [input.provider, model, await encryptSecret(apiKey, PROVIDER_SECRET_PURPOSE), hint, new Date().toISOString(), userId];
  const sql = `INSERT INTO provider_settings (id, provider, model, encrypted_api_key, key_hint, updated_at, updated_by)
    VALUES (1, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET provider=excluded.provider, model=excluded.model,
      encrypted_api_key=excluded.encrypted_api_key, key_hint=excluded.key_hint,
      updated_at=excluded.updated_at, updated_by=excluded.updated_by`;
  (await import("./db")).getDb().prepare(sql).run(...values);
  return getProviderStatus(true);
}
