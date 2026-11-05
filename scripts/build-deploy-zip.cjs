#!/usr/bin/env node
"use strict";

// Build a single deployment ZIP for the Nomreh Plesk application root.
//
// Why a ZIP instead of a git pull on the host:
//   The production host cannot reach github.com:443 (connect timeouts, and
//   Plesk's own deployment task fails with an authentication/connection error).
//   A ready archive lets the operator upload once through the Plesk file
//   manager and extract it over the existing application root.
//
// What it contains:
//   * application source, so the host can rebuild with `npm run build:plesk`
//   * the already-built `.next` output (12 MB, cache excluded) so a restart is
//     enough even when the host cannot run a build
//   * `vendor/*.tgz` and the lockfile, so a later `npm ci` works offline-ish
//   * the genuine `shecan (2).exe` installer (the Windows runtime itself is a
//     separate, already-uploaded download and is never shipped here)
//
// What it never contains:
//   * node_modules (the existing install is enough: this release adds no new
//     dependencies)
//   * .git, nomreh-vm (3.3 GB), .next/cache, data/, any .env file
//   * the obsolete 40 MB `nomreh-deploy-*.zip` artifact committed earlier
//
// The script refuses to write an archive that contains a dotenv file, a private
// key, or anything matching a secret-looking token, and prints only its size,
// entry count and SHA-256.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const APP_ROOT = path.resolve(__dirname, "..");
const OUTPUT = path.resolve(
  process.env.NOMREH_DEPLOY_ZIP || path.join(APP_ROOT, "..", `nomreh-deploy-${new Date().toISOString().slice(0, 10)}.zip`),
);
const STAGE = path.join(APP_ROOT, "..", ".nomreh-deploy-stage");

// Top-level entries never shipped.
const EXCLUDE_TOP = new Set([
  ".git",
  "node_modules",
  "nomreh-vm",
  "data",
  ".nomreh-deploy-stage",
  ".env",
  ".env.local",
  ".env.production",
]);

// Path fragments never shipped, checked on the relative path.
const EXCLUDE_FRAGMENTS = [
  "/.next/cache/",
  "/.next/trace",
  "/.git/",
  "/data/",
  "nomreh-deploy-b4847c0.zip",
];

// A file is refused if it looks like it carries credentials.
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bsk-llm-[A-Za-z0-9_-]{20,}/,
  // A real Google key is random; fixtures use placeholders spelling "invalid",
  // which are exempted instead of weakening the check.
  /\bAIza(?![0-9A-Za-z_-]*[Ii]nvalid)[0-9A-Za-z_-]{30,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
];

function walk(directory, relative, collected) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "." || entry.name === "..") continue;
    const absolute = path.join(directory, entry.name);
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (!relative && EXCLUDE_TOP.has(entry.name)) continue;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      walk(absolute, rel, collected);
      continue;
    }
    if (!entry.isFile()) continue;
    if (EXCLUDE_FRAGMENTS.some((fragment) => `/${rel}`.includes(fragment))) continue;
    if (entry.name.startsWith(".env")) continue;
    // Local build artifacts must never ship.
    if (entry.name.endsWith(".tsbuildinfo")) continue;
    collected.push(rel);
  }
  return collected;
}

function looksSecret(absolute, relative) {
  // Only text-ish files are scanned, and only the first 256 KB of each.
  if (/\.(tgz|zip|exe|so|dll|bin|png|jpg|jpeg|woff2?|ico|pack)$/i.test(relative)) return false;
  let handle;
  try {
    const stat = fs.statSync(absolute);
    if (stat.size > 8 * 1024 * 1024) return false;
    handle = fs.openSync(absolute, "r");
    const length = Math.min(stat.size, 256 * 1024);
    const buffer = Buffer.alloc(length);
    fs.readSync(handle, buffer, 0, length, 0);
    const text = buffer.toString("utf8");
    return SECRET_PATTERNS.some((pattern) => pattern.test(text));
  } catch {
    return false;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

function main() {
  if (!fs.existsSync(path.join(APP_ROOT, ".next", "BUILD_ID"))) {
    throw new Error(".next/BUILD_ID is missing; run `npm run build` before packaging so the archive is runnable.");
  }

  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });

  const files = walk(APP_ROOT, "", []);
  if (!files.length) throw new Error("Nothing to package.");

  const refused = [];
  for (const relative of files) {
    if (looksSecret(path.join(APP_ROOT, relative), relative)) {
      refused.push(relative);
      continue;
    }
    const destination = path.join(STAGE, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(APP_ROOT, relative), destination);
  }
  if (refused.length) {
    throw new Error(`Refusing to package: these files look like they contain secrets: ${refused.join(", ")}`);
  }

  fs.rmSync(OUTPUT, { force: true });
  execFileSync("zip", ["-q", "-r", "-9", OUTPUT, "."], { cwd: STAGE, stdio: "inherit" });
  fs.rmSync(STAGE, { recursive: true, force: true });

  const bytes = fs.statSync(OUTPUT).size;
  const digest = crypto.createHash("sha256").update(fs.readFileSync(OUTPUT)).digest("hex");

  console.log(`NOMREH_DEPLOY_ZIP_OK file=${path.basename(OUTPUT)}`);
  console.log(`entries=${files.length}`);
  console.log(`bytes=${bytes}`);
  console.log(`sha256=${digest}`);
}

try {
  main();
} catch (error) {
  console.error(`NOMREH_DEPLOY_ZIP_ERROR ${String(error && error.message ? error.message : error).slice(0, 400)}`);
  process.exitCode = 1;
}
