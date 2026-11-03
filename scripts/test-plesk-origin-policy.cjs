"use strict";
const http = require("node:http");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { restrictToPanelOrigin } = require("./plesk-origin-policy.cjs");
const { startPanelProxy } = require("./plesk-panel-proxy.cjs");

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
  const panelUrl = new URL(panelOrigin);
  const proxy = await startPanelProxy(`https://${panelUrl.host}`);
  async function tunnel(authority) {
    return new Promise((resolve, reject) => {
      const proxyUrl = new URL(proxy.address);
      const req = http.request({ host: proxyUrl.hostname, port: proxyUrl.port, method: "CONNECT", path: authority });
      req.on("connect", (res, socket) => { socket.destroy(); resolve(res.statusCode); });
      req.on("error", reject);
      req.end();
    });
  }
  assert.equal(await tunnel(panelUrl.host), 200, "the configured panel tunnel must be reachable");
  assert.equal(await tunnel(new URL(otherOrigin).host), 403, "the proxy must reject a different origin");
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: "block" });
    const page = await context.newPage();
    await restrictToPanelOrigin(page, panelOrigin);
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
    await proxy.close();
    await Promise.all([new Promise((resolve) => panel.close(resolve)), new Promise((resolve) => other.close(resolve))]);
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
