// A short, in-memory record of recent provider failures for the admin panel.
//
// "It worked, then it broke again" was unanswerable because the only trace was a
// teacher-facing sentence that deliberately hides details. The administrator needs
// the opposite: the code, the moment, which model, and whether the failure was a
// network outage or an account problem.
//
// Nothing here touches disk, and no API key is ever recorded.

export interface ProviderFailure {
  at: string;
  hostname: string;
  model: string;
  provider: string;
  code: string;
  /** A short, key-free excerpt of the upstream or transport message. */
  detail: string;
  attempt: number;
}

const MAX_ENTRIES = 40;

const globalStore = globalThis as typeof globalThis & { __nomrehProviderFailures?: ProviderFailure[] };
const failures = globalStore.__nomrehProviderFailures || [];
globalStore.__nomrehProviderFailures = failures;

/** Strips anything that could be a secret before storing a message. */
export function scrubSecret(text: string): string {
  return String(text)
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, "[کلید]")
    .replace(/AIza[A-Za-z0-9_-]{10,}/g, "[کلید]")
    .replace(/Bearer\s+[A-Za-z0-9._-]{10,}/gi, "Bearer [کلید]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

export function recordProviderFailure(entry: Omit<ProviderFailure, "at">): void {
  failures.unshift({ ...entry, detail: scrubSecret(entry.detail), at: new Date().toISOString() });
  if (failures.length > MAX_ENTRIES) failures.length = MAX_ENTRIES;
}

export function recentProviderFailures(): ProviderFailure[] {
  return [...failures];
}

export function clearProviderFailures(): void {
  failures.length = 0;
}

// Tracks consecutive failures per provider so the panel can show "3 in a row"
// without reading logs.
const streaks = (globalStore as typeof globalThis & { __nomrehProviderStreak?: Map<string, number> }).__nomrehProviderStreak || new Map<string, number>();
(globalStore as typeof globalThis & { __nomrehProviderStreak?: Map<string, number> }).__nomrehProviderStreak = streaks;

export function noteProviderOutcome(provider: string, ok: boolean): void {
  streaks.set(provider, ok ? 0 : (streaks.get(provider) || 0) + 1);
}

export function providerStreaks(): Array<{ provider: string; consecutiveFailures: number }> {
  return [...streaks.entries()].map(([provider, count]) => ({ provider, consecutiveFailures: count }));
}
