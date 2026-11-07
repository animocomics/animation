import { NextResponse } from "next/server";
import { authenticate, createSession } from "@/lib/server/auth";
import { rateLimit, requestIp } from "@/lib/server/rate-limit";

/**
 * Form-post login — the path that works without JavaScript.
 *
 * Why this exists: the login form used to submit only through a React handler, so
 * if hydration did not finish (a proxy that rewrites the page, a blocked chunk, a
 * browser extension, a preview host) pressing "ورود" did nothing visible at all —
 * the page simply stayed on the login screen with no error. That failure looks
 * identical to "the password is wrong", and it wasted a day once already.
 *
 * A plain <form> posting here always works: the server authenticates, sets the
 * cookie and redirects. The React path still exists for the nicer experience; this
 * is the floor, not a replacement.
 *
 * It never echoes the password, and a failed attempt says only that the pair is
 * wrong — the same sentence the JSON endpoint uses.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Only local paths are honoured, so the form cannot be used as an open redirect. */
function safeNext(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

/**
 * Builds the redirect against the address the browser actually used.
 *
 * `request.url` behind a reverse proxy or a preview host is the internal bind
 * address — `http://0.0.0.0:3100` on this app — and redirecting a browser there
 * sends it nowhere. The forwarded headers are the only truthful source, so they
 * win, and the internal URL is a last resort for a direct local request.
 */
function publicUrl(request: Request, path: string): URL {
  const forwardedHost = request.headers.get("x-forwarded-host");
  const host = forwardedHost || request.headers.get("host") || "";
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const proto = forwardedProto || (request.url.startsWith("https:") ? "https" : "http");
  // A bind address is never something a browser can use.
  if (!host || /^(0\.0\.0\.0|\[::\])(:\d+)?$/.test(host)) return new URL(path, request.url);
  try {
    return new URL(path, `${proto}://${host}`);
  } catch {
    return new URL(path, request.url);
  }
}

export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  const username = String(form?.get("username") || "").trim();
  const password = String(form?.get("password") || "");
  const next = safeNext(String(form?.get("next") || ""));

  const back = new URLSearchParams({ next });
  if (!rateLimit(`login-form:${requestIp(request)}:${username.toLowerCase()}`, 10, 15 * 60 * 1000)) {
    return NextResponse.redirect(publicUrl(request, `/login?e=rate&${back}`), 303);
  }
  if (!username || !password) {
    return NextResponse.redirect(publicUrl(request, `/login?e=empty&${back}`), 303);
  }

  const user = await authenticate(username, password);
  if (!user) {
    // No detail about which half was wrong: that is an account-enumeration hint.
    return NextResponse.redirect(publicUrl(request, `/login?e=bad&${back}`), 303);
  }

  await createSession(user.id);
  // Admins land on their panel, teachers on their workspace; both are the app's
  // own destinations, not a value taken from the request.
  const target = user.role === "admin" ? "/admin" : next;
  return NextResponse.redirect(publicUrl(request, target), 303);
}
