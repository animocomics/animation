#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

const ORIGIN = "https://nomreh.arounidea.com";
const OUTPUT = process.env.NOMREH_LIVE_OUTPUT || "";
const lines = ["# Nomreh independent live HTTPS validation", "", "No Plesk session, application credentials, or certificate bypass is used.", ""];
const failures = [];

function clean(value) {
  return String(value || "").replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}

function fail(message) {
  failures.push(message);
  lines.push(`- FAILED: ${clean(message)}`);
}

async function request(pathname) {
  const response = await fetch(`${ORIGIN}${pathname}`, {
    redirect: "follow",
    cache: "no-store",
    headers: {
      Accept: pathname.startsWith("/api/") ? "application/json" : "text/html,application/xhtml+xml",
      "Cache-Control": "no-cache",
      "User-Agent": "Nomreh-Live-Validation/1.0",
    },
    signal: AbortSignal.timeout(25000),
  });
  const body = await response.text();
  if (body.length > 2_000_000) throw new Error(`${pathname} returned an unexpectedly large response.`);
  return { response, body };
}

function validateLogin(result, label) {
  const { response, body } = result;
  const finalUrl = new URL(response.url());
  const title = clean(body.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || "not exposed");
  lines.push(`- ${label} HTTP status: ${response.status}`);
  lines.push(`- ${label} final URL: ${finalUrl.origin}${finalUrl.pathname}`);
  lines.push(`- ${label} response bytes: ${Buffer.byteLength(body)}`);
  lines.push(`- ${label} document title: ${title}`);
  if (response.status !== 200) fail(`${label} did not return HTTP 200.`);
  if (finalUrl.origin !== ORIGIN || finalUrl.pathname !== "/login") fail(`${label} did not finish at Nomreh's HTTPS login page.`);
  if (!body.includes("به نمره خوش آمدید")) fail(`${label} did not contain the Nomreh Persian login heading.`);
  if (!body.includes("ورود به فضای کاری")) fail(`${label} did not contain the Nomreh login form.`);
  if (!/<html[^>]+lang="fa"[^>]+dir="rtl"/i.test(body)) fail(`${label} did not contain the expected Persian RTL document.`);
  if (/Plesk|Apache2 Ubuntu Default|403 Forbidden|Access Denied/i.test(body)) fail(`${label} contained a hosting/default error page instead of Nomreh.`);
}

async function main() {
  lines.push("## Public application responses", "");
  try {
    const root = await request("/");
    validateLogin(root, "Root");
  } catch (error) {
    fail(`Root request failed: ${error.message}`);
  }

  try {
    const login = await request("/login");
    validateLogin(login, "Login");
  } catch (error) {
    fail(`Login request failed: ${error.message}`);
  }

  try {
    const { response, body } = await request("/api/auth/me");
    lines.push(`- Guest auth API HTTP status: ${response.status}`);
    lines.push(`- Guest auth API content type: ${clean(response.headers.get("content-type"))}`);
    lines.push(`- Guest auth API cache control: ${clean(response.headers.get("cache-control"))}`);
    if (response.status !== 200) fail("Guest auth API did not return HTTP 200.");
    if (!/application\/json/i.test(response.headers.get("content-type") || "")) fail("Guest auth API did not return JSON.");
    let payload;
    try { payload = JSON.parse(body); } catch { fail("Guest auth API returned invalid JSON."); }
    if (payload && Object.keys(payload).length === 1 && payload.user === null) {
      lines.push("- Guest auth API returned the expected { user: null } application response.");
    } else if (payload) {
      fail("Guest auth API did not return the expected anonymous application payload.");
    }
  } catch (error) {
    fail(`Guest auth API request failed: ${error.message}`);
  }

  lines.push("", "## Result", "");
  if (failures.length) {
    lines.push(`Nomreh is not yet validated as live: ${failures.length} independent public-response check(s) failed. No live-success claim is made.`);
  } else {
    lines.push("Nomreh is live on its real HTTPS domain. The public root reaches the Persian RTL login application, and the unauthenticated auth API returns the expected anonymous JSON response.");
  }
  lines.push("");
  const report = lines.join("\n");
  if (OUTPUT) fs.writeFileSync(OUTPUT, report, { mode: 0o600 });
  console.log(report);
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => {
  const report = `${lines.join("\n")}\n- FAILED: ${clean(error.message)}\n`;
  if (OUTPUT) fs.writeFileSync(OUTPUT, report, { mode: 0o600 });
  console.error(report);
  process.exitCode = 1;
});
