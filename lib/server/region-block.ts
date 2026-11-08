/**
 * Remembers, per host, that a provider already refused this server by country.
 *
 * The operator reported spending credit on repeated Gemini attempts that Google
 * answered with "User location is not supported for the API use." Nothing about that
 * answer changes between attempts: the key, the model and the file are irrelevant, so
 * every retry is another billed no-op. The state is in-process on purpose — it is a
 * warning, not a rule, and a restart clears it.
 */

const blocked = new Map<string, { at: number; reason: string }>();

export function markRegionBlocked(provider: string, reason: string, now = Date.now()): void {
  blocked.set(provider, { at: now, reason });
}

export function regionBlockInfo(provider: string): { at: number; reason: string } | undefined {
  return blocked.get(provider);
}

/** Called after a successful call: the route works now, so the warning no longer applies. */
export function clearRegionBlocked(provider: string): void {
  blocked.delete(provider);
}

export function resetRegionBlocks(): void {
  blocked.clear();
}

/**
 * The sentence the panel shows next to a provider that already refused this server.
 * Returns null when there is nothing to warn about, so the caller stays simple.
 */
export function regionBlockWarning(provider: string, now = Date.now()): string | null {
  const info = blocked.get(provider);
  if (!info) return null;
  const minutes = Math.max(1, Math.round((now - info.at) / 60_000));
  return `این سرویس‌دهنده ${minutes} دقیقه پیش درخواست این سرور را از نظر کشور مبدأ رد کرد. تا وقتی مسیر خروجی عوض نشود، هر تلاش دوباره فقط هزینه است. (رفعش بدون تغییر کد: docs/gemini-relay-cloudflare-fa.md)`;
}
