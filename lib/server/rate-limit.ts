interface Bucket { count: number; resetAt: number }
interface RateLimitGlobal { __nomrehRateLimits?: Map<string, Bucket> }
const store = globalThis as typeof globalThis & RateLimitGlobal;
const buckets = store.__nomrehRateLimits || new Map<string, Bucket>();
store.__nomrehRateLimits = buckets;

export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  current.count += 1;
  return current.count <= limit;
}

export function requestIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "local";
}
