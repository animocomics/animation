#!/usr/bin/env node
"use strict";

// One-shot, bounded-space installer for the private GitHub deployment tag.
// The tag carries verified ZIP chunks; the normal branch carries none. Each
// part is assembled, hash/CRC checked and extracted before its chunks are
// removed. Completed stages can be resumed without downloading anything again.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { once } = require("node:events");
const { spawnSync } = require("node:child_process");

const APP_ROOT = path.resolve(process.env.NOMREH_APP_ROOT || path.join(__dirname, "..", ".."));
const DEPLOY_ROOT = path.join(APP_ROOT, "deploy", "windows-runtime");
const VM_ROOT = path.join(APP_ROOT, "nomreh-vm");
const FINAL_ROOT = path.join(VM_ROOT, "windows");
const WORK_ROOT = path.join(VM_ROOT, ".windows-assembly");
const EXTRACT_ROOT = path.join(WORK_ROOT, "extracted");
const REQUIRED = [
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
];

function regularFile(target) {
  try { return fs.lstatSync(target).isFile() && !fs.lstatSync(target).isSymbolicLink(); } catch { return false; }
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function hashFile(target) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(target)) hash.update(chunk);
  return hash.digest("hex");
}

async function verifyRuntime(root) {
  const manifestPath = path.join(root, "runtime-manifest.json");
  if (!regularFile(manifestPath)) return false;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.format !== 2 || manifest.windowsInstallerSha256 !== "362f73e9603a49d7c323feab7f747b6c97feaad1dfc4d649df18cef0ccdc54e7") return false;
  for (const relative of REQUIRED) {
    const target = path.resolve(root, relative);
    if (!inside(root, target) || !regularFile(target)) return false;
    if (manifest.files?.[relative] !== await hashFile(target)) return false;
  }
  return true;
}

function unzip(args, options = {}) {
  const result = spawnSync("unzip", args, { encoding: "utf8", timeout: 900000, maxBuffer: 4 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`The verified Windows runtime could not be unpacked (${result.error?.code || result.status || "unknown"}).`);
  return result.stdout || "";
}

function validateArchivePaths(archive) {
  const names = unzip(["-Z1", archive]).split(/\r?\n/).filter(Boolean);
  if (!names.length || names.length > 10000) throw new Error("The Windows runtime archive has an invalid file count.");
  for (const name of names) {
    if (!name.startsWith("nomreh-vm/windows/") || name.includes("..") || name.startsWith("/") || name.includes("\\")) throw new Error("The Windows runtime archive contains an unsafe path.");
  }
}

async function assemblePart(part, archive) {
  const output = fs.createWriteStream(archive, { flags: "wx", mode: 0o600 });
  const whole = crypto.createHash("sha256");
  let total = 0;
  try {
    for (const chunk of part.chunks) {
      const source = path.resolve(DEPLOY_ROOT, chunk.path);
      if (!inside(DEPLOY_ROOT, source) || !regularFile(source)) throw new Error(`A required Windows runtime chunk is missing: ${part.name}.`);
      const hash = crypto.createHash("sha256");
      let bytes = 0;
      for await (const data of fs.createReadStream(source)) {
        hash.update(data); whole.update(data); bytes += data.length; total += data.length;
        if (!output.write(data)) await once(output, "drain");
      }
      if (bytes !== chunk.bytes || hash.digest("hex") !== chunk.sha256) throw new Error(`Windows runtime chunk verification failed: ${part.name}.`);
    }
    output.end();
    await once(output, "finish");
    if (total !== part.bytes || whole.digest("hex") !== part.sha256) throw new Error(`Windows runtime part verification failed: ${part.name}.`);
  } catch (error) {
    output.destroy();
    fs.rmSync(archive, { force: true });
    throw error;
  } finally {
    if (!output.closed) output.destroy();
  }
}

function markerPath(part) { return path.join(WORK_ROOT, `${part.name}.done`); }
function markerValid(part) {
  try { return fs.readFileSync(markerPath(part), "utf8").trim() === part.sha256 && fs.existsSync(EXTRACT_ROOT); } catch { return false; }
}

async function main() {
  const manifestPath = path.join(DEPLOY_ROOT, "manifest.json");
  if (!regularFile(manifestPath)) return;
  if (await verifyRuntime(FINAL_ROOT)) {
    fs.rmSync(DEPLOY_ROOT, { recursive: true, force: true });
    fs.rmSync(WORK_ROOT, { recursive: true, force: true });
    console.log("NOMREH_WINDOWS_ASSEMBLY_SKIPPED verified_runtime_already_installed");
    return;
  }
  if (fs.existsSync(FINAL_ROOT)) throw new Error("An existing unverified nomreh-vm/windows directory was preserved; automatic replacement was not attempted.");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.format !== 1 || !Array.isArray(manifest.parts) || manifest.parts.length !== 3 || !Number.isSafeInteger(manifest.extractedBytes)) throw new Error("The Windows deployment manifest is invalid.");
  const names = new Set();
  for (const part of manifest.parts) {
    if (!/^[a-z0-9-]+$/.test(part.name || "") || names.has(part.name) || !/^[a-f0-9]{64}$/.test(part.sha256 || "") || !Number.isSafeInteger(part.bytes) || !Array.isArray(part.chunks) || !part.chunks.length) throw new Error("The Windows deployment part metadata is invalid.");
    names.add(part.name);
    for (const chunk of part.chunks) {
      if (!/^parts\/[a-z0-9-]+\/[0-9]{3}$/.test(chunk.path || "") || !/^[a-f0-9]{64}$/.test(chunk.sha256 || "") || !Number.isSafeInteger(chunk.bytes)) throw new Error("The Windows deployment chunk metadata is invalid.");
    }
  }
  const available = fs.statfsSync(APP_ROOT).bavail * fs.statfsSync(APP_ROOT).bsize;
  // Chunks are removed after each verified part, so transient archives are
  // covered by the 512 MiB safety margin.
  const requiredFree = manifest.extractedBytes + 512 * 1024 * 1024;
  if (available < requiredFree) throw new Error(`Insufficient free space for bounded Windows assembly; ${requiredFree} bytes must be available before starting. Existing files were preserved.`);
  fs.mkdirSync(EXTRACT_ROOT, { recursive: true, mode: 0o700 });
  for (const part of manifest.parts) {
    if (markerValid(part)) {
      console.log(`NOMREH_WINDOWS_ASSEMBLY_RESUME part=${part.name}`);
      continue;
    }
    const archive = path.join(WORK_ROOT, `${part.name}.zip`);
    if (!regularFile(archive)) await assemblePart(part, archive);
    if (await hashFile(archive) !== part.sha256) throw new Error(`The staged Windows archive does not match its pinned hash: ${part.name}.`);
    validateArchivePaths(archive);
    unzip(["-tqq", archive]);
    for (const chunk of part.chunks) fs.rmSync(path.resolve(DEPLOY_ROOT, chunk.path), { force: true });
    console.log(`NOMREH_WINDOWS_ASSEMBLY_VERIFIED part=${part.name} bytes=${part.bytes}`);
    unzip(["-q", "-o", archive, "-d", EXTRACT_ROOT]);
    fs.rmSync(archive, { force: true });
    fs.writeFileSync(markerPath(part), `${part.sha256}\n`, { mode: 0o600 });
  }
  const staged = path.join(EXTRACT_ROOT, "nomreh-vm", "windows");
  if (!await verifyRuntime(staged)) throw new Error("The extracted Windows runtime did not pass its twelve-file hash manifest; it was not activated.");
  if (fs.existsSync(FINAL_ROOT)) throw new Error("The Windows runtime target appeared during assembly; the existing directory was preserved.");
  fs.renameSync(staged, FINAL_ROOT);
  fs.rmSync(WORK_ROOT, { recursive: true, force: true });
  fs.rmSync(DEPLOY_ROOT, { recursive: true, force: true });
  console.log(`NOMREH_WINDOWS_ASSEMBLY_OK extracted_bytes=${manifest.extractedBytes}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`NOMREH_WINDOWS_ASSEMBLY_ERROR ${String(error?.message || error).replace(/https?:\/\/\S+/g, "[url]").slice(0, 300)}`);
    process.exitCode = 1;
  });
}

module.exports = { APP_ROOT, DEPLOY_ROOT, FINAL_ROOT, WORK_ROOT, hashFile, verifyRuntime };
