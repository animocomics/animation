#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const dns = require("node:dns").promises;
const https = require("node:https");

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
  const fetchOnce = (url, redirects = 0) => new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: "GET",
      family: 4,
      servername: url.hostname,
      rejectUnauthorized: true,
      headers: {
        Accept: url.pathname.startsWith("/api/") ? "application/json" : "text/html,application/xhtml+xml",
        "Cache-Control": "no-cache",
        "User-Agent": "Nomreh-Live-Validation/1.0",
      },
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size <= 2_000_000) chunks.push(chunk);
        else request.destroy(new Error(`${pathname} returned an unexpectedly large response.`));
      });
      response.on("error", reject);
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const status = response.statusCode || 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && location) {
          if (redirects >= 5) { reject(new Error(`${pathname} exceeded five redirects.`)); return; }
          const next = new URL(location, url);
          if (next.origin !== ORIGIN) { reject(new Error(`${pathname} redirected outside Nomreh's HTTPS origin.`)); return; }
          resolve(fetchOnce(next, redirects + 1));
          return;
        }
        resolve({
          response: {
            status,
            url: url.toString(),
            headers: { get: (name) => response.headers[String(name).toLowerCase()] || null },
          },
          body,
        });
      });
    });
    request.setTimeout(20000, () => request.destroy(new Error(`IPv4 HTTPS socket timeout for ${pathname}.`)));
    request.on("error", reject);
    request.end();
  });
  return fetchOnce(new URL(`${ORIGIN}${pathname}`));
}

function validateLogin(result, label) {
  const { response, body } = result;
  const finalUrl = new URL(response.url);
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
    const addresses = await dns.lookup("nomreh.arounidea.com", { all: true, verbatim: true });
    lines.push(`- Public DNS addresses: ${addresses.map((entry) => `IPv${entry.family} ${entry.address}`).join(", ")}`);
    lines.push("- HTTPS validation uses the public IPv4 route with normal certificate verification.");
  } catch (error) {
    fail(`Public DNS lookup failed: ${error.message}`);
  }
  try {
    const root = await request("/");
    validateLogin(root, "Root");
  } catch (error) {
    fail(`Root request failed: ${error.message}`);
  }

  try {
    const login = await request("/login");
    validateLogin(login, "Login");

    lines.push("", "## Login static assets", "");
    const assetPaths = [...new Set([...login.body.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+)"/g)].map((match) => match[1].replace(/&amp;/g, "&")))].slice(0, 30);
    const scriptCount = assetPaths.filter((pathname) => pathname.endsWith(".js")).length;
    lines.push(`- Referenced static assets found: ${assetPaths.length}; JavaScript assets: ${scriptCount}.`);
    if (!scriptCount) fail("The login document did not reference any Next.js JavaScript assets.");
    let validAssets = 0;
    for (const pathname of assetPaths) {
      try {
        const asset = await request(pathname);
        const contentType = asset.response.headers.get("content-type") || "";
        if (asset.response.status !== 200 || !Buffer.byteLength(asset.body)) {
          lines.push(`- Asset failure: ${clean(pathname)} returned HTTP ${asset.response.status}; content type ${clean(contentType || "none")}; server ${clean(asset.response.headers.get("server") || "none")}; response excerpt ${clean(asset.body.slice(0, 180)) || "empty"}.`);
          fail(`${pathname} was not available as a public static asset.`);
          continue;
        }
        if (pathname.endsWith(".js") && !/javascript|ecmascript/i.test(contentType)) {
          fail(`${pathname} returned HTTP 200 with a non-JavaScript content type.`);
          continue;
        }
        if (pathname.endsWith(".css") && !/text\/css/i.test(contentType)) {
          fail(`${pathname} returned HTTP 200 with a non-CSS content type.`);
          continue;
        }
        validAssets += 1;
      } catch (error) {
        fail(`Static asset ${pathname} failed: ${error.message}`);
      }
    }
    lines.push(`- Static assets validated successfully: ${validAssets}/${assetPaths.length}.`);
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
    lines.push("Nomreh is live on its real HTTPS domain. The public root reaches the Persian RTL login application, all referenced login JS/CSS assets load successfully, and the unauthenticated auth API returns the expected anonymous JSON response.");
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
