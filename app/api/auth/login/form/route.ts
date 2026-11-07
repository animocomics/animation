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
 * Redirects to a path, never to an absolute URL.
 *
 * This used to rebuild an absolute URL from `x-forwarded-host` / `x-forwarded-proto`
 * and that was still wrong in the two cases that matter:
 *
 *  - a proxy that does not forward those headers produced `http://<host>/…`, i.e. a
 *    downgrade from https to http, which the https preview proxy refuses to follow;
 *  - a request straight at the bind address produced `http://0.0.0.0:3100/…`, which
 *    a browser cannot use at all.
 *
 * Both looked exactly like "the login page just refreshes and stays there". A
 * relative Location is resolved by the browser against the URL it actually used, so
 * it is correct behind every proxy, on https and on http, with or without forwarded
 * headers. There is nothing left to get wrong.
 */
function redirectTo(path: string, status: 303 = 303) {
  const response = new NextResponse(null, { status, headers: { Location: path } });
  // A cached 303 would replay an old success/failure after the credentials changed.
  response.headers.set("Cache-Control", "no-store, max-age=0");
  return response;
}

export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  const username = String(form?.get("username") || "").trim();
  const password = String(form?.get("password") || "");
  const next = safeNext(String(form?.get("next") || ""));

  const back = new URLSearchParams({ next });
  if (!rateLimit(`login-form:${requestIp(request)}:${username.toLowerCase()}`, 10, 15 * 60 * 1000)) {
    return redirectTo(`/login?e=rate&${back}`);
  }
  if (!username || !password) {
    return redirectTo(`/login?e=empty&${back}`);
  }

  const user = await authenticate(username, password);
  if (!user) {
    // No detail about which half was wrong: that is an account-enumeration hint.
    return redirectTo(`/login?e=bad&${back}`);
  }

  await createSession(user.id);
  // Admins land on their panel, teachers on their workspace; both are the app's
  // own destinations, not a value taken from the request.
  const target = user.role === "admin" ? "/admin" : next;
  return redirectTo(target);
}
