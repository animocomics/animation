#!/usr/bin/env node
"use strict";

// Read-only disk report for Plesk. It never deletes files, follows symlinks,
// reads user content, or scans other domains.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const APP_ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.resolve(APP_ROOT, process.env.NOMREH_DATA_DIR || "../nomreh-data");

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
