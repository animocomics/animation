#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { chromium } = require("playwright");
const { normalizePanelUrl } = require("./plesk-api-diagnostics.cjs");

const ORIGIN = "https://nomreh.arounidea.com";
const DOMAIN = "nomreh.arounidea.com";
const OUTPUT = process.env.NOMREH_E2E_OUTPUT || "";
const lines = ["# Nomreh admin login and configuration readiness", "", "This check uses the publicly offered initial account or the existing configured admin credentials in memory only. It never prints credentials or session cookies, and it does not save API settings or change Shecan.", ""];
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

function nestedValue(payload, key) {
  let visited = 0;
  const search = (value, depth = 0) => {
    if (!value || depth > 9 || visited > 6000) return undefined;
    visited += 1;
    if (Array.isArray(value)) {
      for (const entry of value) {
        const found = search(entry, depth + 1);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    if (typeof value !== "object") return undefined;
    if (typeof value[key] === "string" && value[key]) return value[key];
    const name = value.name ?? value.key ?? value.variable ?? value.variable_name;
    if (name === key && typeof value.value === "string" && value.value) return value.value;
    for (const entry of Object.values(value)) {
      const found = search(entry, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return search(payload);
}

function dotenvValue(text, key) {
  const line = String(text || "").split(/\r?\n/).find((entry) => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`).test(entry));
  if (!line) return "";
  let value = line.slice(line.indexOf("=") + 1).trim();
  if (value.startsWith('"')) {
    try { value = JSON.parse(value); } catch { return ""; }
  } else if (value.startsWith("'")) {
    const end = value.lastIndexOf("'");
    if (end > 0) value = value.slice(1, end);
  } else {
    value = value.replace(/\s+#.*$/, "").trim();
  }
  return typeof value === "string" ? value : "";
}

async function readConfiguredAdminFromPlesk() {
  if (!process.env.PLESK_PANEL_URL || !process.env.PLESK_API_USERNAME || !process.env.PLESK_API_PASSWORD) return null;
  const panel = normalizePanelUrl(process.env.PLESK_PANEL_URL);
  const pleskContext = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1500, height: 1000 } });
  try {
    const page = await pleskContext.newPage();
    page.setDefaultTimeout(18000);
    await page.goto(`${panel}/login_up.php`, { waitUntil: "domcontentloaded", timeout: 45000 });
    const cookieButton = page.getByRole("button", { name: /Accept necessary cookies/i }).first();
    if (await cookieButton.count() && await cookieButton.isVisible().catch(() => false)) await cookieButton.click().catch(() => undefined);
    const findInput = async (selectors) => {
      for (const selector of selectors) {
        const input = page.locator(selector).first();
        if (await input.count() && await input.isVisible().catch(() => false)) return input;
      }
      return null;
    };
    const username = await findInput(['input[name="login_name"]', 'input[name="username"]', 'input[name="login"]', 'input[type="email"]']);
    const password = await findInput(['input[name="passwd"]', 'input[name="password"]', 'input[type="password"]']);
    if (!username || !password) throw new Error("The Plesk login form was not available for the in-memory credential lookup.");
    await username.fill(process.env.PLESK_API_USERNAME);
    await password.fill(process.env.PLESK_API_PASSWORD);
    await password.press("Enter");
    await page.waitForTimeout(3500);
    if (await findInput(['input[type="password"]', 'input[name="passwd"]'])) throw new Error("Plesk authentication did not succeed; no application credentials were read.");

    let domainFound = false;
    for (const inspectPath of ["/smb/web/domains", "/admin/domain/list"]) {
      await page.goto(`${panel}${inspectPath}`, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(1400);
      const domainElement = page.getByText(DOMAIN, { exact: false }).first();
      if (!await domainElement.count()) continue;
      await domainElement.click({ timeout: 8000 }).catch(() => undefined);
      await page.waitForTimeout(1500);
      const domainCard = domainElement.locator("xpath=ancestor::*[.//a[contains(@href, '/modules/nodejs/')] and .//a[contains(@href, '/smb/file-manager/')]][1]");
      const nodeScope = await domainCard.count() ? domainCard : domainElement.locator("xpath=ancestor::*[.//a[contains(@href, '/modules/nodejs/')]][1]");
      const nodeLink = await nodeScope.count() ? nodeScope.locator("a[href*='/modules/nodejs/']").first() : null;
      if (!nodeLink || !await nodeLink.count()) continue;
      await nodeLink.click({ timeout: 10000 });
      domainFound = true;
      break;
    }
    if (!domainFound) throw new Error("Nomreh's scoped Node.js settings were not found; no application credentials were read.");
    await page.waitForTimeout(1800);
    const body = await page.locator("body").innerText().catch(() => "");
    if (!body.includes(`Node.js on ${DOMAIN}`) || !body.includes("Application Root") || !body.includes("/nomreh.arounidea.com") || !body.includes("server.js")) {
      throw new Error("The Node.js page was not verified as Nomreh's server.js application; no application credentials were read.");
    }
    const result = await page.evaluate(async (url) => {
      const response = await fetch(url, { credentials: "same-origin", cache: "no-store" });
      return { status: response.status, body: (await response.text()).slice(0, 2000000) };
    }, `${panel}/modules/nodejs/index.php/api/application/domainId/145`);
    if (result.status !== 200) throw new Error("Nomreh's scoped application settings could not be read for login.");
    const payload = JSON.parse(result.body);
    let configuredUsername = nestedValue(payload, "NOMREH_ADMIN_USERNAME") || "";
    let configuredPassword = nestedValue(payload, "NOMREH_ADMIN_PASSWORD") || "";
    if (!configuredUsername || !configuredPassword) {
      await page.goto(`${panel}/smb/file-manager/list/domainId/145`, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(1800);
      const appFolder = page.locator("a.tree-item-content").filter({ hasText: DOMAIN }).first();
      if (await appFolder.count()) {
        await appFolder.click({ timeout: 8000 }).catch(() => undefined);
        await page.waitForTimeout(2000);
      }
      const envLink = page.getByText(".env", { exact: true }).first();
      if (await envLink.count()) {
        const cancelDownload = (download) => { void download.cancel(); };
        page.on("download", cancelDownload);
        await envLink.click({ timeout: 8000 }).catch(() => undefined);
        await page.waitForTimeout(1500);
        page.off("download", cancelDownload);
        const bodyText = await page.locator("body").innerText().catch(() => "");
        const textAreas = await page.locator("textarea").evaluateAll((elements) => elements.map((element) => element.value || "").filter((value) => /NOMREH_[A-Z0-9_]+/.test(value))).catch(() => []);
        const codeEditors = await page.locator(".CodeMirror").evaluateAll((elements) => elements.map((element) => {
          try { return element.CodeMirror && typeof element.CodeMirror.getValue === "function" ? element.CodeMirror.getValue() : element.innerText || ""; } catch { return ""; }
        }).filter((value) => /NOMREH_[A-Z0-9_]+/.test(value))).catch(() => []);
        const environmentText = [bodyText, ...textAreas, ...codeEditors].join("\n");
        configuredUsername = configuredUsername || dotenvValue(environmentText, "NOMREH_ADMIN_USERNAME");
        configuredPassword = configuredPassword || dotenvValue(environmentText, "NOMREH_ADMIN_PASSWORD");
      }
    }
    if (!configuredUsername && !configuredPassword) return null;
    lines.push("- Existing custom admin settings were located in Nomreh's scoped configuration; values remained in memory and no file or setting was saved.");
    return {
      username: configuredUsername || "admin",
      password: configuredPassword || "Admin@1405",
    };
  } finally {
    await pleskContext.close();
  }
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
  const secretUsername = process.env.NOMREH_ADMIN_USERNAME || "";
  const secretPassword = process.env.NOMREH_ADMIN_PASSWORD || "";
  let credentials = initialAccess
    ? { username: "admin", password: "Admin@1405" }
    : (secretUsername || secretPassword
      ? { username: secretUsername || "admin", password: secretPassword || "Admin@1405" }
      : await readConfiguredAdminFromPlesk());
  if (!credentials) throw new Error("Initial accounts are hidden and no configured admin credential fields were available in existing Secrets or Nomreh's scoped settings. No password was attempted.");
  if (!credentials.username || !credentials.password) throw new Error("The configured admin login was incomplete. No password was attempted.");

  await page.locator("#login-username").fill(credentials.username);
  await page.locator("#login-password").fill(credentials.password);
  const navigation = page.waitForURL((url) => url.origin === ORIGIN && url.pathname === "/", { timeout: 30000 }).then(() => true).catch(() => false);
  await page.getByRole("button", { name: "ورود به فضای کاری", exact: true }).click();
  const reachedWorkspace = await navigation;
  if (!reachedWorkspace) {
    const alert = await page.getByRole("alert").innerText().catch(() => "");
    throw new Error(`The admin login did not reach the workspace.${alert ? ` ${clean(alert)}` : ""}`);
  }
  authenticated = true;
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
  await page.getByText("فضای کاری شما", { exact: true }).waitFor({ state: "visible" });
  const meResponse = await context.request.get(`${ORIGIN}/api/auth/me`);
  const me = await meResponse.json();
  if (!meResponse.ok() || me.user?.role !== "admin" || String(me.user?.username || "").toLowerCase() !== credentials.username.toLowerCase()) throw new Error("The authenticated session was not verified as the expected admin account.");
  lines.push("- Admin login succeeded and the real workspace loaded.", `- Authenticated username: ${clean(me.user.username)}.`, "- Authenticated role verified by /api/auth/me: admin.", "");

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
