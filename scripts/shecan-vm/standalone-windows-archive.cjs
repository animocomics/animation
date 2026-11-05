#!/usr/bin/env node
"use strict";

// Standalone, resumable codeload transfer for Plesk's Node.js command console.
// This deliberately does not use Git, deploy source files, extract the archive,
// or alter an existing Nomreh installation. The private token stays in the
// process environment and is never included in argv or log messages.
const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const { once } = require("node:events");
const { spawnSync } = require("node:child_process");

const EXPECTED_BYTES = 1_428_928_417;
const EXPECTED_CHUNKS = 81;
const TAG = "nomreh-windows-complete";
const SOURCE = `https://codeload.github.com/rayavc099/animation/zip/refs/tags/${TAG}`;
const MAX_REDIRECTS = 4;
const REQUEST_TIMEOUT = 120000;
const MAX_ATTEMPTS = 4;

function regularFile(target) {
  try {
    return fs.lstatSync(target).isFile() && !fs.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

function systemCa() {
  for (const candidate of [
    "/etc/pki/tls/certs/ca-bundle.crt",
    "/etc/ssl/certs/ca-certificates.crt",
    "/etc/ssl/cert.pem",
  ]) {
    try {
      if (regularFile(candidate) && fs.statSync(candidate).size <= 16 * 1024 * 1024) return fs.readFileSync(candidate);
    } catch {
      // Try the next standard system bundle; Node's secure default remains.
    }
  }
  return undefined;
}

const CA = systemCa();

function get(url, headers, redirects = 0) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error("The Windows archive URL is invalid."));
      return;
    }
    if (parsed.protocol !== "https:") {
      reject(new Error("The Windows archive requires HTTPS."));
      return;
    }
    const request = https.get(parsed, { headers, ca: CA, timeout: REQUEST_TIMEOUT }, (response) => {
      const status = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location && redirects < MAX_REDIRECTS) {
        response.resume();
        const next = new URL(response.headers.location, parsed);
        const nextHeaders = { ...headers };
        if (next.hostname !== parsed.hostname) delete nextHeaders.Authorization;
        resolve(get(next.href, nextHeaders, redirects + 1));
        return;
      }
      resolve(response);
    });
    request.on("timeout", () => request.destroy(new Error("The GitHub download stalled.")));
    request.on("error", reject);
  });
}

function inspectArchive(archive) {
  const result = spawnSync("unzip", ["-Z1", archive], {
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`The downloaded ZIP could not be inspected (${result.error?.code || result.status || "unknown"}). The file was preserved.`);
  }
  const names = String(result.stdout || "").split(/\r?\n/).filter(Boolean);
  const manifest = names.find((name) => /^[^/]+\/deploy\/windows-runtime\/manifest\.json$/.test(name));
  const chunks = names.filter((name) => /^[^/]+\/deploy\/windows-runtime\/parts\/(?:application|support|webview)\/[0-9]{3}$/.test(name));
  if (!manifest || chunks.length !== EXPECTED_CHUNKS || names.some((name) => name.includes("..") || name.includes("\\") || name.startsWith("/"))) {
    throw new Error("The downloaded ZIP does not have the pinned safe Windows deployment structure. The file was preserved.");
  }
}

async function main() {
  const token = String(process.env.NOMREH_WINDOWS_GITHUB_TOKEN || "").trim();
  if (!token) throw new Error("NOMREH_WINDOWS_GITHUB_TOKEN is missing from this Node.js application's environment.");

  const appRoot = path.resolve(process.env.NOMREH_APP_ROOT || process.cwd());
  if (path.basename(appRoot) !== "nomreh.arounidea.com") {
    throw new Error("Run this only from Nomreh's own Node.js application console; no files were changed.");
  }
  const transferRoot = path.resolve(appRoot, "..", "nomreh-data", "windows-transfer");
  const archive = path.join(transferRoot, "nomreh-windows-complete.zip");
  const partial = `${archive}.partial`;

  if (regularFile(archive)) {
    if (fs.statSync(archive).size !== EXPECTED_BYTES) throw new Error("An existing final ZIP has an unexpected size and was preserved.");
    inspectArchive(archive);
    console.log(`NOMREH_WINDOWS_ARCHIVE_READY path=${archive} bytes=${EXPECTED_BYTES} resumed=false`);
    return { archive, bytes: EXPECTED_BYTES, resumed: true };
  }

  fs.mkdirSync(transferRoot, { recursive: true, mode: 0o700 });
  if (fs.existsSync(archive)) throw new Error("The final ZIP path exists but is not a regular file; it was preserved.");
  if (fs.existsSync(partial) && !regularFile(partial)) throw new Error("The partial ZIP path is unsafe; nothing was changed.");

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const existing = regularFile(partial) ? fs.statSync(partial).size : 0;
    if (existing > EXPECTED_BYTES) throw new Error("The partial ZIP is larger than the pinned archive and was preserved for inspection.");
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/zip",
      "User-Agent": "nomreh-standalone-windows-archive",
    };
    if (existing) headers.Range = `bytes=${existing}-`;

    let response;
    let output;
    try {
      response = await get(SOURCE, headers);
      const status = response.statusCode || 0;
      if (status === 416 && existing === EXPECTED_BYTES) {
        response.resume();
        inspectArchive(partial);
        fs.renameSync(partial, archive);
        console.log(`NOMREH_WINDOWS_ARCHIVE_READY path=${archive} bytes=${EXPECTED_BYTES} resumed=true`);
        return { archive, bytes: EXPECTED_BYTES, resumed: true };
      }
      if (![200, 206].includes(status)) {
        response.resume();
        if ([401, 403, 404].includes(status)) throw new Error("GitHub rejected the private archive; check the token's Contents: Read-only permission for animation.");
        throw new Error(`GitHub returned HTTP ${status} for the Windows archive.`);
      }
      if (existing && status === 206 && !(response.headers["content-range"] || "").startsWith(`bytes ${existing}-`)) {
        response.resume();
        throw new Error("GitHub returned an invalid resume range; the partial file was preserved.");
      }

      const append = existing > 0 && status === 206;
      let bytes = append ? existing : 0;
      let nextReport = Math.floor(bytes / (128 * 1024 * 1024) + 1) * 128 * 1024 * 1024;
      output = fs.createWriteStream(partial, { flags: append ? "a" : "w", mode: 0o600 });
      try {
        for await (const chunk of response) {
          bytes += chunk.length;
          if (bytes > EXPECTED_BYTES) throw new Error("The Windows archive exceeded its pinned byte size; the partial file was preserved.");
          if (!output.write(chunk)) await once(output, "drain");
          if (bytes >= nextReport) {
            console.log(`NOMREH_WINDOWS_ARCHIVE_PROGRESS bytes=${bytes} total=${EXPECTED_BYTES}`);
            nextReport += 128 * 1024 * 1024;
          }
        }
        output.end();
        await once(output, "finish");
      } finally {
        if (!output.closed) output.destroy();
      }

      const declared = Number(response.headers["content-length"] || 0) + (append ? existing : 0);
      if (declared && bytes !== declared) throw new Error("The Windows archive ended before its declared length; rerun to resume.");
      if (bytes !== EXPECTED_BYTES) throw new Error(`The Windows archive has ${bytes} bytes instead of the pinned ${EXPECTED_BYTES}; rerun to resume.`);
      inspectArchive(partial);
      fs.renameSync(partial, archive);
      console.log(`NOMREH_WINDOWS_ARCHIVE_RECEIVED bytes=${bytes}`);
      console.log(`NOMREH_WINDOWS_ARCHIVE_READY path=${archive} bytes=${bytes} resumed=${existing > 0}`);
      return { archive, bytes, resumed: existing > 0 };
    } catch (error) {
      if (response) response.destroy();
      if (output && !output.closed) output.destroy();
      if (attempt === MAX_ATTEMPTS) throw error;
      console.log(`NOMREH_WINDOWS_ARCHIVE_RETRY attempt=${attempt + 1} partial_bytes=${regularFile(partial) ? fs.statSync(partial).size : 0}`);
    }
  }
  throw new Error("The Windows archive download did not complete; the partial file was preserved.");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`NOMREH_WINDOWS_ARCHIVE_ERROR ${String(error?.message || error).replace(/https?:\/\/\S+/g, "[url]").slice(0, 350)}`);
    process.exitCode = 1;
  });
}

module.exports = { EXPECTED_BYTES, EXPECTED_CHUNKS, SOURCE, main };
