#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { chromium } = require("playwright");
const ORIGIN = "https://nomreh.arounidea.com";
const OUTPUT = process.env.NOMREH_BROWSER_PROVIDER_OUTPUT || "";
const lines = ["# Nomreh real-browser provider check", "", "Read-only provider diagnostics from a real Chromium page. No API key, cookie, account secret, or provider response body is printed.", ""];
let browser;
let context;

function clean(value) {
  return String(value ?? "")
    .split(/\r?\n\s*Call log:/i)[0]
    .replace(/[\u0000-\u001f\u007f<>]/g, " ")
    .replace(/https?:\/\/\S+/gi, "[link]")
    .replace(/AIza[0-9A-Za-z_-]{8,}/g, "[کلید]")
    .replace(/(?:nomreh_session|next-auth\.session-token)=[^\s;]+/gi, "[جلسهٔ حذف‌شده]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function report() {
  const text = lines.join("\n");
  if (OUTPUT) fs.writeFileSync(OUTPUT, text, { mode: 0o600 });
  return text;
}

function summarize(result) {
  let payload;
  try { payload = result.text ? JSON.parse(result.text) : null; } catch { payload = null; }
  if (payload?.error) return clean(payload.error);
  if (!payload && result.text) {
    const title = result.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "";
    return `non-JSON ${clean(result.contentType)}${title ? `; title ${clean(title)}` : ""}`;
  }
  return "JSON response";
}

async function api(page, pathname, body) {
  return page.evaluate(async ({ pathname: path, body: requestBody }) => {
    const response = await fetch(path, {
      method: requestBody === undefined ? "GET" : "POST",
      headers: { Accept: "application/json", ...(requestBody === undefined ? {} : { "Content-Type": "application/json" }) },
      body: requestBody === undefined ? undefined : JSON.stringify(requestBody),
      cache: "no-store",
    });
    return { status: response.status, contentType: response.headers.get("content-type") || "none", text: await response.text() };
  }, { pathname, body });
}

async function run() {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ locale: "fa-IR" });
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/login`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.locator("#login-username").fill(process.env.NOMREH_ADMIN_USERNAME || "admin");
  await page.locator("#login-password").fill(process.env.NOMREH_ADMIN_PASSWORD || "Admin@1405");
  await page.getByRole("button", { name: "ورود به فضای کاری", exact: true }).click();
  await page.waitForURL((url) => url.pathname !== "/login", { timeout: 30000 });
  await page.goto(`${ORIGIN}/admin`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.getByRole("heading", { name: "مدیریت سامانهٔ نمره", exact: true }).waitFor({ state: "visible", timeout: 20000 });

  const provider = await api(page, "/api/provider");
  if (provider.status !== 200) throw new Error(`Provider status failed: HTTP ${provider.status} ${summarize(provider)}`);
  const providerPayload = JSON.parse(provider.text);
  const status = providerPayload.status;
  lines.push(`- Real browser admin login and provider status: HTTP 200; configured ${status.configured ? "yes" : "no"}; provider ${clean(status.providerLabel)}; model ${clean(status.model)}.`);
  if (!status.configured) {
    lines.push("- No stored provider key is configured; external provider checks were not attempted.");
    return;
  }

  const test = await api(page, "/api/provider/test", { provider: status.provider, model: status.model });
  lines.push(`- Real browser stored-key provider test: HTTP ${test.status}; ${test.status === 200 ? "success" : summarize(test)}.`);
  const models = await api(page, "/api/provider/models", { provider: status.provider });
  let modelCount = 0;
  let selectedPresent = false;
  try {
    const payload = JSON.parse(models.text);
    if (Array.isArray(payload.models)) {
      modelCount = payload.models.length;
      selectedPresent = payload.models.includes(status.model);
    }
  } catch { /* summarize below retains only a safe classification. */ }
  lines.push(`- Real browser stored-key model discovery: HTTP ${models.status}; ${models.status === 200 ? `${modelCount} compatible models; selected model present ${selectedPresent ? "yes" : "no"}` : summarize(models)}.`);

  const usage = await api(page, "/api/admin/usage");
  if (usage.status === 200) {
    const payload = JSON.parse(usage.text);
    const summary = payload.summary || {};
    lines.push(`- Nomreh-recorded usage: jobs ${summary.jobs || 0}; input tokens ${summary.input_tokens || 0}; output tokens ${summary.output_tokens || 0}; failed ${summary.failures || 0}.`);
  } else lines.push(`- Usage read: HTTP ${usage.status}; ${summarize(usage)}.`);
  lines.push("", "No grading request, provider save, Shecan change, or workspace mutation was made. Remaining provider quota is not exposed by these endpoints.");
}

run().catch((error) => {
  lines.push("", "## Stopped", "", clean(error.message));
  process.exitCode = 1;
}).finally(async () => {
  if (context) await context.request.post(`${ORIGIN}/api/auth/logout`).catch(() => undefined);
  if (browser) await browser.close();
  console.log(report());
});
