import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const REQUIRED_RUNTIME_FILES = [
  "glibc/lib/x86_64-linux-gnu/ld-2.27.so",
  "qemu/bin/qemu-system-x86_64",
  "guest/vmlinuz-virt",
  "guest/initramfs-official",
  "run-official.sh",
] as const;

export interface OfficialRuntimeStatus {
  installed: boolean;
  running: boolean;
  appReady: boolean;
  brokerReady: boolean;
  activationReady: boolean;
  supervisorRunning: boolean;
  markers: string[];
  phase: "not-installed" | "stopped" | "starting" | "ready" | "error";
  startedAt?: string;
  message: string;
}

interface RuntimeState {
  startedAt?: string;
  lastError?: string;
}

function runtimeRoot(): string {
  return path.resolve(process.env.NOMREH_SHECAN_RUNTIME_DIR || path.join(process.cwd(), "nomreh-vm", "official"));
}

function stateRoot(): string {
  const data = path.resolve(process.env.NOMREH_DATA_DIR || path.join(process.cwd(), "data"));
  return path.join(data, "shecan-official");
}

function pidPath(): string { return path.join(stateRoot(), "guest.pid"); }
function supervisorPidPath(): string { return path.join(stateRoot(), "supervisor.pid"); }
function stopRequestedPath(): string { return path.join(stateRoot(), "stop-requested"); }
function statePath(): string { return path.join(stateRoot(), "state.json"); }
function consolePath(): string { return path.join(stateRoot(), "guest-console.log"); }
function controlSocketPath(): string { return path.join(stateRoot(), "control.sock"); }
function supervisorScriptPath(): string { return path.resolve(process.cwd(), "scripts", "shecan-runtime-watchdog.cjs"); }

function isOurSupervisor(pid: number | null): pid is number {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(supervisorScriptPath());
  } catch { return false; }
}

function launchOfficialRuntimeSupervisor(): void {
  if (isOurSupervisor(readSupervisorPid()) || !regularFile(supervisorScriptPath())) return;
  try {
    const child = spawn(process.execPath, [supervisorScriptPath()], {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    });
    child.on("error", () => undefined);
    child.unref();
  } catch { /* The explicit runtime status remains fail-closed if supervision cannot start. */ }
}

let lastSupervisorRecoveryAttempt = 0;

/** Re-establish the detached supervisor after a host/application process loss. */
export function ensureOfficialRuntimeSupervisor(): void {
  if (!regularFile(path.join(runtimeRoot(), "runtime-manifest.json")) || regularFile(stopRequestedPath())) return;
  const now = Date.now();
  if (now - lastSupervisorRecoveryAttempt < 2000) return;
  lastSupervisorRecoveryAttempt = now;
  launchOfficialRuntimeSupervisor();
}

function readSupervisorPid(): number | null {
  try {
    const pid = Number(fs.readFileSync(supervisorPidPath(), "utf8").trim());
    return Number.isInteger(pid) && pid > 1 ? pid : null;
  } catch { return null; }
}

export function officialRuntimePorts(): { vnc: number; proxy: number } {
  const vnc = Number(process.env.NOMREH_VNC_PORT || 15900);
  const proxy = Number(process.env.NOMREH_PROXY_PORT || 18888);
  if (![vnc, proxy].every((port) => Number.isInteger(port) && port >= 1024 && port <= 65535) || vnc === proxy) {
    throw new Error("Invalid isolated Shecan runtime ports");
  }
  return { vnc, proxy };
}

/** Send one scoped activation command without ever placing the secret in argv or logs. */
export async function sendOfficialGuestActivation(
  updateUrl: string,
  servers: [string, string],
  options: { socketPath?: string; timeoutMs?: number } = {},
): Promise<string> {
  const parsed = new URL(updateUrl);
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" || parsed.port || !(hostname === "shecan.ir" || hostname.endsWith(".shecan.ir")) || parsed.username || parsed.password || updateUrl.length > 2000 || !servers.every((server) => net.isIPv4(server))) {
    throw new Error("Invalid isolated Shecan activation input");
  }
  const socketPath = options.socketPath || controlSocketPath();
  const timeoutMs = Math.max(1000, Math.min(60_000, options.timeoutMs || 45_000));
  const nonce = randomBytes(8).toString("hex");
  const encode = (value: string) => Buffer.from(value, "utf8").toString("base64");
  const command = `ACTIVATE ${nonce} ${encode(updateUrl)} ${encode(servers[0])} ${encode(servers[1])}\n`;
  return new Promise<string>((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let settled = false;
    let received = "";
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(new Date().toISOString());
    };
    const timer = setTimeout(() => finish(new Error("Isolated Shecan activation timed out")), timeoutMs);
    socket.once("connect", () => { socket.write(command); });
    socket.on("data", (chunk) => {
      received = `${received}${chunk.toString("utf8")}`.slice(-512);
      let newline = received.indexOf("\n");
      while (newline >= 0) {
        const line = received.slice(0, newline).trim();
        received = received.slice(newline + 1);
        const [status, responseNonce, rawCode] = line.split(" ");
        if (responseNonce === nonce && status === "OK") { finish(); return; }
        if (responseNonce === nonce && status === "ERROR") {
          const code = String(rawCode || "FAILED").replace(/[^A-Z0-9_]/g, "").slice(0, 32) || "FAILED";
          finish(new Error(`Isolated Shecan activation failed: ${code}`));
          return;
        }
        newline = received.indexOf("\n");
      }
    });
    socket.once("error", () => finish(new Error("Isolated Shecan control channel is unavailable")));
    socket.once("close", () => { if (!settled) finish(new Error("Isolated Shecan control channel closed")); });
  });
}

let officialControlQueue: Promise<unknown> = Promise.resolve();

export async function activateOfficialGuest(updateUrl: string, servers: [string, string]): Promise<string> {
  let runtime = getOfficialRuntimeStatus();
  if (!runtime.running) throw new Error("Isolated Shecan guest is not running");
  const deadline = Date.now() + 30_000;
  while ((!runtime.appReady || !runtime.brokerReady) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    runtime = getOfficialRuntimeStatus();
    if (!runtime.running) throw new Error("Isolated Shecan guest stopped before activation");
  }
  if (!runtime.appReady || !runtime.brokerReady) throw new Error("Isolated Shecan app or AI broker is not ready");
  const activation = officialControlQueue.then(() => sendOfficialGuestActivation(updateUrl, servers));
  officialControlQueue = activation.catch(() => undefined);
  return activation;
}

function regularFile(target: string): boolean {
  try {
    const info = fs.lstatSync(target);
    return info.isFile() && !info.isSymbolicLink();
  } catch { return false; }
}

function readState(): RuntimeState {
  try {
    const value = JSON.parse(fs.readFileSync(statePath(), "utf8")) as RuntimeState;
    return { startedAt: typeof value.startedAt === "string" ? value.startedAt : undefined, lastError: typeof value.lastError === "string" ? value.lastError.slice(0, 80) : undefined };
  } catch { return {}; }
}

function writeState(state: RuntimeState): void {
  fs.mkdirSync(stateRoot(), { recursive: true, mode: 0o700 });
  const temporary = `${statePath()}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, statePath());
}

function consoleTail(): string {
  try {
    const info = fs.statSync(consolePath());
    const length = Math.min(info.size, 1024 * 1024);
    const descriptor = fs.openSync(consolePath(), "r");
    try {
      const buffer = Buffer.alloc(length);
      fs.readSync(descriptor, buffer, 0, length, info.size - length);
      return buffer.toString("utf8");
    } finally { fs.closeSync(descriptor); }
  } catch { return ""; }
}

function consoleMarkers(text = consoleTail()): string[] {
  return text.split(/\r?\n/).map((line) => line.trim())
    .filter((line) => /^NOMREH_(?:OFFICIAL|VNC)_[A-Z0-9_]+$/.test(line))
    .slice(-48);
}

function readPid(): number | null {
  try {
    const pid = Number(fs.readFileSync(pidPath(), "utf8").trim());
    return Number.isInteger(pid) && pid > 1 ? pid : null;
  } catch { return null; }
}

function isOurGuest(pid: number | null): pid is number {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    const command = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return command.includes(path.join(runtimeRoot(), "qemu", "bin", "qemu-system-x86_64"))
      && command.includes(path.join(runtimeRoot(), "guest", "initramfs-official"));
  } catch { return false; }
}

export function verifyOfficialRuntime(root = runtimeRoot()): void {
  const rootInfo = fs.lstatSync(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Official Shecan runtime root is unsafe");
  const manifestPath = path.join(root, "runtime-manifest.json");
  if (!regularFile(manifestPath)) throw new Error("Official Shecan runtime manifest is missing");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    format?: number;
    officialRpmSha256?: string;
    files?: Record<string, string>;
  };
  if (manifest.format !== 1 || !/^[a-f0-9]{64}$/.test(manifest.officialRpmSha256 || "") || !manifest.files) {
    throw new Error("Official Shecan runtime manifest is invalid");
  }
  for (const relative of REQUIRED_RUNTIME_FILES) {
    const expected = manifest.files[relative];
    if (!/^[a-f0-9]{64}$/.test(expected || "")) throw new Error(`Official Shecan runtime hash is missing: ${relative}`);
    const target = path.resolve(root, relative);
    if (!target.startsWith(`${path.resolve(root)}${path.sep}`) || !regularFile(target)) throw new Error(`Official Shecan runtime file is unsafe: ${relative}`);
    const actual = createHash("sha256").update(fs.readFileSync(target)).digest("hex");
    if (actual !== expected) throw new Error(`Official Shecan runtime hash mismatch: ${relative}`);
  }
}

export function getOfficialRuntimeStatus(): OfficialRuntimeStatus {
  let installed = false;
  try {
    const root = runtimeRoot();
    installed = regularFile(path.join(root, "runtime-manifest.json")) && regularFile(path.join(root, "run-official.sh"));
  } catch { installed = false; }
  const state = readState();
  const running = isOurGuest(readPid());
  const supervisorRunning = isOurSupervisor(readSupervisorPid());
  const markers = running ? consoleTail() : "";
  const markerList = running ? consoleMarkers(markers) : [];
  const appReady = running && markers.includes("NOMREH_OFFICIAL_APP_PROCESS_ALIVE");
  const brokerReady = running && markers.includes("NOMREH_OFFICIAL_AI_BROKER_LISTENING");
  const activationMarkers = markers.split(/\r?\n/).map((line) => line.trim()).filter((marker) => marker === "NOMREH_OFFICIAL_AI_ACTIVATED" || marker === "NOMREH_OFFICIAL_AI_ACTIVATION_FAILED");
  const activationReady = running && appReady && brokerReady && activationMarkers.at(-1) === "NOMREH_OFFICIAL_AI_ACTIVATED";
  const failed = running && /NOMREH_(?:OFFICIAL|VNC)_[A-Z_]*ERROR/.test(markers);
  const ready = appReady && brokerReady && !failed;
  return {
    installed,
    running,
    appReady,
    brokerReady,
    activationReady,
    supervisorRunning,
    markers: markerList,
    phase: !installed ? "not-installed" : failed || state.lastError ? "error" : ready ? "ready" : running ? "starting" : "stopped",
    startedAt: state.startedAt,
    message: !installed
      ? "بستهٔ رسمی روی سرور نصب نشده است."
      : failed || state.lastError
        ? "اجرای محیط رسمی کامل نشد؛ اتصال AI از این مسیر استفاده نمی‌کند."
        : ready
          ? "برنامهٔ رسمی و مسیر جداگانهٔ AI در حال اجرا هستند."
          : running
            ? "برنامهٔ رسمی در حال راه‌اندازی است."
            : "محیط رسمی متوقف است.",
  };
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

export async function startOfficialRuntime(): Promise<OfficialRuntimeStatus> {
  fs.mkdirSync(stateRoot(), { recursive: true, mode: 0o700 });
  const wasStopRequested = regularFile(stopRequestedPath());
  try { fs.unlinkSync(stopRequestedPath()); } catch { /* No manual-stop marker. */ }
  const current = getOfficialRuntimeStatus();
  if (current.running) {
    launchOfficialRuntimeSupervisor();
    return getOfficialRuntimeStatus();
  }
  if (current.supervisorRunning && !wasStopRequested) {
    // The detached watchdog owns the next spawn. Do not race it with a second
    // QEMU instance when an admin opens the page during its backoff window.
    return getOfficialRuntimeStatus();
  }
  if (!current.installed) throw new Error("بستهٔ رسمی شکن هنوز روی سرور نصب نشده است.");
  verifyOfficialRuntime();
  const { vnc, proxy } = officialRuntimePorts();
  if (!(await portIsFree(vnc)) || !(await portIsFree(proxy))) throw new Error("پورت جداگانهٔ محیط شکن در اختیار فرایند دیگری است؛ آن را متوقف یا دوباره بررسی کنید.");
  fs.mkdirSync(stateRoot(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(consolePath(), "", { mode: 0o600 });
  const hostLog = fs.openSync(path.join(stateRoot(), "host.log"), "a", 0o600);
  let child;
  try {
    child = spawn(path.join(runtimeRoot(), "run-official.sh"), [], {
      cwd: runtimeRoot(),
      detached: true,
      stdio: ["ignore", hostLog, hostLog],
      env: {
        ...process.env,
        NOMREH_VM_MEMORY: process.env.NOMREH_VM_MEMORY || "2048M",
        NOMREH_VNC_PORT: String(vnc),
        NOMREH_VNC_UNIX_SOCKET: process.env.NOMREH_VNC_UNIX_SOCKET || path.join(stateRoot(), "vnc.sock"),
        NOMREH_CONTROL_UNIX_SOCKET: process.env.NOMREH_CONTROL_UNIX_SOCKET || controlSocketPath(),
        NOMREH_PROXY_PORT: String(proxy),
        NOMREH_VM_SERIAL: `file:${consolePath()}`,
        NOMREH_VM_PROBE: "0",
      },
    });
  } finally { fs.closeSync(hostLog); }
  const startedAt = new Date().toISOString();
  fs.writeFileSync(pidPath(), `${child.pid}\n`, { mode: 0o600 });
  writeState({ startedAt });
  child.once("error", () => writeState({ startedAt, lastError: "SPAWN_FAILED" }));
  child.once("exit", (code, signal) => {
    if (readPid() === child.pid && !regularFile(stopRequestedPath())) {
      writeState({ startedAt, lastError: `GUEST_EXIT_${signal || code || "UNKNOWN"}`.slice(0, 80) });
    }
  });
  child.unref();
  launchOfficialRuntimeSupervisor();
  await new Promise<void>((resolve) => setTimeout(resolve, 300));
  return getOfficialRuntimeStatus();
}

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export async function stopOfficialRuntime(): Promise<OfficialRuntimeStatus> {
  fs.mkdirSync(stateRoot(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(stopRequestedPath(), "manual stop\n", { mode: 0o600 });
  const supervisor = readSupervisorPid();
  if (isOurSupervisor(supervisor)) {
    try { process.kill(supervisor, "SIGTERM"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  const pid = readPid();
  if (isOurGuest(pid)) {
    try { process.kill(-pid, "SIGTERM"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && isOurGuest(pid)) await delay(150);
    if (isOurGuest(pid)) {
      try { process.kill(-pid, "SIGKILL"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  }
  try { fs.unlinkSync(pidPath()); } catch { /* Already absent. */ }
  writeState({ lastError: undefined });
  return getOfficialRuntimeStatus();
}

export async function restartOfficialRuntime(): Promise<OfficialRuntimeStatus> {
  await stopOfficialRuntime();
  return startOfficialRuntime();
}
