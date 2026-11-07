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
  // public/_next is REQUIRED (nginx serves it); only its staging/backup dirs are dropped.
  // Both copies are required and must NOT be de-duplicated:
  //   .next/static        -> Next's own server refuses to boot without it
  //   public/_next/static -> nginx serves the browser assets from here
  "/public/_next/.static-staging-",
  "/public/_next/.static-backup-",
  "nomreh-deploy-b4847c0.zip",
  // Never nest a previous deploy archive inside a new one.
  "nomreh-deploy-2026-11-05.zip",
  // Release archives kept at the repository root are artifacts, not source.
  // Nesting the previous one made v29 twice its real size (83 MB instead of 41 MB),
  // so the rule below matches every version rather than one hardcoded name.
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
    // Every real dotenv file is excluded, but the *example* is a documented
    // template with no secrets in it, and a fresh account has nothing to copy
    // without it. Blanket-skipping ".env*" shipped an archive with no template.
    if (entry.name.startsWith(".env") && entry.name !== ".env.example") continue;
    if (!relative && /^nomreh-(deploy|direct-v\d+).*\.zip$/i.test(entry.name)) continue;
    // A teacher's exam paper or a test scan is data, not source, and must not end
    // up inside a release archive that other people download.
    if (!relative && /\.pdf$/i.test(entry.name)) continue;
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

  // Plesk's document root is <app>/public and nginx serves the built client
  // assets from public/_next. A package without them makes the browser 404 every
  // script, so the page renders its loading shell and never hydrates. Always
  // mirror .next/static into public/_next before packaging.
  const { syncPublicStatic } = require("./plesk-node22.cjs");
  syncPublicStatic(APP_ROOT);

  const publicNext = path.join(APP_ROOT, "public", "_next");
  if (!fs.existsSync(publicNext) || !fs.readdirSync(publicNext).length) {
    throw new Error("public/_next is missing after the static sync; refusing to package a bundle that cannot hydrate.");
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

  // Cross-check that every asset the pages reference is present in public/.
  const referenced = new Set();
  const pageRoot = path.join(APP_ROOT, ".next", "server", "app");
  const collectRefs = (directory) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) { collectRefs(absolute); continue; }
      if (!entry.name.endsWith(".html") && !entry.name.endsWith(".rsc")) continue;
      const text = fs.readFileSync(absolute, "utf8");
      for (const match of text.matchAll(/\/_next\/static\/[A-Za-z0-9._/-]+\.(?:js|css)/g)) referenced.add(match[0]);
    }
  };
  collectRefs(pageRoot);
  const missing = [...referenced].filter((asset) => !fs.existsSync(path.join(APP_ROOT, "public", asset)));
  if (missing.length) {
    throw new Error(`Refusing to package: ${missing.length} client asset(s) referenced by the build are missing from public/, so the app would not hydrate. First: ${missing[0]}`);
  }
  console.log(`client assets verified=${referenced.size}`);

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
