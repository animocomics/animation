"use strict";

// Staged, offline-only host probe installation. This module is NOT an active
// deployment controller; callers must independently verify the manifest and
// gate each invocation. It never configures networking or starts the VM.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const MIB = 1024 * 1024;
const SUB_LIMIT = 4 * 1024 * MIB;
const APP_LIMIT = 1000 * 1000 * 1000;
const RESERVE = 128 * MIB;
const CHUNK = 1024 * 1024;
const SHA = /^[a-f0-9]{64}$/;

function fail(reason) { throw new Error(reason); }
function validPath(value) {
  return typeof value === "string" && value.length > 0 && !value.startsWith("/") && !value.includes("\\") && !value.split("/").some((p) => !p || p === "." || p === "..");
}
function exists(file) { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }
function regular(file) {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) fail("UNSAFE_FILE");
  return st;
}
function directory(file) {
  const st = fs.lstatSync(file);
  if (!st.isDirectory() || st.isSymbolicLink()) fail("UNSAFE_DIRECTORY");
}
function hashFile(file) {
  regular(file);
  const h = crypto.createHash("sha256"), fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const buffer = Buffer.allocUnsafe(CHUNK);
  try {
    for (;;) { const size = fs.readSync(fd, buffer, 0, buffer.length, null); if (!size) break; h.update(buffer.subarray(0, size)); }
  } finally { fs.closeSync(fd); }
  return h.digest("hex");
}
function verifyFile(file, bytes, sha) {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || !SHA.test(sha) || regular(file).size !== bytes || hashFile(file) !== sha) fail("HASH_OR_SIZE_MISMATCH");
}
function verifyArchive(file, bytes, sha) { verifyFile(file, bytes, sha); }
function rootScope(root) {
  const absolute = path.resolve(root), parent = path.dirname(absolute);
  if (path.basename(absolute) !== "nomreh.arounidea.com" || path.basename(path.dirname(parent)) !== "vhosts") fail("BAD_ROOT_SCOPE");
  if (fs.realpathSync(absolute) !== absolute || fs.realpathSync(parent) !== parent) fail("SYMLINK_ROOT");
  directory(absolute); directory(parent);
  return { root: absolute, parent };
}
function usage(target) {
  const result = spawnSync("du", ["-sk", "--", target], { encoding: "utf8", timeout: 300000 });
  if (result.error || result.status !== 0 || !/^\d+\s/.test(result.stdout)) fail("USAGE_UNAVAILABLE");
  const kib = Number(result.stdout.match(/^\d+/)[0]);
  if (!Number.isSafeInteger(kib)) fail("USAGE_INVALID");
  return kib * 1024;
}
function budget(scope, extra, getUsage = usage) {
  if (!Number.isSafeInteger(extra) || extra < 0) fail("BAD_BUDGET");
  const app = getUsage(scope.root), sub = getUsage(scope.parent);
  if (!Number.isSafeInteger(app) || !Number.isSafeInteger(sub) || app < 0 || sub < app) fail("BAD_USAGE");
  if (app + extra + RESERVE > APP_LIMIT || sub + extra + RESERVE > SUB_LIMIT) fail("QUOTA_HEADROOM_INSUFFICIENT");
  return { app, sub, extra, reserve: RESERVE };
}
function checkManifest(m) {
  if (!m || m.format !== "nomreh-local-gui-probe-v1" || !m.base || !m.initramfs) fail("BAD_MANIFEST");
  const b = m.base, i = m.initramfs;
  if (b.archive !== "nomreh-deploy-gui-probe-base.zip" || !SHA.test(b.sha256) || !Number.isSafeInteger(b.bytes) || b.bytes <= 0 || b.bytes > 90*MIB || !Number.isSafeInteger(b.uncompressed_bytes) || b.uncompressed_bytes <= 0 || b.uncompressed_bytes > 150*MIB || !Array.isArray(b.files) || !b.files.length) fail("BAD_BASE");
  const names = new Set(); let sum = 0;
  for (const entry of b.files) {
    if (!entry || !validPath(entry.path) || names.has(entry.path) || entry.path === "guest/initramfs-gui" || /^guest\/initramfs-gui\.part-\d{3}$/.test(entry.path)) fail("BAD_BASE_ENTRY");
    names.add(entry.path);
    if (entry.type === "file") {
      if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !SHA.test(entry.sha256) || typeof entry.executable !== "boolean") fail("BAD_BASE_FILE");
      sum += entry.bytes;
    } else if (entry.type === "symlink") {
      if (typeof entry.target !== "string" || path.posix.isAbsolute(entry.target) || entry.target.includes("\0")) fail("BAD_LINK");
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(entry.path), entry.target));
      if (target === ".." || target.startsWith("../")) fail("BAD_LINK");
      sum += Buffer.byteLength(entry.target);
    } else fail("BAD_BASE_TYPE");
  }
  if (sum !== b.uncompressed_bytes) fail("BAD_BASE_SIZE");
  for (const entry of b.files) {
    let parent = path.posix.dirname(entry.path);
    while (parent !== ".") { if (names.has(parent)) fail("BASE_PARENT_COLLISION"); parent = path.posix.dirname(parent); }
  }
  if (!Array.isArray(i.parts) || i.parts.length < 1 || i.parts.length > 10 || !SHA.test(i.sha256) || !Number.isSafeInteger(i.bytes) || i.bytes <= 0 || i.bytes > 10*90*MIB) fail("BAD_INITRAMFS");
  let partTotal = 0;
  i.parts.forEach((part, n) => {
    const id = String(n).padStart(3, "0");
    if (!part || part.archive !== `nomreh-deploy-gui-probe-part-${id}.zip` || part.file !== `initramfs-gui.part-${id}` || !SHA.test(part.sha256) || !SHA.test(part.archive_sha256) || !Number.isSafeInteger(part.bytes) || part.bytes <= 0 || part.bytes > 90*MIB || !Number.isSafeInteger(part.archive_bytes) || part.archive_bytes <= 0 || part.archive_bytes > 90*MIB) fail("BAD_PART");
    partTotal += part.bytes;
  });
  if (partTotal !== i.bytes) fail("BAD_TOTAL");
}
function verifyBase(scope, manifest) {
  const vm = path.join(scope.root, "nomreh-vm"), gui = path.join(vm, "gui"); directory(vm); directory(gui);
  const files = manifest.base.files, expected = new Map(files.map((e) => [e.path, e]));
  const dirs = new Set();
  for (const entry of files) { let p = path.posix.dirname(entry.path); while (p !== ".") { dirs.add(p); p = path.posix.dirname(p); } }
  function walk(dir, prefix) {
    for (const name of fs.readdirSync(dir)) {
      const rel = prefix ? `${prefix}/${name}` : name, full = path.join(dir, name), st = fs.lstatSync(full), entry = expected.get(rel);
      if (st.isDirectory() && !st.isSymbolicLink()) { if (!dirs.has(rel)) fail("UNEXPECTED_DIRECTORY"); walk(full, rel); }
      else if (!entry) fail("UNEXPECTED_FILE");
      else if (entry.type === "symlink") { if (!st.isSymbolicLink() || fs.readlinkSync(full) !== entry.target) fail("LINK_MISMATCH"); }
      else { if (!st.isFile() || st.isSymbolicLink() || Boolean(st.mode & 0o111) !== entry.executable) fail("FILE_MODE_MISMATCH"); verifyFile(full, entry.bytes, entry.sha256); }
      expected.delete(rel);
    }
  }
  walk(gui, ""); if (expected.size) fail("MISSING_BASE_FILES");
}
function unpack(scope, archive) {
  const unzip = ["/usr/bin/unzip", "/bin/unzip"].find((file) => { try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; } });
  if (!unzip) fail("UNZIP_UNAVAILABLE");
  const result = spawnSync(unzip, ["-n", "-q", archive], { cwd: scope.root, timeout: 180000, stdio: "ignore" });
  if (result.error || result.status !== 0) fail("UNZIP_FAILED");
}
function installStage(manifest, phase, appRoot, getUsage = usage) {
  checkManifest(manifest); const scope = rootScope(appRoot), b = manifest.base, i = manifest.initramfs;
  const vm = path.join(scope.root, "nomreh-vm"), gui = path.join(vm, "gui"), guest = path.join(gui, "guest");
  if (phase === "preflight-base-upload") {
    if (exists(vm)) { directory(vm); if (exists(gui)) fail("GUI_ALREADY_EXISTS"); }
    if (exists(path.join(scope.root, b.archive))) fail("ARCHIVE_ALREADY_EXISTS");
    return budget(scope, b.bytes + 4*MIB, getUsage);
  }
  if (phase === "extract-base") {
    const archive = path.join(scope.root, b.archive);
    verifyArchive(archive, b.bytes, b.sha256);
    if (exists(vm)) { directory(vm); if (exists(gui)) fail("GUI_ALREADY_EXISTS"); }
    budget(scope, b.uncompressed_bytes + 8*MIB, getUsage);
    unpack(scope, archive); verifyBase(scope, manifest);
    verifyArchive(archive, b.bytes, b.sha256); fs.unlinkSync(archive);
    return { stage: phase, verified: true };
  }
  // The base is verified in its entirety on extraction; later stages inspect
  // the critical parents and their own exact files without overwriting anything.
  directory(vm); directory(gui); directory(guest);
  const matched = /^(preflight-part-upload|extract-part)-(\d{3})$/.exec(phase);
  if (matched) {
    const n = Number(matched[2]), p = i.parts[n]; if (!p) fail("BAD_PART_INDEX");
    const archive = path.join(scope.root, p.archive), target = path.join(guest, p.file);
    if (exists(target) || exists(path.join(guest, "initramfs-gui"))) fail("PART_TARGET_EXISTS");
    if (matched[1] === "preflight-part-upload") {
      if (exists(archive)) fail("ARCHIVE_ALREADY_EXISTS");
      return budget(scope, p.archive_bytes + 4*MIB, getUsage);
    }
    verifyArchive(archive, p.archive_bytes, p.archive_sha256);
    budget(scope, p.bytes + 8*MIB, getUsage); unpack(scope, archive);
    verifyFile(target, p.bytes, p.sha256); verifyArchive(archive, p.archive_bytes, p.archive_sha256); fs.unlinkSync(archive);
    return { stage: phase, verified: true };
  }
  if (phase === "assemble") {
    const target = path.join(guest, "initramfs-gui");
    if (exists(target)) fail("ASSEMBLY_TARGET_EXISTS");
    for (const p of i.parts) verifyFile(path.join(guest, p.file), p.bytes, p.sha256);
    budget(scope, i.bytes + 8*MIB, getUsage);
    const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600), buffer = Buffer.allocUnsafe(CHUNK);
    try {
      for (const p of i.parts) {
        const part = path.join(guest, p.file), input = fs.openSync(part, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try { for (;;) { const size = fs.readSync(input, buffer, 0, buffer.length, null); if (!size) break; let offset = 0; while (offset < size) offset += fs.writeSync(fd, buffer, offset, size - offset); } } finally { fs.closeSync(input); }
      }
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    verifyFile(target, i.bytes, i.sha256);
    for (const p of i.parts) { const part = path.join(guest, p.file); verifyFile(part, p.bytes, p.sha256); fs.unlinkSync(part); }
    return { stage: phase, verified: true };
  }
  fail("UNKNOWN_STAGE");
}
module.exports = { installStage, checkManifest, budget, rootScope, verifyBase };
