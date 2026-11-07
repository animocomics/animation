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

import { createOutboundWindow } from "./outbound-window";
import { DATA_DIRECTORY } from "./db";

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

/**
 * The ceiling that actually matters.
 *
 * The hosting provider blocks the whole subscription, not one API: 200 requests to
 * anything inside 20 minutes and the server loses egress. The per-host counter
 * below could not enforce that — two destinations at 120 each is 240 — so every
 * request also passes a single server-wide window, kept in the data directory so
 * that a second Next.js worker, a console script, or the admin's own test spends
 * from the same budget.
 */
// 120, not 200: the other 80 slots belong to the rest of the site's traffic, which
// shares the same per-IP allowance at the hosting provider.
const SERVER_WIDE_MAX = (() => {
  // Tests exercise the provider path dozens of times; they must not consume a
  // real 20-minute window. `npm test` sets NOMREH_OUTBOUND_WINDOW_LIMIT for that
  // reason only; the production launcher never sets it, and the app never reads it
  // from the database or the panel.
  const override = Number(process.env.NOMREH_OUTBOUND_WINDOW_LIMIT || "");
  if (Number.isInteger(override) && override > 0) return override;
  return 120;
})();
const serverWindow = createOutboundWindow({
  dataDirectory: DATA_DIRECTORY,
  max: SERVER_WIDE_MAX,
  windowMs: WINDOW_MS,
});

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

  // Whole-server ceiling first: it is the only one the provider enforces.
  const shared = serverWindow.take();
  if (!shared.ok) {
    throw new ProviderRateLimitError(
      `سقف کل خروجی سرور در ۲۰ دقیقه پر شده است (${shared.limit} درخواست برای همهٔ مقصدها). برای جلوگیری از مسدودشدن کامل خروجی، ${Math.ceil(shared.retryAfterMs / 60_000)} دقیقهٔ دیگر تلاش کنید.`,
      "PROVIDER_RATE_LIMITED",
      shared.retryAfterMs,
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

/** The whole-server ceiling, for the counter in /admin. */
export function serverOutboundUsage(): { used: number; limit: number; remaining: number; windowMinutes: number } {
  return serverWindow.snapshot();
}
