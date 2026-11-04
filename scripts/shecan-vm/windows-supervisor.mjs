import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const runtimeRoot = path.resolve(process.env.SHECAN_WINDOWS_RUNTIME_DIR || path.join(process.cwd(), 'nomreh-vm', 'windows'));
const stateRoot = path.resolve(process.env.SHECAN_WINDOWS_STATE_DIR || path.join(runtimeRoot, 'state'));
const displayNumber = Number(process.env.SHECAN_DISPLAY_NUMBER || 100);
const previewPort = Number(process.env.SHECAN_PREVIEW_PORT || 6099);
const cdpPort = Number(process.env.SHECAN_CDP_PORT || 9222);
const proxyPort = Number(process.env.SHECAN_PROXY_PORT || process.env.NOMREH_PROXY_PORT || 18888);
const controlPort = Number(process.env.SHECAN_BROKER_CONTROL_PORT || 18889);
const previewHost = process.env.SHECAN_PREVIEW_HOST || '127.0.0.1';
const scriptPath = path.resolve(process.cwd(), 'scripts', 'shecan-vm', 'live-preview.mjs');
const brokerScript = path.resolve(process.cwd(), 'scripts', 'shecan-vm', 'windows-ai-broker.mjs');
const wineRoot = path.resolve(process.env.SHECAN_WINE_ROOT || path.join(runtimeRoot, 'wine-src', 'wine'));
const bunBinary = path.join(runtimeRoot, 'windows-ai', 'bun.exe');
const wineBinary = path.join(wineRoot, 'bin', 'wine64');
const wineServer = path.join(wineRoot, 'bin', 'wineserver');
const prefix = path.resolve(process.env.SHECAN_WINE_PREFIX || path.join(runtimeRoot, 'prefix'));
const xvfbBinary = path.resolve(process.env.SHECAN_XVFB_BIN || path.join(runtimeRoot, 'x-server-aws', 'package', 'lib', 'aws-2', 'poppler-0.26-xvfb', 'bin', 'Xvfb'));
const xkbDirectory = path.resolve(process.env.SHECAN_XKB_DIR || path.join(path.dirname(xvfbBinary), '..', 'share', 'xkb'));
const xvfbLibraryDirectory = path.resolve(process.env.SHECAN_XVFB_LIB_DIR || path.join(path.dirname(xvfbBinary), '..', 'lib'));
const hostMesa = path.resolve(process.env.SHECAN_HOST_MESA_DIR || path.join(runtimeRoot, 'mesa-runtime', 'lib'));
const windowsApplication = process.env.SHECAN_WINDOWS_APPLICATION || 'C:\\Program Files\\shecan\\shecan-desktop\\shecan-desktop.exe';
const statusPath = path.join(stateRoot, 'status.json');
const supervisorPidPath = path.join(stateRoot, 'supervisor.pid');
const stopPath = path.join(stateRoot, 'stop-requested');
const appLogPath = path.join(stateRoot, 'windows-application.log');
const brokerLogPath = path.join(stateRoot, 'windows-ai-broker.log');
const brokerTokenPath = path.join(stateRoot, 'broker-control-token');
const supervisorLogPath = path.join(stateRoot, 'supervisor.log');
const startedAt = new Date().toISOString();
let xvfb = null;
let application = null;
let preview = null;
let broker = null;
let brokerRestartTimer = null;
let applicationStartedAt = 0;
let lastReadyAt = 0;
let restarts = 0;
let stopping = false;
let appLog;
let brokerLog;
let supervisorLog;

function writeStatus(patch) {
  let previous = {};
  try {
    const value = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    if (value && typeof value === 'object') previous = value;
  } catch { /* Replace a missing or damaged status atomically. */ }
  const status = {
    ...previous,
    ...patch,
    display: `:${displayNumber}`,
    previewPort,
    cdpPort,
    applicationPid: application?.pid || null,
    previewPid: preview?.pid || null,
    brokerPid: broker?.pid || null,
    xvfbPid: xvfb?.pid || null,
    restarts,
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const temporary = `${statusPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(status)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, statusPath);
}

function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  if (supervisorLog !== undefined) {
    try { fs.writeSync(supervisorLog, line); } catch { /* Status remains available. */ }
  }
  if (/^[A-Z0-9_ ]+$/.test(message)) console.log(message);
}

function environment() {
  return {
    ...process.env,
    WINEPREFIX: prefix,
    DISPLAY: `:${displayNumber}`,
    PATH: `${path.join(wineRoot, 'bin')}:${process.env.PATH || ''}`,
    LD_LIBRARY_PATH: hostMesa,
    LIBGL_DRIVERS_PATH: path.join(hostMesa, 'dri'),
    GALLIUM_DRIVER: 'llvmpipe',
    LIBGL_ALWAYS_SOFTWARE: '1',
    LP_NUM_THREADS: process.env.LP_NUM_THREADS || '4',
    WINEDLLOVERRIDES: 'opengl32=n,b;winemenubuilder.exe=',
    WINEDEBUG: '-all',
  };
}

function terminate(child, signal = 'SIGTERM') {
  if (!child?.pid) return;
  try { process.kill(-child.pid, signal); } catch (error) {
    if (error.code !== 'ESRCH') {
      try { process.kill(child.pid, signal); } catch { /* Already exiting. */ }
    }
  }
}

function stopWineProcesses() {
  const result = spawnSync(wineServer, ['-k'], { env: environment(), stdio: 'ignore', timeout: 5000 });
  if (result.error) log('WINESERVER_STOP_FAILED');
}

function spawnLogged(command, args, options = {}) {
  return spawn(command, args, {
    cwd: runtimeRoot,
    detached: true,
    stdio: ['ignore', appLog, appLog],
    ...options,
  });
}

function asWinePath(target) {
  const resolved = path.resolve(target);
  if (!resolved.startsWith('/')) throw new Error('Invalid Linux runtime path');
  return `Z:${resolved.replaceAll('/', '\\')}`;
}

function ensureBrokerToken() {
  try {
    if (/^[a-f0-9]{64}$/i.test(fs.readFileSync(brokerTokenPath, 'utf8').trim())) return;
  } catch { /* Create a fresh private token below. */ }
  const temporary = `${brokerTokenPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
  fs.renameSync(temporary, brokerTokenPath);
}

function scheduleBrokerRestart() {
  if (stopping || brokerRestartTimer || !application) return;
  brokerRestartTimer = setTimeout(() => {
    brokerRestartTimer = null;
    startBroker();
  }, 3000);
  brokerRestartTimer.unref();
}

function startBroker() {
  if (stopping || broker || !application || !fs.existsSync(bunBinary) || !fs.existsSync(brokerScript)) return;
  try {
    ensureBrokerToken();
    broker = spawn(wineBinary, [asWinePath(bunBinary), asWinePath(brokerScript)], {
      cwd: runtimeRoot,
      detached: true,
      stdio: ['ignore', brokerLog, brokerLog],
      env: {
        ...environment(),
        SHECAN_BROKER_RUN: '1',
        SHECAN_BROKER_STATE_DIR: asWinePath(stateRoot),
        SHECAN_BROKER_TOKEN_FILE: asWinePath(brokerTokenPath),
        SHECAN_BROKER_PORT: String(proxyPort),
        SHECAN_BROKER_CONTROL_PORT: String(controlPort),
      },
    });
    writeStatus({ brokerStartedAt: new Date().toISOString(), brokerError: undefined });
    log('SHECAN_WINDOWS_AI_BROKER_STARTED');
    broker.once('error', () => {
      broker = null;
      writeStatus({ brokerError: 'BROKER_SPAWN_FAILED' });
      scheduleBrokerRestart();
    });
    broker.once('exit', (code, signal) => {
      broker = null;
      if (stopping) return;
      writeStatus({ brokerError: `BROKER_EXIT_${signal || code}` });
      scheduleBrokerRestart();
    });
  } catch {
    broker = null;
    writeStatus({ brokerError: 'BROKER_SPAWN_FAILED' });
    scheduleBrokerRestart();
  }
}

function stopBroker() {
  if (brokerRestartTimer) {
    clearTimeout(brokerRestartTimer);
    brokerRestartTimer = null;
  }
  terminate(broker);
  broker = null;
}

function startXvfb() {
  if (stopping || xvfb) return;
  writeStatus({ phase: 'starting', startedAt, lastError: undefined });
  xvfb = spawnLogged(xvfbBinary, [
    `:${displayNumber}`, '-screen', '0', '1200x800x24', '-ac', '+iglx',
    '-nolisten', 'tcp', '-xkbdir', xkbDirectory,
  ], { env: { ...process.env, LD_LIBRARY_PATH: `${xvfbLibraryDirectory}:${hostMesa}` } });
  xvfb.once('error', () => writeStatus({ phase: 'error', lastError: 'XVFB_SPAWN_FAILED' }));
  xvfb.once('exit', (code, signal) => {
    xvfb = null;
    if (stopping) return;
    restarts += 1;
    writeStatus({ phase: 'degraded', lastError: `XVFB_EXIT_${signal || code}` });
    terminate(application);
    setTimeout(() => {
      if (stopping) return;
      startXvfb();
      setTimeout(startApplication, 1500);
    }, Math.min(15_000, 2000 + restarts * 500)).unref();
  });
}

function startApplication() {
  if (stopping || application || !xvfb) return;
  stopBroker();
  stopWineProcesses();
  applicationStartedAt = Date.now();
  application = spawnLogged(wineBinary, [windowsApplication], { env: environment() });
  writeStatus({ phase: 'starting', lastError: undefined, applicationStartedAt: new Date().toISOString() });
  log('SHECAN_WINDOWS_APP_STARTED');
  application.once('error', () => {
    writeStatus({ phase: 'error', lastError: 'APP_SPAWN_FAILED' });
  });
  application.once('exit', (code, signal) => {
    application = null;
    stopBroker();
    if (stopping) return;
    restarts += 1;
    writeStatus({ phase: 'degraded', lastError: `APP_EXIT_${signal || code}` });
    setTimeout(startApplication, Math.min(15_000, 2000 + restarts * 500)).unref();
  });
}

function startPreview() {
  if (stopping || preview) return;
  preview = spawnLogged(process.execPath, [scriptPath], {
    env: {
      ...process.env,
      SHECAN_PREVIEW_PORT: String(previewPort),
      SHECAN_PREVIEW_HOST: previewHost,
      SHECAN_CDP_HTTP: `http://127.0.0.1:${cdpPort}`,
    },
  });
  writeStatus({ phase: 'starting', startedAt });
  log('SHECAN_WINDOWS_PREVIEW_STARTED');
  preview.once('error', () => writeStatus({ phase: 'error', lastError: 'PREVIEW_SPAWN_FAILED' }));
  preview.once('exit', (code, signal) => {
    preview = null;
    if (stopping) return;
    restarts += 1;
    writeStatus({ phase: 'degraded', lastError: `PREVIEW_EXIT_${signal || code}` });
    setTimeout(startPreview, 2000).unref();
  });
}

async function ready() {
  try {
    const [targetsResponse, previewResponse] = await Promise.all([
      fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(2000) }),
      fetch(`http://127.0.0.1:${previewPort}/healthz`, { signal: AbortSignal.timeout(2000) }),
    ]);
    if (!targetsResponse.ok || !previewResponse.ok) return false;
    const [targets, health] = await Promise.all([targetsResponse.json(), previewResponse.json()]);
    return Boolean(health.ok && targets.some((item) => item.type === 'page' && item.url.startsWith('http://wails.localhost/')));
  } catch { return false; }
}

async function monitor() {
  if (stopping) return;
  const isReady = await ready();
  if (isReady) {
    lastReadyAt = Date.now();
    startBroker();
    writeStatus({ phase: 'ready', readyAt: new Date(lastReadyAt).toISOString(), lastError: undefined });
  } else {
    const stuck = application && Date.now() - applicationStartedAt > 120_000;
    writeStatus({ phase: application ? 'starting' : 'degraded' });
    if (stuck) {
      log('SHECAN_WINDOWS_READINESS_TIMEOUT');
      terminate(application);
    }
  }
}

function acquireLock() {
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = fs.openSync(supervisorPidPath, 'wx', 0o600);
      fs.writeSync(descriptor, `${process.pid}\n`);
      fs.closeSync(descriptor);
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let existing = 0;
      try { existing = Number(fs.readFileSync(supervisorPidPath, 'utf8').trim()); } catch { /* Stale lock. */ }
      if (existing > 1) {
        try {
          process.kill(existing, 0);
          const command = fs.readFileSync(`/proc/${existing}/cmdline`, 'utf8');
          if (command.includes('windows-supervisor.mjs')) return false;
        } catch { /* Replace a stale lock below. */ }
      }
      try { fs.unlinkSync(supervisorPidPath); } catch { /* Another supervisor is recovering. */ }
    }
  }
  return false;
}

function shutdown() {
  if (stopping) return;
  stopping = true;
  writeStatus({ phase: 'stopped', stoppedAt: new Date().toISOString() });
  stopBroker();
  terminate(preview);
  terminate(application);
  stopWineProcesses();
  terminate(xvfb);
  setTimeout(() => {
    try {
      if (Number(fs.readFileSync(supervisorPidPath, 'utf8').trim()) === process.pid) fs.unlinkSync(supervisorPidPath);
    } catch { /* Lock already removed. */ }
    if (appLog !== undefined) fs.closeSync(appLog);
    if (brokerLog !== undefined) fs.closeSync(brokerLog);
    if (supervisorLog !== undefined) fs.closeSync(supervisorLog);
    process.exit(0);
  }, 1200).unref();
}

if (process.argv[2] === '--stop') {
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(stopPath, 'manual stop\n', { mode: 0o600 });
  try {
    const pid = Number(fs.readFileSync(supervisorPidPath, 'utf8').trim());
    if (pid > 1) process.kill(pid, 'SIGTERM');
  } catch { /* Already stopped. */ }
} else {
  if (!acquireLock()) process.exit(0);
  try { fs.unlinkSync(stopPath); } catch { /* Automatic start clears a previous stop. */ }
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  appLog = fs.openSync(appLogPath, 'a', 0o600);
  brokerLog = fs.openSync(brokerLogPath, 'a', 0o600);
  supervisorLog = fs.openSync(supervisorLogPath, 'a', 0o600);
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  writeStatus({ phase: 'starting', startedAt, stoppedAt: undefined, lastError: undefined });
  startXvfb();
  startPreview();
  setTimeout(startApplication, 1500).unref();
  setInterval(monitor, 5000).ref();
}
