/**
 * Cookie policy for the session cookie.
 *
 * This lives on its own so it can be tested without pulling in Next's request
 * context. The policy is the part that broke login once, and it broke it silently.
 *
 * The default is the safe one for a real deployment: the app is same-origin there,
 * so `lax` is enough and it keeps cross-site POSTs from riding on a live session.
 *
 * The sandbox preview is different: the app is shown inside a cross-site iframe.
 * In that context a `lax` cookie is *stored* but never *sent back*, so every request
 * after a successful login looked signed-out — the panel rejected it and bounced to
 * /login, which is exactly the "it refreshes and stays on the login page" report.
 * `NOMREH_COOKIE_SAMESITE=none` opts into the cross-site-capable cookie, and only
 * for a deployment that actually needs to be framed.
 *
 * Browsers reject `SameSite=None` unless the cookie is also `Secure`, and they
 * silently reject `Partitioned` on a non-secure cookie too — so the two are tied
 * together here rather than left as separate switches that can be set wrong.
 */
export function sessionCookieOptions(expires: Date) {
  const insecure = process.env.NOMREH_COOKIE_SECURE === "0";
  const wantsCrossSite = process.env.NOMREH_COOKIE_SAMESITE?.toLowerCase() === "none";
  const secure = !insecure && (wantsCrossSite || process.env.NODE_ENV === "production");
  return {
    httpOnly: true,
    // Without Secure the browser discards a "none" cookie outright, so the request
    // would not even carry a cookie to reject: fall back to "lax" in that case.
    sameSite: (wantsCrossSite && secure ? "none" : "lax") as "none" | "lax",
    secure,
    path: "/",
    expires,
    // Partitioned keeps the session scoped to the embedding site, so it cannot be
    // read or replayed from any other origin that frames the app.
    ...(wantsCrossSite && secure ? { partitioned: true } : {}),
  };
}
