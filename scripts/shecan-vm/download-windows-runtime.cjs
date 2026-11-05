#!/usr/bin/env node
"use strict";

// Server-side, authenticated download for users who cannot transfer the large
// runtime archive through their browser. Only the small deployment-chunk tree
// is extracted from the private tag; the source branch and Plesk Git mirror
// remain free of binary runtime payloads.
const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const { once } = require("node:events");
const { spawnSync } = require("node:child_process");

const APP_ROOT = path.resolve(process.env.NOMREH_APP_ROOT || path.join(__dirname, "..", ".."));
const DEPLOY_ROOT = path.join(APP_ROOT, "deploy", "windows-runtime");
const FINAL_MANIFEST = path.join(APP_ROOT, "nomreh-vm", "windows", "runtime-manifest.json");
const WORK_ROOT = path.join(APP_ROOT, "nomreh-vm", ".windows-download");
const ARCHIVE = path.join(WORK_ROOT, "runtime.zip");
const COMPLETE = `${ARCHIVE}.complete`;
const EXTRACT_ROOT = path.join(WORK_ROOT, "payload");
const TAG = process.env.NOMREH_WINDOWS_GITHUB_TAG || "nomreh-windows-complete";
// The repository moved from rayavc099 to animocomics. Default to the current
// owner so a host clone keeps working after the transfer, and allow an explicit
// override for forks or mirrors. Codeload paths are case-sensitive and cannot
// follow a repository redirect.
const REPOSITORY = (process.env.NOMREH_WINDOWS_GITHUB_REPOSITORY || "animocomics/animation").replace(/^\/+|\/+$/g, "");
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(REPOSITORY)) throw new Error("NOMREH_WINDOWS_GITHUB_REPOSITORY must look like owner/name.");
const TOKEN = (process.env.NOMREH_WINDOWS_GITHUB_TOKEN || "").trim();
const MAX_ARCHIVE = 2_000_000_000;
const REQUIRED_FREE = 1_337_349_552 + 3_343_228_444 + 512 * 1024 * 1024;

function regularFile(target) {
  try { return fs.lstatSync(target).isFile() && !fs.lstatSync(target).isSymbolicLink(); } catch { return false; }
}
function unzip(args) {
  const result = spawnSync("unzip", args, { encoding: "utf8", timeout: 900000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`The downloaded Windows deployment archive could not be inspected (${result.error?.code || result.status || "unknown"}).`);
  return result.stdout || "";
}
function get(url, headers, redirects = 0) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return reject(new Error("The Windows deployment requires HTTPS."));
    const request = https.get(parsed, { headers, timeout: 120000 }, (response) => {
      const status = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location && redirects < 4) {
        response.resume();
        const next = new URL(response.headers.location, parsed);
        const nextHeaders = { ...headers };
        if (next.hostname !== parsed.hostname) delete nextHeaders.Authorization;
        return resolve(get(next, nextHeaders, redirects + 1));
      }
      resolve(response);
    });
    request.on("timeout", () => request.destroy(new Error("The GitHub download stalled.")));
    request.on("error", reject);
  });
}

async function download() {
  if (regularFile(COMPLETE) && regularFile(ARCHIVE) && Number(fs.readFileSync(COMPLETE, "utf8")) === fs.statSync(ARCHIVE).size) return fs.statSync(ARCHIVE).size;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const existing = regularFile(ARCHIVE) ? fs.statSync(ARCHIVE).size : 0;
    const headers = { Authorization: `Bearer ${TOKEN}`, Accept: "application/zip", "User-Agent": "nomreh-windows-server-installer" };
    if (existing) headers.Range = `bytes=${existing}-`;
    let response;
    try {
      response = await get(`https://codeload.github.com/${REPOSITORY}/zip/refs/tags/${TAG}`, headers);
      const status = response.statusCode || 0;
      if (![200, 206].includes(status)) {
        response.resume();
        if ([401, 403, 404].includes(status)) throw new Error("GitHub rejected the private Windows deployment download; check the token's repository Contents permission.");
        throw new Error(`GitHub returned HTTP ${status} for the Windows deployment download.`);
      }
      if (existing && status === 206 && !(response.headers["content-range"] || "").startsWith(`bytes ${existing}-`)) throw new Error("GitHub returned an invalid resume range.");
      const append = existing > 0 && status === 206;
      let bytes = append ? existing : 0;
      let nextReport = Math.floor(bytes / (256 * 1024 * 1024) + 1) * 256 * 1024 * 1024;
      const output = fs.createWriteStream(ARCHIVE, { flags: append ? "a" : "w", mode: 0o600 });
      try {
        for await (const chunk of response) {
          bytes += chunk.length;
          if (bytes > MAX_ARCHIVE) throw new Error("The Windows deployment archive exceeded its two-gigabyte safety limit.");
          if (!output.write(chunk)) await once(output, "drain");
          if (bytes >= nextReport) {
            console.log(`NOMREH_WINDOWS_DOWNLOAD_PROGRESS bytes=${bytes}`);
            nextReport += 256 * 1024 * 1024;
          }
        }
        output.end();
        await once(output, "finish");
      } finally {
        if (!output.closed) output.destroy();
      }
      const expected = Number(response.headers["content-length"] || 0) + (append ? existing : 0);
      if (expected && bytes !== expected) throw new Error("The Windows deployment download ended before its declared length.");
      fs.writeFileSync(COMPLETE, String(bytes), { mode: 0o600 });
      console.log(`NOMREH_WINDOWS_DOWNLOAD_RECEIVED bytes=${bytes}`);
      return bytes;
    } catch (error) {
      if (response) response.destroy();
      if (attempt === 3) throw error;
      console.log(`NOMREH_WINDOWS_DOWNLOAD_RETRY attempt=${attempt + 1}`);
    }
  }
  throw new Error("The Windows deployment download did not complete.");
}

async function main() {
  if (!TOKEN || regularFile(FINAL_MANIFEST) || regularFile(path.join(DEPLOY_ROOT, "manifest.json"))) return;
  if (!/^nomreh-[a-z0-9-]+$/.test(TAG)) throw new Error("The Windows deployment tag is invalid.");
  const stats = fs.statfsSync(APP_ROOT);
  const available = stats.bavail * stats.bsize;
  if (available < REQUIRED_FREE) throw new Error(`Insufficient free space for the direct Windows installation; ${REQUIRED_FREE} bytes must be available before starting.`);
  fs.mkdirSync(WORK_ROOT, { recursive: true, mode: 0o700 });
  const archiveBytes = await download();
  const names = unzip(["-Z1", ARCHIVE]).split(/\r?\n/).filter(Boolean);
  const prefix = names[0]?.split("/")[0];
  const deployPrefix = `${prefix}/deploy/windows-runtime/`;
  if (!prefix || !names.includes(`${deployPrefix}manifest.json`)) throw new Error("The GitHub tag does not contain the verified Windows deployment manifest.");
  for (const name of names) {
    if (!name.startsWith(`${prefix}/`) || name.includes("..") || name.includes("\\")) throw new Error("The downloaded GitHub archive contains an unsafe path.");
  }
  fs.rmSync(EXTRACT_ROOT, { recursive: true, force: true });
  fs.mkdirSync(EXTRACT_ROOT, { recursive: true, mode: 0o700 });
  unzip(["-q", ARCHIVE, `${deployPrefix}*`, "-d", EXTRACT_ROOT]);
  const extracted = path.join(EXTRACT_ROOT, prefix, "deploy", "windows-runtime");
  if (!regularFile(path.join(extracted, "manifest.json"))) throw new Error("The extracted Windows deployment manifest is missing.");
  if (fs.existsSync(DEPLOY_ROOT)) throw new Error("The Windows deployment target appeared during download; it was preserved.");
  fs.mkdirSync(path.dirname(DEPLOY_ROOT), { recursive: true, mode: 0o700 });
  fs.renameSync(extracted, DEPLOY_ROOT);
  // Remove the large codeload archive before runtime assembly begins.
  fs.rmSync(WORK_ROOT, { recursive: true, force: true });
  console.log(`NOMREH_WINDOWS_DOWNLOAD_OK archive_bytes=${archiveBytes}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`NOMREH_WINDOWS_DOWNLOAD_ERROR ${String(error?.message || error).replace(/https?:\/\/\S+/g, "[url]").slice(0, 300)}`);
    process.exitCode = 1;
  });
}
