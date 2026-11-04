"use strict";

// Keep the validated official guest alive independently of the Next.js process.
// This supervisor never logs credentials or network configuration. A manual
// stop is persistent until an administrator explicitly starts the guest again;
// an application/process restart does not clear that choice.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const REQUIRED_FILES = [
  "glibc/lib/x86_64-linux-gnu/ld-2.27.so",
  "qemu/bin/qemu-system-x86_64",
  "guest/vmlinuz-virt",
  "guest/initramfs-official",
  "run-official.sh",
];
const runtimeRoot = path.resolve(process.env.NOMREH_SHECAN_RUNTIME_DIR || path.join(process.cwd(), "nomreh-vm", "official"));
const dataRoot = path.resolve(process.env.NOMREH_DATA_DIR || path.join(process.cwd(), "data"));
const stateRoot = path.join(dataRoot, "shecan-official");
const guestPidPath = path.join(stateRoot, "guest.pid");
const supervisorPidPath = path.join(stateRoot, "supervisor.pid");
const stopPath = path.join(stateRoot, "stop-requested");
const statePath = path.join(stateRoot, "state.json");
const consolePath = path.join(stateRoot, "guest-console.log");
const hostLogPath = path.join(stateRoot, "host.log");
const supervisorLogPath = path.join(stateRoot, "supervisor.log");
const scriptPath = path.resolve(__filename);
let child = null;
let restartPending = false;

function regularFile(file) {
  try {
    const info = fs.lstatSync(file);
    return info.isFile() && !info.isSymbolicLink();
  } catch { return false; }
}

function readPid(file) {
  try {
    const pid = Number(fs.readFileSync(file, "utf8").trim());
    return Number.isInteger(pid) && pid > 1 ? pid : null;
  } catch { return null; }
}

function commandLine(pid) {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8"); } catch { return ""; }
}

function isGuest(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); } catch { return false; }
  const command = commandLine(pid);
  return command.includes(path.join(runtimeRoot, "qemu", "bin", "qemu-system-x86_64"))
    && command.includes(path.join(runtimeRoot, "guest", "initramfs-official"));
}

function isSupervisor(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); } catch { return false; }
  return commandLine(pid).includes(scriptPath);
}

function stopped() {
  return regularFile(stopPath);
}

function writeState(patch) {
  let previous = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (parsed && typeof parsed === "object") previous = parsed;
  } catch { /* A missing or damaged state file is replaced atomically. */ }
  const state = { ...previous, ...patch };
  if (patch.lastError === undefined) delete state.lastError;
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const temporary = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, statePath);
}

function markError(code) {
  try { writeState({ lastError: String(code).replace(/[^A-Z0-9_]/g, "").slice(0, 60) || "RUNTIME_ERROR" }); } catch { /* Status remains fail-closed. */ }
}

function verifyRuntime() {
  try {
    const rootInfo = fs.lstatSync(runtimeRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("unsafe-root");
    const manifestPath = path.join(runtimeRoot, "runtime-manifest.json");
    if (!regularFile(manifestPath)) throw new Error("missing-manifest");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (manifest.format !== 1 || !/^[a-f0-9]{64}$/.test(manifest.officialRpmSha256 || "") || !manifest.files) throw new Error("invalid-manifest");
    for (const relative of REQUIRED_FILES) {
      const expected = manifest.files[relative];
      const target = path.resolve(runtimeRoot, relative);
      if (!/^[a-f0-9]{64}$/.test(expected || "") || !target.startsWith(`${runtimeRoot}${path.sep}`) || !regularFile(target)) throw new Error("unsafe-file");
      const actual = crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
      if (actual !== expected) throw new Error("hash-mismatch");
    }
    return true;
  } catch {
    markError("RUNTIME_VERIFY_FAILED");
    return false;
  }
}

function acquireLock() {
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = fs.openSync(supervisorPidPath, "wx", 0o600);
      try { fs.writeSync(descriptor, `${process.pid}\n`); } finally { fs.closeSync(descriptor); }
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = readPid(supervisorPidPath);
      if (existing && isSupervisor(existing)) return false;
      try {
        const info = fs.lstatSync(supervisorPidPath);
        if (info.isFile() && !info.isSymbolicLink()) fs.unlinkSync(supervisorPidPath);
      } catch { /* Another supervisor may be replacing the stale lock. */ }
    }
  }
  return false;
}

function releaseLock() {
  if (readPid(supervisorPidPath) !== process.pid) return;
  try { fs.unlinkSync(supervisorPidPath); } catch { /* Already removed. */ }
}

function spawnGuest() {
  if (stopped() || !verifyRuntime()) return null;
  const existing = readPid(guestPidPath);
  if (isGuest(existing)) return null;
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(consolePath, "", { mode: 0o600 });
  const log = fs.openSync(hostLogPath, "a", 0o600);
  let guest;
  try {
    guest = spawn(path.join(runtimeRoot, "run-official.sh"), [], {
      cwd: runtimeRoot,
      detached: true,
      stdio: ["ignore", log, log],
      env: {
        ...process.env,
        NOMREH_VM_MEMORY: process.env.NOMREH_VM_MEMORY || "2048M",
        NOMREH_VNC_PORT: process.env.NOMREH_VNC_PORT || "15900",
        NOMREH_VNC_UNIX_SOCKET: process.env.NOMREH_VNC_UNIX_SOCKET || path.join(stateRoot, "vnc.sock"),
        NOMREH_PROXY_PORT: process.env.NOMREH_PROXY_PORT || "18888",
        NOMREH_VM_SERIAL: `file:${consolePath}`,
        NOMREH_VM_PROBE: "0",
      },
    });
  } finally { fs.closeSync(log); }
  fs.writeFileSync(guestPidPath, `${guest.pid}\n`, { mode: 0o600 });
  writeState({ startedAt: new Date().toISOString(), lastError: undefined });
  guest.once("error", () => markError("SPAWN_FAILED"));
  guest.once("exit", (code, signal) => {
    if (!stopped()) markError(`GUEST_EXIT_${signal || code || "UNKNOWN"}`);
  });
  return guest;
}

function terminateGuest(pid) {
  if (!isGuest(pid)) return;
  try { process.kill(-pid, "SIGTERM"); } catch (error) {
    if (error.code !== "ESRCH") {
      try { process.kill(pid, "SIGTERM"); } catch { /* Already exiting. */ }
    }
  }
}

function stop() {
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(stopPath, "manual stop\n", { mode: 0o600 });
  const supervisor = readPid(supervisorPidPath);
  if (supervisor && supervisor !== process.pid && isSupervisor(supervisor)) {
    try { process.kill(supervisor, "SIGTERM"); } catch { /* Already exiting. */ }
  }
  terminateGuest(readPid(guestPidPath));
}

function run() {
  if (stopped() || !regularFile(path.join(runtimeRoot, "runtime-manifest.json"))) return;
  let locked = false;
  try { locked = acquireLock(); } catch { markError("SUPERVISOR_LOCK_FAILED"); }
  if (!locked) return;
  const shutdown = () => { releaseLock(); process.exit(0); };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  const tick = () => {
    if (stopped()) { shutdown(); return; }
    const pid = readPid(guestPidPath);
    if (isGuest(pid) || (child && isGuest(child.pid)) || restartPending) return;
    restartPending = true;
    const timer = setTimeout(() => {
      restartPending = false;
      if (!stopped() && !isGuest(readPid(guestPidPath))) child = spawnGuest();
    }, child ? 5000 : 0);
    timer.unref();
    // The interval below keeps the supervisor alive even while this timer is unref'd.
  };
  tick();
  const interval = setInterval(tick, 5000);
  interval.ref();
}

if (process.argv[2] === "--stop") stop();
else run();
