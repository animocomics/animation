const { createServer } = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const next = require("next");
const { attachShecanVncWebSocket } = require("./shecan-vnc-websocket.cjs");
const { handleShecanVncHttp, closeShecanVncHttpSessions, startShecanVncReverseServer, startShecanVncUnixClient } = require("./shecan-vnc-http.cjs");

process.env.NODE_ENV = "production";
const port = Number(process.env.PORT) || 3000;
const hostname = process.env.NOMREH_HOST || "0.0.0.0";
const app = next({ dev: false, hostname, port });
const handle = app.getRequestHandler();

function ensureOfficialShecanSupervisor() {
  if (process.env.NOMREH_DISABLE_SHECAN_SUPERVISOR === "1") return;
  const windowsRuntimeDirectory = process.env.NOMREH_SHECAN_WINDOWS_RUNTIME_DIR || path.join(process.cwd(), "nomreh-vm", "windows");
  const windowsSupervisor = path.join(process.cwd(), "scripts", "shecan-vm", "windows-supervisor.mjs");
  if (fs.existsSync(path.join(windowsRuntimeDirectory, "runtime-manifest.json")) && fs.existsSync(windowsSupervisor)) {
    const child = spawn(process.execPath, [windowsSupervisor], {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        SHECAN_WINDOWS_RUNTIME_DIR: windowsRuntimeDirectory,
        SHECAN_PREVIEW_HOST: "127.0.0.1",
      },
    });
    child.on("error", () => undefined);
    child.unref();
    return;
  }
  const runtimeDirectory = process.env.NOMREH_SHECAN_RUNTIME_DIR || path.join(process.cwd(), "nomreh-vm", "official");
  const supervisor = path.join(process.cwd(), "scripts", "shecan-runtime-watchdog.cjs");
  if (!fs.existsSync(path.join(runtimeDirectory, "runtime-manifest.json")) || !fs.existsSync(supervisor)) return;
  // A Nomreh application restart is an explicit request for always-on service.
  // Clear only our own regular stop marker; never follow a symlink or touch
  // any other data. The admin Stop button still works until the next restart.
  try {
    const dataDirectory = process.env.NOMREH_DATA_DIR || path.join(process.cwd(), "data");
    const stopPath = path.join(dataDirectory, "shecan-official", "stop-requested");
    const info = fs.lstatSync(stopPath);
    if (info.isFile() && !info.isSymbolicLink()) fs.unlinkSync(stopPath);
  } catch { /* No stale stop marker, or the data directory is unavailable. */ }
  // The watchdog has its own PID lock and verifies every runtime hash before
  // launching anything. It survives this Node process and restores the guest
  // after an application restart or an unexpected QEMU exit.
  const child = spawn(process.execPath, [supervisor], {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  child.on("error", () => undefined);
  child.unref();
}

app.prepare().then(() => {
  // Listen before the guest boots so its reverse x11vnc connection is queued
  // even when no admin console is open yet.
  try { startShecanVncReverseServer(); } catch { console.error("Nomreh reverse VNC listener could not be configured"); }
  try { startShecanVncUnixClient(); } catch { console.error("Nomreh UNIX VNC client could not be configured"); }
  ensureOfficialShecanSupervisor();
  const server = createServer((request, response) => {
    if (handleShecanVncHttp(request, response, port)) return;
    handle(request, response);
  });
  attachShecanVncWebSocket(server, port);
  server.listen(port, hostname, () => {
    console.log(`Nomreh is ready on ${hostname}:${port} with ${process.version}`);
  });
  const shutdown = () => {
    closeShecanVncHttpSessions();
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}).catch((error) => {
  console.error("Nomreh failed to start", error);
  process.exit(1);
});
