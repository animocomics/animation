#!/usr/bin/env node
"use strict";

// Update an installed Nomreh app in place, downloading only what changed.
//
//   npm run delta                      # update to the latest build on the branch
//   npm run delta -- --dry-run         # show what would change, download nothing
//   npm run delta -- --from v12        # rebase the diff from an older build
//
// The app is served from a prebuilt .next bundle, so a delta must carry compiled
// output as well as sources. The manifest below maps the file groups a build
// produces; the script compares each file's hash with the local copy over the
// GitHub contents API, which returns one small JSON per file and never a tarball.
//
// Deliberate limits, because the hosting provider blocks egress above 200 requests
// to one host in 20 minutes:
//   - the remote tree is listed with ONE request per folder (tree API), not per file
//   - downloads are sequential, capped at MAX_FILES and MAX_BYTES per run
//   - a file already identical by size+sha is never downloaded
//   - `git` on the host is never used, so the installed tree cannot be rewritten
//
// Nothing here touches ../nomreh-data, .env, the database or the provider secret.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const OWNER = "animocomics";
const REPO = "animation";
const BRANCH = process.env.NOMREH_DELTA_BRANCH || "arena/dfdcef22-animation";
const TOKEN = process.env.NOMREH_GITHUB_TOKEN || process.env.GITHUB_TOKEN || "";

const MAX_FILES = 400;
const MAX_BYTES = 120 * 1024 * 1024;
const DRY = process.argv.includes("--dry-run");

const APP_ROOT = path.resolve(__dirname, "..");

// Directories whose contents are part of the running application.
const GROUPS = [".next/", "public/_next/", "app/", "components/", "lib/", "scripts/", "tests/"];

// Files that must never be touched by an in-place update.
const PROTECTED = [/^\.env/, /^\.provider-secret/, /^nomreh\.db/, /^node_modules\//, /\.bak$/, /^server\.js\./];

function log(message) {
  console.log(message);
}

function shouldInclude(file) {
  if (PROTECTED.some((pattern) => pattern.test(file))) return false;
  if (file.endsWith(".zip")) return false;
  if (file.startsWith("docs/")) return false;
  if (["package.json", "package-lock.json", "server.js", "next.config.mjs", "tsconfig.json"].includes(file)) return true;
  return GROUPS.some((prefix) => file.startsWith(prefix));
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function gitBlobSha(buffer) {
  // GitHub's tree API reports the git blob id, which is sha1 over "blob <len>\0"+data.
  return crypto.createHash("sha1").update(`blob ${buffer.length}\0`).update(buffer).digest("hex");
}

async function api(url) {
  const headers = { "User-Agent": "nomreh-delta", Accept: "application/vnd.github+json" };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${response.status} ${url.replace(/https:\/\/api\.github\.com/, "")} ${body.slice(0, 120)}`);
  }
  return response.json();
}

async function remoteTree() {
  const tree = await api(`https://api.github.com/repos/${OWNER}/${REPO}/git/trees/${encodeURIComponent(BRANCH)}?recursive=1`);
  if (tree.truncated) log("  ! the remote tree listing was truncated; only the first part is compared");
  return tree.tree.filter((entry) => entry.type === "blob" && shouldInclude(entry.path));
}

function localBlobSha(file) {
  const absolute = path.join(APP_ROOT, file);
  if (!fs.existsSync(absolute)) return null;
  try {
    return gitBlobSha(fs.readFileSync(absolute));
  } catch {
    return null;
  }
}

async function download(sha) {
  const payload = await api(`https://api.github.com/repos/${OWNER}/${REPO}/git/blobs/${sha}`);
  return Buffer.from(payload.content, payload.encoding === "base64" ? "base64" : "utf8");
}

async function main() {
  log(`Nomreh delta update — branch ${BRANCH}${DRY ? " (dry run)" : ""}`);
  log(`app root: ${APP_ROOT}`);
  if (!TOKEN) log("  note: no NOMREH_GITHUB_TOKEN set; unauthenticated GitHub allows 60 requests/hour.");

  log("listing remote tree (1 request)…");
  const remote = await remoteTree();
  log(`  ${remote.length} application files in the remote tree`);

  const changed = [];
  for (const entry of remote) {
    const local = localBlobSha(entry.path);
    if (local !== entry.sha) changed.push(entry);
  }

  log(`  ${changed.length} file(s) differ locally`);

  if (changed.length === 0) {
    log("NOMREH_DELTA_UP_TO_DATE nothing to download");
    return;
  }

  if (changed.length > MAX_FILES) {
    log(`  ! ${changed.length} files changed, above the ${MAX_FILES}-file cap for one run.`);
    log("    Install the full package instead: nomreh-deploy-*.zip");
    process.exitCode = 1;
    return;
  }

  if (DRY) {
    changed.slice(0, 60).forEach((entry) => log(`  would update ${entry.path} (${entry.size} bytes)`));
    if (changed.length > 60) log(`  … and ${changed.length - 60} more`);
    log(`NOMREH_DELTA_DRY_RUN ${changed.length} file(s), ${changed.reduce((sum, e) => sum + e.size, 0)} bytes`);
    return;
  }

  let bytes = 0;
  let written = 0;
  for (const entry of changed) {
    if (bytes + entry.size > MAX_BYTES) {
      log(`  ! stopping at the ${Math.round(MAX_BYTES / 1024 / 1024)}MB cap; run again to continue`);
      break;
    }
    const buffer = await download(entry.sha);
    const absolute = path.join(APP_ROOT, entry.path);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, buffer);
    bytes += buffer.length;
    written += 1;
    log(`  updated ${entry.path} (${buffer.length} bytes)`);
  }

  // The app runs a prebuilt bundle, so sources alone change nothing. Record which
  // files moved and whether a rebuild is required.
  const needsBuild = changed.some((entry) => !entry.path.startsWith(".next/") && !entry.path.startsWith("public/_next/"));
  fs.writeFileSync(
    path.join(APP_ROOT, ".nomreh-delta.json"),
    JSON.stringify({ at: new Date().toISOString(), branch: BRANCH, files: changed.map((entry) => entry.path), needsBuild }, null, 2),
  );

  log(`NOMREH_DELTA_OK files=${written} bytes=${bytes} requests≈${1 + written} needsBuild=${needsBuild ? "yes" : "no"}`);
  if (needsBuild) {
    log("Source files changed; the bundle must be rebuilt for them to take effect:");
    log("    npm run setup:plesk -- --silent-build      (or the panel build action)");
    log("then restart the application.");
  } else {
    log("Only compiled output changed; restart the application.");
  }
}

main().catch((error) => {
  log(`NOMREH_DELTA_FAILED ${String(error && error.message ? error.message : error).slice(0, 300)}`);
  process.exitCode = 1;
});
