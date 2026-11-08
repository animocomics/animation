/**
 * One paid request per identical sheet, per short window.
 *
 * Why: the importer sends the page images to a metered model, and every call bills
 * the input even when the answer is unusable. A double click, a second tab, or the
 * same button pressed again while the toast is still on screen used to be a second
 * full charge for the identical work — which is exactly the "tokens falling, nothing
 * built" report. The panel also had no server-side memory that this sheet had just
 * been sent.
 *
 * This is deliberately small and in-process: it is a duplicate-stopper, not a billing
 * system. A restart clears it, and nothing here decides whether a request may run —
 * that is still the outbound window's job.
 */

const claims = new Map<string, number>();

/** Window in which the identical request is treated as a duplicate. */
export const DUPLICATE_WINDOW_MS = 90_000;

export function duplicateKey(parts: Array<string | number>): string {
  return parts.map((part) => String(part)).join("\u0000");
}

/**
 * Returns true when this caller may make the request.
 * A second caller with the same key inside the window gets false, and spends nothing.
 */
export function claimPaidRequest(key: string, now = Date.now(), windowMs = DUPLICATE_WINDOW_MS): boolean {
  for (const [existing, claimedAt] of claims) {
    if (now - claimedAt > windowMs) claims.delete(existing);
  }
  const previous = claims.get(key);
  if (previous !== undefined && now - previous <= windowMs) return false;
  claims.set(key, now);
  return true;
}

/**
 * Releases a claim that provably cost nothing.
 *
 * Used when the failure happened before the provider could bill — a rejected key, a
 * wrong base URL, an unconfigured provider. Keeping the claim in those cases would
 * lock the teacher out of a request that was never paid for.
 */
export function releasePaidRequest(key: string): void {
  claims.delete(key);
}

/** Test hook: the map is module state, so tests need a clean slate. */
export function resetPaidRequestClaims(): void {
  claims.clear();
}
