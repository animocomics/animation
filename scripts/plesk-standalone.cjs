#!/usr/bin/env node
"use strict";

/**
 * Small self-supervising production launcher for Plesk accounts where
 * Passenger/CageFS cannot start the application. It uses only Node.js and
 * keeps credentials, logs and PID files outside the public document root.
 */
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");

const APP_ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.resolve(APP_ROOT, process.env.NOMREH_DATA_DIR || "../nomreh-data");
const RUNTIME_DIR = path.join(DATA_DIR, "standalone");
const ENV_FILE = path.join(RUNTIME_DIR, "runtime.env");
const PID_FILE = path.join(RUNTIME_DIR, "supervisor.pid");
const LOCK_FILE = path.join(RUNTIME_DIR, "manager.lock");
const LOG_FILE = path.join(RUNTIME_DIR, "nomreh.log");
const PORT = Number(process.env.NOMREH_STANDALONE_PORT || 32147);
const HOST = "127.0.0.1";
const ENV_KEYS = [
  "NOMREH_ADMIN_USERNAME",
  "NOMREH_ADMIN_PASSWORD",
  "NOMREH_TEACHER_USERNAME",
  "NOMREH_TEACHER_PASSWORD",
  "NOMREH_SECRET_KEY",
];

function ensureRuntimeDirectory() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(RUNTIME_DIR, 0o700); } catch { /* Some shared filesystems do not support chmod. */ }
}

function readEnvironmentFile() {
  if (!fs.existsSync(ENV_FILE)) return {};
  const values = {};
  for (const line of fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator);
    if (![...ENV_KEYS, "NOMREH_DATA_DIR"].includes(key)) continue;
    const raw = line.slice(separator + 1);
    try { values[key] = JSON.parse(raw); } catch { values[key] = raw; }
  }
  return values;
}

function persistEnvironment() {
  const saved = readEnvironmentFile();
  for (const key of ENV_KEYS) {
    if (process.env[key]) saved[key] = process.env[key];
  }
  saved.NOMREH_DATA_DIR = DATA_DIR;
  const temporary = `${ENV_FILE}.${process.pid}.tmp`;
  const contents = `${Object.keys(saved).sort().map((key) => `${key}=${JSON.stringify(saved[key])}`).join("\n")}\n`;
  fs.writeFileSync(temporary, contents, { mode: 0o600 });
  fs.renameSync(temporary, ENV_FILE);
  try { fs.chmodSync(ENV_FILE, 0o600); } catch { /* See ensureRuntimeDirectory. */ }
}

function runtimeEnvironment() {
  const saved = readEnvironmentFile();
  const environment = { ...process.env, ...saved };
  for (const key of ENV_KEYS) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  environment.NOMREH_DATA_DIR = DATA_DIR;
  environment.NOMREH_HOST = HOST;
  environment.NODE_ENV = "production";
  environment.PORT = String(PORT);
  environment.NEXT_TELEMETRY_DISABLED = "1";
  return environment;
}

function readPid() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, "utf8").trim());
    return Number.isInteger(pid) && pid > 1 ? pid : null;
  } catch { return null; }
}

function processExists(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function isOurSupervisor(pid) {
  if (!processExists(pid)) return false;
  try {
    const command = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return command.includes(__filename) && command.includes("supervise");
  } catch { return false; }
}

function removePidFile() {
  try { fs.unlinkSync(PID_FILE); } catch { /* Already absent. */ }
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function signalGroup(pid, signal) {
  if (!isOurSupervisor(pid)) return;
  try { process.kill(-pid, signal); } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function stopSupervisor() {
  const pid = readPid();
  if (!pid) { removePidFile(); return; }
  if (!processExists(pid)) { removePidFile(); return; }
  if (!isOurSupervisor(pid)) {
    removePidFile();
    throw new Error("The saved process ID does not belong to Nomreh; it was not stopped.");
  }
  signalGroup(pid, "SIGTERM");
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && processExists(pid)) await delay(150);
  if (processExists(pid)) signalGroup(pid, "SIGKILL");
  removePidFile();
}

function healthCheck() {
  return new Promise((resolve) => {
    const request = http.get({
      hostname: HOST,
      port: PORT,
      path: "/login",
      // Any Host is accepted by Next; the old subdomain is not assumed.
      headers: { Host: process.env.NOMREH_HOST_HEADER || "localhost" },
      timeout: 2500,
    }, (response) => {
      response.resume();
      resolve(Boolean(response.statusCode && response.statusCode < 500));
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(false));
  });
}

async function waitForHealth(pid) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (await healthCheck()) return;
    if (!isOurSupervisor(pid)) break;
    await delay(500);
  }
  let details = "";
  try { details = fs.readFileSync(LOG_FILE, "utf8").trim().split(/\r?\n/).slice(-20).join("\n"); } catch { /* No log yet. */ }
  throw new Error(`Nomreh did not become ready on ${HOST}:${PORT}.${details ? `\nLast log lines:\n${details}` : ""}`);
}

async function startSupervisor() {
  const existingPid = readPid();
  if (isOurSupervisor(existingPid) && await healthCheck()) {
    console.log(`Nomreh is already running on ${HOST}:${PORT}.`);
    return;
  }
  if (existingPid) await stopSupervisor();

  const logDescriptor = fs.openSync(LOG_FILE, "a");
  let child;
  try {
    child = spawn(process.execPath, [__filename, "supervise"], {
      cwd: APP_ROOT,
      env: runtimeEnvironment(),
      detached: true,
      stdio: ["ignore", logDescriptor, logDescriptor],
    });
  } finally {
    fs.closeSync(logDescriptor);
  }
  child.on("error", (error) => console.error("Supervisor spawn error:", error.message));
  child.unref();
  fs.writeFileSync(PID_FILE, `${child.pid}\n`, { mode: 0o600 });
  try {
    await waitForHealth(child.pid);
    console.log(`Nomreh is ready on ${HOST}:${PORT}.`);
  } catch (error) {
    await stopSupervisor();
    throw error;
  }
}

function supervise() {
  let application = null;
  let restartTimer = null;
  let stopping = false;

  const launch = () => {
    if (stopping) return;
    console.log(`[${new Date().toISOString()}] Starting Nomreh (pid ${process.pid} supervisor).`);
    application = spawn(process.execPath, [path.join(APP_ROOT, "server.js")], {
      cwd: APP_ROOT,
      env: process.env,
      stdio: ["ignore", "inherit", "inherit"],
    });
    application.on("error", (error) => console.error(`[${new Date().toISOString()}] Application spawn error: ${error.message}`));
    application.on("exit", (code, signal) => {
      application = null;
      if (stopping) { process.exit(0); return; }
      console.error(`[${new Date().toISOString()}] Nomreh exited (code=${code}, signal=${signal}); restarting in 2 seconds.`);
      restartTimer = setTimeout(launch, 2000);
    });
  };

  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    if (restartTimer) clearTimeout(restartTimer);
    if (!application) { process.exit(0); return; }
    application.kill("SIGTERM");
    const forceTimer = setTimeout(() => {
      if (application) application.kill("SIGKILL");
      process.exit(0);
    }, 8000);
    forceTimer.unref();
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  launch();
}

async function withLock(action) {
  let descriptor;
  try {
    descriptor = fs.openSync(LOCK_FILE, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") {
      try {
        if (Date.now() - fs.statSync(LOCK_FILE).mtimeMs > 120000) {
          fs.unlinkSync(LOCK_FILE);
          descriptor = fs.openSync(LOCK_FILE, "wx", 0o600);
        }
      } catch { /* Another process may have completed meanwhile. */ }
    }
    if (descriptor === undefined) throw new Error("Another Nomreh start/stop operation is still running; try again shortly.");
  }
  try { await action(); } finally {
    fs.closeSync(descriptor);
    try { fs.unlinkSync(LOCK_FILE); } catch { /* Already removed. */ }
  }
}

async function main() {
  const command = process.argv[2] || "start";
  if (command === "supervise") { supervise(); return; }
  if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) throw new Error("Invalid standalone port.");
  ensureRuntimeDirectory();
  if (["start", "restart", "ensure"].includes(command)) persistEnvironment();

  await withLock(async () => {
    if (command === "start" || command === "ensure") await startSupervisor();
    else if (command === "restart") { await stopSupervisor(); await startSupervisor(); }
    else if (command === "stop") { await stopSupervisor(); console.log("Nomreh standalone process stopped."); }
    else if (command === "status") {
      const pid = readPid();
      const healthy = isOurSupervisor(pid) && await healthCheck();
      console.log(healthy ? `Nomreh is running on ${HOST}:${PORT}.` : "Nomreh is not running.");
      if (!healthy) process.exitCode = 1;
    } else throw new Error(`Unknown command: ${command}`);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
