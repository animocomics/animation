#!/usr/bin/env node
"use strict";

// Keep Plesk's remote deployment mirror shallow without touching the GitHub
// repository, the published application, user data, or any other repository.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const APP_ROOT = path.resolve(__dirname, "..");
const HOME_DIRECTORY = os.homedir();
const unique = (values) => [...new Set(values)];
const GIT_ROOTS = unique([
  path.join(HOME_DIRECTORY, "git"),
  path.join(HOME_DIRECTORY, ".git"),
  path.join(path.dirname(APP_ROOT), "git"),
  path.join(path.dirname(APP_ROOT), ".git"),
  path.join(path.sep, "git"),
]);
const DIRECT_REPOSITORIES = unique([
  path.join(HOME_DIRECTORY, "git", "nomreh"),
  path.join(HOME_DIRECTORY, ".git", "nomreh"),
  path.join(path.dirname(APP_ROOT), "git", "nomreh"),
  path.join(path.dirname(APP_ROOT), ".git", "nomreh"),
  path.join(path.sep, "git", "nomreh"),
]);

function gitDirectoryFor(candidate) {
  return [candidate, path.join(candidate, ".git")].find((entry) =>
    fs.existsSync(path.join(entry, "objects")) && fs.existsSync(path.join(entry, "HEAD")),
  ) || "";
}

function remoteNames(repository) {
  const result = spawnSync("git", ["-C", repository, "remote"], {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    timeout: 10000,
  });
  if (result.error || result.status !== 0) return [];
  return result.stdout.split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
}

function remoteUrl(repository, remoteName) {
  const result = spawnSync("git", ["-C", repository, "remote", "get-url", remoteName], {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    timeout: 10000,
  });
  return result.error || result.status !== 0 ? "" : result.stdout.trim();
}

// The repository was transferred from rayavc099 to animocomics. Both owners are
// accepted so an existing host clone keeps matching after the transfer, but the
// current owner is tried first. Keep this list in sync with
// NOMREH_REPOSITORIES in the deployment scripts.
const NOMREH_OWNERS = ["animocomics", "rayavc099"];
const NOMREH_PROJECT = "animation";

function isNomrehUrl(remote) {
  if (typeof remote !== "string" || !remote.trim()) return false;
  const scp = remote.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (scp) return NOMREH_OWNERS.includes(scp[1].toLowerCase()) && scp[2].replace(/\.git$/, "") === NOMREH_PROJECT;
  try {
    const parsed = new URL(remote);
    const project = parsed.pathname.replace(/\/+$/, "").replace(/\.git$/, "").replace(/^\/+/, "");
    const [owner, name, ...rest] = project.split("/");
    return (
      ["https:", "ssh:"].includes(parsed.protocol) &&
      parsed.hostname === "github.com" &&
      rest.length === 0 &&
      NOMREH_OWNERS.includes((owner || "").toLowerCase()) &&
      name === NOMREH_PROJECT
    );
  } catch {
    return false;
  }
}

function matchingRemote(repository) {
  for (const name of remoteNames(repository)) {
    if (isNomrehUrl(remoteUrl(repository, name))) return name;
  }
  return "";
}

function selectRemote(repository) {
  const names = remoteNames(repository);
  for (const name of names) {
    if (isNomrehUrl(remoteUrl(repository, name))) return name;
  }
  if (names.includes("origin")) return "origin";
  if (names.length === 1) return names[0];
  throw new Error(`Nomreh's repository was found at ${repository}, but its remote could not be identified safely. Nothing was changed.`);
}

function discoverRepository() {
  if (process.env.NOMREH_GIT_DIR) return path.resolve(process.env.NOMREH_GIT_DIR);
  for (const candidate of DIRECT_REPOSITORIES) {
    if (gitDirectoryFor(candidate)) return candidate;
  }

  const matches = [];
  const seen = [];
  function walk(directory, depth) {
    if (gitDirectoryFor(directory)) {
      seen.push(directory);
      if (matchingRemote(directory)) matches.push(directory);
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
  if (uniqueMatches.length > 1) throw new Error("Multiple Nomreh Plesk mirrors were found. Nothing was changed.");
  throw new Error(`No Nomreh mirror was found. Home directory: ${HOME_DIRECTORY}. Repositories seen: ${[...new Set(seen)].join(", ") || "none"}. Nothing was changed.`);
}

const REPOSITORY = discoverRepository();
const GIT_DIRECTORY = gitDirectoryFor(REPOSITORY);
if (!GIT_DIRECTORY) throw new Error(`Nomreh's Plesk Git mirror was not found at ${REPOSITORY}. Nothing was changed.`);
const REMOTE_NAME = selectRemote(REPOSITORY);

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

git(["rev-parse", "--git-dir"]);
git(["remote", "get-url", REMOTE_NAME]);
let branch = process.env.NOMREH_GIT_BRANCH || "";
if (!branch) {
  branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch || branch === "HEAD") branch = "arena/f4b832aa-animation";
}

const before = sizeInKiB(GIT_DIRECTORY);
console.log(`Compacting only Nomreh's Plesk mirror: ${REPOSITORY}`);
console.log(`Using remote name: ${REMOTE_NAME}`);
console.log(`Size before: ${format(before)}`);

// Move the shallow boundary to the current remote tip. The deployment branch
// itself is not reset, so the files just deployed by Plesk remain untouched.
git(["fetch", "--depth=1", REMOTE_NAME, branch]);

// Reflogs are unnecessary in a deployment mirror and would retain old objects.
git(["config", "core.logAllRefUpdates", "false"]);
git(["reflog", "expire", "--expire=now", "--all"]);
git(["-c", "pack.windowMemory=16m", "gc", "--prune=now"]);
fs.rmSync(path.join(GIT_DIRECTORY, "logs"), { recursive: true, force: true });

const after = sizeInKiB(GIT_DIRECTORY);
console.log(`Size after: ${format(after)}`);
console.log("Nomreh's Plesk mirror now keeps only the latest deployment snapshot; GitHub and published files were not changed.");
