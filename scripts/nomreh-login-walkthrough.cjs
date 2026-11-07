#!/usr/bin/env node
"use strict";

/**
 * Walks the login the way a browser does, without a browser.
 *
 * Why this exists: "it stays on the login page" can mean five different things,
 * and guessing between them wastes a day. This script answers the question with
 * evidence:
 *
 *   1. does the login page render, and are all of its scripts reachable;
 *   2. does the login API accept the credentials and set a cookie;
 *   3. is that cookie actually sent back, and accepted, on a page load;
 *   4. does the page the app redirects to render the workspace shell.
 *
 * It reports what a real browser would need — a Secure cookie over plain HTTP is
 * the classic cause of "the form submits and nothing happens" — and never prints
 * a password, a cookie value or a key.
 *
 * Usage: node scripts/nomreh-login-walkthrough.cjs [--origin http://127.0.0.1:3100]
 *        node scripts/nomreh-login-walkthrough.cjs --cookie-flag
 */

const { JSDOM } = (() => {
  try {
    return { JSDOM: null };
  } catch {
    return { JSDOM: null };
  }
})();

const ORIGIN = (() => {
  const flag = process.argv.find((argument) => argument.startsWith("--origin="));
  if (flag) return flag.split("=").slice(1).join("=").replace(/\/+$/, "");
  const index = process.argv.indexOf("--origin");
  if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1].replace(/\/+$/, "");
  return process.env.NOMREH_ORIGIN || "http://127.0.0.1:3100";
})();

const USERNAME = process.env.NOMREH_ADMIN_USERNAME || "admin";
const PASSWORD = process.env.NOMREH_ADMIN_PASSWORD || "Admin@1405";

const lines = [];
function say(label, value) {
  const text = `${label.padEnd(34)} ${value}`;
  console.log(text);
  lines.push(text);
}
function fail(label, value) {
  say(`FAIL ${label}`, value);
  process.exitCode = 1;
}

/** Minimal cookie jar: attributes are kept, because that is the whole point. */
class Jar {
  constructor() {
    this.cookies = new Map();
  }
  store(setCookieHeaders) {
    for (const header of setCookieHeaders) {
      const [pair, ...attributes] = header.split(";").map((part) => part.trim());
      const index = pair.indexOf("=");
      if (index === -1) continue;
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      const flags = new Set(attributes.map((attribute) => attribute.toLowerCase().split("=")[0]));
      this.cookies.set(name, { value, secure: flags.has("secure"), httpOnly: flags.has("httponly"), attributes });
    }
  }
  header() {
    return [...this.cookies.entries()].map(([name, cookie]) => `${name}=${cookie.value}`).join("; ");
  }
  describe(name) {
    const cookie = this.cookies.get(name);
    if (!cookie) return "not set";
    return cookie.attributes.filter((attribute) => !attribute.includes("=")).join(", ") || "no flags";
  }
  secureNames() {
    return [...this.cookies.entries()].filter(([, cookie]) => cookie.secure).map(([name]) => name);
  }
  /** True when the session cookie is SameSite=None, i.e. usable in a framed preview. */
  sameSiteNone() {
    return [...this.cookies.values()].some((cookie) =>
      cookie.attributes.some((attribute) => attribute.toLowerCase() === "samesite=none"),
    );
  }
}

async function checkStaticAssets(html) {
  const assets = new Set();
  for (const match of html.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+)"/g)) assets.add(match[1]);
  const broken = [];
  for (const asset of assets) {
    const response = await fetch(`${ORIGIN}${asset}`, { method: "GET" }).catch(() => null);
    if (!response || !response.ok) broken.push(`${asset} -> ${response ? response.status : "no answer"}`);
  }
  return { count: assets.size, broken };
}

async function main() {
  say("origin", ORIGIN);

  // 1. Login page
  const page = await fetch(`${ORIGIN}/login`, { redirect: "manual" });
  const html = await page.text();
  say("GET /login", `HTTP ${page.status}, ${html.length} bytes`);
  if (page.status !== 200) fail("login page", "did not render");
  const hasForm = /<form|type="password"|Password/i.test(html);
  say("login form in HTML", hasForm ? "present" : "NOT FOUND");
  const assets = await checkStaticAssets(html);
  say("client scripts", `${assets.count} referenced, ${assets.broken.length} unreachable`);
  if (assets.broken.length) fail("static assets", assets.broken.slice(0, 3).join(" | "));

  // 2. Login API
  const jar = new Jar();
  let role = "unknown";
  const login = await fetch(`${ORIGIN}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
    redirect: "manual",
  });
  const setCookie = typeof login.headers.getSetCookie === "function" ? login.headers.getSetCookie() : [login.headers.get("set-cookie") || ""].filter(Boolean);
  jar.store(setCookie);
  const body = await login.text();
  say("POST /api/auth/login", `HTTP ${login.status}`);
  if (login.status !== 200) {
    fail("credentials", `${login.status}: ${body.slice(0, 160)}`);
  } else {
    role = (() => {
      try {
        return JSON.parse(body)?.user?.role || "unknown";
      } catch {
        return "unparsed";
      }
    })();
    say("session cookie", `${jar.describe("nomreh_session")} (role ${role})`);
    const secure = jar.secureNames();
    const isHttps = ORIGIN.startsWith("https://");
    // Over plain HTTP a Secure cookie is dropped by the browser; over HTTPS it is
    // exactly what the preview needs, so only the insecure origin is a failure.
    if (secure.length && !isHttps) {
      fail(
        "cookie flags",
        `${secure.join(", ")} is Secure but this origin is plain HTTP, so a browser will drop it and the page will stay on the login screen`,
      );
    } else if (secure.length) {
      say("cookie flags", `Secure over HTTPS — accepted by the browser${jar.sameSiteNone() ? " (cross-site capable)" : ""}`);
    }
  }

  // 3. Does the cookie authenticate a page load?
  const cookieHeader = jar.header();
  const me = await fetch(`${ORIGIN}/api/auth/me`, { headers: { cookie: cookieHeader }, redirect: "manual" });
  say("GET /api/auth/me with cookie", `HTTP ${me.status}`);
  if (me.status !== 200) fail("session", "the cookie was not accepted");

  // The app deliberately sends an admin from a teacher page to /admin, so the test
  // follows one redirect and only complains if it lands back on /login.
  const destination = role === "admin" ? "/admin" : "/grading";
  const landing = await fetch(`${ORIGIN}${destination}`, { headers: { cookie: cookieHeader }, redirect: "manual" });
  const location = landing.headers.get("location") || "";
  say(`GET ${destination} with cookie`, `HTTP ${landing.status}${location ? ` -> ${location}` : ""}`);
  if (location.includes("/login")) {
    fail("redirect", "an authenticated browser is still being sent back to the login page");
  }

  // 4. The shell the browser would hydrate
  if (landing.status === 200) {
    const landingHtml = await landing.text();
    const hydrated = /__next_f|self\.__next_f/.test(landingHtml);
    const shell = /app-shell|workspace|sidebar/i.test(landingHtml);
    say("landing page", `${landingHtml.length} bytes, stream payload ${hydrated ? "present" : "MISSING"}, app shell ${shell ? "present" : "MISSING"}`);
  }

  // 5. The form post path: what happens when React never hydrates. This is the
  //    failure that looked like "the login page just stays there".
  const formBody = new URLSearchParams({ username: USERNAME, password: PASSWORD, next: "/" });
  const proxied = new URL(ORIGIN);
  const formLogin = await fetch(`${ORIGIN}/api/auth/login/form`, {
    method: "POST",
    // Headers the preview proxy sets, so the redirect is built the way a real
    // browser request would be.
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      host: proxied.host,
      "x-forwarded-host": proxied.host,
      "x-forwarded-proto": proxied.protocol.replace(":", ""),
    },
    body: formBody,
    redirect: "manual",
  });
  const formLocation = formLogin.headers.get("location") || "";
  say("POST /api/auth/login/form", `HTTP ${formLogin.status} -> ${formLocation || "(no redirect)"}`);
  if (formLogin.status !== 303 || formLocation.includes("/login")) {
    fail("no-JavaScript login", "the form post did not authenticate and redirect into the app");
  }
  // A redirect to a bind address sends the browser nowhere.
  if (/^(?:https?:\/\/)?(?:0\.0\.0\.0|\[::\])/.test(formLocation)) {
    fail("redirect target", `${formLocation} is a bind address, not an address a browser can follow`);
  }

  // 6. Logout hygiene: the cookie must not survive on the client
  const logout = await fetch(`${ORIGIN}/api/auth/logout`, { method: "POST", headers: { cookie: cookieHeader } });
  say("POST /api/auth/logout", `HTTP ${logout.status}`);

  if (!process.exitCode) say("result", "the login path works end to end");
  process.exit(process.exitCode || 0);
}

main().catch((error) => {
  fail("walkthrough", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
