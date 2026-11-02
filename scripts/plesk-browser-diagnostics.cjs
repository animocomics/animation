#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
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
  if (!["diagnose", "upload"].includes(ACTION)) throw new Error(`Unsupported Plesk browser action: ${ACTION}`);
  const panel = normalizePanelUrl(process.env.PLESK_PANEL_URL || "");
  const readOnly = ACTION === "diagnose";
  const lines = ["# Plesk browser diagnostics", "", readOnly
    ? "Read-only browser inspection. No settings, deployments or files were changed."
    : "Controlled action: upload one validated application archive to Nomreh only. No extraction, build, restart, or settings change is attempted.", ""];
  let actionCompleted = false;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1680, height: 1050 } });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(`${panel}/login_up.php`, { waitUntil: "domcontentloaded", timeout: 30000 });

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
          })).filter((item) => /^(nomreh\.|nomreh-data|httpdocs|public|package(-lock)?\.json|server\.js|next\.config|scripts|node_modules|\.next|git)$/i.test(item.text)).slice(0, 30));
          for (const link of fileLinks) lines.push(`- File entry: ${sanitize(link.text)}${link.href.startsWith("/") ? ` (${sanitize(new URL(link.href, page.url()).pathname)})` : ""}`);
          if (fileLinks.length) lines.push("");
          if (depth === 1) {
            const archivePresent = fileBody.includes(ARCHIVE_NAME);
            if (ACTION === "upload" && archivePresent) {
              throw new Error(`${ARCHIVE_NAME} already exists in the Nomreh application directory. Upload stopped without overwriting it.`);
            }
            const fileDetails = fileBody.split(/\r?\n/).map((line) => line.trim()).filter((line) => /package\.json|server\.js|next\.config|sqlite\.ts|plesk-node22|\.next\b/i.test(line) && !/secret|token|password|credential/i.test(line)).slice(0, 20);
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
              lines.push(`- Extract menu item found: ${extractChoice && await extractChoice.count() ? "yes" : "no"}`);
              if (extractChoice && await extractChoice.count()) {
                await extractChoice.click({ timeout: 5000 }).catch(() => undefined);
                await page.waitForTimeout(600);
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
              lines.push("- Inspection only: the extract confirmation button was not pressed.", "");
            }
            if (ACTION === "upload" || !archivePresent) {
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
          if (depth === 0 && appLink && appLink.href.startsWith("/")) {
            const appUrl = new URL(appLink.href, page.url());
            filePath = `${appUrl.pathname}${appUrl.search}`;
            continue;
          }
          const domainFolder = page.locator("a.tree-item-content").filter({ hasText: DOMAIN }).first();
          if (depth === 0 && await domainFolder.count()) {
            await domainFolder.click({ timeout: 8000 }).catch(() => undefined);
            await page.waitForTimeout(1800);
            filePath = "";
            continue;
          }
          break;
        }
      }
    }
    if (ACTION === "upload" && !actionCompleted) throw new Error("The controlled Nomreh archive upload did not complete. No extraction, build, restart, or settings change was attempted.");
    lines.push("## Result", "", ACTION === "upload"
      ? "The validated application archive was uploaded to Nomreh. Extraction, dependency installation, build, and Node.js enablement remain pending."
      : domainFound
        ? "Plesk web login succeeded and the Nomreh domain was found. No remediation was attempted."
        : "Plesk web login completed, but the Nomreh domain was not visible on the inspected pages. No remediation was attempted.", "");
  } finally {
    if (browser) await browser.close();
  }
  const output = sanitize(lines.join("\n"));
  fs.writeFileSync(OUTPUT, output, { mode: 0o600 });
  console.log(output);
}

if (require.main === module) {
  main().catch((error) => {
    const output = sanitize(`# Plesk browser diagnostics\n\nBrowser action stopped: ${error.message}\n\n${ACTION === "diagnose" ? "No settings, deployments or files were changed." : "No subsequent extraction, build, restart, or settings change was attempted. Review the step result before retrying."}\n`);
    fs.writeFileSync(OUTPUT, output, { mode: 0o600 });
    console.error(output);
    process.exitCode = 1;
  });
}
