#!/usr/bin/env node
"use strict";

/**
 * Domain-local Node 22 bootstrap for Plesk accounts exposing only an older
 * Node.js runtime. Node 17 can run this file; all application installs,
 * builds, native-module checks and production requests use Node 22.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const https = require("node:https");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { spawn, spawnSync } = require("node:child_process");

const NODE_VERSION = "22.22.3";
const NODE_TAG = `v${NODE_VERSION}`;
const APP_ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.resolve(APP_ROOT, process.env.NOMREH_DATA_DIR || "../nomreh-data");
const RUNTIME_ROOT = path.join(DATA_DIR, "runtime");
const ACTIVE_DIR = path.join(RUNTIME_ROOT, "node");
const ACTIVE_NODE = path.join(ACTIVE_DIR, "bin", process.platform === "win32" ? "node.exe" : "node");
const MANIFEST_FILE = path.join(RUNTIME_ROOT, "runtime.json");
const PROGRESS_FILE = path.join(DATA_DIR, "build-progress.txt");
const LOCK_FILE = path.join(RUNTIME_ROOT, "install.lock");
const BOOTSTRAP_PACKAGE = path.join(__dirname, "plesk-runtime");
const LEGACY_NODE = {
  archive: `node-${NODE_TAG}-linux-x64-glibc-217.tar.xz`,
  directory: `node-${NODE_TAG}-linux-x64-glibc-217`,
  url: `https://unofficial-builds.nodejs.org/download/release/${NODE_TAG}/node-${NODE_TAG}-linux-x64-glibc-217.tar.xz`,
  sha256: "5de83ffe678e6c478b7be75708458c2a2f552c300c8a24fb4bdcd1574cb7e132",
};

function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}

let progressStartedAt = 0;
let progressEnabled = false;

function progress(stage, status = "RUNNING") {
  if (!progressEnabled) return;
  const elapsed = Math.max(0, Math.round((Date.now() - progressStartedAt) / 1000));
  console.log(`[Nomreh ${status}; ${elapsed}s] ${stage}`);
  try {
    ensureDirectory(DATA_DIR);
    fs.writeFileSync(PROGRESS_FILE, [
      `Nomreh build status: ${status}`,
      `Stage: ${stage}`,
      `Elapsed seconds: ${elapsed}`,
      `Process ID: ${process.pid}`,
      `Updated at: ${new Date().toISOString()}`,
      "",
    ].join("\n"), { mode: 0o600 });
  } catch (error) {
    console.error(`The progress report could not be written: ${error.message}`);
  }
}

function removeRuntimePath(candidate) {
  if (!inside(RUNTIME_ROOT, candidate) || candidate === RUNTIME_ROOT) {
    throw new Error("Refusing to remove a path outside Nomreh's runtime directory.");
  }
  fs.rmSync(candidate, { recursive: true, force: true });
}

function temporaryPath(prefix) {
  return path.join(RUNTIME_ROOT, `.${prefix}-${process.pid}-${Date.now()}`);
}

function execute(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || APP_ROOT,
    env: options.env || process.env,
    stdio: "inherit",
    timeout: options.timeout || 0,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} exited with status ${result.status ?? "unknown"}.`);
}

function hostNpmInvocation() {
  const npmCli = process.env.npm_execpath;
  if (npmCli && fs.existsSync(npmCli)) {
    return { command: process.execPath, args: [npmCli], npmCli };
  }
  return { command: process.platform === "win32" ? "npm.cmd" : "npm", args: [], npmCli: "" };
}

function runHostNpm(args, cwd) {
  const invocation = hostNpmInvocation();
  execute(invocation.command, [...invocation.args, ...args], {
    cwd,
    env: { ...process.env, NODE_OPTIONS: "", npm_config_engine_strict: "false" },
  });
}

function runtimeEnvironment(runtime) {
  const npmCli = hostNpmInvocation().npmCli;
  const entries = [path.dirname(runtime.nodeBinary), path.join(APP_ROOT, "node_modules", ".bin"), process.env.PATH || ""];
  return {
    ...process.env,
    PATH: entries.join(path.delimiter),
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    NOMREH_NPM_EXECPATH: npmCli,
    npm_config_engine_strict: "false",
    npm_config_ignore_scripts: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  };
}

function runRuntimeNpm(runtime, args) {
  const invocation = hostNpmInvocation();
  const command = invocation.npmCli ? runtime.nodeBinary : invocation.command;
  const prefix = invocation.npmCli ? [invocation.npmCli] : [];
  execute(command, [...prefix, ...args], { cwd: APP_ROOT, env: runtimeEnvironment(runtime) });
}

function probeNode(nodeBinary) {
  const result = spawnSync(nodeBinary, ["-p", "process.version"], {
    encoding: "utf8",
    timeout: 20000,
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  const details = `${result.stderr || ""}${result.error ? `\n${result.error.message}` : ""}`.trim();
  return {
    ok: result.status === 0 && result.stdout.trim() === NODE_TAG,
    version: result.stdout ? result.stdout.trim() : "",
    details,
  };
}

function readActiveRuntime(verify = true) {
  try {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8"));
    if (manifest.nodeVersion !== NODE_VERSION || !fs.existsSync(ACTIVE_NODE)) return null;
    if (verify && !probeNode(ACTIVE_NODE).ok) return null;
    return { nodeBinary: ACTIVE_NODE, kind: manifest.kind || "unknown" };
  } catch {
    return null;
  }
}

function writeManifest(kind) {
  const temporary = `${MANIFEST_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ nodeVersion: NODE_VERSION, kind, installedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, MANIFEST_FILE);
}

function activateBinary(sourceBinary, kind, licenseFile) {
  const staging = temporaryPath("activate");
  ensureDirectory(path.dirname(path.join(staging, "bin", "node")));
  const targetBinary = path.join(staging, "bin", path.basename(ACTIVE_NODE));
  try {
    try {
      fs.linkSync(sourceBinary, targetBinary);
    } catch {
      fs.copyFileSync(sourceBinary, targetBinary);
    }
    fs.chmodSync(targetBinary, 0o755);
    if (licenseFile && fs.existsSync(licenseFile)) fs.copyFileSync(licenseFile, path.join(staging, "LICENSE"));
    const probe = probeNode(targetBinary);
    if (!probe.ok) throw new Error(`Node ${NODE_VERSION} could not start.${probe.details ? `\n${probe.details}` : ""}`);
    if (fs.existsSync(ACTIVE_DIR)) removeRuntimePath(ACTIVE_DIR);
    fs.renameSync(staging, ACTIVE_DIR);
    writeManifest(kind);
    return { nodeBinary: ACTIVE_NODE, kind };
  } finally {
    if (fs.existsSync(staging)) removeRuntimePath(staging);
  }
}

function installOfficialRuntime() {
  const staging = temporaryPath("official");
  ensureDirectory(staging);
  try {
    for (const filename of ["package.json", "package-lock.json"]) {
      fs.copyFileSync(path.join(BOOTSTRAP_PACKAGE, filename), path.join(staging, filename));
    }
    console.log(`Installing Nomreh's private Node ${NODE_VERSION} runtime from the pinned npm package…`);
    progress("Downloading the standard Node 22 runtime package");
    runHostNpm(["ci", "--ignore-scripts=false", "--engine-strict=false", "--no-audit", "--no-fund"], staging);
    const sourceBinary = path.join(staging, "node_modules", "node", "bin", path.basename(ACTIVE_NODE));
    const probe = probeNode(sourceBinary);
    if (!probe.ok) throw new Error(`The standard Node binary is incompatible with this host.${probe.details ? `\n${probe.details}` : ""}`);
    const licenseFile = path.join(staging, "node_modules", "node", "node_modules", `node-${process.platform}-${process.arch}`, "LICENSE");
    return activateBinary(sourceBinary, "npm-official", licenseFile);
  } finally {
    if (fs.existsSync(staging)) removeRuntimePath(staging);
  }
}

async function downloadVerified(url, destination, expectedSha256, redirects = 0) {
  if (redirects > 5) throw new Error("Too many redirects while downloading the Node runtime.");
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("The Node runtime download must use HTTPS.");
  const response = await new Promise((resolve, reject) => {
    const request = https.get(parsed, { headers: { "User-Agent": "Nomreh-Plesk-Runtime/1.0" } }, resolve);
    request.setTimeout(120000, () => request.destroy(new Error("The Node runtime download timed out.")));
    request.on("error", reject);
  });
  if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
    response.resume();
    return downloadVerified(new URL(response.headers.location, parsed).toString(), destination, expectedSha256, redirects + 1);
  }
  if (response.statusCode !== 200) {
    response.resume();
    throw new Error(`Node runtime download returned HTTP ${response.statusCode}.`);
  }
  const hash = crypto.createHash("sha256");
  let size = 0;
  let nextProgress = 8 * 1024 * 1024;
  const meter = new Transform({
    transform(chunk, encoding, callback) {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) {
        callback(new Error("The Node runtime archive exceeded the allowed 64 MiB."));
        return;
      }
      hash.update(chunk);
      if (size >= nextProgress) {
        const received = Math.floor(size / (1024 * 1024));
        console.log(`Downloaded ${received} MiB of the compatible Node runtime…`);
        progress(`Downloading the compatible Node runtime (${received} MiB received)`);
        nextProgress += 8 * 1024 * 1024;
      }
      callback(null, chunk);
    },
  });
  try {
    await pipeline(response, meter, fs.createWriteStream(destination, { flags: "wx", mode: 0o600 }));
    if (hash.digest("hex") !== expectedSha256) throw new Error("The Node runtime archive failed SHA-256 verification.");
    console.log(`Verified the ${Math.ceil(size / (1024 * 1024))} MiB Node runtime download.`);
  } catch (error) {
    if (fs.existsSync(destination)) fs.unlinkSync(destination);
    throw error;
  }
}

async function downloadVerifiedWithRetry(url, destination, expectedSha256) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      if (attempt > 1) console.log(`Retrying the compatible Node runtime download (${attempt}/4)…`);
      progress(`Downloading the compatible Node runtime (attempt ${attempt}/4)`);
      await downloadVerified(url, destination, expectedSha256);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 4) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Download attempt ${attempt} did not complete: ${message}`);
        await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
      }
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`The compatible Node runtime download failed after 4 attempts. Last error: ${message}`);
}

async function installLegacyRuntime() {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("No compatible domain-local Node runtime is available for this platform.");
  }
  const archive = path.join(RUNTIME_ROOT, `.${LEGACY_NODE.archive}.${process.pid}.tmp`);
  const staging = temporaryPath("glibc-217");
  ensureDirectory(staging);
  try {
    console.log("Standard Node is not compatible; trying the Node.js community glibc-2.17 build with checksum verification…");
    progress("Preparing to download the compatible glibc-2.17 Node runtime");
    await downloadVerifiedWithRetry(LEGACY_NODE.url, archive, LEGACY_NODE.sha256);
    progress("Extracting and testing the compatible Node runtime");
    execute("tar", ["-xJf", archive, "-C", staging], { cwd: RUNTIME_ROOT, timeout: 120000 });
    const sourceRoot = path.join(staging, LEGACY_NODE.directory);
    return activateBinary(path.join(sourceRoot, "bin", "node"), "nodejs-unofficial-glibc-217", path.join(sourceRoot, "LICENSE"));
  } finally {
    if (fs.existsSync(archive)) fs.unlinkSync(archive);
    if (fs.existsSync(staging)) removeRuntimePath(staging);
  }
}

async function ensureRuntime() {
  const existing = readActiveRuntime();
  if (existing) return existing;
  ensureDirectory(RUNTIME_ROOT);
  let lock;
  try {
    lock = fs.openSync(LOCK_FILE, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") {
      try {
        if (Date.now() - fs.statSync(LOCK_FILE).mtimeMs > 15 * 60 * 1000) {
          fs.unlinkSync(LOCK_FILE);
          lock = fs.openSync(LOCK_FILE, "wx", 0o600);
        }
      } catch { /* Another installer may have completed. */ }
    }
    if (lock === undefined) throw new Error("Another Nomreh runtime installation is still running. Wait for it to finish, then run the build again.");
  }
  try {
    const concurrent = readActiveRuntime();
    if (concurrent) return concurrent;
    try {
      return installOfficialRuntime();
    } catch (error) {
      console.error(`Standard local runtime setup did not complete: ${error.message}`);
      return await installLegacyRuntime();
    }
  } finally {
    if (lock !== undefined) fs.closeSync(lock);
    try { fs.unlinkSync(LOCK_FILE); } catch { /* Already released. */ }
  }
}

function installDependencies(runtime) {
  console.log("Installing application dependencies with the domain-local Node 22…");
  runRuntimeNpm(runtime, ["install", "--ignore-scripts", "--engine-strict=false", "--no-audit", "--no-fund"]);
}

function compactProduction(runtime) {
  execute(runtime.nodeBinary, [path.join(APP_ROOT, "scripts", "compact-production.cjs")], {
    cwd: APP_ROOT,
    env: runtimeEnvironment(runtime),
  });
}

function smokeRuntime(runtime) {
  const source = `
    const Database = require("better-sqlite3");
    const database = new Database(":memory:");
    database.exec("CREATE TABLE smoke (value INTEGER)");
    database.prepare("INSERT INTO smoke VALUES (?)").run(22);
    if (database.prepare("SELECT value FROM smoke").get().value !== 22) throw new Error("SQLite smoke failed");
    database.close();
    const { createCanvas } = require("@napi-rs/canvas");
    const canvas = createCanvas(4, 4);
    const context = canvas.getContext("2d");
    context.fillStyle = "#162a68";
    context.fillRect(0, 0, 4, 4);
    if (canvas.toBuffer("image/png").length < 20) throw new Error("Canvas smoke failed");
    console.log("Node " + process.version + ", SQLite and canvas are ready.");
  `;
  execute(runtime.nodeBinary, ["-e", source], { cwd: APP_ROOT, env: runtimeEnvironment(runtime) });
}

async function build() {
  progressStartedAt = Date.now();
  progressEnabled = true;
  try {
    progress("Checking or installing the private Node 22 runtime");
    const runtime = await ensureRuntime();
    progress("Installing application dependencies");
    installDependencies(runtime);
    console.log("Building Nomreh with Node 22…");
    progress("Building the Nomreh production application with Next.js");
    runRuntimeNpm(runtime, ["run", "build"]);
    if (!fs.existsSync(path.join(APP_ROOT, ".next", "BUILD_ID"))) throw new Error("The production build did not create .next/BUILD_ID; nothing was compacted.");
    progress("Removing development-only packages and regenerable build caches");
    compactProduction(runtime);
    progress("Testing SQLite and canvas with the production runtime");
    smokeRuntime(runtime);
    console.log(`Nomreh production build is ready with the domain-local Node ${NODE_VERSION} (${runtime.kind}).`);
    progress("Nomreh production build is ready", "READY");
    try { fs.unlinkSync(PROGRESS_FILE); } catch { /* The successful build is already complete. */ }
  } catch (error) {
    progress(error instanceof Error ? error.message : String(error), "FAILED");
    throw error;
  } finally {
    progressEnabled = false;
  }
}

async function setup() {
  const runtime = await ensureRuntime();
  installDependencies(runtime);
  smokeRuntime(runtime);
  console.log(`Nomreh dependencies are ready with the domain-local Node ${NODE_VERSION} (${runtime.kind}).`);
}

function launchServer() {
  const runtime = readActiveRuntime();
  if (!runtime) {
    throw new Error("Nomreh's domain-local Node 22 runtime is not ready. Run the build:plesk script once before enabling Node.js.");
  }
  const child = spawn(runtime.nodeBinary, [path.join(APP_ROOT, "server.js")], {
    cwd: APP_ROOT,
    env: { ...process.env, NOMREH_NODE22_DELEGATED: "1" },
    stdio: "inherit",
  });
  let stopping = false;
  const forward = (signal) => {
    if (stopping) return;
    stopping = true;
    child.kill(signal);
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    timer.unref();
  };
  process.on("SIGTERM", () => forward("SIGTERM"));
  process.on("SIGINT", () => forward("SIGINT"));
  child.on("error", (error) => {
    console.error(`Nomreh's Node 22 process could not start: ${error.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) console.error(`Nomreh's Node 22 process stopped with ${signal}.`);
    process.exitCode = code === null ? 1 : code;
  });
}

async function main() {
  const command = process.argv[2] || "setup";
  if (command === "build") await build();
  else if (command === "setup") await setup();
  else if (command === "compact") {
    const runtime = await ensureRuntime();
    compactProduction(runtime);
    smokeRuntime(runtime);
  } else if (command === "status") {
    const runtime = readActiveRuntime();
    if (!runtime) throw new Error("The domain-local Node 22 runtime is not ready.");
    console.log(`Nomreh uses ${NODE_TAG} (${runtime.kind}) at ${runtime.nodeBinary}`);
  } else throw new Error(`Unknown Plesk runtime command: ${command}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

module.exports = { build, ensureRuntime, launchServer, probeNode, readActiveRuntime, smokeRuntime };
