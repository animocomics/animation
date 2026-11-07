import assert from "node:assert/strict";
import test from "node:test";
import { sessionCookieOptions } from "../lib/server/session-cookie";

/**
 * The session cookie was the reason login "worked" on the server yet still bounced
 * back to the login page in the browser.
 *
 * Two mistakes are easy to repeat here, and both are silent — the browser just
 * discards the cookie and the app looks broken with no error anywhere:
 *
 *  1. `SameSite=lax` inside a cross-site iframe (the sandbox preview): the cookie is
 *     stored but never sent back, so every request after login is anonymous.
 *  2. `SameSite=none` without `Secure`: browsers reject the cookie outright.
 *
 * These tests pin the acceptable combinations so neither can come back unnoticed.
 */

/** NODE_ENV is read-only in the type system but plain writable at runtime. */
const env = process.env as Record<string, string | undefined>;

function reset() {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("NOMREH_COOKIE_")) delete process.env[key];
  }
  delete env.NODE_ENV;
}

test("a production build ships a lax and Secure cookie by default", () => {
  reset();
  env.NODE_ENV = "production";
  const options = sessionCookieOptions(new Date(0));
  assert.equal(options.httpOnly, true);
  assert.equal(options.sameSite, "lax");
  assert.equal(options.secure, true, "a production build must never ship a non-Secure session cookie");
  assert.equal(options.path, "/");
  assert.equal((options as { partitioned?: boolean }).partitioned, undefined, "partitioned is for the framed case only");
});

test("a cross-site iframe gets SameSite=none together with Secure and Partitioned", () => {
  reset();
  env.NODE_ENV = "production";
  process.env.NOMREH_COOKIE_SAMESITE = "none";
  const options = sessionCookieOptions(new Date(0));
  assert.equal(options.sameSite, "none");
  // Without Secure the browser drops the cookie instead of sending it.
  assert.equal(options.secure, true);
  assert.equal((options as { partitioned?: boolean }).partitioned, true);
});

test("a SameSite=none request over plain HTTP falls back instead of shipping a cookie the browser drops", () => {
  reset();
  process.env.NOMREH_COOKIE_SAMESITE = "none";
  process.env.NOMREH_COOKIE_SECURE = "0";
  const options = sessionCookieOptions(new Date(0));
  assert.equal(options.secure, false);
  // None + not Secure is invalid, so the only usable answer is lax.
  assert.equal(options.sameSite, "lax");
});

test("an unrecognised SameSite value never becomes none", () => {
  reset();
  env.NODE_ENV = "production";
  process.env.NOMREH_COOKIE_SAMESITE = "banana";
  assert.equal(sessionCookieOptions(new Date(0)).sameSite, "lax");
});
