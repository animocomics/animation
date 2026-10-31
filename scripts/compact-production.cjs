#!/usr/bin/env node
"use strict";

/**
 * Remove only regenerable build artifacts and development-only packages after
 * a successful Node/Plesk production build. Application data is never touched.
 * Small TypeScript/typecheck packages intentionally remain installed so the
 * next in-place Plesk build does not trigger Next's automatic dev install.
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const APP_ROOT = path.resolve(__dirname, "..");
const BUILD_ID = path.join(APP_ROOT, ".next", "BUILD_ID");

if (!fs.existsSync(BUILD_ID)) {
  throw new Error("A completed production build was not found. Run the Plesk build first; nothing was pruned.");
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npmCli = process.env.NOMREH_NPM_EXECPATH;
const command = npmCli ? process.execPath : npm;
const args = npmCli
  ? [npmCli, "prune", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"]
  : ["prune", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"];
const result = spawnSync(command, args, {
  cwd: APP_ROOT,
  env: { ...process.env, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", npm_config_update_notifier: "false" },
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(`npm prune could not complete (status ${result.status ?? "unknown"}); generated files were kept.`);
}

// These are caches only. Keep .next/server, .next/static and BUILD_ID intact.
for (const relativePath of [".next/cache", "tsconfig.tsbuildinfo"]) {
  fs.rmSync(path.join(APP_ROOT, relativePath), { recursive: true, force: true });
}

console.log("Production compaction complete. Build cache and development-only packages were removed; application data and uploads were not touched.");
