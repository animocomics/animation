#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { chromium } = require("playwright");
const { normalizePanelUrl } = require("./plesk-api-diagnostics.cjs");

const ORIGIN = "https://nomreh.arounidea.com";
const DOMAIN = "nomreh.arounidea.com";
const OUTPUT = process.env.NOMREH_E2E_OUTPUT || "";
const lines = ["# Nomreh admin login and configuration readiness", "", "This check uses the authorized demo account, the publicly offered initial account, or existing configured admin credentials in memory. It never prints credentials or session cookies, and it does not save API settings or change Shecan.", ""];
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

function nestedAccountVariableNames(payload) {
  const names = new Set();
  let visited = 0;
  const search = (value, depth = 0) => {
    if (!value || depth > 9 || visited > 6000) return;
    visited += 1;
    if (Array.isArray(value)) {
      for (const entry of value) search(entry, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    for (const key of Object.keys(value)) {
      if (/^NOMREH_(?:ADMIN|TEACHER)_(?:USERNAME|PASSWORD)$/.test(key)) names.add(key);
    }
    const name = value.name ?? value.key ?? value.variable ?? value.variable_name;
    if (typeof name === "string" && /^NOMREH_(?:ADMIN|TEACHER)_(?:USERNAME|PASSWORD)$/.test(name)) names.add(name);
    for (const entry of Object.values(value)) search(entry, depth + 1);
  };
  search(payload);
  return [...names].sort();
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

async function readAdminFromNodeDom(page) {
  return page.evaluate(() => {
    const keys = ["NOMREH_ADMIN_USERNAME", "NOMREH_ADMIN_PASSWORD"];
    const result = { values: {}, visibleKeys: [], controls: [] };
    const controls = Array.from(document.querySelectorAll("a, button"));
    result.controls = [...new Set(controls.map((element) => (element.textContent || "").trim().replace(/\s+/g, " ")).filter((text) => /^(Add Variable|Edit|Show|Hide|Environment Variables|Save)$/i.test(text)))].slice(0, 20);
    const usable = (value, key) => Boolean(value && value !== key && !/^[•*.\s]+$/.test(value) && !/^(Show|Hide|Save|Edit)$/i.test(value));
    const companionValue = (element, key) => {
      let current = element;
      for (let depth = 0; current && depth < 7; depth += 1, current = current.parentElement) {
        const candidates = Array.from(current.querySelectorAll("input, textarea"));
        for (const candidate of candidates) {
          if (candidate === element || /^(checkbox|radio|submit|button|hidden)$/i.test(candidate.type || "")) continue;
          if (usable(candidate.value, key)) return candidate.value;
        }
        const dataValues = Array.from(current.querySelectorAll("[data-value]"));
        for (const candidate of dataValues) {
          const value = candidate.getAttribute("data-value") || "";
          if (usable(value, key)) return value;
        }
      }
      return "";
    };
    for (const key of keys) {
      const inputs = Array.from(document.querySelectorAll("input, textarea"));
      const namedValue = inputs.find((input) => `${input.name || ""} ${input.id || ""} ${input.getAttribute("data-name") || ""}`.includes(key) && usable(String(input.value || ""), key));
      if (namedValue) {
        result.visibleKeys.push(key);
        result.values[key] = namedValue.value;
        continue;
      }
      let marker = inputs.find((input) => String(input.value || "").trim() === key);
      if (!marker) {
        marker = Array.from(document.querySelectorAll("label, td, th, span, div")).find((element) => element.children.length === 0 && (element.textContent || "").trim() === key);
      }
      if (marker) {
        result.visibleKeys.push(key);
        const value = companionValue(marker, key);
        if (value) result.values[key] = value;
      }
    }
    return result;
  });
}

async function readConfiguredAdminFromPlesk() {
  if (!process.env.PLESK_PANEL_URL || !process.env.PLESK_API_USERNAME || !process.env.PLESK_API_PASSWORD) return null;
  const panel = normalizePanelUrl(process.env.PLESK_PANEL_URL);
  const pleskContext = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1500, height: 1000 } });
  try {
    const page = await pleskContext.newPage();
    page.setDefaultTimeout(18000);
    const scopedPayloads = [];
    const scopedResponseReads = [];
    let captureNodeResponses = false;
    page.on("response", (response) => {
      if (!captureNodeResponses || !response.url().includes("/modules/nodejs/index.php/api/")) return;
      const contentType = response.headers()["content-type"] || "";
      if (!/json|text\/plain/i.test(contentType)) return;
      const read = response.text().then((text) => {
        if (text.length > 2000000 || scopedPayloads.length >= 30) return;
        try { scopedPayloads.push(JSON.parse(text)); } catch { /* Non-JSON endpoint response. */ }
      }).catch(() => undefined);
      scopedResponseReads.push(read);
    });
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
      captureNodeResponses = true;
      await nodeLink.click({ timeout: 10000 });
      domainFound = true;
      break;
    }
    if (!domainFound) throw new Error("Nomreh's scoped Node.js settings were not found; no application credentials were read.");
    await page.waitForTimeout(1800);
    await page.getByText("Application Root", { exact: true }).waitFor({ state: "visible", timeout: 15000 }).catch(() => undefined);
    const body = await page.locator("body").innerText().catch(() => "");
    if (!body.includes(`Node.js on ${DOMAIN}`) || !body.includes("Application Root") || !body.includes("/nomreh.arounidea.com") || !body.includes("server.js")) {
      throw new Error("The Node.js page was not verified as Nomreh's server.js application; no application credentials were read.");
    }
    const scopedFileManagerHref = await page.locator("a[href*='/smb/file-manager/']").evaluateAll((anchors) => {
      const match = anchors.map((anchor) => anchor.getAttribute("href") || "").find((href) => /domainId(?:\/|=)145(?:\D|$)/.test(href));
      return match || "";
    }).catch(() => "");
    const scopedFileManagerUrl = scopedFileManagerHref ? new URL(scopedFileManagerHref, page.url()).toString() : "";
    const result = await page.evaluate(async (url) => {
      const response = await fetch(url, { credentials: "same-origin", cache: "no-store" });
      return { status: response.status, body: (await response.text()).slice(0, 2000000) };
    }, `${panel}/modules/nodejs/index.php/api/application/domainId/145`);
    if (result.status !== 200) throw new Error("Nomreh's scoped application settings could not be read for login.");
    const payload = JSON.parse(result.body);
    let configuredUsername = nestedValue(payload, "NOMREH_ADMIN_USERNAME") || "";
    let configuredPassword = nestedValue(payload, "NOMREH_ADMIN_PASSWORD") || "";
    const applyCapturedAdmin = () => {
      for (const captured of scopedPayloads) {
        configuredUsername = configuredUsername || nestedValue(captured, "NOMREH_ADMIN_USERNAME") || "";
        configuredPassword = configuredPassword || nestedValue(captured, "NOMREH_ADMIN_PASSWORD") || "";
      }
    };
    await Promise.allSettled([...scopedResponseReads]);
    applyCapturedAdmin();
    const accountVariableNames = new Set(nestedAccountVariableNames(payload));
    for (const captured of scopedPayloads) for (const name of nestedAccountVariableNames(captured)) accountVariableNames.add(name);
    lines.push(`- Scoped Node.js JSON responses inspected in memory: ${scopedPayloads.length}.`);
    lines.push(`- Account variable names present in scoped configuration: ${accountVariableNames.size ? [...accountVariableNames].sort().join(", ") : "none"}.`);
    if (!configuredUsername || !configuredPassword) {
      lines.push(`- Scoped application API admin fields available: ${configuredUsername || configuredPassword ? "partially" : "no"}.`);
      const dom = await readAdminFromNodeDom(page);
      lines.push(`- Relevant environment variable names visible in scoped Node.js view: ${dom.visibleKeys.length ? dom.visibleKeys.join(", ") : "none"}.`);
      lines.push(`- Admin credential values readable in scoped environment view: username=${dom.values.NOMREH_ADMIN_USERNAME ? "yes" : "no"}; password=${dom.values.NOMREH_ADMIN_PASSWORD ? "yes" : "no"}.`);
      lines.push(`- Relevant environment view controls: ${dom.controls.length ? dom.controls.join(", ") : "none identified"}.`);
      configuredUsername = configuredUsername || dom.values.NOMREH_ADMIN_USERNAME || "";
      configuredPassword = configuredPassword || dom.values.NOMREH_ADMIN_PASSWORD || "";
      if (!configuredUsername || !configuredPassword) {
        const editControls = page.locator("a, button").filter({ hasText: /^\s*edit\s*$/i });
        const editCount = await editControls.count();
        lines.push(`- Scoped Edit controls available for read-only inspection: ${editCount}.`);
        if (editCount) {
          await editControls.first().click({ timeout: 10000 });
          await page.waitForTimeout(1800);
          await Promise.allSettled([...scopedResponseReads]);
          applyCapturedAdmin();
          const editDom = await readAdminFromNodeDom(page);
          lines.push(`- Scoped Node.js JSON responses inspected after opening Edit: ${scopedPayloads.length}.`);
          lines.push(`- Relevant environment variable names visible after opening Edit: ${editDom.visibleKeys.length ? editDom.visibleKeys.join(", ") : "none"}.`);
          lines.push(`- Admin credential values readable after opening Edit: username=${editDom.values.NOMREH_ADMIN_USERNAME ? "yes" : "no"}; password=${editDom.values.NOMREH_ADMIN_PASSWORD ? "yes" : "no"}.`);
          lines.push(`- Controls visible after opening Edit: ${editDom.controls.length ? editDom.controls.join(", ") : "none identified"}. No Save or Apply control was used.`);
          configuredUsername = configuredUsername || editDom.values.NOMREH_ADMIN_USERNAME || "";
          configuredPassword = configuredPassword || editDom.values.NOMREH_ADMIN_PASSWORD || "";
        }
      }
    }
    if (!configuredUsername || !configuredPassword) {
      lines.push(`- File Manager link taken from the verified scoped Node.js page: ${scopedFileManagerUrl ? "yes" : "no; scoped numeric fallback used"}.`);
      await page.goto(scopedFileManagerUrl || `${panel}/smb/file-manager/list/domainId/145`, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(2500);
      const appFolder = page.locator("a.tree-item-content").filter({ hasText: DOMAIN }).first();
      if (await appFolder.count()) {
        await appFolder.evaluate((element) => element.click()).catch(() => undefined);
        await page.waitForTimeout(3000);
      }
      const fileManagerLocation = new URL(page.url());
      lines.push(`- Scoped File Manager location: ${clean(`${fileManagerLocation.pathname}${fileManagerLocation.search}`)}.`);
      const knownEntries = [];
      for (const name of ["server.js", "package.json", "public", DOMAIN]) {
        if (await page.getByText(name, { exact: true }).count()) knownEntries.push(name);
      }
      lines.push(`- Known entries visible at the inspected scoped File Manager location: ${knownEntries.length ? knownEntries.join(", ") : "none"}.`);
      let serverFileHref = await page.locator("a").evaluateAll((anchors) => {
        const match = anchors.find((anchor) => (anchor.textContent || "").trim().replace(/\s+/g, " ") === "server.js");
        return match ? match.getAttribute("href") || "" : "";
      }).catch(() => "");
      const environmentFileNames = [".env", ".env.local", ".env.production", ".env.production.local"];
      const visibleEnvironmentFiles = [];
      for (const name of environmentFileNames) {
        if (await page.getByText(name, { exact: true }).count()) visibleEnvironmentFiles.push(name);
      }
      lines.push(`- Environment files visible in the scoped File Manager: ${visibleEnvironmentFiles.length ? visibleEnvironmentFiles.join(", ") : "none"}.`);
      const envLink = visibleEnvironmentFiles.length ? page.getByText(visibleEnvironmentFiles[0], { exact: true }).first() : null;
      if (envLink) {
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
        lines.push(`- Environment editor sources containing Nomreh variable names: body=${/NOMREH_[A-Z0-9_]+/.test(bodyText) ? "yes" : "no"}; textareas=${textAreas.length}; code-editors=${codeEditors.length}.`);
        lines.push(`- Admin fields parsed from the in-memory environment view: username=${configuredUsername ? "yes" : "no"}; password=${configuredPassword ? "yes" : "no"}.`);
      }
      if ((!configuredUsername || !configuredPassword) && (!serverFileHref || /^(?:javascript:|data:|#)/i.test(serverFileHref))) {
        const serverFileLink = page.locator("a").filter({ hasText: /^\s*server\.js\s*$/ }).first();
        if (await serverFileLink.count()) {
          const downloadPromise = page.waitForEvent("download", { timeout: 8000 }).catch(() => null);
          const responsePromise = page.waitForResponse((response) => response.url().includes("server.js"), { timeout: 8000 }).catch(() => null);
          await serverFileLink.click({ timeout: 8000 }).catch(() => undefined);
          const [download, response] = await Promise.all([downloadPromise, responsePromise]);
          if (download) {
            serverFileHref = download.url();
            await download.cancel().catch(() => undefined);
          } else if (response) {
            serverFileHref = response.url();
          } else if (page.url().includes("server.js")) {
            serverFileHref = page.url();
          }
          lines.push(`- Scoped server.js read target acquired without saving a download: ${serverFileHref && !/^(?:javascript:|data:|#)/i.test(serverFileHref) ? "yes" : "no"}.`);
        }
      }
      if ((!configuredUsername || !configuredPassword) && serverFileHref && !/^(?:javascript:|data:|#)/i.test(serverFileHref)) {
        lines.push("- Read-only hidden-environment lookup derived from the scoped server.js file link: yes.");
        for (const name of environmentFileNames) {
          if (configuredUsername && configuredPassword) break;
          const derivedHref = serverFileHref.replace(/server\.js/g, name);
          if (derivedHref === serverFileHref) continue;
          const target = new URL(derivedHref, fileManagerLocation);
          if (target.origin !== new URL(panel).origin) continue;
          const result = await page.evaluate(async (url) => {
            try {
              const response = await fetch(url, { credentials: "same-origin", cache: "no-store" });
              const text = (await response.text()).slice(0, 2000000);
              const candidates = [text];
              try {
                const parsed = JSON.parse(text);
                let visited = 0;
                const collect = (value) => {
                  if (visited++ > 4000 || candidates.length >= 20) return;
                  if (typeof value === "string") candidates.push(value);
                  else if (Array.isArray(value)) for (const entry of value) collect(entry);
                  else if (value && typeof value === "object") for (const entry of Object.values(value)) collect(entry);
                };
                collect(parsed);
              } catch { /* HTML or raw environment content. */ }
              if (/<(?:html|textarea|body|pre)\b/i.test(text)) {
                const documentNode = new DOMParser().parseFromString(text, "text/html");
                candidates.push(documentNode.body?.innerText || "");
                for (const area of documentNode.querySelectorAll("textarea")) candidates.push(area.value || "");
              }
              return { status: response.status, texts: [...new Set(candidates.filter((value) => /NOMREH_[A-Z0-9_]+/.test(value)).map((value) => value.slice(0, 2000000)))].slice(0, 20) };
            } catch {
              return { status: 0, texts: [] };
            }
          }, target.toString());
          for (const text of result.texts) {
            configuredUsername = configuredUsername || dotenvValue(text, "NOMREH_ADMIN_USERNAME");
            configuredPassword = configuredPassword || dotenvValue(text, "NOMREH_ADMIN_PASSWORD");
          }
          lines.push(`- Scoped ${name} read: HTTP ${result.status}; Nomreh environment content=${result.texts.length ? "yes" : "no"}; admin username=${configuredUsername ? "yes" : "no"}; admin password=${configuredPassword ? "yes" : "no"}. No file was saved.`);
        }
      }
    }
    if (!configuredUsername || !configuredPassword) return null;
    lines.push("- Existing custom admin settings were located in Nomreh's scoped configuration; values remained in memory and no file or setting was saved.");
    return { username: configuredUsername, password: configuredPassword };
  } finally {
    await pleskContext.close();
  }
}

async function testTeacherAccess() {
  lines.push("## Teacher workspace and access boundaries", "");
  if (process.env.NOMREH_ALLOW_DEMO_ACCOUNTS !== "1") {
    lines.push("- Demo teacher access test was not authorized for this run; skipped.");
    return;
  }
  const teacherContext = await browser.newContext({ ignoreHTTPSErrors: false, viewport: { width: 1440, height: 1000 } });
  let teacherAuthenticated = false;
  let teacherLoggedOut = false;
  try {
    const login = await teacherContext.request.post(`${ORIGIN}/api/auth/login`, { data: { username: "teacher", password: "Teacher@1405" } });
    lines.push(`- Demo teacher login API HTTP status: ${login.status()}.`);
    if (!login.ok()) throw new Error("The documented demo teacher login was rejected.");
    teacherAuthenticated = true;
    const meResponse = await teacherContext.request.get(`${ORIGIN}/api/auth/me`);
    const me = await meResponse.json().catch(() => ({}));
    if (!meResponse.ok() || me.user?.role !== "teacher") throw new Error("The demo teacher session was not verified with the teacher role.");
    lines.push("- Teacher session and role verified by /api/auth/me.");

    const teacherPage = await teacherContext.newPage();
    teacherPage.setDefaultTimeout(20000);
    const workspaceResponse = await teacherPage.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await teacherPage.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => undefined);
    await teacherPage.locator(".workspace-loading").waitFor({ state: "hidden", timeout: 20000 }).catch(() => undefined);
    await teacherPage.getByRole("heading", { name: "داشبورد", exact: true }).waitFor({ state: "visible" });
    if (!workspaceResponse || workspaceResponse.status() !== 200) throw new Error("The teacher workspace did not load successfully.");
    if (await teacherPage.getByRole("link", { name: "مدیریت سامانه", exact: true }).count()) throw new Error("The teacher navigation exposed the admin area.");
    lines.push("- Teacher dashboard loaded without an admin navigation link.");

    const adminPage = await teacherPage.goto(`${ORIGIN}/admin`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await teacherPage.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => undefined);
    const finalPath = new URL(teacherPage.url()).pathname;
    if (!adminPage || adminPage.status() !== 200 || finalPath !== "/") throw new Error("The teacher was not redirected away from /admin.");
    if (await teacherPage.getByText("پیکربندی سراسری مدل", { exact: true }).count()) throw new Error("The teacher could see provider configuration content.");
    lines.push("- Direct teacher access to /admin redirected to the ordinary dashboard; provider configuration was not exposed.");

    const adminChecks = [
      ["/api/admin/users", "account management"],
      ["/api/admin/usage", "usage reporting"],
      ["/api/admin/api-network", "Shecan configuration"],
    ];
    for (const [pathname, label] of adminChecks) {
      const response = await teacherContext.request.get(`${ORIGIN}${pathname}`);
      lines.push(`- Teacher ${label} API: HTTP ${response.status()}.`);
      if (response.status() !== 403) throw new Error(`Teacher access to ${label} was not rejected with HTTP 403.`);
    }
    const provider = await teacherContext.request.get(`${ORIGIN}/api/provider`);
    const providerPayload = await provider.json().catch(() => ({}));
    if (!provider.ok() || !providerPayload.status || providerPayload.status.keyHint !== undefined) throw new Error("The teacher provider status was unavailable or exposed a key hint.");
    lines.push("- Teacher provider status is available without any API-key hint.");

    await teacherPage.goto(`${ORIGIN}/settings`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await teacherPage.locator(".workspace-loading").waitFor({ state: "hidden", timeout: 20000 }).catch(() => undefined);
    if (await teacherPage.locator("#admin-api-key, #shecan-update-url").count()) throw new Error("Teacher settings exposed admin credential fields.");
    lines.push("- Teacher settings contain no admin API-key or Shecan update-link fields.");

    const teacherWorkspace = await teacherContext.request.get(`${ORIGIN}/api/workspace`);
    if (!teacherWorkspace.ok()) throw new Error("The teacher workspace read API was not available.");
    const forbiddenProviderSave = await teacherContext.request.put(`${ORIGIN}/api/provider`, { data: {} });
    if (forbiddenProviderSave.status() !== 403) throw new Error("A teacher provider save was not rejected with HTTP 403.");
    lines.push("- Teacher workspace API remains available; provider save is read-only for the teacher (HTTP 403).");

    await teacherPage.goto(`${ORIGIN}/review`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await teacherPage.locator(".workspace-loading").waitFor({ state: "hidden", timeout: 20000 }).catch(() => undefined);
    await teacherPage.getByRole("heading", { name: "بازبینی نمرات", exact: true }).first().waitFor({ state: "visible" });
    const scoreInputs = teacherPage.locator('input[aria-label^="نمرهٔ سؤال"]');
    if (await scoreInputs.count() < 1) throw new Error("The teacher review page exposed no question score inputs.");
    if (await teacherPage.locator(".question-score-actions").count() < 1) throw new Error("The teacher review page exposed no explicit score-saving action.");
    lines.push(`- Teacher review loaded with ${await scoreInputs.count()} question score input(s) and explicit save controls.`);
    const identityMeta = await teacherPage.locator(".identity-detection-meta").innerText();
    if (!identityMeta.includes("کد دانش‌آموزی روی برگه")) throw new Error("The review identity card does not expose the student code read from the paper.");
    if (await teacherPage.locator(".criterion-result-table").count() < 1) throw new Error("The review page does not expose per-criterion score rows.");
    lines.push("- Review shows the paper student-code field and explicit per-criterion scoring rows.");

    // Exercise the new controls without allowing this read-only readiness session
    // to persist a draft or a score change to the teacher workspace.
    await teacherPage.route("**/api/workspace", async (route) => {
      if (route.request().method() !== "GET") return route.abort();
      return route.continue();
    });
    const teacherClientErrors = [];
    teacherPage.on("pageerror", (error) => teacherClientErrors.push(error.message));
    await teacherPage.goto(`${ORIGIN}/grading`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await teacherPage.locator(".workspace-loading").waitFor({ state: "hidden", timeout: 20000 }).catch(() => undefined);
    await teacherPage.locator("#exam-pass-score").waitFor({ state: "visible" });
    if (await teacherPage.locator('input[type="date"]').count()) throw new Error("A native Gregorian date input is still exposed in the exam wizard.");
    if (await teacherPage.locator("#exam-date").evaluate((element) => element.tagName) !== "BUTTON") throw new Error("The exam date is not the Persian calendar trigger.");
    const passHint = await teacherPage.locator(".form-field:has(#exam-pass-score) .form-hint").innerText();
    if (!passHint.includes("نمرهٔ قبولی") || passHint.includes("نمره فعلی")) throw new Error("The pass-score explanation is unclear or still contains the rejected wording.");
    const passInput = teacherPage.locator("#exam-pass-score");
    const originalPass = await passInput.inputValue();
    await passInput.fill("");
    if (await passInput.inputValue() !== "") throw new Error("Clearing the pass-score field did not preserve an empty editing state.");
    await passInput.press("Tab");
    if (await passInput.inputValue() !== originalPass) throw new Error("Clearing and leaving the pass-score field unexpectedly changed its value.");
    await passInput.fill("۰٫۵");
    if (await passInput.inputValue() !== "۰٫۵") throw new Error("Persian fractional digits were not preserved in the numeric field.");
    await passInput.fill(originalPass);
    await passInput.press("Tab");
    await teacherPage.locator("#exam-date").click();
    const calendar = teacherPage.getByRole("dialog", { name: "تقویم شمسی", exact: true });
    await calendar.waitFor({ state: "visible" });
    if (await calendar.locator(".persian-calendar-weekdays span").count() !== 7) throw new Error("The Persian calendar does not contain a seven-day week.");
    if (await calendar.locator(".persian-calendar-days button").count() < 28) throw new Error("The Persian calendar did not render its month days.");
    await teacherPage.locator("#exam-date").click();
    lines.push("- Exam wizard uses a Persian calendar, clearable numeric editing, Persian fractional digits, and a meaningful pass-score explanation; workspace writes were blocked during these checks.");

    await teacherPage.goto(`${ORIGIN}/review`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await teacherPage.locator(".workspace-loading").waitFor({ state: "hidden", timeout: 20000 }).catch(() => undefined);
    const editableScore = teacherPage.locator('input[aria-label^="نمرهٔ سؤال"]').first();
    const originalScore = await editableScore.inputValue();
    await editableScore.fill("");
    if (await editableScore.inputValue() !== "") throw new Error("Clearing a review score did not preserve an empty editing state.");
    await editableScore.press("Tab");
    if (await editableScore.inputValue() !== originalScore) throw new Error("Clearing and leaving a review score changed it unexpectedly.");
    if (teacherClientErrors.length) throw new Error(`The new teacher controls caused a browser error: ${teacherClientErrors[0]}`);
    await teacherPage.unroute("**/api/workspace");
    lines.push("- Review score clearing/restoration passed without a forced blank-to-zero mutation or browser JavaScript error.");

    const logoutResponse = await teacherContext.request.post(`${ORIGIN}/api/auth/logout`);
    if (!logoutResponse.ok()) throw new Error("The teacher test session could not be closed cleanly.");
    teacherLoggedOut = true;
    lines.push(`- Teacher test session closed: HTTP ${logoutResponse.status()}.`, "");
  } finally {
    if (teacherAuthenticated && !teacherLoggedOut) await teacherContext.request.post(`${ORIGIN}/api/auth/logout`).catch(() => undefined);
    await teacherContext.close();
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
  let loginScriptCount = 0;
  const loginScriptFailures = [];
  const loginClientErrors = [];
  page.on("response", (response) => {
    if (response.request().resourceType() !== "script") return;
    if (response.status() >= 400) loginScriptFailures.push(`${new URL(response.url()).pathname} (HTTP ${response.status()})`);
    else loginScriptCount += 1;
  });
  page.on("pageerror", (error) => { if (loginClientErrors.length < 10) loginClientErrors.push(clean(error.message)); });

  lines.push("## Real admin login", "");
  const loginResponse = await page.goto(`${ORIGIN}/login`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
  lines.push(`- Login page HTTP status: ${loginResponse ? loginResponse.status() : "unavailable"}.`);
  await page.getByRole("heading", { name: "به نمره خوش آمدید" }).waitFor({ state: "visible" });
  const initialAccess = await page.getByText("دسترسی اولیهٔ نصب", { exact: true }).count();
  lines.push(`- Publicly offered initial installation accounts: ${initialAccess ? "yes" : "no"}.`);
  lines.push(`- Login JavaScript assets loaded successfully: ${loginScriptCount}; failed: ${loginScriptFailures.length}.`);
  if (loginScriptFailures.length) lines.push(`- Failed login script assets: ${loginScriptFailures.slice(0, 5).join(", ")}.`);
  lines.push(`- Browser JavaScript page errors before login: ${loginClientErrors.length}.`);
  const secretUsername = process.env.NOMREH_ADMIN_USERNAME || "";
  const secretPassword = process.env.NOMREH_ADMIN_PASSWORD || "";
  const demoAccountsAllowed = process.env.NOMREH_ALLOW_DEMO_ACCOUNTS === "1";
  const credentials = secretUsername || secretPassword
    ? { username: secretUsername, password: secretPassword }
    : (initialAccess || demoAccountsAllowed
      ? { username: "admin", password: "Admin@1405" }
      : await readConfiguredAdminFromPlesk());
  lines.push(`- Authorized demo admin login requested: ${demoAccountsAllowed && !secretUsername && !secretPassword ? "yes" : "no"}.`);
  if (!credentials) throw new Error("Initial accounts are hidden and no configured admin credential fields were available in existing Secrets or Nomreh's scoped settings. No password was attempted.");
  if (!credentials.username || !credentials.password) throw new Error("The configured admin login was incomplete. No password was attempted.");

  await page.locator("#login-username").fill(credentials.username);
  await page.locator("#login-password").fill(credentials.password);
  const navigation = page.waitForURL((url) => url.origin === ORIGIN && (url.pathname === "/" || url.pathname === "/admin"), { timeout: 45000 }).then(() => true).catch(() => false);
  const loginApiPromise = page.waitForResponse((response) => response.url() === `${ORIGIN}/api/auth/login` && response.request().method() === "POST", { timeout: 20000 }).catch(() => null);
  await page.getByRole("button", { name: "ورود به فضای کاری", exact: true }).click();
  let usedDirectLogin = false;
  let loginApiResponse = await loginApiPromise;
  lines.push(`- Browser-form login API HTTP status: ${loginApiResponse ? loginApiResponse.status() : "not observed"}.`);
  if (!loginApiResponse) {
    const alert = await page.getByRole("alert").innerText().catch(() => "");
    lines.push(`- Browser form current path after submit: ${new URL(page.url()).pathname}; alert present: ${alert ? "yes" : "no"}; JavaScript page errors: ${loginClientErrors.length}.`);
    if (loginClientErrors.length) lines.push(`- First browser error: ${loginClientErrors[0]}.`);
    usedDirectLogin = true;
    loginApiResponse = await context.request.post(`${ORIGIN}/api/auth/login`, { data: { username: credentials.username, password: credentials.password } });
    lines.push(`- Direct domain login API HTTP status: ${loginApiResponse.status()}.`);
  }
  const loginPayload = await loginApiResponse.json().catch(() => ({}));
  if (!loginApiResponse.ok()) throw new Error(`Admin login was rejected: HTTP ${loginApiResponse.status()}.${loginPayload.error ? ` ${clean(loginPayload.error)}` : ""}`);
  authenticated = true;

  const meResponse = await context.request.get(`${ORIGIN}/api/auth/me`);
  const me = await meResponse.json().catch(() => ({}));
  lines.push(`- Authenticated-session verification HTTP status: ${meResponse.status()}.`);
  if (!meResponse.ok() || me.user?.role !== "admin" || String(me.user?.username || "").toLowerCase() !== credentials.username.toLowerCase()) throw new Error("The authenticated session was not verified as the expected admin account.");

  const reachedWorkspace = usedDirectLogin ? false : await navigation;
  if (!reachedWorkspace || new URL(page.url()).pathname !== "/admin") {
    await page.goto(`${ORIGIN}/admin`, { waitUntil: "domcontentloaded", timeout: 30000 });
    lines.push("- The authenticated management area required explicit navigation after login.");
  }
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
  await page.getByRole("heading", { name: "مدیریت سامانهٔ نمره" }).waitFor({ state: "visible" });
  if (await page.getByRole("link", { name: "کلاس‌ها و دانش‌آموزان", exact: true }).count() || await page.getByRole("link", { name: "آزمون جدید", exact: true }).count()) throw new Error("Admin navigation exposed teacher workspace links.");
  lines.push("- Admin login succeeded and the management-only area loaded without class or exam navigation.", `- Authenticated username: ${clean(me.user.username)}.`, "- Authenticated role verified by /api/auth/me: admin.", "");

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

  lines.push("## Management-only routes and read APIs", "");
  const workspaceApi = await context.request.get(`${ORIGIN}/api/workspace`);
  if (workspaceApi.status() !== 403) throw new Error("Admin workspace read was not rejected with HTTP 403.");
  const workspaceContentApiChecks = [
    ["POST", "/api/files", "file upload"],
    ["POST", "/api/grade", "grading"],
    ["POST", "/api/grading/import", "question import"],
  ];
  for (const [method, pathname, label] of workspaceContentApiChecks) {
    const response = await context.request.fetch(`${ORIGIN}${pathname}`, { method, data: method === "POST" ? {} : undefined });
    lines.push(`- Admin ${label} API: HTTP ${response.status()}.`);
    if (response.status() !== 403) throw new Error(`Admin ${label} API was not rejected with HTTP 403.`);
  }
  lines.push("- Admin workspace read API: HTTP 403; no class, student, exam, or grading data is exposed.");
  const usageApi = await context.request.get(`${ORIGIN}/api/admin/usage`);
  const usagePayload = await usageApi.json().catch(() => ({}));
  if (!usageApi.ok() || typeof usagePayload.summary?.jobs !== "number") throw new Error("The admin usage reporting API was not operational.");
  lines.push(`- Admin usage API: HTTP ${usageApi.status()}; ${usagePayload.summary.jobs} recorded job(s) reported without student content.`);

  const workspacePages = [
    ["/", "داشبورد"],
    ["/classes", "کلاس‌ها و دانش‌آموزان"],
    ["/exams", "آزمون‌های من"],
    ["/grading", "آزمون جدید"],
    ["/review", "بازبینی نمرات"],
    ["/reports", "گزارش و تحلیل"],
    ["/settings", "تنظیمات"],
    ["/help", "راهنمای نمره"],
  ];
  for (const [pathname, title] of workspacePages) {
    const scriptFailuresBefore = loginScriptFailures.length;
    const clientErrorsBefore = loginClientErrors.length;
    const response = await page.goto(`${ORIGIN}${pathname}`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
    await page.locator(".workspace-loading").waitFor({ state: "hidden", timeout: 20000 }).catch(() => undefined);
    await page.getByRole("heading", { name: "مدیریت سامانهٔ نمره", exact: true }).waitFor({ state: "visible" });
    if (!response || response.status() !== 200 || new URL(page.url()).pathname !== "/admin") throw new Error(`Admin was not redirected from ${title} to management.`);
    if (await page.locator(".workspace-loading:visible").count()) throw new Error(`${title} remained on the workspace loading screen.`);
    if (await page.getByText(/Application error|فضای کاری بارگذاری نشد|خطای غیرمنتظره/).count()) throw new Error(`${title} displayed an application or workspace error.`);
    if (loginScriptFailures.length > scriptFailuresBefore) throw new Error(`${title} loaded a failed JavaScript asset: ${loginScriptFailures[loginScriptFailures.length - 1]}.`);
    if (loginClientErrors.length > clientErrorsBefore) throw new Error(`${title} caused a browser JavaScript error: ${loginClientErrors[loginClientErrors.length - 1]}.`);
    lines.push(`- Admin ${title}: redirected to /admin with HTTP 200 and no teacher content.`);
  }

  await logout();
  await testTeacherAccess();
  lines.push("", "## Result", "", "Real admin login, management-only routes and APIs, provider controls, GLM 5.3 Flash, Shecan configuration controls, teacher workspace/review scoring, and teacher access boundaries are operational. External provider-key validity and Shecan activation were not changed or tested; no real grading job was run without a configured provider.");
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
