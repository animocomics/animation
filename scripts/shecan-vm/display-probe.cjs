"use strict";
// Runner-only proof of a no-NIC guest's framebuffer over a private Unix socket.
// This is not an authenticated production endpoint and must not run on Plesk.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright");
const { WebSocketServer } = require("ws");

async function main() {
  const [runtime, novnc] = process.argv.slice(2).map((value) => value && path.resolve(value));
  if (!runtime || !novnc || !fs.existsSync(path.join(novnc, "core/rfb.js"))) throw new Error("Missing local probe runtime or noVNC source");
  const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nomreh-display-"));
  fs.chmodSync(privateDir, 0o700);
  const socketPath = path.join(privateDir, "vnc.sock");
  const vm = spawn("/bin/sh", [path.join(runtime, "run-display-probe.sh")], {
    env: { ...process.env, NOMREH_DISPLAY_SOCKET: socketPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let vmLog = "";
  let exited = false;
  vm.on("exit", () => { exited = true; });
  for (const output of [vm.stdout, vm.stderr]) output.on("data", (data) => { vmLog = (vmLog + data.toString()).slice(-40000); });
  let browser, server;
  const counts = { upgrades: 0, targetConnected: 0, received: 0, sent: 0, targetErrors: 0, targetClosed: 0, pageErrors: 0, scriptFailures: 0 };
  const wss = new WebSocketServer({ noServer: true });
  try {
    const deadline = Date.now() + 180000;
    while (!vmLog.includes("NOMREH_LOCAL_DISPLAY_RELAY_READY")) {
      if (exited || Date.now() > deadline) throw new Error("Guest display relay did not become ready");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!vmLog.includes("NOMREH_OFFICIAL_PROBE_WINDOW_OBSERVED yes") || !vmLog.includes("NOMREH_OFFICIAL_PROBE_NO_NETWORK yes")) throw new Error("Guest window or no-NIC evidence missing");
    server = http.createServer((req, res) => {
      const pathname = new URL(req.url, "http://localhost").pathname;
      if (pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html" });
        return res.end(`<!doctype html><div id="screen"></div><script type="module">
          import RFB from '/core/rfb.js';
          const rfb=new RFB(document.getElementById('screen'), 'ws://'+location.host+'/vnc');
          rfb.addEventListener('connect',()=>{window.probeConnected=true});
          rfb.addEventListener('disconnect',()=>{window.probeDisconnected=true});
        </script>`);
      }
      const target = path.resolve(novnc, "." + pathname);
      if (!target.startsWith(novnc + path.sep) || !/\.js$/.test(target)) { res.writeHead(404); return res.end(); }
      fs.readFile(target, (error, contents) => {
        if (error) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { "Content-Type": "text/javascript" }); res.end(contents);
      });
    });
    server.on("upgrade", (request, connection, head) => {
      if (request.url !== "/vnc") return connection.destroy();
      counts.upgrades += 1;
      wss.handleUpgrade(request, connection, head, (ws) => {
        const target = net.createConnection(socketPath);
        target.on("connect", () => { counts.targetConnected += 1; target.write(Buffer.from([0x4e])); });
        target.on("data", (data) => { counts.received += data.length; if (ws.readyState === ws.OPEN) ws.send(data, { binary: true }); });
        target.on("error", () => { counts.targetErrors += 1; ws.close(); });
        target.on("close", () => { counts.targetClosed += 1; ws.close(); });
        ws.on("message", (data) => { counts.sent += data.length; target.write(data); });
        ws.on("error", () => target.destroy());
        ws.on("close", () => target.destroy());
      });
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
    page.on("pageerror", () => { counts.pageErrors += 1; });
    page.on("requestfailed", () => { counts.scriptFailures += 1; });
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "load" });
    await page.waitForFunction(() => window.probeConnected === true, null, { timeout: 45000 });
    // Require real framebuffer pixels, not merely a WebSocket handshake.
    await page.waitForFunction(() => {
      const canvas = document.querySelector("canvas");
      if (!canvas || canvas.width < 100 || canvas.height < 100) return false;
      const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      const colors = new Set();
      for (let i = 0; i < pixels.length; i += 400) colors.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`);
      return colors.size > 12;
    }, null, { timeout: 30000 });
    console.log("NOMREH_NOVNC_OFFICIAL_WINDOW_OBSERVED yes");
    console.log("NOMREH_NOVNC_BROWSER_CONNECTED yes");
    console.log("NOMREH_NOVNC_FRAMEBUFFER_NONBLANK yes");
    console.log("NOMREH_NOVNC_GUEST_NO_NETWORK yes");
    console.log("NOMREH_NOVNC_NO_CREDENTIALS yes");
    console.log("NOMREH_NOVNC_LOCAL_PASS");
  } finally {
    if (browser) await browser.close();
    for (const [label, count] of Object.entries(counts)) console.log(`NOMREH_NOVNC_DIAGNOSTIC ${label}=${count}`);
    for (const client of wss.clients) client.terminate();
    wss.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    if (!exited) vm.kill("SIGTERM");
    for (const line of vmLog.split(/\r?\n/)) if (/^NOMREH_(?:OFFICIAL_PROBE|LOCAL_DISPLAY)_/.test(line)) console.log(line);
    fs.rmSync(privateDir, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(`NOMREH_NOVNC_LOCAL_ERROR ${error.message}`); process.exitCode = 1; });
