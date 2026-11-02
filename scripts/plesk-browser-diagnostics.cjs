#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { chromium } = require("playwright");
const { normalizePanelUrl, redact } = require("./plesk-api-diagnostics.cjs");

const DOMAIN = "nomreh.arounidea.com";
const ACTION = process.env.PLESK_BROWSER_ACTION || "diagnose";
const UPLOAD_ARCHIVE = process.env.PLESK_UPLOAD_ARCHIVE || "";
const ARCHIVE_NAME = "nomreh-deploy.zip";
const OUTPUT = process.env.PLESK_DIAGNOSTICS_OUTPUT || path.join(os.tmpdir(), "nomreh-plesk-browser-diagnostics.md");

function sanitize(value) {
  return redact(value)
    .split("nomreh.[redacted]").join(DOMAIN)
    .replace(/(https?:\/\/)[^/\s:@]+(?::[^/\s@]*)?@/gi, "$1[redacted]@");
}

async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count() && await locator.isVisible().catch(() => false)) return locator;
  }
  return null;
}

function relevantLines(text) {
  const pattern = /nomreh|error|failed|failure|forbidden|suspended|disabled|expired|invalid|incorrect|verification|required|خطا|معلق|غیرفعال|دامنه/i;
  return [...new Set(String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && pattern.test(line))
    .map((line) => line.slice(0, 300)))]
    .slice(0, 40)
    .map(redact);
}

function toolLines(text) {
  const pattern = /nomreh|error|failed|authentication|github|branch|commit|repository|deploy|node|application|startup|document|root|version|disabled|enabled|not found|no commits|npm|build/i;
  return [...new Set(String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && pattern.test(line) && !/webhook|secret|token|password|credential|api.key/i.test(line))
    .map((line) => line.slice(0, 300)))]
    .slice(0, 60)
    .map(sanitize);
}

function labelValues(text, labels) {
  const bodyLines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const result = [];
  for (const label of labels) {
    const index = bodyLines.findIndex((line) => line === label);
    if (index >= 0 && bodyLines[index + 1] && !/secret|token|password|credential|api.key/i.test(bodyLines[index + 1])) {
      result.push(`${label}: ${sanitize(bodyLines[index + 1])}`);
    }
  }
  return result;
}

async function main() {
  if (!["diagnose", "upload", "extract", "build", "status", "disk", "fix-node-version", "update-package", "retire-obsolete"].includes(ACTION)) throw new Error(`Unsupported Plesk browser action: ${ACTION}`);
  const panel = normalizePanelUrl(process.env.PLESK_PANEL_URL || "");
  const readOnly = ACTION === "diagnose" || ACTION === "status";
  const actionDescription = ACTION === "upload"
    ? "Controlled action: upload one validated application archive to Nomreh only. No extraction, build, restart, or settings change is attempted."
    : ACTION === "extract"
      ? "Controlled action: extract the validated archive inside the Nomreh application root only. Persistent data, uploads, environment files, build, restart, and settings changes are not touched."
      : ACTION === "disk"
        ? "Controlled read-only action: run Nomreh's disk report only. No build, deletion, restart, or settings change is attempted."
        : ACTION === "fix-node-version"
          ? "Controlled action: preserve Nomreh's Node override backups and pin its untracked .node-version file only to a verified installed nodenv version. No application source, persistent data, build, restart, or other domain is touched."
          : ACTION === "update-package"
            ? "Controlled action: preserve Nomreh's current package.json as package.json.pre-npm-node-fix and upload only the hash-validated replacement. No other application file, persistent data, build, restart, or other domain is touched."
            : ACTION === "retire-obsolete"
              ? "Controlled action: rename only three verified obsolete Cloudflare/better-sqlite3 host artifacts to non-TypeScript backup names. No current source, persistent data, build, restart, or other domain is touched."
              : "Controlled action: run the validated Nomreh production build with its domain-local Node 22 runtime. Node.js enablement and restart remain pending.";
  const lines = ["# Plesk browser diagnostics", "", readOnly
    ? "Read-only browser inspection. No settings, deployments or files were changed."
    : actionDescription, ""];
  let actionCompleted = false;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1680, height: 1050 } });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    let loginPageLoaded = false;
    for (let attempt = 1; attempt <= 2 && !loginPageLoaded; attempt += 1) {
      try {
        await page.goto(`${panel}/login_up.php`, { waitUntil: "domcontentloaded", timeout: 45000 });
        loginPageLoaded = true;
      } catch (error) {
        if (attempt === 2) throw error;
        lines.push("- The initial Plesk login page load failed; retrying once before credentials or host commands.", "");
      }
    }

    const cookieButton = page.getByRole("button", { name: /Accept necessary cookies/i }).first();
    if (await cookieButton.count() && await cookieButton.isVisible().catch(() => false)) {
      await cookieButton.click().catch(() => undefined);
    }

    const username = await firstVisible(page, [
      'input[name="login_name"]',
      'input[name="username"]',
      'input[name="login"]',
      'input[type="email"]',
    ]);
    const password = await firstVisible(page, [
      'input[name="passwd"]',
      'input[name="password"]',
      'input[type="password"]',
    ]);
    if (!username || !password) throw new Error("The Plesk login form was not found; no credentials were submitted.");

    await username.fill(process.env.PLESK_API_USERNAME || "");
    await password.fill(process.env.PLESK_API_PASSWORD || "");
    await password.press("Enter");
    await page.waitForTimeout(4000);
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => undefined);

    const remainingPassword = await firstVisible(page, ['input[type="password"]', 'input[name="passwd"]']);
    const currentPath = new URL(page.url()).pathname;
    lines.push("## Login result", "", `- Current page: ${sanitize(currentPath)}`, `- Plesk page title: ${sanitize(await page.title())}`, `- Login form still present: ${remainingPassword ? "yes" : "no"}`, "");

    const initialLines = relevantLines(await page.locator("body").innerText());
    if (initialLines.length) lines.push("### Relevant messages", "", ...initialLines.map((line) => `- ${line}`), "");
    if (remainingPassword) {
      lines.push("## Result", "", "Plesk returned the login form again. No domain pages were inspected and no remediation was attempted.", "");
      const output = sanitize(lines.join("\n"));
      fs.writeFileSync(OUTPUT, output, { mode: 0o600 });
      console.error(output);
      process.exitCode = 1;
      return;
    }

    const pagesToInspect = ["/smb/web/domains", "/admin/domain/list"];
    let domainFound = false;
    let nomrehFilesPath = "";
    let nomrehNodeLink = null;
    let nomrehFileManagerLink = null;
    let nomrehConsoleLink = null;
    for (const inspectPath of pagesToInspect) {
      const response = await page.goto(`${panel}${inspectPath}`, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
      await page.waitForTimeout(1500);
      const body = await page.locator("body").innerText().catch(() => "");
      lines.push("## Domain page inspection", "", `- Page: ${inspectPath}`, `- HTTP status: ${response ? response.status() : "unavailable"}`, `- Nomreh visible: ${body.includes(DOMAIN) ? "yes" : "no"}`, "");
      const selected = relevantLines(body);
      if (selected.length) lines.push(...selected.map((line) => `- ${line}`), "");
      if (body.includes(DOMAIN)) {
        domainFound = true;
        const link = page.locator(`a:has-text("${DOMAIN}")`).first();
        if (await link.count()) {
          const href = await link.getAttribute("href");
          if (href) lines.push(`- Nomreh link: ${sanitize(new URL(href, page.url()).pathname)}`, "");
        }
        const domainElement = page.getByText(DOMAIN, { exact: false }).first();
        if (await domainElement.count()) {
          await domainElement.click({ timeout: 8000 }).catch(() => undefined);
          await page.waitForTimeout(2000);
          const overview = await page.locator("body").innerText().catch(() => "");
          lines.push("## Nomreh overview", "", `- Current page: ${sanitize(new URL(page.url()).pathname)}`, `- Page title: ${sanitize(await page.title())}`, "");
          const overviewLines = relevantLines(overview);
          if (overviewLines.length) lines.push(...overviewLines.map((line) => `- ${line}`), "");
          const domainCard = domainElement.locator("xpath=ancestor::*[.//a[contains(@href, '/modules/nodejs/')] and .//a[contains(@href, '/smb/file-manager/')]][1]");
          const hasDomainCard = await domainCard.count() > 0;
          const toolScope = hasDomainCard ? domainCard : page.locator("body");
          const nodeScope = hasDomainCard ? domainCard : domainElement.locator("xpath=ancestor::*[.//a[contains(@href, '/modules/nodejs/')]][1]");
          nomrehNodeLink = await nodeScope.count() ? nodeScope.locator("a[href*='/modules/nodejs/']").first() : null;
          const tools = await toolScope.locator("a").evaluateAll((anchors) => anchors.map((anchor) => ({
            text: (anchor.textContent || "").trim().replace(/\s+/g, " "),
            href: anchor.getAttribute("href") || "",
          })).filter((item) => /^(Git|Node\.js|Files|File Manager|Hosting Settings|Dashboard)/i.test(item.text) || /\/modules\/nodejs\/|\/smb\/file-manager\//.test(item.href)).slice(0, 20));
          for (const tool of tools) {
            if (!nomrehFilesPath && /\/smb\/file-manager\/.*domainId\/\d+/.test(tool.href)) {
              const fileUrl = new URL(tool.href, page.url());
              nomrehFilesPath = `${fileUrl.pathname}${fileUrl.search}`;
            }
            lines.push(`- Tool: ${sanitize(tool.text)}${tool.href.startsWith("/") ? ` (${sanitize(new URL(tool.href, page.url()).pathname)})` : ""}`);
          }
          if (tools.length) lines.push("");
        }
        break;
      }
    }
    if (domainFound) {
      const toolPages = [
        ["Node.js", "/modules/nodejs/index.php/domain/index"],
      ];
      for (const [label, toolPath] of toolPages) {
        let response = null;
        if (label === "Node.js" && nomrehNodeLink && await nomrehNodeLink.count()) {
          const responsePromise = page.waitForResponse((item) => item.url().includes("/modules/nodejs/") && item.request().isNavigationRequest(), { timeout: 15000 }).catch(() => null);
          await nomrehNodeLink.click({ timeout: 10000 }).catch(() => undefined);
          response = await responsePromise;
        } else {
          response = await page.goto(`${panel}${toolPath}`, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
        }
        await page.waitForTimeout(1800);
        if (label === "Node.js") {
          await page.getByText("Application Root", { exact: true }).waitFor({ state: "visible", timeout: 12000 }).catch(() => undefined);
        }
        const body = await page.locator("body").innerText().catch(() => "");
        lines.push(`## ${label} page`, "", `- HTTP status: ${response ? response.status() : "unavailable"}`, `- Current page: ${sanitize(new URL(page.url()).pathname)}`, `- Body characters: ${body.length}`, "");
        const selected = toolLines(body);
        if (selected.length) lines.push(...selected.map((line) => `- ${line}`), "");
        if (body.length < 2000) {
          const excerpt = body.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !/webhook|secret|token|password|credential|api.key|environment/i.test(line) && (!line.includes("arounidea.com") || line.includes(DOMAIN))).slice(0, 30);
          if (excerpt.length) lines.push(...excerpt.map((line) => `- Page text: ${sanitize(line.slice(0, 250))}`), "");
        }
        const controls = await page.locator("a, button, input[type='submit']").evaluateAll((elements) => elements.map((element) => ({
          text: (element.textContent || element.getAttribute("value") || "").trim().replace(/\s+/g, " "),
          href: element.getAttribute("href") || "",
        })).filter((item) => /pull|deploy|repository|settings|branch|run|build|restart|enable|disable|install|npm/i.test(item.text)).slice(0, 30));
        for (const control of controls) {
          lines.push(`- Control: ${sanitize(control.text)}${control.href.startsWith("/") ? ` (${sanitize(new URL(control.href, page.url()).pathname)})` : ""}`);
        }
        if (controls.length) lines.push("");
        if (label === "Node.js") {
          const consoleCandidates = page.locator("a[href*='/modules/nodejs/index.php/domain/console']");
          const namedConsoleLink = consoleCandidates.filter({ hasText: /Run Node\.js commands/i }).first();
          nomrehConsoleLink = await namedConsoleLink.count() ? namedConsoleLink : (await consoleCandidates.count() ? consoleCandidates.first() : null);
          const managerLinks = await page.locator("a[href*='/smb/file-manager/']").evaluateAll((anchors) => anchors.map((anchor) => ({
            text: (anchor.textContent || "").trim().replace(/\s+/g, " "),
            href: anchor.getAttribute("href") || "",
          })).filter((item) => /domainId\/\d+/.test(item.href)));
          const managerLink = managerLinks.find((item) => /File Manager|open/i.test(item.text)) || managerLinks[0];
          const managerCandidates = page.locator("a[href*='/smb/file-manager/'][href*='domainId/']");
          const namedManagerLink = managerCandidates.filter({ hasText: /File Manager|open/i }).first();
          nomrehFileManagerLink = await namedManagerLink.count() ? namedManagerLink : (await managerCandidates.count() ? managerCandidates.first() : null);
          if (managerLink) {
            const managerUrl = new URL(managerLink.href, page.url());
            nomrehFilesPath = `${managerUrl.pathname}${managerUrl.search}${managerUrl.hash}`;
            lines.push(`- Application File Manager: ${sanitize(`${managerUrl.pathname}${managerUrl.search}${managerUrl.hash}`)}`, "");
          }
          const fields = await page.locator("input, select, textarea").evaluateAll((elements) => elements.map((element) => {
            const name = element.getAttribute("name") || element.id || "";
            const labelElement = element.id ? document.querySelector(`label[for="${element.id}"]`) : null;
            const labelText = (labelElement?.textContent || "").trim().replace(/\s+/g, " ");
            const value = element.tagName === "SELECT"
              ? (element.selectedOptions[0]?.textContent || "").trim()
              : (element.getAttribute("value") || "");
            return { name, labelText, value, type: element.getAttribute("type") || element.tagName.toLowerCase() };
          }).filter((field) => /document|root|startup|version|mode|package|url|node|npm/i.test(`${field.name} ${field.labelText}`) && !/password|secret|token|credential|api.key/i.test(`${field.name} ${field.labelText}`)).slice(0, 30));
          for (const field of fields) lines.push(`- Node field: ${sanitize(field.labelText || field.name)} = ${sanitize(field.value)}`);
          const values = labelValues(body, ["Node.js Version", "Document Root", "Application Mode", "Application URL", "Application Root", "Application Startup File"]);
          for (const value of values) lines.push(`- Node value: ${value}`);
          if (fields.length || values.length) lines.push("");
        }
      }
      if (["diagnose", "build", "status", "disk"].includes(ACTION) && nomrehConsoleLink && await nomrehConsoleLink.count()) {
        const consoleResponsePromise = page.waitForResponse((item) => item.url().includes("/modules/nodejs/index.php/domain/console") && item.request().isNavigationRequest(), { timeout: 15000 }).catch(() => null);
        await nomrehConsoleLink.click({ timeout: 8000 }).catch(() => undefined);
        const consoleResponse = await consoleResponsePromise;
        await page.waitForTimeout(1200);
        const consoleBody = await page.locator("body").innerText().catch(() => "");
        lines.push("## Node command console inspection", "", `- HTTP status: ${consoleResponse ? consoleResponse.status() : "unavailable"}`, `- Current page: ${sanitize(new URL(page.url()).pathname)}`, "");
        const consoleLines = consoleBody.split(/\r?\n/).map((line) => line.trim()).filter((line) => /command|npm|node|application root|script|package manager|run/i.test(line) && !/secret|token|password|credential|api.key|environment/i.test(line)).slice(0, 45);
        for (const line of consoleLines) lines.push(`- Console text: ${sanitize(line.slice(0, 250))}`);
        const consoleFields = await page.locator("input, select, textarea").evaluateAll((elements) => elements.map((element) => ({
          tag: element.tagName,
          name: element.getAttribute("name") || element.id || "",
          label: element.getAttribute("placeholder") || element.getAttribute("aria-label") || "",
          value: element.tagName === "SELECT" ? (element.selectedOptions[0]?.textContent || "").trim() : (element.getAttribute("value") || ""),
        })).filter((field) => /command|script|package|manager|args|npm|node|cwd|root/i.test(`${field.name} ${field.label}`) && !/password|secret|token|credential|environment/i.test(`${field.name} ${field.label}`)).slice(0, 30));
        for (const field of consoleFields) lines.push(`- Console field: ${sanitize(JSON.stringify(field))}`);
        const consoleButtons = await page.locator("button, input[type='submit']").evaluateAll((elements) => elements.map((element) => ({
          text: (element.textContent || element.getAttribute("value") || "").trim().replace(/\s+/g, " "),
          title: element.getAttribute("title") || element.getAttribute("aria-label") || "",
        })).filter((item) => /run|execute|npm|build/i.test(`${item.text} ${item.title}`)).slice(0, 20));
        for (const button of consoleButtons) lines.push(`- Console button: ${sanitize(JSON.stringify(button))}`);
        if (ACTION === "diagnose") lines.push("- Inspection only: no command was entered or executed.", "");
        if (ACTION === "status") {
          lines.push("## Read-only console output inspection", "");
          const outputNodes = await page.locator("pre, textarea, iframe, [class*='output' i], [class*='terminal' i], [class*='console' i], [class*='xterm' i]").evaluateAll((elements) => elements.map((element) => ({
            tag: element.tagName,
            id: element.id || "",
            className: String(element.getAttribute("class") || "").slice(0, 180),
            visible: Boolean(element.getClientRects().length),
            text: (element.innerText || element.textContent || "").slice(0, 12000),
          })).slice(0, 60));
          for (const node of outputNodes) {
            lines.push(`- Output element: ${sanitize(JSON.stringify({ tag: node.tag, id: node.id, className: node.className, visible: node.visible, textLength: node.text.length }))}`);
            const safeOutput = node.text.split(/\r?\n/).map((line) => line.trim()).filter((line) => /\[Nomreh|Node 22|SQLite|canvas|production build|npm ERR|GLIBC|exited with status|Report complete|Application total|MiB|GiB|task|progress|running|completed|failed|npm/i.test(line) && !/secret|token|password|credential|api.key/i.test(line)).slice(-30);
            for (const line of safeOutput) lines.push(`- Existing output: ${sanitize(line.slice(0, 400))}`);
          }
          lines.push("- Inspection only: no command was entered or executed.", "");
        }
        if (ACTION === "disk") {
          if (!consoleBody.includes(`Node.js on ${DOMAIN}`) || !consoleBody.includes("/nomreh.arounidea.com")) {
            throw new Error("The Node command console is not scoped to Nomreh. The read-only disk report was not started.");
          }
          const commandInput = page.getByPlaceholder(/Pick a script or command/i).first();
          const executeButton = page.locator("button[title='Execute command'], button[aria-label='Execute command']").first();
          const outputElement = page.locator("pre.pul-console-output").first();
          if (!await commandInput.count() || !await executeButton.count() || !await outputElement.count()) throw new Error("The Nomreh command controls were not found. The disk report was not started.");
          const command = "run space:plesk";
          const responseSummaries = [];
          let responseOutput = "";
          let capturing = false;
          const responseHandler = async (response) => {
            if (!capturing) return;
            try {
              const target = new URL(response.url());
              if (target.origin !== new URL(panel).origin || !/nodejs|console|npm|command/i.test(target.pathname)) return;
              responseSummaries.push(`${response.request().method()} ${target.pathname} -> HTTP ${response.status()}`);
              const text = await response.text().catch(() => "");
              const safeLines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => /Nomreh read-only disk|Application total|Persistent data total|Dependencies|Production build|Regenerable|Public files|Local Node runtime|Teacher uploads|Available space|Runtime temporary|Report complete|npm ERR|failed|error/i.test(line) && !/secret|token|password|credential|api.key/i.test(line)).slice(0, 100);
              if (safeLines.length) responseOutput += `\n${safeLines.join("\n")}`;
            } catch { /* A non-essential diagnostic response was unavailable. */ }
          };
          page.on("response", responseHandler);
          let latestConsoleOutput = "";
          let lastDiskProgressReport = 0;
          try {
            lines.push("## Controlled read-only Nomreh disk report", "", `- Command: ${command}`, "");
            await commandInput.click({ timeout: 8000 });
            await commandInput.press("Control+A");
            await commandInput.press("Backspace");
            await commandInput.pressSequentially(command, { delay: 45 });
            await page.waitForTimeout(500);
            const enteredCommand = await commandInput.inputValue();
            if (enteredCommand !== command) throw new Error("Plesk did not retain the exact read-only disk command. Nothing was executed.");
            const optionTexts = await page.locator("[role='option']:visible, .pul-dropdown__item:visible, .select2-results__option:visible").allTextContents();
            for (const option of optionTexts.map((text) => text.trim()).filter(Boolean).slice(0, 15)) lines.push(`- Command suggestion: ${sanitize(option.slice(0, 200))}`);
            await commandInput.press("Tab");
            if (await commandInput.inputValue() !== command) throw new Error("Plesk changed the read-only disk command before execution. Nothing was executed.");
            capturing = true;
            await executeButton.click({ timeout: 8000 });
            const diskStartedAt = Date.now();
            let completedOutput = "";
            let diskSucceeded = false;
            while (Date.now() - diskStartedAt < 6 * 60 * 1000) {
              await page.waitForTimeout(2000);
              const consoleOutput = await outputElement.innerText().catch(() => "");
              latestConsoleOutput = consoleOutput;
              if (Date.now() - lastDiskProgressReport > 15000) {
                const partial = `${consoleOutput}\n${responseOutput}`.split(/\r?\n/).map((line) => line.trim()).filter((line) => (/Nomreh|Application|Persistent|Dependencies|Production build|Runtime|uploads|Available space|MiB|GiB|npm|space:plesk|node|du\b|df\b|failed|error/i.test(line) || /^\d+\.\d+\.\d+$/.test(line)) && !/secret|token|password|credential|api.key/i.test(line)).slice(-12);
                if (partial.length) console.log(sanitize(partial.join("\n")));
                if (responseSummaries.length) console.log(sanitize(responseSummaries.slice(-5).join("\n")));
                lastDiskProgressReport = Date.now();
              }
              const currentBody = await page.locator("body").innerText().catch(() => "");
              const combined = `${consoleOutput}\n${responseOutput}\n${currentBody}`;
              if (/Report complete\. No files were changed or deleted\./i.test(combined)) {
                diskSucceeded = true;
                completedOutput = combined;
                break;
              }
              const failure = combined.split(/\r?\n/).find((line) => /npm ERR!|Command failed|another.*command.*running|quota exceeded|permission denied|nodenv: version .*not installed|nodenv: node: command not found|node: not found/i.test(line));
              if (failure) throw new Error(`The read-only Nomreh disk report could not run: ${sanitize(failure.slice(0, 350))}`);
              if (!responseSummaries.length && !consoleOutput.trim() && Date.now() - diskStartedAt > 45000) {
                throw new Error("Plesk did not issue an execution request or display output after the command button was clicked. The disk report did not start.");
              }
            }
            if (!diskSucceeded) throw new Error("The read-only Nomreh disk report did not complete within 6 minutes. No build or settings change was attempted.");
            const diskLines = completedOutput.split(/\r?\n/).map((line) => line.trim()).filter((line) => /Nomreh read-only disk|Application total|Persistent data total|Git history|Dependencies|Production build|Regenerable|Public files|Local Node runtime|Teacher uploads|Available space|Runtime temporary|Report complete|MiB|GiB/i.test(line) && !/secret|token|password|credential|api.key/i.test(line)).slice(-80);
            for (const line of diskLines) lines.push(`- Disk report: ${sanitize(line.slice(0, 350))}`);
            lines.push("- The read-only disk command completed; no build, deletion, restart, or settings change was attempted.", "");
            actionCompleted = true;
          } finally {
            capturing = false;
            page.off("response", responseHandler);
            for (const response of responseSummaries.slice(0, 20)) lines.push(`- Execution response: ${sanitize(response)}`);
            const partialLines = `${latestConsoleOutput}\n${responseOutput}`.split(/\r?\n/).map((line) => line.trim()).filter((line) => (/Nomreh|Application|Persistent|Dependencies|Production build|Runtime|uploads|Available space|MiB|GiB|npm|space:plesk|node|du\b|df\b|failed|error/i.test(line) || /^\d+\.\d+\.\d+$/.test(line)) && !/secret|token|password|credential|api.key/i.test(line)).slice(-40);
            for (const line of partialLines) lines.push(`- Partial disk output: ${sanitize(line.slice(0, 400))}`);
            if (!responseSummaries.length && !partialLines.length) lines.push("- No execution response or sanitized partial output was exposed by Plesk.");
          }
        }
        if (ACTION === "build") {
          if (!consoleBody.includes(`Node.js on ${DOMAIN}`) || !consoleBody.includes("/nomreh.arounidea.com")) {
            throw new Error("The Node command console is not scoped to the Nomreh application root. Build was not started.");
          }
          const commandInput = page.getByPlaceholder(/Pick a script or command/i).first();
          const executeButton = page.locator("button[title='Execute command'], button[aria-label='Execute command']").first();
          if (!await commandInput.count() || !await executeButton.count()) throw new Error("The Nomreh npm command controls were not found. Build was not started.");
          lines.push("## Controlled Nomreh production build", "", "- Command: run build:plesk", "");
          await commandInput.fill("run build:plesk");
          await executeButton.click({ timeout: 8000 });
          const buildStartedAt = Date.now();
          let lastProgressSignature = "";
          let lastProgressReport = 0;
          let completedOutput = "";
          let latestBuildOutput = "";
          let buildSucceeded = false;
          const appendBuildFailureContext = (output) => {
            const contextLines = String(output || "").split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !/^\{"code":/.test(line) && /Nomreh|npm|node|Next|next|SWC|WASM|wasm|GLIBC|SQLite|canvas|error|failed|ERR|Cannot|cannot|Could not|could not|permission|space|memory|heap|install|Building|Compiled|Generating|Finalizing|exit|download|runtime|tar|package|dependenc/i.test(line) && !/secret|token|password|credential|api.key|authorization|cookie|environment/i.test(line)).slice(-60);
            for (const line of contextLines) lines.push(`- Build failure context: ${sanitize(line.slice(0, 500))}`);
            if (!contextLines.length) lines.push("- No sanitized build failure context was exposed by Plesk.");
          };
          while (Date.now() - buildStartedAt < 40 * 60 * 1000) {
            await page.waitForTimeout(4000);
            const currentBody = await page.locator("body").innerText().catch(() => "");
            const currentOutput = currentBody.startsWith(consoleBody) ? currentBody.slice(consoleBody.length) : currentBody;
            latestBuildOutput = currentOutput;
            const progressLines = currentOutput.split(/\r?\n/).map((line) => line.trim()).filter((line) => /\[Nomreh|Node 22|SQLite|canvas|production build|Installing application dependencies|Building Nomreh|npm ERR|GLIBC|exited with status/i.test(line) && !/secret|token|password|credential|api.key/i.test(line));
            const signature = progressLines.slice(-6).join("\n");
            if (signature && signature !== lastProgressSignature && Date.now() - lastProgressReport > 15000) {
              console.log(sanitize(signature));
              lastProgressSignature = signature;
              lastProgressReport = Date.now();
            }
            if (/Nomreh production build is ready with the domain-local Node 22/i.test(currentOutput)) {
              buildSucceeded = true;
              completedOutput = currentOutput;
              break;
            }
            const failure = currentOutput.split(/\r?\n/).find((line) => /\[Nomreh FAILED;|npm ERR!|exited with status|Build failed|Command failed|nodenv: version .*not installed|nodenv: node: command not found|node: not found/i.test(line));
            if (failure) {
              appendBuildFailureContext(currentOutput);
              throw new Error(`Nomreh build failed: ${sanitize(failure.slice(0, 400))}`);
            }
          }
          if (!buildSucceeded) {
            appendBuildFailureContext(latestBuildOutput);
            throw new Error("The Nomreh build did not report completion within 40 minutes. Node.js was not enabled or restarted.");
          }
          const buildLines = completedOutput.split(/\r?\n/).map((line) => line.trim()).filter((line) => /\[Nomreh|Node 22|SQLite|canvas|production build|Installing application dependencies|Building Nomreh|added |removed |Compiled|Generating|Finalizing|BUILD_ID/i.test(line) && !/secret|token|password|credential|api.key/i.test(line)).slice(-80);
          for (const line of buildLines) lines.push(`- Build output: ${sanitize(line.slice(0, 400))}`);
          lines.push("- The domain-local Node 22 build and SQLite/canvas smoke tests completed successfully. Node.js enablement remains pending.", "");
          actionCompleted = true;
        }
      }
      if (nomrehFilesPath) {
        let filePath = nomrehFilesPath;
        for (let depth = 0; depth < 2; depth += 1) {
          let response = null;
          if (depth === 0 && nomrehFileManagerLink && await nomrehFileManagerLink.count()) {
            const responsePromise = page.waitForResponse((item) => item.url().includes("/smb/file-manager/") && item.request().isNavigationRequest(), { timeout: 15000 }).catch(() => null);
            await nomrehFileManagerLink.click({ timeout: 10000 }).catch(() => undefined);
            response = await responsePromise;
          } else if (filePath) {
            response = await page.goto(`${panel}${filePath}`, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
          }
          await page.waitForTimeout(2000);
          const fileBody = await page.locator("body").innerText().catch(() => "");
          const currentFileUrl = new URL(page.url());
          lines.push("## Nomreh File Manager", "", `- HTTP status: ${response ? response.status() : "unavailable"}`, `- Current page: ${sanitize(`${currentFileUrl.pathname}${currentFileUrl.search}`)}`, "");
          const fileMessages = toolLines(fileBody);
          if (fileMessages.length) lines.push(...fileMessages.map((line) => `- ${line}`), "");
          const fileLinks = await page.locator("a").evaluateAll((anchors) => anchors.map((anchor) => ({
            text: (anchor.textContent || "").trim().replace(/\s+/g, " "),
            href: anchor.getAttribute("href") || "",
          })).filter((item) => /^(nomreh\.|nomreh-data|httpdocs|public|package(-lock)?\.json|server\.js|next\.config|scripts|node_modules|\.next|git|runtime|build-progress\.txt|runtime\.json|BUILD_ID|\.node-version(?:\.nomreh-backup)?)$/i.test(item.text)).slice(0, 30));
          for (const link of fileLinks) lines.push(`- File entry: ${sanitize(link.text)}${link.href.startsWith("/") ? ` (${sanitize(new URL(link.href, page.url()).pathname)})` : ""}`);
          if (fileLinks.length) lines.push("");
          if (depth === 1) {
            if (ACTION === "status") {
              lines.push("## Nomreh persistent-data status", "");
              const progressPresent = fileBody.includes("build-progress.txt");
              const runtimePresent = fileLinks.some((link) => link.text === "runtime");
              lines.push(`- Build progress file visible: ${progressPresent ? "yes" : "no"}`);
              lines.push(`- Domain-local runtime directory visible: ${runtimePresent ? "yes" : "no"}`);
              const statusRows = fileBody.split(/\r?\n/).map((line) => line.trim()).filter((line) => /build-progress\.txt|^runtime\s/i.test(line) && !/secret|token|password|credential|api.key/i.test(line)).slice(0, 12);
              for (const row of statusRows) lines.push(`- Status entry: ${sanitize(row.slice(0, 350))}`);
              for (const link of fileLinks.filter((item) => /^(build-progress\.txt|runtime)$/i.test(item.text))) {
                const target = link.href.startsWith("/") ? new URL(link.href, page.url()) : null;
                lines.push(`- Status link: ${sanitize(link.text)}${target ? ` (${sanitize(`${target.pathname}${target.search}`)})` : ""}`);
              }
              if (progressPresent) {
                const progressLink = page.getByText("build-progress.txt", { exact: true }).first();
                const downloadPromise = page.waitForEvent("download", { timeout: 6000 }).catch(() => null);
                await progressLink.click({ timeout: 8000 }).catch(() => undefined);
                const download = await downloadPromise;
                let progressText = "";
                if (download) {
                  const downloadPath = await download.path();
                  if (downloadPath && fs.statSync(downloadPath).size <= 16384) progressText = fs.readFileSync(downloadPath, "utf8");
                } else {
                  await page.waitForTimeout(1200);
                  progressText = await page.locator("body").innerText().catch(() => "");
                }
                const progressLines = progressText.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^Nomreh build status:|^Stage:|^Elapsed seconds:|^Process ID:|^Updated at:/i.test(line)).slice(0, 12);
                for (const line of progressLines) lines.push(`- Previous progress: ${sanitize(line.slice(0, 350))}`);
                if (!progressLines.length) lines.push("- Previous progress content was not exposed by the File Manager view.");
              }
              lines.push("- Persistent-data inspection only; no file was saved or changed.", "");
              actionCompleted = true;
            }
            if (ACTION === "retire-obsolete") {
              const obsoleteTargets = [
                { directories: [], file: "open-next.config.ts", backup: "open-next.config.ts.nomreh-obsolete-backup", marker: "package.json" },
                { directories: ["lib", "server"], file: "cloudflare.ts", backup: "cloudflare.ts.nomreh-obsolete-backup", marker: "sqlite.ts" },
                { directories: ["tests"], file: "cloudflare-seed.test.ts", backup: "cloudflare-seed.test.ts.nomreh-obsolete-backup", marker: "plesk-runtime.test.ts" },
              ];
              lines.push("## Controlled retirement of obsolete Nomreh host artifacts", "");
              if (!fileBody.includes("package.json") || !fileBody.includes("server.js") || !fileBody.includes(ARCHIVE_NAME)) {
                throw new Error("The File Manager is not verified at Nomreh's application root. No obsolete artifact was changed.");
              }
              const navigateToTarget = async (target) => {
                await page.goto(`${panel}${nomrehFilesPath}`, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
                await page.waitForTimeout(1400);
                const appFolder = page.locator("a.tree-item-content:visible").filter({ hasText: DOMAIN }).first();
                if (!await appFolder.count()) throw new Error("The Nomreh application folder was not available in the File Manager tree. No artifact was changed.");
                await appFolder.evaluate((element) => element.click());
                await page.waitForTimeout(2500);
                for (const directory of target.directories) {
                  const directoryPattern = new RegExp(`^${directory}$`);
                  const directoryLink = page.locator("a.tree-item-content:visible").filter({ hasText: directoryPattern }).last();
                  await directoryLink.waitFor({ state: "visible", timeout: 15000 }).catch(() => undefined);
                  if (!await directoryLink.count()) {
                    const visibleEntries = await page.locator("a:visible").evaluateAll((anchors) => [...new Set(anchors.map((anchor) => (anchor.textContent || "").trim()).filter((text) => /^(?:lib|server|tests|app|components|scripts|public|[a-z0-9_.@-]+\.(?:ts|tsx|json|cjs))$/i.test(text)))].slice(0, 60));
                    for (const entry of visibleEntries) lines.push(`- Directory inspection: ${sanitize(entry)}`);
                    throw new Error(`The Nomreh ${directory} directory was not found in the file list while locating ${target.file}. No artifact was changed.`);
                  }
                  await directoryLink.evaluate((element) => element.click());
                  await page.waitForTimeout(2000);
                }
                const targetBody = await page.locator("body").innerText().catch(() => "");
                if (!targetBody.includes(target.marker)) throw new Error(`The containing directory for ${target.file} could not be verified. No artifact was changed.`);
                return targetBody;
              };
              const retireTarget = async (target) => {
                await navigateToTarget(target);
                const originalLink = page.getByText(target.file, { exact: true }).first();
                const backupLink = page.getByText(target.backup, { exact: true }).first();
                const originalCount = await originalLink.count();
                const backupCount = await backupLink.count();
                if (!originalCount && backupCount) {
                  lines.push(`- Already preserved: ${target.backup}`);
                  return;
                }
                if (!originalCount) throw new Error(`The expected obsolete artifact ${target.file} was not found. No artifact was changed in its directory.`);
                if (backupCount) throw new Error(`Both ${target.file} and its backup are present. Rename stopped to avoid overwriting the backup.`);
                const originalRow = originalLink.locator("xpath=ancestor::*[.//input[@type='checkbox']][1]");
                const checkbox = originalRow.locator("input[type='checkbox']").first();
                if (!await checkbox.count()) throw new Error(`The ${target.file} row could not be selected. No artifact was changed.`);
                await checkbox.check({ force: true, timeout: 5000 }).catch(async () => checkbox.click({ force: true, timeout: 5000 }));
                if (!await checkbox.isChecked().catch(() => false)) throw new Error(`The ${target.file} row was not selected. No artifact was changed.`);
                let renameChoice = null;
                const rowActions = originalRow.locator("button[title='Actions'], button[aria-label='Actions']").first();
                if (await rowActions.count()) {
                  await rowActions.evaluate((element) => element.click());
                  await page.waitForTimeout(400);
                  renameChoice = page.locator("a:visible, button:visible").filter({ hasText: /^Rename$/i }).first();
                }
                if (!renameChoice || !await renameChoice.count()) {
                  const moreButton = page.getByRole("button", { name: /^More/i }).first();
                  if (await moreButton.count()) {
                    await moreButton.evaluate((element) => element.click());
                    await page.waitForTimeout(400);
                    renameChoice = page.locator("a:visible, button:visible").filter({ hasText: /^Rename$/i }).first();
                  }
                }
                if (!renameChoice || !await renameChoice.count()) throw new Error(`The Rename command was not available for ${target.file}. No artifact was changed.`);
                await renameChoice.evaluate((element) => element.click());
                await page.waitForTimeout(700);
                let renameInput = null;
                const candidates = page.locator("input:not([type='checkbox']):not([type='hidden']):visible");
                for (let index = 0; index < Math.min(await candidates.count(), 30); index += 1) {
                  const candidate = candidates.nth(index);
                  if (await candidate.inputValue().catch(() => "") === target.file) {
                    renameInput = candidate;
                    break;
                  }
                }
                if (!renameInput) throw new Error(`The Rename input for ${target.file} was not found. Rename was not confirmed.`);
                await renameInput.fill(target.backup);
                if (await renameInput.inputValue() !== target.backup) throw new Error(`The backup name for ${target.file} was not retained. Rename was not confirmed.`);
                const dialog = page.locator("[role='dialog']:visible, .pul-modal:visible, .modal:visible").last();
                const scope = await dialog.count() ? dialog : page;
                const confirmRename = scope.getByRole("button", { name: /^(OK|Rename|Confirm)$/i }).last();
                if (!await confirmRename.count()) throw new Error(`The Rename confirmation for ${target.file} was not found. Rename was not confirmed.`);
                await confirmRename.evaluate((element) => element.click());
                await page.waitForTimeout(2500);
                lines.push(`- Preserved obsolete ${target.file} as ${target.backup}.`);
              };
              for (const target of obsoleteTargets) await retireTarget(target);
              for (const target of obsoleteTargets) {
                await navigateToTarget(target);
                if (await page.getByText(target.file, { exact: true }).count() || !await page.getByText(target.backup, { exact: true }).count()) {
                  throw new Error(`The backup state for ${target.file} could not be verified. No build or further host change was attempted.`);
                }
                lines.push(`- Verified non-TypeScript backup only: ${target.backup}`);
              }
              lines.push("- All three obsolete Cloudflare/better-sqlite3 artifacts are preserved outside TypeScript compilation. No current source, persistent data, build, restart, or other domain was changed.", "");
              actionCompleted = true;
            }
            if (ACTION === "update-package") {
              lines.push("## Controlled Nomreh package launcher update", "");
              if (!fileBody.includes("package.json") || !fileBody.includes("server.js") || !fileBody.includes(ARCHIVE_NAME)) {
                throw new Error("The File Manager is not verified at Nomreh's application root. package.json was not changed.");
              }
              const localPackage = path.resolve(__dirname, "..", "package.json");
              const expectedPackageSha256 = process.env.PLESK_PACKAGE_SHA256 || "";
              if (!/^[a-f0-9]{64}$/.test(expectedPackageSha256)) throw new Error("The validated package.json SHA-256 was not provided. No file was uploaded.");
              const packageBytes = fs.readFileSync(localPackage);
              const actualPackageSha256 = crypto.createHash("sha256").update(packageBytes).digest("hex");
              if (actualPackageSha256 !== expectedPackageSha256) throw new Error("The local package.json does not match the validated legacy-build commit. No file was uploaded.");
              const packageBackupName = "package.json.pre-npm-node-fix";
              const existingPackageLink = page.getByText("package.json", { exact: true }).first();
              const existingPackageCount = await existingPackageLink.count();
              const packageBackupCount = await page.getByText(packageBackupName, { exact: true }).count();
              if (packageBackupCount && existingPackageCount) throw new Error("Both package.json and its pre-fix backup are present. No overwrite was attempted; inspect the active launcher before continuing.");
              if (packageBackupCount && !existingPackageCount) {
                lines.push("- The original package.json is already preserved as a backup; uploading the validated replacement without overwriting it.");
              } else {
                if (!existingPackageCount) throw new Error("Neither package.json nor its preserved backup was found. No file was changed.");
                const packageRow = existingPackageLink.locator("xpath=ancestor::*[.//input[@type='checkbox']][1]");
                const packageCheckbox = packageRow.locator("input[type='checkbox']").first();
                if (!await packageCheckbox.count()) throw new Error("The package.json row could not be selected. No file was changed.");
                await packageCheckbox.check({ force: true, timeout: 5000 }).catch(async () => packageCheckbox.click({ force: true, timeout: 5000 }));
                if (!await packageCheckbox.isChecked().catch(() => false)) throw new Error("The package.json row was not selected. No file was changed.");
                let renameChoice = null;
                const rowActions = packageRow.locator("button[title='Actions'], button[aria-label='Actions']").first();
                if (await rowActions.count()) {
                  await rowActions.click({ timeout: 5000 });
                  await page.waitForTimeout(400);
                  renameChoice = page.locator("a:visible, button:visible").filter({ hasText: /^Rename$/i }).first();
                }
                if (!renameChoice || !await renameChoice.count()) {
                  const moreButton = page.getByRole("button", { name: /^More/i }).first();
                  if (await moreButton.count()) {
                    await moreButton.click({ timeout: 5000 }).catch(() => undefined);
                    await page.waitForTimeout(400);
                    renameChoice = page.locator("a:visible, button:visible").filter({ hasText: /^Rename$/i }).first();
                  }
                }
                if (!renameChoice || !await renameChoice.count()) throw new Error("The Rename command was not available for package.json. No file was changed.");
                await renameChoice.evaluate((element) => element.click());
                await page.waitForTimeout(700);
                let renameInput = page.locator('input:not([type="checkbox"]):not([type="hidden"])[value="package.json"]:visible').first();
                if (!await renameInput.count()) {
                  const candidates = page.locator("input:not([type='checkbox']):not([type='hidden']):visible");
                  for (let index = 0; index < Math.min(await candidates.count(), 30); index += 1) {
                    const candidate = candidates.nth(index);
                    if (await candidate.inputValue().catch(() => "") === "package.json") {
                      renameInput = candidate;
                      break;
                    }
                  }
                }
                if (!await renameInput.count()) throw new Error("The package.json Rename input was not found. Rename was not confirmed.");
                await renameInput.fill(packageBackupName);
                if (await renameInput.inputValue() !== packageBackupName) throw new Error("The package.json backup name was not retained. Rename was not confirmed.");
                const dialog = page.locator("[role='dialog']:visible, .pul-modal:visible, .modal:visible").last();
                const scope = await dialog.count() ? dialog : page;
                const confirmRename = scope.getByRole("button", { name: /^(OK|Rename|Confirm)$/i }).last();
                if (!await confirmRename.count()) throw new Error("The package.json Rename confirmation was not found. Rename was not confirmed.");
                await confirmRename.click({ timeout: 8000 });
                await page.waitForTimeout(2500);
                lines.push(`- Preserved the previous hosted package.json as ${packageBackupName}.`);
              }
              lines.push(`- Validated package.json bytes: ${packageBytes.length}`, `- Validated package.json SHA-256: ${actualPackageSha256}`, "");
              const packageDialogHandler = async (dialog) => {
                const message = dialog.message();
                lines.push(`- Browser upload confirmation: ${sanitize(message.slice(0, 350))}`);
                if (dialog.type() === "confirm" && /overwrite|replace|already exists/i.test(message) && (/package\.json/i.test(message) || !/[a-z0-9_-]+\.[a-z0-9]+/i.test(message.replace(/package\.json/ig, "")))) {
                  await dialog.accept();
                } else {
                  await dialog.dismiss();
                }
              };
              page.on("dialog", packageDialogHandler);
              const addNewButton = page.getByRole("button", { name: "Add New", exact: true }).first();
              if (!await addNewButton.count()) throw new Error("The Add New control was not found. package.json was not uploaded.");
              await addNewButton.click({ timeout: 5000 });
              await page.waitForTimeout(500);
              const packageUpload = page.locator("input[type='file']").first();
              if (!await packageUpload.count()) throw new Error("The File Manager upload input was not found. package.json was not uploaded.");
              await packageUpload.setInputFiles(localPackage);
              await page.waitForTimeout(1500);
              const confirmUpload = page.locator("button:visible").filter({ hasText: /^Upload/i }).first();
              if (await confirmUpload.count()) await confirmUpload.click({ timeout: 5000 }).catch(() => undefined);
              await page.waitForTimeout(1800);
              const overwriteBody = await page.locator("body").innerText().catch(() => "");
              const overwriteLines = overwriteBody.split(/\r?\n/).map((line) => line.trim()).filter((line) => /package\.json|overwrite|replace existing|already exists/i.test(line) && !/secret|token|password|credential/i.test(line)).slice(0, 20);
              for (const line of overwriteLines) lines.push(`- Upload form: ${sanitize(line.slice(0, 300))}`);
              if (/overwrite|replace existing|already exists/i.test(overwriteBody)) {
                if (!/package\.json/i.test(overwriteBody)) throw new Error("The overwrite prompt did not explicitly identify package.json. Overwrite was not confirmed.");
                const overwriteControl = page.getByLabel(/overwrite existing files|replace existing files/i).first();
                if (await overwriteControl.count()) await overwriteControl.check({ force: true, timeout: 5000 }).catch(() => undefined);
                const dialog = page.locator("[role='dialog']:visible, .pul-modal:visible, .modal:visible").last();
                const scope = await dialog.count() ? dialog : page;
                const confirmOverwrite = scope.getByRole("button", { name: /^(Overwrite|Replace|Yes|OK|Confirm)$/i }).last();
                if (!await confirmOverwrite.count()) throw new Error("The package.json overwrite confirmation control was not found. Overwrite was not confirmed.");
                await confirmOverwrite.click({ timeout: 8000 });
                await page.waitForTimeout(2500);
              }
              await page.waitForTimeout(3500);
              await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => undefined);
              await page.waitForTimeout(1500);
              const appFolder = page.locator("a.tree-item-content").filter({ hasText: DOMAIN }).first();
              if (await appFolder.count()) {
                await appFolder.click({ timeout: 8000 }).catch(() => undefined);
                await page.waitForTimeout(2000);
              }
              if (!await page.getByText(packageBackupName, { exact: true }).count()) throw new Error("The preserved package.json backup was not visible after upload. No build or further host change was attempted.");
              const uploadedPackageLink = page.getByText("package.json", { exact: true }).first();
              if (!await uploadedPackageLink.count()) throw new Error("package.json was not visible after upload. No build or further host change was attempted.");
              const downloadPromise = page.waitForEvent("download", { timeout: 6000 }).catch(() => null);
              await uploadedPackageLink.click({ timeout: 8000 }).catch(() => undefined);
              const download = await downloadPromise;
              let verified = false;
              if (download) {
                const downloadPath = await download.path();
                if (downloadPath) {
                  const hostedBytes = fs.readFileSync(downloadPath);
                  const hostedSha256 = crypto.createHash("sha256").update(hostedBytes).digest("hex");
                  if (hostedSha256 !== actualPackageSha256) throw new Error("The hosted package.json hash does not match the validated file. No build or restart was attempted.");
                  verified = true;
                }
              } else {
                await page.waitForTimeout(1200);
                const editorBody = await page.locator("body").innerText().catch(() => "");
                if (editorBody.includes("$npm_node_execpath") && editorBody.includes("build:plesk") && editorBody.includes("space:plesk")) verified = true;
              }
              if (!verified) {
                const unverifiedBody = await page.locator("body").innerText().catch(() => "");
                const packageLines = unverifiedBody.split(/\r?\n/).map((line) => line.trim()).filter((line) => /build:plesk|space:plesk|npm_node_execpath|node scripts\/plesk/i.test(line) && !/secret|token|password|credential/i.test(line)).slice(0, 20);
                for (const line of packageLines) lines.push(`- Unverified package content: ${sanitize(line.slice(0, 300))}`);
                throw new Error("The hosted package.json launcher fix could not be verified. No build or restart was attempted.");
              }
              page.off("dialog", packageDialogHandler);
              lines.push("- Nomreh package.json was replaced only with the validated npm-node launcher fix and verified after upload; the previous file remains preserved as package.json.pre-npm-node-fix.", "- No other application file, persistent data, build, restart, or other domain was changed.", "");
              actionCompleted = true;
            }
            if (ACTION === "fix-node-version") {
              const originalName = ".node-version";
              const backupName = process.env.PLESK_NODE_BACKUP_NAME || ".node-version.nomreh-backup";
              const desiredNodeVersion = process.env.PLESK_NODENV_VERSION || "17.9.1";
              if (!/^\.node-version\.[a-z0-9.-]+$/i.test(backupName) || backupName === originalName) throw new Error("The requested Node override backup name is invalid. No file was changed.");
              if (!/^\d+\.\d+\.\d+$/.test(desiredNodeVersion)) throw new Error("The requested nodenv version must be an exact numeric version. No file was changed.");
              lines.push("## Controlled Nomreh Node version override fix", "");
              if (!fileBody.includes("package.json") || !fileBody.includes("server.js") || !fileBody.includes(ARCHIVE_NAME)) {
                throw new Error("The File Manager is not verified at Nomreh's application root. The Node version override was not changed.");
              }
              const originalLink = page.getByText(originalName, { exact: true }).first();
              const backupLink = page.getByText(backupName, { exact: true }).first();
              const originalCount = await originalLink.count();
              const backupCount = await backupLink.count();
              if (!originalCount && backupCount) {
                const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nomreh-node-version-"));
                const localVersionFile = path.join(temporaryDirectory, originalName);
                try {
                  const versionFileContents = `${desiredNodeVersion}\n`;
                  const expectedVersionBytes = Buffer.byteLength(versionFileContents);
                  fs.writeFileSync(localVersionFile, versionFileContents, { mode: 0o600 });
                  lines.push(`- The original Node 24 override is preserved as a backup. Uploading a new .node-version pinned to the verified installed nodenv version ${desiredNodeVersion}.`, "");
                  const addNewButton = page.getByRole("button", { name: "Add New", exact: true }).first();
                  if (!await addNewButton.count()) throw new Error("The Add New control was not found. The corrected Node version file was not uploaded.");
                  await addNewButton.click({ timeout: 5000 });
                  await page.waitForTimeout(500);
                  const versionUpload = page.locator("input[type='file']").first();
                  if (!await versionUpload.count()) throw new Error("The File Manager upload input was not found. The corrected Node version file was not uploaded.");
                  await versionUpload.setInputFiles(localVersionFile);
                  await page.waitForTimeout(1500);
                  const confirmUpload = page.locator("button:visible").filter({ hasText: /^Upload/i }).first();
                  if (await confirmUpload.count()) await confirmUpload.click({ timeout: 5000 }).catch(() => undefined);
                  await page.waitForFunction((expected) => Array.from(document.querySelectorAll("a")).some((anchor) => (anchor.textContent || "").trim() === expected), originalName, { timeout: 60000 });
                  await page.waitForTimeout(1000);
                  const uploadedRow = await page.getByText(originalName, { exact: true }).first().locator("xpath=ancestor::*[.//input[@type='checkbox']][1]").innerText().catch(() => "");
                  if (!new RegExp(`\\b${expectedVersionBytes}\\s*B\\b`, "i").test(uploadedRow)) throw new Error("The uploaded .node-version did not have the expected byte size. No overwrite or build was attempted.");
                  if (!await page.getByText(backupName, { exact: true }).count()) throw new Error("The preserved Node 24 backup is no longer visible. No build or further host change was attempted.");
                  lines.push(`- Corrected override entry: ${sanitize(uploadedRow.slice(0, 350))}`, `- Uploaded .node-version with nodenv ${desiredNodeVersion}; the Node 24 backup remains preserved.`, "- No existing file was overwritten and no application source, persistent data, build, restart, or other domain was changed.", "");
                  actionCompleted = true;
                } finally {
                  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
                }
              } else if (originalCount && backupCount) {
                lines.push("- Both the pinned .node-version and its preserved backup are already present. No file was overwritten; command verification remains pending.", "");
                actionCompleted = true;
              } else {
                if (!originalCount) throw new Error("Nomreh's .node-version file was not found. No file was changed.");
                if (backupCount) throw new Error("The .node-version backup already exists. Rename stopped to avoid overwriting it.");
                const originalRowText = await originalLink.locator("xpath=ancestor::*[.//input[@type='checkbox']][1]").innerText().catch(() => "");
                lines.push(`- Override entry: ${sanitize(originalRowText.slice(0, 350))}`);
                const originalRow = originalLink.locator("xpath=ancestor::*[.//input[@type='checkbox']][1]");
                const checkbox = originalRow.locator("input[type='checkbox']").first();
                if (!await checkbox.count()) throw new Error("The .node-version row could not be selected. No file was changed.");
                await checkbox.check({ force: true, timeout: 5000 }).catch(async () => checkbox.click({ force: true, timeout: 5000 }));
                if (!await checkbox.isChecked().catch(() => false)) throw new Error("The .node-version row was not selected. No file was changed.");
                let renameChoice = null;
                const rowActions = originalRow.locator("button[title='Actions'], button[aria-label='Actions']").first();
                if (await rowActions.count()) {
                  await rowActions.click({ timeout: 5000 });
                  await page.waitForTimeout(400);
                  renameChoice = page.locator("a:visible, button:visible").filter({ hasText: /^Rename$/i }).first();
                }
                if (!renameChoice || !await renameChoice.count()) {
                  const moreButton = page.getByRole("button", { name: /^More/i }).first();
                  if (await moreButton.count()) {
                    await moreButton.click({ timeout: 5000 }).catch(() => undefined);
                    await page.waitForTimeout(400);
                    renameChoice = page.locator("a:visible, button:visible").filter({ hasText: /^Rename$/i }).first();
                  }
                }
                if (!renameChoice || !await renameChoice.count()) throw new Error("The Rename command was not available for Nomreh's .node-version file. No file was changed.");
                await renameChoice.click({ timeout: 8000 });
                await page.waitForTimeout(700);
                const renameBody = await page.locator("body").innerText().catch(() => "");
                const renameLines = renameBody.split(/\r?\n/).map((line) => line.trim()).filter((line) => /rename|new name|file name/i.test(line) && !/secret|token|password|credential/i.test(line)).slice(0, 15);
                for (const line of renameLines) lines.push(`- Rename form: ${sanitize(line.slice(0, 250))}`);
                let renameInput = page.locator(`input:not([type="checkbox"]):not([type="hidden"])[value="${originalName}"]:visible`).first();
                if (!await renameInput.count()) {
                  const candidates = page.locator("input:not([type='checkbox']):not([type='hidden']):visible");
                  for (let index = 0; index < Math.min(await candidates.count(), 30); index += 1) {
                    const candidate = candidates.nth(index);
                    if (await candidate.inputValue().catch(() => "") === originalName) {
                      renameInput = candidate;
                      break;
                    }
                  }
                }
                if (!await renameInput.count()) throw new Error("The Rename input did not contain the expected .node-version name. Rename was not confirmed.");
                await renameInput.fill(backupName);
                if (await renameInput.inputValue() !== backupName) throw new Error("The backup name was not retained. Rename was not confirmed.");
                const dialog = page.locator("[role='dialog']:visible, .pul-modal:visible, .modal:visible").last();
                const scope = await dialog.count() ? dialog : page;
                const confirmRename = scope.getByRole("button", { name: /^(OK|Rename|Confirm)$/i }).last();
                if (!await confirmRename.count()) throw new Error("The Rename confirmation control was not found. Rename was not confirmed.");
                await confirmRename.click({ timeout: 8000 });
                await page.waitForTimeout(2500);
                await page.waitForFunction(({ originalName: original, backupName: backup }) => {
                  const names = Array.from(document.querySelectorAll("a")).map((anchor) => (anchor.textContent || "").trim());
                  return !names.includes(original) && names.includes(backup);
                }, { originalName, backupName }, { timeout: 12000 }).catch(() => undefined);
                const remainingOriginal = await page.getByText(originalName, { exact: true }).count();
                const createdBackup = await page.getByText(backupName, { exact: true }).count();
                if (remainingOriginal || !createdBackup) throw new Error("The .node-version rename could not be verified. No build or further host change was attempted.");
                lines.push(`- Renamed ${originalName} to ${backupName} inside Nomreh only.`, "- The previous override is no longer active; its contents remain preserved in the backup.", "- No application source, persistent data, build, restart, or other domain was changed.", "");
                actionCompleted = true;
              }
            }
            const archivePresent = fileBody.includes(ARCHIVE_NAME);
            if (ACTION === "upload" && archivePresent) {
              throw new Error(`${ARCHIVE_NAME} already exists in the Nomreh application directory. Upload stopped without overwriting it.`);
            }
            if (ACTION === "extract" && !archivePresent) {
              throw new Error(`${ARCHIVE_NAME} is not present in the Nomreh application directory. Extraction was not started.`);
            }
            const fileDetails = fileBody.split(/\r?\n/).map((line) => line.trim()).filter((line) => /package\.json|server\.js|next\.config|sqlite\.ts|plesk-node22|\.next\b|\.node-version/i.test(line) && !/secret|token|password|credential/i.test(line)).slice(0, 20);
            if (fileDetails.length) lines.push(...fileDetails.map((line) => `- Application file: ${sanitize(line.slice(0, 300))}`), "");
            const managerControls = await page.locator("button, a, input").evaluateAll((elements) => elements.map((element) => ({
              tag: element.tagName,
              text: (element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 120),
              title: element.getAttribute("title") || element.getAttribute("aria-label") || "",
              type: element.getAttribute("type") || "",
              name: element.getAttribute("name") || element.id || "",
            })).filter((item) => /upload|extract|archive/i.test(`${item.text} ${item.title} ${item.name}`) || item.type === "file").slice(0, 30));
            for (const control of managerControls) lines.push(`- File control: ${sanitize(JSON.stringify(control))}`);
            if (managerControls.length) lines.push("");
            const toolbarButtons = await page.locator("button").evaluateAll((elements) => elements.map((element) => ({
              text: (element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 100),
              title: element.getAttribute("title") || element.getAttribute("aria-label") || "",
              className: String(element.getAttribute("class") || "").slice(0, 120),
            })).filter((item) => item.text || item.title).slice(0, 40));
            for (const control of toolbarButtons) lines.push(`- Toolbar button: ${sanitize(JSON.stringify(control))}`);
            if (toolbarButtons.length) lines.push("");
            if (ACTION === "extract" && archivePresent) {
              lines.push("## Controlled Nomreh archive extraction", "");
              const archiveName = page.getByText(ARCHIVE_NAME, { exact: true }).first();
              const archiveRow = archiveName.locator("xpath=ancestor::*[.//input[@type='checkbox']][1]");
              const archiveCheckbox = archiveRow.locator("input[type='checkbox']").first();
              if (!await archiveCheckbox.count()) throw new Error("The uploaded archive row was not found. Extraction was not started.");
              await archiveCheckbox.check({ force: true, timeout: 5000 }).catch(async () => {
                await archiveCheckbox.click({ force: true, timeout: 5000 });
              });
              if (!await archiveCheckbox.isChecked().catch(() => false)) throw new Error("The uploaded archive could not be selected. Extraction was not started.");
              const rowActions = archiveRow.locator("button[title='Actions'], button[aria-label='Actions']").first();
              if (!await rowActions.count()) throw new Error("The archive row Actions menu was not found. Extraction was not started.");
              await rowActions.click({ timeout: 5000 });
              await page.waitForTimeout(400);
              const extractChoice = page.locator("a:visible, button:visible").filter({ hasText: /^Extract Files$/i }).first();
              if (!await extractChoice.count()) throw new Error("Extract Files was not available for the selected Nomreh archive.");
              await extractChoice.click({ timeout: 8000 });
              await page.waitForTimeout(1000);
              const extractBody = await page.locator("body").innerText().catch(() => "");
              const extractLines = extractBody.split(/\r?\n/).map((line) => line.trim()).filter((line) => /extract|overwrite|replace existing|destination|target directory|extract to/i.test(line) && !/secret|token|password|credential/i.test(line)).slice(0, 30);
              for (const line of extractLines) lines.push(`- Extract form: ${sanitize(line.slice(0, 300))}`);
              const pathFields = await page.locator("input:visible").evaluateAll((elements) => elements.map((element) => ({
                name: element.getAttribute("name") || element.id || "",
                label: element.getAttribute("placeholder") || element.getAttribute("aria-label") || "",
                value: element.getAttribute("value") || "",
              })).filter((field) => /path|directory|destination|target|extract/i.test(`${field.name} ${field.label}`) && !/password|secret|token|credential/i.test(`${field.name} ${field.label}`)));
              for (const field of pathFields) {
                lines.push(`- Extract path field: ${sanitize(JSON.stringify(field))}`);
                if (field.value.startsWith("/") && !field.value.includes(DOMAIN)) throw new Error(`The extraction path is outside Nomreh: ${sanitize(field.value)}`);
              }
              const overwriteControl = page.getByLabel(/overwrite existing files|replace existing files/i).first();
              if (await overwriteControl.count()) await overwriteControl.check({ force: true, timeout: 5000 }).catch(() => undefined);
              const namedOverwrite = page.locator("input[name*='overwrite' i], input[id*='overwrite' i]").first();
              if (await namedOverwrite.count()) await namedOverwrite.check({ force: true, timeout: 5000 }).catch(() => undefined);
              const hasConfirmationForm = /overwrite existing files|replace existing files|destination directory|extract files to the following directory|extract to|target directory/i.test(extractBody);
              if (hasConfirmationForm) {
                const confirmExtract = page.getByRole("button", { name: /^(OK|Confirm|Extract|Extract Files|Overwrite)/i }).last();
                if (!await confirmExtract.count()) throw new Error("The extraction confirmation control was not found; extraction was not confirmed.");
                await confirmExtract.click({ timeout: 8000 });
              }
              await page.waitForTimeout(5000);
              await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => undefined);
              await page.waitForTimeout(1500);
              const appFolder = page.locator("a.tree-item-content").filter({ hasText: DOMAIN }).first();
              if (await appFolder.count()) {
                await appFolder.click({ timeout: 8000 }).catch(() => undefined);
                await page.waitForTimeout(2000);
              }
              const verifiedBody = await page.locator("body").innerText().catch(() => "");
              const serverLine = verifiedBody.split(/\r?\n/).map((line) => line.trim()).find((line) => /^server\.js\s/i.test(line));
              const packageLine = verifiedBody.split(/\r?\n/).map((line) => line.trim()).find((line) => /^package\.json\s/i.test(line));
              if (serverLine) lines.push(`- Extracted server.js: ${sanitize(serverLine)}`);
              if (packageLine) lines.push(`- Extracted package.json: ${sanitize(packageLine)}`);
              if (!serverLine || !/\b593\s*B\b/i.test(serverLine)) {
                throw new Error("Extraction could not be verified: the hosted server.js is not the validated 593-byte launcher. No build or restart was attempted.");
              }
              lines.push("- Extraction verified: the validated server.js is present in the Nomreh application root. No build or restart was attempted.", "");
              actionCompleted = true;
            }
            if (ACTION === "diagnose" && archivePresent) {
              lines.push("## Extract dialog inspection", "");
              const archiveName = page.getByText(ARCHIVE_NAME, { exact: true }).first();
              const archiveRow = archiveName.locator("xpath=ancestor::*[.//input[@type='checkbox']][1]");
              const archiveCheckbox = archiveRow.locator("input[type='checkbox']").first();
              if (await archiveCheckbox.count()) {
                await archiveCheckbox.check({ force: true, timeout: 5000 }).catch(async () => {
                  await archiveCheckbox.click({ force: true, timeout: 5000 }).catch(() => undefined);
                });
              }
              lines.push(`- Archive selector found: ${await archiveCheckbox.count() ? "yes" : "no"}`);
              if (await archiveCheckbox.count()) lines.push(`- Archive selected: ${await archiveCheckbox.isChecked().catch(() => false) ? "yes" : "no"}`);
              let extractChoice = null;
              for (const menuName of ["Archive", "More"]) {
                const menuButton = page.getByRole("button", { name: new RegExp(`^${menuName}`, "i") }).first();
                if (!await menuButton.count()) continue;
                await menuButton.click({ timeout: 5000 }).catch(() => undefined);
                await page.waitForTimeout(400);
                const menuItems = await page.locator("a:visible, button:visible").evaluateAll((elements) => elements.map((element) => (element.textContent || "").trim().replace(/\s+/g, " ")).filter((text) => /extract|archive|compress|decompress/i.test(text)).slice(0, 15));
                for (const item of menuItems) lines.push(`- ${menuName} menu: ${sanitize(item)}`);
                extractChoice = page.locator("a:visible, button:visible").filter({ hasText: /Extract/i }).first();
                if (await extractChoice.count()) break;
              }
              if (!extractChoice || !await extractChoice.count()) {
                const rowActions = archiveRow.locator("button[title='Actions'], button[aria-label='Actions']").first();
                if (await rowActions.count()) {
                  await rowActions.click({ timeout: 5000 }).catch(() => undefined);
                  await page.waitForTimeout(400);
                  const rowMenuItems = await page.locator("a:visible, button:visible").evaluateAll((elements) => elements.map((element) => (element.textContent || "").trim().replace(/\s+/g, " ")).filter((text) => /extract|unzip|archive|download|rename|edit|remove|delete/i.test(text)).slice(0, 20));
                  for (const item of rowMenuItems) lines.push(`- Archive row menu: ${sanitize(item)}`);
                  extractChoice = page.locator("a:visible, button:visible").filter({ hasText: /Extract|Unzip/i }).first();
                }
              }
              lines.push(`- Extract menu item found: ${extractChoice && await extractChoice.count() ? "yes" : "no"}`);
              if (extractChoice && await extractChoice.count()) {
                await extractChoice.click({ timeout: 8000 }).catch(() => undefined);
                await page.waitForTimeout(900);
                const formBody = await page.locator("body").innerText().catch(() => "");
                const formLines = formBody.split(/\r?\n/).map((line) => line.trim()).filter((line) => /extract|overwrite|existing files|destination|target|directory|cancel|confirm/i.test(line) && !/secret|token|password|credential/i.test(line)).slice(0, 40);
                for (const line of formLines) lines.push(`- Extract form text: ${sanitize(line.slice(0, 300))}`);
                const formInputs = await page.locator("input:visible").evaluateAll((elements) => elements.map((element) => ({
                  name: element.getAttribute("name") || element.id || "",
                  type: element.getAttribute("type") || "text",
                  value: (element.getAttribute("value") || "").slice(0, 200),
                  checked: element.checked,
                })).filter((input) => !/password|secret|token|credential/i.test(input.name)).slice(0, 30));
                for (const input of formInputs) lines.push(`- Extract form input: ${sanitize(JSON.stringify(input))}`);
                const formButtons = await page.locator("button:visible, input[type='submit']:visible").evaluateAll((elements) => elements.map((element) => ({
                  text: (element.textContent || element.getAttribute("value") || "").trim().replace(/\s+/g, " "),
                  title: element.getAttribute("title") || element.getAttribute("aria-label") || "",
                })).filter((item) => /extract|ok|confirm|overwrite|cancel/i.test(`${item.text} ${item.title}`)).slice(0, 20));
                for (const button of formButtons) lines.push(`- Extract form button: ${sanitize(JSON.stringify(button))}`);
                lines.push("- Extract Files was opened for inspection; no confirmation or overwrite action was activated.");
              }
              const dialog = page.locator("[role='dialog']:visible, .pul-modal:visible, .modal:visible").last();
              if (await dialog.count()) {
                const dialogText = await dialog.innerText().catch(() => "");
                for (const line of dialogText.split(/\r?\n/).map((item) => item.trim()).filter((line) => line && !/secret|token|password|credential/i.test(line)).slice(0, 40)) {
                  lines.push(`- Extract dialog: ${sanitize(line.slice(0, 300))}`);
                }
                const dialogInputs = await dialog.locator("input").evaluateAll((elements) => elements.map((element) => ({
                  name: element.getAttribute("name") || element.id || "",
                  type: element.getAttribute("type") || "text",
                  value: (element.getAttribute("value") || "").slice(0, 250),
                  checked: element.checked,
                })).filter((item) => !/password|secret|token|credential/i.test(item.name)));
                for (const input of dialogInputs) lines.push(`- Extract input: ${sanitize(JSON.stringify(input))}`);
              } else {
                lines.push("- No extract confirmation dialog was opened; no files were extracted.");
              }
              lines.push("- Inspection only: no extraction confirmation or overwrite action was activated in this run.", "");
            }
            if (ACTION !== "status" && (ACTION === "upload" || !archivePresent)) {
              const addNewButton = page.getByRole("button", { name: "Add New", exact: true }).first();
              if (await addNewButton.count()) {
              await addNewButton.click({ timeout: 5000 }).catch(() => undefined);
              await page.waitForTimeout(500);
              const menuItems = await page.locator("a:visible, button:visible").evaluateAll((elements) => elements.map((element) => ({
                text: (element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 120),
                title: element.getAttribute("title") || element.getAttribute("aria-label") || "",
              })).filter((item) => /upload|file|directory|create/i.test(`${item.text} ${item.title}`)).slice(0, 25));
              for (const item of menuItems) lines.push(`- Add New menu: ${sanitize(JSON.stringify(item))}`);
              const fileInputs = await page.locator("input[type='file']").evaluateAll((elements) => elements.map((element) => ({
                name: element.getAttribute("name") || element.id || "",
                accept: element.getAttribute("accept") || "",
                multiple: element.hasAttribute("multiple"),
              })));
              lines.push(`- File inputs after opening Add New: ${fileInputs.length}`, "");
              for (const input of fileInputs) lines.push(`- File input: ${sanitize(JSON.stringify(input))}`);
              if (fileInputs.length) lines.push("");
              if (ACTION === "upload") {
                if (!UPLOAD_ARCHIVE || !fs.existsSync(UPLOAD_ARCHIVE)) throw new Error("The validated Nomreh deployment archive is not available to the browser runner.");
                if (!fileInputs.length) throw new Error("Plesk did not provide its file upload input. No archive was sent.");
                const archiveSize = fs.statSync(UPLOAD_ARCHIVE).size;
                if (archiveSize > 90 * 1024 * 1024) throw new Error("The deployment archive exceeds the 90 MB safety limit.");
                lines.push("## Controlled Nomreh archive upload", "", `- Archive: ${ARCHIVE_NAME}`, `- Archive bytes: ${archiveSize}`, "");
                await page.locator("input[type='file']").first().setInputFiles(UPLOAD_ARCHIVE);
                await page.waitForTimeout(2000);
                const confirmUpload = page.locator("button:visible").filter({ hasText: /^Upload/i }).first();
                if (await confirmUpload.count()) await confirmUpload.click({ timeout: 5000 }).catch(() => undefined);
                await page.waitForFunction((name) => Array.from(document.querySelectorAll("a")).some((anchor) => (anchor.textContent || "").trim() === name), ARCHIVE_NAME, { timeout: 180000 });
                await page.waitForTimeout(2000);
                const uploadedBody = await page.locator("body").innerText().catch(() => "");
                const uploadFailure = uploadedBody.split(/\r?\n/).find((line) => /upload.*(failed|error)|(?:failed|error).*upload|quota exceeded|permission denied/i.test(line));
                if (uploadFailure) throw new Error(`Plesk archive upload failed: ${sanitize(uploadFailure.slice(0, 250))}`);
                const uploadedDetails = uploadedBody.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.includes(ARCHIVE_NAME)).slice(0, 5);
                for (const detail of uploadedDetails) lines.push(`- Uploaded file: ${sanitize(detail.slice(0, 300))}`);
                lines.push("- Upload completed and the archive is visible in the Nomreh application directory. No extraction or build was attempted.", "");
                actionCompleted = true;
              }
              }
            }
          }
          const appLink = fileLinks.find((link) => link.text.toLowerCase() === DOMAIN);
          const dataLink = fileLinks.find((link) => link.text === "nomreh-data");
          const initialLink = ACTION === "status" ? dataLink : appLink;
          if (depth === 0 && initialLink && initialLink.href.startsWith("/")) {
            const initialUrl = new URL(initialLink.href, page.url());
            filePath = `${initialUrl.pathname}${initialUrl.search}`;
            continue;
          }
          const domainFolder = page.locator("a.tree-item-content").filter({ hasText: ACTION === "status" ? "nomreh-data" : DOMAIN }).first();
          if (depth === 0 && await domainFolder.count()) {
            await domainFolder.click({ timeout: 8000 }).catch(() => undefined);
            await page.waitForTimeout(1800);
            filePath = "";
            continue;
          }
          break;
        }
        if (ACTION === "diagnose") {
          lines.push("## Existing nodenv runtime versions", "");
          await page.goto(`${panel}${nomrehFilesPath}`, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
          await page.waitForTimeout(1500);
          const nodenvLink = page.locator("a").filter({ hasText: /^\.nodenv$/ }).first();
          if (!await nodenvLink.count()) {
            lines.push("- The existing .nodenv directory was not visible; no runtime configuration was changed.", "");
          } else {
            await nodenvLink.click({ timeout: 8000 }).catch(() => undefined);
            await page.waitForTimeout(1500);
            const versionsLink = page.locator("a").filter({ hasText: /^versions$/ }).first();
            if (!await versionsLink.count()) {
              lines.push("- The existing .nodenv/versions directory was not visible; no runtime configuration was changed.", "");
            } else {
              await versionsLink.click({ timeout: 8000 }).catch(() => undefined);
              await page.waitForTimeout(1500);
              const versionNames = await page.locator("a").evaluateAll((anchors) => [...new Set(anchors.map((anchor) => (anchor.textContent || "").trim()).filter((text) => /^\d+\.\d+\.\d+$/.test(text)))]);
              if (versionNames.length) {
                for (const version of versionNames) lines.push(`- Installed nodenv version: ${version}`);
              } else {
                lines.push("- No numeric nodenv runtime versions were exposed in the directory listing.");
              }
              lines.push("- Read-only runtime inspection; no nodenv configuration or domain setting was changed.", "");
            }
          }
        }
      }
    }
    if (["upload", "extract", "build", "status", "disk", "fix-node-version", "update-package", "retire-obsolete"].includes(ACTION) && !actionCompleted) throw new Error(`The controlled Nomreh ${ACTION} action did not complete. Node.js was not enabled or restarted.`);
    lines.push("## Result", "", ACTION === "upload"
      ? "The validated application archive was uploaded to Nomreh. Extraction, dependency installation, build, and Node.js enablement remain pending."
      : ACTION === "extract"
        ? "The validated application source was extracted and verified in the Nomreh application root. Dependency installation, build, and Node.js enablement remain pending."
        : ACTION === "build"
          ? "The validated Nomreh production build and runtime smoke tests succeeded. Node.js enablement and live validation remain pending."
          : ACTION === "status"
            ? "The read-only Nomreh console and persistent-data inspection completed. No command, build, deletion, restart, or settings change was attempted."
            : ACTION === "disk"
              ? "The read-only Nomreh disk report completed. No build, deletion, restart, or settings change was attempted."
              : ACTION === "fix-node-version"
                ? "Nomreh's Node override fix completed with the original contents preserved. No build or restart was attempted; read-only command verification remains pending."
                : ACTION === "update-package"
                  ? "Nomreh's validated package.json npm launcher fix was uploaded and verified. No build or restart was attempted; disk verification remains pending."
                  : ACTION === "retire-obsolete"
                    ? "All three obsolete Nomreh Cloudflare/better-sqlite3 artifacts were preserved as non-TypeScript backups and verified. No build or restart was attempted."
                    : domainFound
        ? "Plesk web login succeeded and the Nomreh domain was found. No remediation was attempted."
        : "Plesk web login completed, but the Nomreh domain was not visible on the inspected pages. No remediation was attempted.", "");
  } catch (error) {
    lines.push("## Stopped", "", sanitize(error.message), "");
    error.nomrehReport = sanitize(lines.join("\n"));
    throw error;
  } finally {
    if (browser) await browser.close();
  }
  const output = sanitize(lines.join("\n"));
  fs.writeFileSync(OUTPUT, output, { mode: 0o600 });
  console.log(output);
}

if (require.main === module) {
  main().catch((error) => {
    const output = error.nomrehReport || sanitize(`# Plesk browser diagnostics\n\nBrowser action stopped: ${error.message}\n\n${ACTION === "diagnose" ? "No settings, deployments or files were changed." : "No subsequent build, restart, or settings change was attempted. Review the step result before retrying."}\n`);
    fs.writeFileSync(OUTPUT, output, { mode: 0o600 });
    console.error(output);
    process.exitCode = 1;
  });
}
