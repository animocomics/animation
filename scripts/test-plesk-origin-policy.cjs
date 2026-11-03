"use strict";
const http = require("node:http");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { restrictToPanelOrigin } = require("./plesk-origin-policy.cjs");

async function listen(server) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function main() {
  let leaked = 0;
  const other = http.createServer((_req, res) => { leaked += 1; res.end("untrusted"); });
  const otherOrigin = await listen(other);
  const panel = http.createServer((req, res) => {
    if (req.url === "/external-redirect") { res.writeHead(302, { location: `${otherOrigin}/leak` }); return res.end(); }
    if (req.url === "/chained-redirect") { res.writeHead(302, { location: "/external-redirect" }); return res.end(); }
    if (req.url === "/internal-redirect") { res.writeHead(302, { location: "/ok" }); return res.end(); }
    if (req.url === "/subresource") { res.writeHead(200, { "content-type": "text/html" }); return res.end(`<img src="${otherOrigin}/leak">`); }
    res.end("panel");
  });
  const panelOrigin = await listen(panel);
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: "block" });
    await restrictToPanelOrigin(context, panelOrigin);
    const page = await context.newPage();
    await page.goto(`${panelOrigin}/internal-redirect`);
    assert.equal(await page.locator("body").innerText(), "panel");
    await page.goto(`${panelOrigin}/subresource`, { waitUntil: "load" });
    await page.goto(`${panelOrigin}/external-redirect`).catch(() => undefined);
    await page.goto(`${panelOrigin}/chained-redirect`).catch(() => undefined);
    await page.goto(`${otherOrigin}/leak`).catch(() => undefined);
    assert.equal(leaked, 0, "the non-panel server must receive no requests, including redirects");
    console.log("PLESK_ORIGIN_POLICY_PASS");
  } finally {
    await browser.close();
    await Promise.all([new Promise((resolve) => panel.close(resolve)), new Promise((resolve) => other.close(resolve))]);
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
