#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { chromium } = require("playwright");
const ORIGIN = "https://nomreh.arounidea.com";
const OUTPUT = process.env.NOMREH_BROWSER_SHECAN_OUTPUT || "";
const UPDATE_URL = process.env.SHECAN_UPDATE_URL || "";
// This check is intentionally repeatable after a scoped Passenger restart.
const lines = [
  "# Nomreh real-browser Shecan and provider check",
  "",
  "The real admin Chromium form is used. The Shecan update link, API key, cookies, and full upstream response bodies are never printed.",
  "",
];
let browser;
let context;

function clean(value) {
  return String(value ?? "")
    .split(/\r?\n\s*Call log:/i)[0]
    .replace(/[\u0000-\u001f\u007f<>]/g, " ")
    .replace(/https?:\/\/\S+/gi, "[link]")
    .replace(/AIza[0-9A-Za-z_-]{8,}/g, "[key]")
    .replace(/(?:nomreh_session|next-auth\.session-token)=[^\s;]+/gi, "[session]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function report() {
  const text = lines.join("\n");
  if (OUTPUT) fs.writeFileSync(OUTPUT, text, { mode: 0o600 });
  return text;
}

function payloadOf(result) {
  try { return result.text ? JSON.parse(result.text) : null; } catch { return null; }
}

function summarize(result) {
  const payload = payloadOf(result);
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
      credentials: "same-origin",
    });
    return { status: response.status, contentType: response.headers.get("content-type") || "none", text: await response.text() };
  }, { pathname, body });
}

async function login(page) {
  await page.goto(`${ORIGIN}/login`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
  await page.locator("#login-username").fill(process.env.NOMREH_ADMIN_USERNAME || "admin");
  await page.locator("#login-password").fill(process.env.NOMREH_ADMIN_PASSWORD || "Admin@1405");
  const responsePromise = page.waitForResponse((response) => response.url() === `${ORIGIN}/api/auth/login` && response.request().method() === "POST", { timeout: 30000 });
  await page.getByRole("button", { name: "ورود به فضای کاری", exact: true }).click();
  const response = await responsePromise;
  if (!response.ok()) throw new Error(`Browser login was rejected with HTTP ${response.status()}.`);
  await page.goto(`${ORIGIN}/admin`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.getByRole("heading", { name: "مدیریت سامانهٔ نمره", exact: true }).waitFor({ state: "visible", timeout: 20000 });
  await page.locator(".api-network-connection").waitFor({ state: "visible", timeout: 20000 });
}

function networkLine(prefix, result) {
  const status = payloadOf(result)?.status;
  if (!status) return `${prefix}: HTTP ${result.status}; ${summarize(result)}.`;
  return `${prefix}: HTTP ${result.status}; configured ${status.configured ? "yes" : "no"}; enabled ${status.enabled ? "yes" : "no"}; plan ${clean(status.plan)}; DNS ${clean((status.servers || []).join(" / "))}; update link stored ${status.hasUpdateUrl ? "yes" : "no"}; last test ${clean(status.lastTestStatus)}; message ${clean(status.lastTestMessage)}.`;
}

async function usage(page) {
  const result = await api(page, "/api/admin/usage");
  const summary = payloadOf(result)?.summary || {};
  return { jobs: Number(summary.jobs || 0), input: Number(summary.input_tokens || 0), output: Number(summary.output_tokens || 0), failures: Number(summary.failures || 0) };
}

async function run() {
  if (!UPDATE_URL) throw new Error("The SHECAN GitHub secret was not supplied to the controlled browser run.");
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ locale: "fa-IR" });
  const page = await context.newPage();
  await login(page);

  const before = await api(page, "/api/admin/api-network");
  lines.push(`- ${networkLine("Shecan before the requested test", before)}`);
  const beforeUsage = await usage(page);

  const current = payloadOf(before)?.status;
  if (current?.plan !== "pro") {
    const pro = page.getByRole("radio", { name: /شکن حرفه‌ای/ }).first();
    if (!await pro.count()) throw new Error("The professional Shecan option was not visible in the real admin form.");
    await pro.click();
  }
  const updateField = page.locator("#shecan-update-url");
  await updateField.waitFor({ state: "visible", timeout: 10000 });
  const useStoredUpdateUrl = Boolean(current?.hasUpdateUrl);
  if (!useStoredUpdateUrl) await updateField.fill(UPDATE_URL);
  lines.push(`- Activation input: ${useStoredUpdateUrl ? "the existing encrypted update link, with no URL repeated in the request body" : "the supplied SHECAN secret"}.`);
  const saveButton = page.locator(".api-network-connection button.btn-primary").filter({ hasText: /آزمایش/ }).first();
  await saveButton.waitFor({ state: "visible", timeout: 10000 });
  const responsePromise = page.waitForResponse((response) => response.url() === `${ORIGIN}/api/admin/api-network` && response.request().method() === "POST", { timeout: 90000 });
  await saveButton.click();
  const response = await responsePromise;
  const result = { status: response.status(), contentType: response.headers()["content-type"] || "none", text: await response.text() };
  lines.push(`- Real admin Shecan save/activation test: HTTP ${result.status}; ${result.status === 200 ? "request accepted" : summarize(result)}.`);
  await page.waitForTimeout(1200);

  const after = await api(page, "/api/admin/api-network");
  const afterStatus = payloadOf(after)?.status;
  lines.push(`- ${networkLine("Shecan after the requested test", after)}`);
  if (result.status === 200 && afterStatus?.enabled) {
    const providerStatusResult = await api(page, "/api/provider");
    const providerStatus = payloadOf(providerStatusResult)?.status;
    if (providerStatus?.configured) {
      const providerTest = await api(page, "/api/provider/test", { provider: providerStatus.provider, model: providerStatus.model });
      lines.push(`- Stored-key provider test after Shecan: HTTP ${providerTest.status}; ${providerTest.status === 200 ? "success" : summarize(providerTest)}.`);
    } else lines.push("- Stored-key provider test after Shecan: skipped because no provider key is configured.");
  } else {
    lines.push("- Stored-key provider test after Shecan: not attempted because Shecan was not confirmed active.");
  }
  const afterUsage = await usage(page);
  lines.push(`- Nomreh-recorded AI usage before/after: jobs ${beforeUsage.jobs}/${afterUsage.jobs}; input tokens ${beforeUsage.input}/${afterUsage.input}; output tokens ${beforeUsage.output}/${afterUsage.output}; failed ${beforeUsage.failures}/${afterUsage.failures}. Shecan and provider connection tests are not grading jobs.`);
  lines.push("", "No exam, grade, teacher data, or provider setting was changed. The requested Shecan activation/test was the only configuration mutation; the provider test used the already stored key without saving it.");
}

run().catch((error) => {
  lines.push("", "## Stopped", "", clean(error.message));
  process.exitCode = 1;
}).finally(async () => {
  if (context) await context.request.post(`${ORIGIN}/api/auth/logout`).catch(() => undefined);
  if (browser) await browser.close();
  console.log(report());
});
