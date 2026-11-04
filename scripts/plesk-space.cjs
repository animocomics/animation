#!/usr/bin/env node
"use strict";

// Read-only disk report for Plesk. It never deletes files, follows symlinks,
// reads user content, or scans outside the verified current subscription home.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const APP_ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.resolve(APP_ROOT, process.env.NOMREH_DATA_DIR || "../nomreh-data");
const SUBSCRIPTION_ROOT = path.dirname(APP_ROOT);
// The user increased the shared subscription allowance to 4,500 decimal MB.
// Use a conservative decimal-byte threshold while reporting actual du MiB.
const SUBSCRIPTION_LIMIT_KIB = (4500 * 1000 * 1000) / 1024;
const SUBSCRIPTION_LIMIT_LABEL = "4500 MB";
const TOTAL_STORAGE_LIMIT_KIB = (7 * 1000 * 1000 * 1000) / 1024;

function formatMiB(kibibytes) {
  return `${(kibibytes / 1024).toFixed(1)} MiB`;
}

function diskUsage(target) {
  if (!fs.existsSync(target)) return "not present";
  const result = spawnSync("du", ["-sk", "--", target], { encoding: "utf8", timeout: 120000 });
  if (result.error || result.status !== 0) {
    const message = result.error ? result.error.message : String(result.stderr || "du failed").trim();
    return `unavailable (${message})`;
  }
  const kibibytes = Number(result.stdout.trim().split(/\s+/, 1)[0]);
  return Number.isFinite(kibibytes) ? formatMiB(kibibytes) : "unavailable";
}

function subscriptionUsage() {
  // Plesk subscription homes are direct children of vhosts. Refuse to run a
  // broader scan if this structural guard is not true on the current host.
  if (path.basename(path.dirname(SUBSCRIPTION_ROOT)) !== "vhosts" || SUBSCRIPTION_ROOT === APP_ROOT) {
    return { text: "unavailable (current subscription scope was not verified)" };
  }
  const result = spawnSync("du", ["-sk", "--", SUBSCRIPTION_ROOT], { encoding: "utf8", timeout: 300000 });
  if (result.error || result.status !== 0) {
    const message = result.error ? result.error.message : String(result.stderr || "du failed").trim();
    return { text: `unavailable (${message})` };
  }
  const kibibytes = Number(result.stdout.trim().split(/\s+/, 1)[0]);
  return Number.isFinite(kibibytes) ? { text: formatMiB(kibibytes), kibibytes } : { text: "unavailable" };
}

function freeSpace(target) {
  const existing = fs.existsSync(target) ? target : path.dirname(target);
  const result = spawnSync("df", ["-kP", existing], { encoding: "utf8", timeout: 20000 });
  if (result.error || result.status !== 0) return "unavailable";
  const lines = result.stdout.trim().split(/\r?\n/);
  const fields = lines[lines.length - 1].trim().split(/\s+/);
  const available = Number(fields[3]);
  return Number.isFinite(available) ? formatMiB(available) : "unavailable";
}

function report(label, target) {
  console.log(`${label.padEnd(38)} ${diskUsage(target)}`);
}

console.log("Nomreh read-only disk report (du, 1 KiB blocks)");
console.log(`Application root: ${APP_ROOT}`);
console.log(`Persistent data:  ${DATA_DIR}`);
console.log("");
report("Application total", APP_ROOT);
report("  Git history (.git)", path.join(APP_ROOT, ".git"));
report("  Dependencies (node_modules)", path.join(APP_ROOT, "node_modules"));
report("  Production build (.next)", path.join(APP_ROOT, ".next"));
report("  Regenerable Next cache", path.join(APP_ROOT, ".next", "cache"));
report("  Public files", path.join(APP_ROOT, "public"));
console.log("");
report("Persistent data total", DATA_DIR);
report("  Local Node runtime", path.join(DATA_DIR, "runtime"));
report("  Teacher uploads", path.join(DATA_DIR, "uploads"));

console.log("");
console.log(`Current subscription root: ${SUBSCRIPTION_ROOT}`);
const subscription = subscriptionUsage();
console.log(`All domains in current subscription total: ${subscription.text}`);
if (typeof subscription.kibibytes === "number") {
  const totalRemaining = TOTAL_STORAGE_LIMIT_KIB - subscription.kibibytes;
  console.log(`7 GB total-storage ceiling: ${totalRemaining >= 0 ? `${formatMiB(totalRemaining)} remaining` : `EXCEEDED by ${formatMiB(-totalRemaining)}`}`);
}
if (typeof subscription.kibibytes === "number") {
  const remaining = SUBSCRIPTION_LIMIT_KIB - subscription.kibibytes;
  if (remaining >= 0) {
    console.log(`${SUBSCRIPTION_LIMIT_LABEL} current-subscription budget remaining: ${formatMiB(remaining)}`);
  } else {
    console.log(`${SUBSCRIPTION_LIMIT_LABEL} current-subscription budget EXCEEDED by: ${formatMiB(-remaining)}`);
  }
}

// File-manager removals can be moved to a subscription-level recovery folder.
// Report only direct trash/recycle entries, never unrelated domain contents.
const recoveryEntries = fs.readdirSync(SUBSCRIPTION_ROOT, { withFileTypes: true })
  .filter((entry) => /trash|recycle/i.test(entry.name));
if (recoveryEntries.length) {
  console.log("\nSubscription recovery entries (report only; nothing deleted):");
  for (const entry of recoveryEntries) report(`  ${entry.name}`, path.join(SUBSCRIPTION_ROOT, entry.name));
} else {
  console.log("\nSubscription recovery entries: none found");
}

const runtimeRoot = path.join(DATA_DIR, "runtime");
if (fs.existsSync(runtimeRoot)) {
  const temporary = fs.readdirSync(runtimeRoot).filter((name) =>
    /^\.(?:official|activate|glibc-217)-/.test(name) || name.startsWith(".node-v22.22.3-"),
  );
  if (temporary.length) {
    console.log("\nRuntime temporary entries (report only; nothing deleted):");
    for (const name of temporary) report(`  ${name}`, path.join(runtimeRoot, name));
  } else {
    console.log("\nRuntime temporary entries: none");
  }
}

console.log("");
console.log(`Available space on application filesystem: ${freeSpace(APP_ROOT)}`);
console.log(`Available space on data filesystem:        ${freeSpace(DATA_DIR)}`);
console.log("\nReport complete. No files were changed or deleted.");
