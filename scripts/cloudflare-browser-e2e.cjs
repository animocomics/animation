const fs = require("node:fs");
const path = require("node:path");

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value.replace(/\/$/, "");
}

async function main() {
  const baseUrl = required("NOMREH_BASE_URL");
  const playwrightModule = process.env.PLAYWRIGHT_MODULE || "playwright-core";
  const { chromium } = require(playwrightModule);
  const screenshotDir = process.env.SCREENSHOT_DIR || "/tmp/nomreh-cloudflare";
  fs.mkdirSync(screenshotDir, { recursive: true });
  const chromeCandidates = [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  const executablePath = chromeCandidates.find((candidate) => fs.existsSync(candidate));
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    headless: !process.env.DISPLAY,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const results = [];
  try {
    for (const role of ["admin", "teacher"]) {
      const prefix = role === "admin" ? "NOMREH_ADMIN" : "NOMREH_TEACHER";
      const username = required(`${prefix}_USERNAME`);
      const password = process.env[`${prefix}_PASSWORD`];
      if (!password) throw new Error(`${prefix}_PASSWORD is required`);
      const context = await browser.newContext({
        locale: "fa-IR",
        viewport: { width: 1440, height: 1000 },
      });
      const page = await context.newPage();
      try {
        await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.locator("#login-username").waitFor({ state: "visible", timeout: 90_000 });
        await page.locator("#login-username").fill(username);
        await page.locator("#login-password").fill(password);
        await Promise.all([
          page.waitForURL((url) => url.origin === baseUrl && url.pathname === "/", { timeout: 60_000 }),
          page.locator(".login-submit").click(),
        ]);
        await page.getByRole("heading", { name: "داشبورد", exact: true }).waitFor({ state: "visible", timeout: 60_000 });
        await page.waitForTimeout(1_500);
        const loginError = page.locator(".login-error");
        if (await loginError.count()) throw new Error(`Login error remained visible: ${await loginError.textContent()}`);
        const screenshot = path.join(screenshotDir, `${role}-dashboard.png`);
        await page.screenshot({ path: screenshot, fullPage: true });
        results.push({ role, login: "passed", dashboard: "visible", screenshot: path.basename(screenshot) });
      } catch (error) {
        await page.screenshot({ path: path.join(screenshotDir, `${role}-failure.png`), fullPage: true }).catch(() => {});
        throw error;
      } finally {
        await context.close();
      }
    }
    console.log(JSON.stringify({ ok: true, baseUrl, browser: "Chromium", results }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
