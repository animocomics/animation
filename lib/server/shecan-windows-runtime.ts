import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { OfficialRuntimeStatus } from "./shecan-runtime";

export const SHECAN_WINDOWS_INSTALLER_SHA256 = "362f73e9603a49d7c323feab7f747b6c97feaad1dfc4d649df18cef0ccdc54e7";

export const REQUIRED_WINDOWS_RUNTIME_FILES = [
  "wine-src/wine/bin/wine64",
  "wine-src/wine/lib/wine/x86_64-windows/ws2_32.dll",
  "windows-ai/bun.exe",
  "x-server-aws/package/lib/aws-2/poppler-0.26-xvfb/bin/Xvfb",
  "xkb/bin/xkbcomp",
  "xkb/lib/libxkbfile.so.1",
  "prefix/drive_c/Program Files/shecan/shecan-desktop/shecan-desktop.exe",
  "prefix/drive_c/Program Files (x86)/Microsoft/EdgeWebView/Application-Shim/133.0.3065.92/msedgewebview2.exe",
  "prefix/drive_c/Program Files (x86)/Microsoft/EdgeWebView/Application-Shim/133.0.3065.92/EBWebView/x64/EmbeddedBrowserWebView.dll",
  "prefix/drive_c/Program Files (x86)/Microsoft/EdgeWebView/Application-Shim/133.0.3065.92/EBWebView/x64/EmbeddedBrowserWebView-real.dll",
  "prefix/drive_c/Program Files (x86)/Microsoft/EdgeWebView/Application-Shim/133.0.3065.92/opengl32.dll",
  "prefix/drive_c/Program Files (x86)/Microsoft/EdgeWebView/Application-Shim/133.0.3065.92/libgallium_wgl.dll",
] as const;

type WindowsStatusFile = {
  phase?: string;
  startedAt?: string;
  updatedAt?: string;
  applicationPid?: number;
  previewPid?: number;
  brokerPid?: number;
  xvfbPid?: number;
  brokerError?: string;
  supervisorPid?: number;
  lastError?: string;
};

export function windowsRuntimeRoot(): string {
  return path.resolve(process.env.NOMREH_SHECAN_WINDOWS_RUNTIME_DIR || path.join(process.cwd(), "nomreh-vm", "windows"));
}

export function windowsStateRoot(): string {
  return path.resolve(process.env.NOMREH_SHECAN_WINDOWS_STATE_DIR || path.join(windowsRuntimeRoot(), "state"));
}

function supervisorScriptPath(): string {
  return path.resolve(process.env.NOMREH_SHECAN_WINDOWS_SUPERVISOR_SCRIPT || path.join(process.cwd(), "scripts", "shecan-vm", "windows-supervisor.mjs"));
}

function statusPath(): string { return path.join(windowsStateRoot(), "status.json"); }
function brokerStatusPath(): string { return path.join(windowsStateRoot(), "broker-status.json"); }
export function windowsBrokerTokenPath(): string { return path.join(windowsStateRoot(), "broker-control-token"); }
function supervisorPidPath(): string { return path.join(windowsStateRoot(), "supervisor.pid"); }
function stopRequestedPath(): string { return path.join(windowsStateRoot(), "stop-requested"); }

function regularFile(target: string): boolean {
  try {
    const info = fs.lstatSync(target);
    return info.isFile() && !info.isSymbolicLink();
  } catch { return false; }
}

export function isWindowsRuntimeInstalled(root = windowsRuntimeRoot()): boolean {
  return regularFile(path.join(root, "runtime-manifest.json"));
}

export function verifyWindowsRuntime(root = windowsRuntimeRoot()): void {
  const rootInfo = fs.lstatSync(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Windows Shecan runtime root is unsafe");
  const manifestPath = path.join(root, "runtime-manifest.json");
  if (!regularFile(manifestPath)) throw new Error("Windows Shecan runtime manifest is missing");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { format?: number; windowsInstallerSha256?: string; files?: Record<string, string> };
  if (manifest.format !== 2 || manifest.windowsInstallerSha256 !== SHECAN_WINDOWS_INSTALLER_SHA256 || !manifest.files) {
    throw new Error("Windows Shecan runtime manifest is invalid");
  }
  for (const relative of REQUIRED_WINDOWS_RUNTIME_FILES) {
    const expected = manifest.files[relative];
    if (!/^[a-f0-9]{64}$/.test(expected || "")) throw new Error(`Windows Shecan runtime hash is missing: ${relative}`);
    const target = path.resolve(root, relative);
    if (!target.startsWith(`${path.resolve(root)}${path.sep}`) || !regularFile(target)) throw new Error(`Windows Shecan runtime file is unsafe: ${relative}`);
    const actual = createHash("sha256").update(fs.readFileSync(target)).digest("hex");
    if (actual !== expected) throw new Error(`Windows Shecan runtime hash mismatch: ${relative}`);
  }
}

function readPid(target: string): number | null {
  try {
    const pid = Number(fs.readFileSync(target, "utf8").trim());
    return Number.isInteger(pid) && pid > 1 ? pid : null;
  } catch { return null; }
}

function processHasToken(pid: number | null | undefined, token: string): pid is number {
  if (!pid || !Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(token);
  } catch { return false; }
}

function readStatus(): WindowsStatusFile {
  try {
    const value = JSON.parse(fs.readFileSync(statusPath(), "utf8")) as WindowsStatusFile;
    return value && typeof value === "object" ? value : {};
  } catch { return {}; }
}

type WindowsBrokerStatus = {
  brokerReady?: boolean;
  activationReady?: boolean;
  activatedAt?: string;
  updatedAt?: string;
  lastError?: string;
};

function readBrokerStatus(): WindowsBrokerStatus {
  try {
    const value = JSON.parse(fs.readFileSync(brokerStatusPath(), "utf8")) as WindowsBrokerStatus;
    return value && typeof value === "object" ? value : {};
  } catch { return {}; }
}

function freshTimestamp(value: string | undefined): boolean {
  const timestamp = value ? Date.parse(value) : 0;
  return Number.isFinite(timestamp) && timestamp > 0 && Date.now() - timestamp >= 0 && Date.now() - timestamp < 15_000;
}

function safeError(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replace(/[^A-Z0-9_]/gi, "").toUpperCase().slice(0, 80) || undefined;
}

export function getWindowsRuntimeStatus(): OfficialRuntimeStatus {
  const installed = isWindowsRuntimeInstalled();
  const status = readStatus();
  const broker = readBrokerStatus();
  const running = processHasToken(status.applicationPid, "shecan-desktop.exe");
  const previewRunning = processHasToken(status.previewPid, "live-preview.mjs");
  const brokerRunning = processHasToken(status.brokerPid, "bun.exe");
  const supervisorRunning = processHasToken(readPid(supervisorPidPath()), "windows-supervisor.mjs");
  const appReady = Boolean(installed && running && previewRunning && status.phase === "ready" && freshTimestamp(status.updatedAt));
  const brokerReady = Boolean(appReady && brokerRunning && broker.brokerReady === true && freshTimestamp(broker.updatedAt));
  const activationReady = Boolean(brokerReady && broker.activationReady === true && Date.parse(broker.activatedAt || "") > 0);
  const errorCode = safeError(status.lastError);
  const markers = [
    running ? "NOMREH_WINDOWS_APP_PROCESS_ALIVE" : "",
    appReady ? "NOMREH_WINDOWS_APP_READY" : "",
    supervisorRunning ? "NOMREH_WINDOWS_SUPERVISOR_RUNNING" : "",
    brokerReady ? "NOMREH_WINDOWS_AI_BROKER_LISTENING" : "",
    activationReady ? "NOMREH_WINDOWS_AI_ACTIVATED" : "",
  ].filter(Boolean);
  return {
    installed,
    running,
    appReady,
    brokerReady,
    activationReady,
    supervisorRunning,
    markers,
    applicationKind: "windows",
    displayTransport: "cdp-screencast",
    // Display readiness is deliberately independent of activation so a healthy
    // app never falls back to a startup prompt merely because AI is not ready.
    phase: !installed ? "not-installed" : errorCode ? "error" : appReady ? "ready" : running ? "starting" : "stopped",
    startedAt: status.startedAt,
    errorCode,
    message: !installed
      ? "بستهٔ ویندوز شکن روی سرور نصب نشده است."
      : errorCode
        ? "اجرای برنامهٔ ویندوز کامل نشد؛ مسیر AI از این محیط استفاده نمی‌کند."
        : !appReady
          ? running ? "برنامهٔ ویندوز شکن در حال راه‌اندازی است." : "محیط ویندوز شکن متوقف است."
          : !brokerReady
            ? "برنامهٔ رسمی ویندوز و نمایش آن آماده‌اند؛ broker اختصاصی AI هنوز آماده نیست."
            : !activationReady
              ? "برنامه و broker ویندوز آماده‌اند؛ فعال‌سازی AI هنوز انجام نشده است."
              : "برنامهٔ رسمی ویندوز و مسیر اختصاصی AI در حال اجرا هستند.",
  };
}

let lastLaunchAttempt = 0;

function launchWindowsSupervisor(): void {
  const script = supervisorScriptPath();
  if (!regularFile(script) || regularFile(stopRequestedPath())) return;
  if (processHasToken(readPid(supervisorPidPath()), "windows-supervisor.mjs")) return;
  const now = Date.now();
  if (now - lastLaunchAttempt < 2000) return;
  lastLaunchAttempt = now;
  try {
    const child = spawn(process.execPath, [script], {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        SHECAN_WINDOWS_RUNTIME_DIR: windowsRuntimeRoot(),
        SHECAN_WINDOWS_STATE_DIR: windowsStateRoot(),
        SHECAN_PREVIEW_HOST: process.env.NOMREH_SHECAN_WINDOWS_PREVIEW_HOST || "127.0.0.1",
        SHECAN_PREVIEW_PORT: process.env.NOMREH_SHECAN_WINDOWS_PREVIEW_PORT || "6099",
        SHECAN_CDP_PORT: process.env.NOMREH_SHECAN_WINDOWS_CDP_PORT || "9222",
        SHECAN_PROXY_PORT: process.env.NOMREH_PROXY_PORT || "18888",
        SHECAN_BROKER_CONTROL_PORT: String(windowsBrokerControlPort()),
      },
    });
    child.on("error", () => undefined);
    child.unref();
  } catch { /* The fail-closed status remains available to the admin. */ }
}

export function ensureWindowsRuntimeSupervisor(): void {
  if (isWindowsRuntimeInstalled() && !regularFile(stopRequestedPath())) launchWindowsSupervisor();
}

export function windowsBrokerControlPort(): number {
  const port = Number(process.env.NOMREH_SHECAN_WINDOWS_CONTROL_PORT || 18889);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid Windows Shecan broker control port");
  return port;
}

export async function startWindowsRuntime(_options: { supervise?: boolean } = {}): Promise<OfficialRuntimeStatus> {
  if (!isWindowsRuntimeInstalled()) throw new Error("بستهٔ ویندوز شکن هنوز روی سرور نصب نشده است.");
  verifyWindowsRuntime();
  fs.mkdirSync(windowsStateRoot(), { recursive: true, mode: 0o700 });
  try { fs.unlinkSync(stopRequestedPath()); } catch { /* No previous manual stop. */ }
  const current = getWindowsRuntimeStatus();
  if (current.running || current.supervisorRunning) {
    launchWindowsSupervisor();
    return getWindowsRuntimeStatus();
  }
  launchWindowsSupervisor();
  await new Promise<void>((resolve) => setTimeout(resolve, 350));
  return getWindowsRuntimeStatus();
}

export async function stopWindowsRuntime(): Promise<OfficialRuntimeStatus> {
  fs.mkdirSync(windowsStateRoot(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(stopRequestedPath(), "manual stop\n", { mode: 0o600 });
  const script = supervisorScriptPath();
  if (regularFile(script)) {
    spawnSync(process.execPath, [script, "--stop"], {
      cwd: process.cwd(),
      stdio: "ignore",
      timeout: 5000,
      env: {
        ...process.env,
        SHECAN_WINDOWS_RUNTIME_DIR: windowsRuntimeRoot(),
        SHECAN_WINDOWS_STATE_DIR: windowsStateRoot(),
      },
    });
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const current = getWindowsRuntimeStatus();
    if (!current.running && !current.supervisorRunning) return current;
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
  }
  const status = readStatus();
  for (const [pid, token] of [[status.previewPid, "live-preview.mjs"], [status.applicationPid, "shecan-desktop.exe"], [status.brokerPid, "bun.exe"], [status.xvfbPid, "Xvfb"]] as const) {
    if (!processHasToken(pid, token)) continue;
    try { process.kill(-pid, "SIGKILL"); } catch {
      try { process.kill(pid, "SIGKILL"); } catch { /* Already exited. */ }
    }
  }
  return getWindowsRuntimeStatus();
}
