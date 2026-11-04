"use strict";

// Patch only the small init/launcher of an already verified official runtime.
// Unchanged QEMU, glibc, kernel and official application files are hard-linked;
// the XZ/cpio transform is streamed, so no rootfs download or large temp copy is
// required and memory stays bounded on the shared Plesk host.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");

const REQUIRED_FILES = [
  "glibc/lib/x86_64-linux-gnu/ld-2.27.so",
  "qemu/bin/qemu-system-x86_64",
  "guest/vmlinuz-virt",
  "guest/initramfs-official",
  "run-official.sh",
];
const HEADLESS_VERSION = 1;
const EXCLUDED = new Set(["guest/initramfs-official", "run-official.sh", "runtime-manifest.json"]);
const MAX_CPIO_ENTRY = 1024 * 1024 * 1024;

function regularFile(target) {
  try {
    const info = fs.lstatSync(target);
    return info.isFile() && !info.isSymbolicLink();
  } catch { return false; }
}

function safeTarget(root, relative) {
  const target = path.resolve(root, relative);
  if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error("Unsafe official runtime path");
  return target;
}

async function sha256(target) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(target)) hash.update(chunk);
  return hash.digest("hex");
}

async function readVerifiedManifest(root) {
  const rootInfo = fs.lstatSync(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Official runtime root is unsafe");
  const manifestPath = safeTarget(root, "runtime-manifest.json");
  if (!regularFile(manifestPath)) throw new Error("Official runtime manifest is missing");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.format !== 1 || !/^[a-f0-9]{64}$/.test(manifest.officialRpmSha256 || "") || !manifest.files) throw new Error("Official runtime manifest is invalid");
  for (const relative of REQUIRED_FILES) {
    const target = safeTarget(root, relative);
    if (!/^[a-f0-9]{64}$/.test(manifest.files[relative] || "") || !regularFile(target)) throw new Error(`Official runtime file is unsafe: ${relative}`);
    if (await sha256(target) !== manifest.files[relative]) throw new Error(`Official runtime hash mismatch: ${relative}`);
  }
  return manifest;
}

function linkTree(source, destination, relative = "") {
  const info = fs.lstatSync(source);
  if (info.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(source), destination);
    return;
  }
  if (info.isDirectory()) {
    fs.mkdirSync(destination, { mode: info.mode & 0o777 });
    for (const entry of fs.readdirSync(source)) {
      const childRelative = relative ? `${relative}/${entry}` : entry;
      if (EXCLUDED.has(childRelative)) continue;
      linkTree(path.join(source, entry), path.join(destination, entry), childRelative);
    }
    return;
  }
  if (!info.isFile() || EXCLUDED.has(relative)) return;
  fs.linkSync(source, destination);
}

function padding(length) {
  return Buffer.alloc((4 - (length % 4)) % 4);
}

function cpioEntry(name, body) {
  const encoded = Buffer.from(`${name}\0`, "utf8");
  const fields = [0, 0o100755, 0, 0, 1, 0, body.length, 0, 0, 0, 0, encoded.length, 0];
  const header = Buffer.from(`070701${fields.map((field) => field.toString(16).padStart(8, "0")).join("")}`, "ascii");
  return Buffer.concat([header, encoded, padding(header.length + encoded.length), body, padding(body.length)]);
}

class BufferedReader {
  constructor(stream) {
    this.iterator = stream[Symbol.asyncIterator]();
    this.buffer = Buffer.alloc(0);
    this.done = false;
  }

  async read(length) {
    if (length === 0) return Buffer.alloc(0);
    while (this.buffer.length < length && !this.done) {
      const { value, done } = await this.iterator.next();
      if (done) this.done = true;
      else if (value?.length) this.buffer = Buffer.concat([this.buffer, value]);
    }
    if (this.buffer.length < length) throw new Error("Truncated official initramfs");
    const output = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return output;
  }
}

async function write(stream, data) {
  if (!data.length) return;
  if (!stream.write(data)) await once(stream, "drain");
}

function processError(chunks) {
  return Buffer.concat(chunks).toString("utf8").replace(/[^A-Za-z0-9_.: /-]/g, "").slice(0, 240);
}

async function patchInitramfs(source, initPath, destination) {
  const input = spawn("xz", ["-dc", source], { stdio: ["ignore", "pipe", "pipe"] });
  const output = spawn("xz", ["-1", "-c"], { stdio: ["pipe", "pipe", "pipe"] });
  const file = fs.createWriteStream(destination, { mode: 0o600 });
  const inputErrors = [];
  const outputErrors = [];
  input.stderr.on("data", (chunk) => { if (Buffer.concat(inputErrors).length < 4096) inputErrors.push(chunk); });
  output.stderr.on("data", (chunk) => { if (Buffer.concat(outputErrors).length < 4096) outputErrors.push(chunk); });
  output.stdout.pipe(file);
  const inputDone = once(input, "close");
  const outputDone = once(output, "close");
  const fileDone = once(file, "finish");
  const reader = new BufferedReader(input.stdout);
  const initBody = fs.readFileSync(initPath);
  let sawInit = false;
  let sawTrailer = false;
  let entries = 0;
  try {
    while (entries < 200000) {
      entries += 1;
      const header = await reader.read(110);
      if (header.subarray(0, 6).toString("ascii") !== "070701" || !/^[0-9a-fA-F]{104}$/.test(header.subarray(6).toString("ascii"))) throw new Error("Invalid official cpio header");
      const fields = [];
      for (let index = 0; index < 13; index += 1) fields.push(Number.parseInt(header.subarray(6 + index * 8, 14 + index * 8).toString("ascii"), 16));
      const fileSize = fields[6];
      const nameSize = fields[11];
      if (!Number.isSafeInteger(fileSize) || fileSize < 0 || fileSize > MAX_CPIO_ENTRY || !Number.isInteger(nameSize) || nameSize < 1 || nameSize > 4096) throw new Error("Invalid official cpio entry");
      const encodedName = await reader.read(nameSize);
      const namePadding = await reader.read(padding(header.length + nameSize).length);
      if (encodedName[nameSize - 1] !== 0) throw new Error("Invalid official cpio name");
      const name = encodedName.subarray(0, nameSize - 1).toString("utf8");
      if (name === "init") {
        let remaining = fileSize;
        while (remaining) {
          const chunk = await reader.read(Math.min(1024 * 1024, remaining));
          remaining -= chunk.length;
        }
        await reader.read(padding(fileSize).length);
        sawInit = true;
        continue;
      }
      if (name === "TRAILER!!!") {
        if (!sawInit) throw new Error("Official init was not found");
        await write(output.stdin, cpioEntry("init", initBody));
        sawTrailer = true;
      }
      await write(output.stdin, header);
      await write(output.stdin, encodedName);
      await write(output.stdin, namePadding);
      let remaining = fileSize;
      while (remaining) {
        const chunk = await reader.read(Math.min(1024 * 1024, remaining));
        remaining -= chunk.length;
        await write(output.stdin, chunk);
      }
      await write(output.stdin, await reader.read(padding(fileSize).length));
      if (sawTrailer) break;
    }
    if (!sawTrailer) throw new Error("Official cpio trailer was not found");
    input.stdout.resume();
    output.stdin.end();
    const [[inputCode], [outputCode]] = await Promise.all([inputDone, outputDone]);
    await fileDone;
    if (inputCode !== 0) throw new Error(`Official XZ read failed: ${processError(inputErrors) || inputCode}`);
    if (outputCode !== 0) throw new Error(`Official XZ write failed: ${processError(outputErrors) || outputCode}`);
    const bytes = fs.statSync(destination).size;
    if (bytes > 220 * 1024 * 1024) throw new Error("Patched official initramfs exceeds the 220 MiB budget");
    console.log(`NOMREH_HEADLESS_INITRAMFS entries=${entries} compressed_bytes=${bytes}`);
  } catch (error) {
    input.kill("SIGKILL");
    output.kill("SIGKILL");
    file.destroy();
    try { fs.unlinkSync(destination); } catch { /* No partial output is retained. */ }
    throw error;
  }
}

function runtimeRoot() {
  return path.resolve(process.env.NOMREH_SHECAN_RUNTIME_DIR || path.join(process.cwd(), "nomreh-vm", "official"));
}

async function prepareOfficialHeadlessRuntime() {
  const root = runtimeRoot();
  if (!fs.existsSync(root)) return { patched: false, installed: false, root, backup: "" };
  const manifest = await readVerifiedManifest(root);
  const initPath = path.join(__dirname, "official-guest-init.sh");
  const runnerPath = path.join(__dirname, "run-official.sh");
  const sourceInitSha256 = await sha256(initPath);
  const sourceRunnerSha256 = await sha256(runnerPath);
  if (manifest.nomrehHeadlessVersion === HEADLESS_VERSION && manifest.nomrehSourceInitSha256 === sourceInitSha256 && manifest.nomrehSourceRunnerSha256 === sourceRunnerSha256) {
    return { patched: false, installed: true, root, backup: "" };
  }
  const parent = path.dirname(root);
  const output = path.join(parent, `.official-headless-${process.pid}`);
  const backup = path.join(parent, `.official-backup-${process.pid}`);
  if (fs.existsSync(output) || fs.existsSync(backup)) throw new Error("Official runtime transaction path already exists");
  try {
    linkTree(root, output);
    fs.copyFileSync(runnerPath, safeTarget(output, "run-official.sh"));
    fs.chmodSync(safeTarget(output, "run-official.sh"), 0o755);
    await patchInitramfs(safeTarget(root, "guest/initramfs-official"), initPath, safeTarget(output, "guest/initramfs-official"));
    const nextManifest = {
      ...manifest,
      nomrehHeadlessVersion: HEADLESS_VERSION,
      nomrehSourceInitSha256: sourceInitSha256,
      nomrehSourceRunnerSha256: sourceRunnerSha256,
      files: { ...manifest.files },
    };
    nextManifest.files["guest/initramfs-official"] = await sha256(safeTarget(output, "guest/initramfs-official"));
    nextManifest.files["run-official.sh"] = await sha256(safeTarget(output, "run-official.sh"));
    fs.writeFileSync(safeTarget(output, "runtime-manifest.json"), `${JSON.stringify(nextManifest, null, 2)}\n`, { mode: 0o600 });
    await readVerifiedManifest(output);
  } catch (error) {
    fs.rmSync(output, { recursive: true, force: true });
    throw error;
  }
  fs.renameSync(root, backup);
  try {
    fs.renameSync(output, root);
  } catch (error) {
    fs.renameSync(backup, root);
    throw error;
  }
  console.log("NOMREH_HEADLESS_RUNTIME_PATCHED unchanged_files=hardlinked downloads=0");
  return { patched: true, installed: true, root, backup };
}

function assertTransaction(transaction) {
  if (!transaction?.patched || !transaction.backup) throw new Error("No official runtime transaction is active");
  const parent = path.dirname(transaction.root);
  if (path.dirname(transaction.backup) !== parent || !path.basename(transaction.backup).startsWith(".official-backup-")) throw new Error("Unsafe official runtime transaction");
}

function commitHeadlessRuntime(transaction) {
  if (!transaction?.patched) return;
  assertTransaction(transaction);
  fs.rmSync(transaction.backup, { recursive: true, force: false });
  console.log("NOMREH_HEADLESS_RUNTIME_COMMITTED temporary_backup=removed");
}

function rollbackHeadlessRuntime(transaction) {
  assertTransaction(transaction);
  const failed = path.join(path.dirname(transaction.root), `.official-failed-${process.pid}`);
  if (fs.existsSync(failed)) throw new Error("Official runtime rollback path already exists");
  fs.renameSync(transaction.root, failed);
  try {
    fs.renameSync(transaction.backup, transaction.root);
  } catch (error) {
    fs.renameSync(failed, transaction.root);
    throw error;
  }
  fs.rmSync(failed, { recursive: true, force: false });
  console.log("NOMREH_HEADLESS_RUNTIME_ROLLED_BACK");
}

module.exports = {
  HEADLESS_VERSION,
  commitHeadlessRuntime,
  patchInitramfs,
  prepareOfficialHeadlessRuntime,
  readVerifiedManifest,
  rollbackHeadlessRuntime,
};
