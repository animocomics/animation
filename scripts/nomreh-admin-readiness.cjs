#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { chromium } = require("playwright");

const ORIGIN = "https://nomreh.arounidea.com";
const OUTPUT = process.env.NOMREH_E2E_OUTPUT || "";
const lines = ["# Nomreh admin login and configuration readiness", "", "This check uses only the publicly offered initial admin account. It does not read custom credentials, reveal session cookies, save API settings, or change Shecan.", ""];
let browser;
let context;
let authenticated = false;
let loggedOut = false;

function clean(value) {
  return String(value || "").replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/https?:\/\/\S+/gi, "[link]").replace(/\s+/g, " ").trim().slice(0, 350);
}

function report() {
  const text = lines.join("\n");
  if (OUTPUT) fs.writeFileSync(OUTPUT, text, { mode: 0o600 });
  return text;
}

async function logout() {
  if (!authenticated || loggedOut || !context) return;
  const response = await context.request.post(`${ORIGIN}/api/auth/logout`).catch(() => null);
  if (response && response.ok()) {
    loggedOut = true;
    lines.push(`- Temporary test session closed: HTTP ${response.status()}.`);
  }
}

async function main() {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  context = await browser.newContext({ ignoreHTTPSErrors: false, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);

  lines.push("## Real admin login", "");
  const loginResponse = await page.goto(`${ORIGIN}/login`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
  lines.push(`- Login page HTTP status: ${loginResponse ? loginResponse.status() : "unavailable"}.`);
  await page.getByRole("heading", { name: "به نمره خوش آمدید" }).waitFor({ state: "visible" });
  const initialAccess = await page.getByText("دسترسی اولیهٔ نصب", { exact: true }).count();
  lines.push(`- Publicly offered initial installation accounts: ${initialAccess ? "yes" : "no"}.`);
  if (!initialAccess) throw new Error("Initial installation accounts are not exposed. No password was attempted; the existing custom admin credentials must be used or securely reset.");

  await page.locator("#login-username").fill("admin");
  await page.locator("#login-password").fill("Admin@1405");
  const navigation = page.waitForURL((url) => url.origin === ORIGIN && url.pathname === "/", { timeout: 30000 }).then(() => true).catch(() => false);
  await page.getByRole("button", { name: "ورود به فضای کاری", exact: true }).click();
  const reachedWorkspace = await navigation;
  if (!reachedWorkspace) {
    const alert = await page.getByRole("alert").innerText().catch(() => "");
    throw new Error(`The initial admin login did not reach the workspace.${alert ? ` ${clean(alert)}` : ""}`);
  }
  authenticated = true;
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
  await page.getByText("فضای کاری شما", { exact: true }).waitFor({ state: "visible" });
  const meResponse = await context.request.get(`${ORIGIN}/api/auth/me`);
  const me = await meResponse.json();
  if (!meResponse.ok() || me.user?.role !== "admin" || me.user?.username !== "admin") throw new Error("The authenticated session was not verified as the initial admin account.");
  lines.push("- Initial admin login succeeded and the real workspace loaded.", "- Authenticated role verified by /api/auth/me: admin.", "");

  lines.push("## Admin API and Shecan readiness", "");
  const adminResponse = await page.goto(`${ORIGIN}/admin`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
  lines.push(`- Admin page HTTP status: ${adminResponse ? adminResponse.status() : "unavailable"}.`);
  await page.getByRole("heading", { name: "مدیریت سامانهٔ نمره" }).waitFor({ state: "visible" });
  await page.getByText("پیکربندی سراسری مدل", { exact: true }).waitFor({ state: "visible" });
  await page.getByText("مسیر اختصاصی API با شکن", { exact: true }).waitFor({ state: "visible" });
  await page.locator("#admin-api-key").waitFor({ state: "visible" });
  await page.locator("#shecan-update-url").waitFor({ state: "hidden" }).catch(() => undefined);

  const usersResponse = await context.request.get(`${ORIGIN}/api/admin/users`);
  const usersPayload = await usersResponse.json();
  if (!usersResponse.ok() || !Array.isArray(usersPayload.users)) throw new Error("The admin-only account API was not available to the authenticated admin.");
  lines.push(`- Admin-only account management API: HTTP ${usersResponse.status()}; ${usersPayload.users.length} account(s) visible without exposing their details.`);

  const providerResponse = await context.request.get(`${ORIGIN}/api/provider`);
  const providerPayload = await providerResponse.json();
  if (!providerResponse.ok() || !providerPayload.status) throw new Error("The provider status API was not available to the authenticated admin.");
  lines.push(`- Provider configured: ${providerPayload.status.configured ? "yes" : "no"}.`, `- Selected provider/model: ${clean(providerPayload.status.providerLabel)} / ${clean(providerPayload.status.model)}.`, "- API Key entry, connection test, and secure-save controls are visible to the admin.");

  await page.getByRole("radio", { name: /Z\.AI GLM/ }).click();
  const modelOptions = await page.locator("#admin-model option").allTextContents();
  if (!modelOptions.includes("glm-5.3-flash")) throw new Error("GLM 5.3 Flash was not available in the actual admin model selector.");
  lines.push("- Z.AI model selector includes glm-5.3-flash. No provider setting was saved.");

  const networkResponse = await context.request.get(`${ORIGIN}/api/admin/api-network`);
  const networkPayload = await networkResponse.json();
  if (!networkResponse.ok() || !networkPayload.status) throw new Error("The Shecan status API was not available to the authenticated admin.");
  lines.push(`- Shecan enabled: ${networkPayload.status.enabled ? "yes" : "no"}.`, `- Shecan plan: ${networkPayload.status.plan}; encrypted update link stored: ${networkPayload.status.hasUpdateUrl ? "yes" : "no"}.`, `- Last Shecan test state: ${clean(networkPayload.status.lastTestStatus)}.`);

  await page.getByRole("radio", { name: /شکن حرفه‌ای/ }).click();
  await page.locator("#shecan-update-url").waitFor({ state: "visible" });
  await page.getByRole("button", { name: /آزمایش، ذخیره و فعال‌سازی|آزمایش مجدد اتصال/ }).waitFor({ state: "visible" });
  lines.push("- Shecan free/pro selection, update-link entry, DNS editing, and test/save/enable controls are available in the real admin UI.", "- No API key, update link, DNS value, or enable/disable state was submitted or changed.", "");

  await logout();
  lines.push("", "## Result", "", "Real admin login, workspace access, admin-only APIs, provider controls, GLM 5.3 Flash, and Shecan configuration controls are operational. External provider-key validity and Shecan activation were not changed or tested in this read-only configuration check.");
}

main().catch(async (error) => {
  lines.push("", "## Stopped", "", clean(error.message), "No live-configuration success is claimed beyond the evidence above.");
  await logout().catch(() => undefined);
  process.exitCode = 1;
}).finally(async () => {
  if (!loggedOut) await logout().catch(() => undefined);
  if (browser) await browser.close();
  console.log(report());
});
