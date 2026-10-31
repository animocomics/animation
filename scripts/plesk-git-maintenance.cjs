#!/usr/bin/env node
"use strict";

// Keep Plesk's remote deployment mirror shallow without touching the GitHub
// repository, the published application, user data, or any other repository.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const APP_ROOT = path.resolve(__dirname, "..");
const GIT_ROOTS = [path.join(path.dirname(APP_ROOT), "git"), path.join(path.dirname(APP_ROOT), ".git")];

function gitDirectoryFor(candidate) {
  return [candidate, path.join(candidate, ".git")].find((entry) =>
    fs.existsSync(path.join(entry, "objects")) && fs.existsSync(path.join(entry, "HEAD")),
  ) || "";
}

function isNomrehRemote(repository) {
  const result = spawnSync("git", ["-C", repository, "remote", "get-url", "origin"], {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    timeout: 10000,
  });
  if (result.error || result.status !== 0) return false;
  const remote = result.stdout.trim();
  if (/^git@github\.com:rayavc099\/animation(?:\.git)?\/?$/.test(remote)) return true;
  try {
    const parsed = new URL(remote);
    const project = parsed.pathname.replace(/\/+$/, "").replace(/\.git$/, "");
    return ["https:", "ssh:"].includes(parsed.protocol) && parsed.hostname === "github.com" && project === "/rayavc099/animation";
  } catch {
    return false;
  }
}

function discoverRepository() {
  if (process.env.NOMREH_GIT_DIR) return path.resolve(process.env.NOMREH_GIT_DIR);
  const matches = [];
  function walk(directory, depth) {
    if (gitDirectoryFor(directory)) {
      if (isNomrehRemote(directory)) matches.push(directory);
      return;
    }
    if (depth >= 5) return;
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      walk(path.join(directory, entry.name), depth + 1);
    }
  }
  for (const root of GIT_ROOTS) {
    if (fs.existsSync(root)) walk(root, 0);
  }
  const uniqueMatches = [...new Set(matches)];
  if (uniqueMatches.length === 1) return uniqueMatches[0];
  const roots = GIT_ROOTS.join(" and ");
  if (uniqueMatches.length > 1) throw new Error(`Multiple Nomreh Plesk mirrors were found under ${roots}. Nothing was changed.`);
  throw new Error(`No Plesk mirror for rayavc099/animation was found under ${roots}. Nothing was changed.`);
}

const REPOSITORY = discoverRepository();
const GIT_DIRECTORY = gitDirectoryFor(REPOSITORY);

if (!GIT_DIRECTORY) {
  throw new Error(`Nomreh's Plesk Git mirror was not found at ${REPOSITORY}. Nothing was changed.`);
}

function git(args) {
  const result = spawnSync("git", ["-C", REPOSITORY, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 1024 * 1024,
    timeout: 120000,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error ? result.error.message : `exit status ${result.status ?? "unknown"}`;
    throw new Error(`Git ${args[0]} failed for Nomreh's Plesk mirror (${detail}). No error output was exposed.`);
  }
  return result.stdout.trim();
}

function sizeInKiB(target) {
  const result = spawnSync("du", ["-sk", "--", target], { encoding: "utf8", timeout: 120000 });
  if (result.error || result.status !== 0) return null;
  const value = Number(result.stdout.trim().split(/\s+/, 1)[0]);
  return Number.isFinite(value) ? value : null;
}

function format(kibibytes) {
  return kibibytes === null ? "unknown" : `${(kibibytes / 1024).toFixed(1)} MiB`;
}

// Validate without ever printing the remote URL, which may contain credentials.
git(["rev-parse", "--git-dir"]);
git(["remote", "get-url", "origin"]);
let branch = process.env.NOMREH_GIT_BRANCH || "";
if (!branch) {
  branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch || branch === "HEAD") branch = "arena/f4b832aa-animation";
}

const before = sizeInKiB(GIT_DIRECTORY);
console.log(`Compacting only Nomreh's Plesk mirror: ${REPOSITORY}`);
console.log(`Size before: ${format(before)}`);

// Move the shallow boundary to the current remote tip. The deployment branch
// itself is not reset, so the files just deployed by Plesk remain untouched.
git(["fetch", "--depth=1", "origin", branch]);

// Reflogs are unnecessary in a deployment mirror and would retain old objects.
git(["config", "core.logAllRefUpdates", "false"]);
git(["reflog", "expire", "--expire=now", "--all"]);
git(["-c", "pack.windowMemory=16m", "gc", "--prune=now"]);
fs.rmSync(path.join(GIT_DIRECTORY, "logs"), { recursive: true, force: true });

const after = sizeInKiB(GIT_DIRECTORY);
console.log(`Size after: ${format(after)}`);
console.log("Nomreh's Plesk mirror now keeps only the latest deployment snapshot; GitHub and published files were not changed.");
