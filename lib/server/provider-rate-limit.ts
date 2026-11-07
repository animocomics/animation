// Hard ceiling on outbound provider traffic.
//
// The hosting provider blocks a subscription's outbound traffic when more than
// 200 requests reach a single destination inside 20 minutes. That happened once
// already: a relay polled in a tight loop and 3612 requests hit one address, so
// the whole server lost egress and every AI call failed with a network error that
// looked like a broken key.
//
// A retry loop must never be able to do that again. Every provider request passes
// through this gate, which enforces:
//   - a sliding-window cap well below the provider's threshold
//   - a hard concurrency limit, so a batch cannot fan out
//   - a circuit breaker that stops hammering a dead destination
//
// Everything here is in-process and cheap; nothing is written to disk.

const WINDOW_MS = 20 * 60 * 1000;
// Kept at 60% of the 200/20min limit so other site traffic (fonts, assets, mail)
// shares the same per-IP budget without tripping the provider's rule.
const MAX_PER_WINDOW = 120;
const MAX_CONCURRENCY = 2;
const BREAKER_THRESHOLD = 5;
const BREAKER_COOLDOWN_MS = 10 * 60 * 1000;

interface HostState {
  hits: number[];
  active: number;
  failures: number;
  openUntil: number;
}

const hosts = new Map<string, HostState>();

function stateFor(hostname: string): HostState {
  let state = hosts.get(hostname);
  if (!state) {
    state = { hits: [], active: 0, failures: 0, openUntil: 0 };
    hosts.set(hostname, state);
  }
  return state;
}

export class ProviderRateLimitError extends Error {
  readonly code: string;
  readonly retryAfterMs: number;

  constructor(message: string, code: string, retryAfterMs = 0) {
    super(message);
    this.name = "ProviderRateLimitError";
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface RateLimitSnapshot {
  hostname: string;
  used: number;
  limit: number;
  remaining: number;
  windowMinutes: number;
  active: number;
  breakerOpen: boolean;
  breakerMinutesLeft: number;
  failures: number;
  /** When the oldest request in the window ages out and frees a slot. */
  nextSlotInSeconds: number;
  /** Requests used per whole window, so the operator can see the burn rate. */
  percentUsed: number;
}

/** Every host that has been called, for the admin counter. */
export function providerBudgetAll(): RateLimitSnapshot[] {
  return providerBudgetSnapshot([...hosts.keys()]);
}

function prune(state: HostState, now: number): void {
  const cutoff = now - WINDOW_MS;
  while (state.hits.length && state.hits[0] < cutoff) state.hits.shift();
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Runs `task` under the budget. Throws ProviderRateLimitError with a human message
// before the request is attempted if the window or the breaker forbids it.
export async function withProviderBudget<T>(hostname: string, task: () => Promise<T>): Promise<T> {
  const state = stateFor(hostname);
  const now = Date.now();
  prune(state, now);

  if (state.openUntil > now) {
    const minutes = Math.ceil((state.openUntil - now) / 60_000);
    throw new ProviderRateLimitError(
      `ارتباط با ${hostname} موقتاً متوقف شده است: چند تلاش پیاپی شکست خورد و برای جلوگیری از مسدودشدن سرور، تا ${minutes} دقیقهٔ دیگر درخواستی ارسال نمی‌شود.`,
      "PROVIDER_BREAKER_OPEN",
      state.openUntil - now,
    );
  }

  if (state.hits.length >= MAX_PER_WINDOW) {
    const retry = state.hits[0] + WINDOW_MS - now;
    throw new ProviderRateLimitError(
      `سقف مجاز درخواست به ${hostname} در ۲۰ دقیقه پر شده است (${MAX_PER_WINDOW} درخواست). برای جلوگیری از مسدودشدن خروجی سرور، ${Math.ceil(retry / 60_000)} دقیقهٔ دیگر تلاش کنید.`,
      "PROVIDER_RATE_LIMITED",
      retry,
    );
  }

  // Queue behind the concurrency cap rather than fanning out.
  let waited = 0;
  while (state.active >= MAX_CONCURRENCY && waited < 30_000) {
    await wait(200);
    waited += 200;
  }

  state.active += 1;
  state.hits.push(now);
  try {
    const result = await task();
    state.failures = 0;
    return result;
  } catch (error) {
    // Only network-shaped failures open the breaker; an HTTP 4xx from an upstream
    // that answered is not a reason to stop talking to it.
    const code = (error as { code?: string; cause?: { code?: string } })?.code || (error as { cause?: { code?: string } })?.cause?.code || "";
    const networkish = /^(UND_ERR|ECONN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|ENOTFOUND)/.test(code);
    if (networkish) {
      state.failures += 1;
      if (state.failures >= BREAKER_THRESHOLD) {
        state.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
        state.failures = 0;
      }
    }
    throw error;
  } finally {
    state.active = Math.max(0, state.active - 1);
  }
}

export function providerBudgetSnapshot(hostnames: string[]): RateLimitSnapshot[] {
  const now = Date.now();
  return hostnames.map((hostname) => {
    const state = stateFor(hostname);
    prune(state, now);
    const used = state.hits.length;
    return {
      hostname,
      used,
      limit: MAX_PER_WINDOW,
      remaining: Math.max(0, MAX_PER_WINDOW - used),
      windowMinutes: WINDOW_MS / 60_000,
      active: state.active,
      breakerOpen: state.openUntil > now,
      breakerMinutesLeft: state.openUntil > now ? Math.ceil((state.openUntil - now) / 60_000) : 0,
      failures: state.failures,
      nextSlotInSeconds: used > 0 ? Math.max(0, Math.round((state.hits[0] + WINDOW_MS - now) / 1000)) : 0,
      percentUsed: Math.round((used / MAX_PER_WINDOW) * 100),
    };
  });
}

export const PROVIDER_BUDGET = { windowMs: WINDOW_MS, maxPerWindow: MAX_PER_WINDOW, maxConcurrency: MAX_CONCURRENCY };
