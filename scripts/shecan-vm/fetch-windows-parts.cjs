#!/usr/bin/env node
"use strict";

// Resume-safe fetcher for the Windows runtime deployment chunks.
//
// Why this exists
// ---------------
// The previous path downloaded a single ~1.4 GB codeload ZIP. Two facts made
// that unusable on the production host:
//   1. codeload.github.com stalls or refuses the connection there, so every
//      attempt ended with partial_bytes=0;
//   2. codeload answers plain requests with HTTP 200 and IGNORES a Range
//      header, so a "resumable" retry silently restarted from byte zero and
//      never made progress.
//
// This script fetches the 81 individual 16 MiB parts through api.github.com,
// which the required token is scoped for. Each part is:
//   * written to a temporary file and renamed only after its pinned SHA-256
//     matches the manifest,
//   * skipped entirely when a verified copy is already on disk,
// which makes the whole transfer resumable at part granularity without
// re-downloading anything that is already good.
//
// It never prints a token, never logs a URL with credentials, and deletes only
// its own temporary files.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const https = require("node:https");

const APP_ROOT = path.resolve(process.env.NOMREH_APP_ROOT || path.join(__dirname, "..", ".."));
const DEPLOY_ROOT = path.join(APP_ROOT, "deploy", "windows-runtime");
const MANIFEST = path.join(DEPLOY_ROOT, "manifest.json");
const TAG = process.env.NOMREH_WINDOWS_GITHUB_TAG || "nomreh-windows-complete";
const REPOSITORY = (process.env.NOMREH_WINDOWS_GITHUB_REPOSITORY || "animocomics/animation")
  .replace(/^\/+|\/+$/g, "");
const TOKEN = (process.env.NOMREH_WINDOWS_GITHUB_TOKEN || "").trim();
const ATTEMPTS = Number(process.env.NOMREH_WINDOWS_CHUNK_ATTEMPTS || 4);
const MAX_CHUNK = 32 * 1024 * 1024;

if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(REPOSITORY)) {
  throw new Error("NOMREH_WINDOWS_GITHUB_REPOSITORY must look like owner/name.");
}

function regularFile(target) {
  try {
    const stat = fs.lstatSync(target);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function sha256File(target) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(target, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!read) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function readManifest() {
  if (!regularFile(MANIFEST)) {
    throw new Error("deploy/windows-runtime/manifest.json is missing; run the checked-in manifest step first.");
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  if (manifest.format !== 1 || !Array.isArray(manifest.parts) || !Number.isSafeInteger(manifest.extractedBytes)) {
    throw new Error("The Windows deployment manifest is invalid.");
  }
  const chunks = [];
  for (const part of manifest.parts) {
    if (!/^[a-z0-9-]+$/.test(part.name || "") || !Array.isArray(part.chunks)) {
      throw new Error("The Windows deployment part metadata is invalid.");
    }
    for (const chunk of part.chunks) {
      if (!/^parts\/[a-z0-9-]+\/[0-9]{3}$/.test(chunk.path || "")) {
        throw new Error("The Windows deployment chunk path is invalid.");
      }
      if (!/^[a-f0-9]{64}$/.test(chunk.sha256 || "") || !Number.isSafeInteger(chunk.bytes) || chunk.bytes <= 0) {
        throw new Error("The Windows deployment chunk metadata is invalid.");
      }
      if (chunk.bytes > MAX_CHUNK) throw new Error("A deployment chunk is larger than the safety bound.");
      chunks.push({ path: chunk.path, bytes: chunk.bytes, sha256: chunk.sha256 });
    }
  }
  return { manifest, chunks };
}

// node:https keeps the TLS trust store explicit and matches the other Nomreh
// scripts. It also avoids undici-specific behaviour on older hosts.
function requestBuffer(url, headers, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error("Too many redirects while fetching a deployment part."));
      return;
    }
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== "api.github.com") {
      reject(new Error("Deployment parts must come from api.github.com over HTTPS."));
      return;
    }
    const request = https.get(parsed, { headers }, (response) => {
      const status = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        response.resume();
        resolve(requestBuffer(new URL(response.headers.location, parsed).toString(), headers, redirects + 1));
        return;
      }
      if (status !== 200) {
        response.resume();
        const error = new Error(`GitHub returned HTTP ${status}.`);
        error.status = status;
        reject(error);
        return;
      }
      const declared = Number(response.headers["content-length"] || 0);
      const chunks = [];
      let received = 0;
      response.on("data", (piece) => {
        received += piece.length;
        if (received > MAX_CHUNK) {
          request.destroy(new Error("Deployment part exceeded the safety bound."));
          return;
        }
        chunks.push(piece);
      });
      response.on("end", () => resolve({ body: Buffer.concat(chunks), declared, received }));
      response.on("error", reject);
    });
    request.setTimeout(120000, () => request.destroy(new Error("The deployment part download timed out.")));
    request.on("error", reject);
  });
}

async function fetchChunk(chunk) {
  const url =
    `https://api.github.com/repos/${REPOSITORY}/contents/deploy/windows-runtime/${chunk.path}?ref=${encodeURIComponent(TAG)}`;
  const { body, declared } = await requestBuffer(url, {
    Authorization: `Bearer ${TOKEN}`,
    Accept: "application/vnd.github.raw",
    "User-Agent": "nomreh-windows-chunk-fetch",
    "X-GitHub-Api-Version": "2022-11-28",
  });
  if (declared && declared !== chunk.bytes) {
    throw new Error(`Unexpected size for ${chunk.path}: header ${declared}, manifest ${chunk.bytes}.`);
  }
  if (body.length !== chunk.bytes) {
    throw new Error(`Truncated part ${chunk.path}: got ${body.length} of ${chunk.bytes} bytes.`);
  }
  const digest = crypto.createHash("sha256").update(body).digest("hex");
  if (digest !== chunk.sha256) {
    throw new Error(`Hash mismatch for ${chunk.path}.`);
  }
  return body;
}

async function withRetry(chunk, destination) {
  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      const body = await fetchChunk(chunk);
      const temporary = `${destination}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, body, { mode: 0o600 });
      if (sha256File(temporary) !== chunk.sha256) {
        fs.rmSync(temporary, { force: true });
        throw new Error(`Hash mismatch after write for ${chunk.path}.`);
      }
      fs.renameSync(temporary, destination);
      return "downloaded";
    } catch (error) {
      lastError = error;
      // A hard auth/permission answer will not improve by retrying.
      if (error.status === 401 || error.status === 403) break;
      const delay = Math.min(15000, 750 * 2 ** (attempt - 1));
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function main() {
  if (!TOKEN) {
    throw new Error("NOMREH_WINDOWS_GITHUB_TOKEN is required; it is read from the environment and never printed.");
  }
  const { manifest, chunks } = readManifest();
  const totalBytes = chunks.reduce((sum, chunk) => sum + chunk.bytes, 0);

  let downloaded = 0;
  let skipped = 0;
  let downloadedBytes = 0;

  console.log(
    `NOMREH_WINDOWS_CHUNK_FETCH_START repo=${REPOSITORY} tag=${TAG} parts=${chunks.length} bytes=${totalBytes}`,
  );

  for (const chunk of chunks) {
    const destination = path.resolve(DEPLOY_ROOT, chunk.path);
    if (!destination.startsWith(path.resolve(DEPLOY_ROOT) + path.sep)) {
      throw new Error("A deployment chunk escaped the deployment root.");
    }
    if (regularFile(destination) && sha256File(destination) === chunk.sha256) {
      skipped += 1;
      console.log(`NOMREH_WINDOWS_CHUNK_PRESENT ${chunk.path}`);
      continue;
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    const result = await withRetry(chunk, destination);
    downloaded += 1;
    downloadedBytes += chunk.bytes;
    console.log(`NOMREH_WINDOWS_CHUNK_${result.toUpperCase()} ${chunk.path} bytes=${chunk.bytes}`);
  }

  console.log(
    `NOMREH_WINDOWS_CHUNK_FETCH_OK downloaded=${downloaded} downloaded_bytes=${downloadedBytes} skipped=${skipped} extracted_target=${manifest.extractedBytes}`,
  );
}

if (require.main === module) {
  main().catch((error) => {
    const message = String(error?.message || error).replace(/https?:\/\/\S+/g, "[url]").slice(0, 300);
    console.error(`NOMREH_WINDOWS_CHUNK_FETCH_ERROR ${message}`);
    process.exitCode = 1;
  });
}

module.exports = { DEPLOY_ROOT, MANIFEST, REPOSITORY, TAG, readManifest, sha256File };
