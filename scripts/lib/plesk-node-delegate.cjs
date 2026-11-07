"use strict";

// Re-runs a console script under the Node that Nomreh actually runs on.
//
// The Plesk subscription exposes Node 17 to its console, but `setup:plesk` and
// `start:plesk` install and use a domain-local Node 22 in the data directory. A
// diagnostic written for the console therefore has to switch to that runtime, or
// it reports "this needs Node 22" and tells the operator nothing useful. That is
// exactly what `npm run diagnose` used to do on this host.
//
// Node 17 can require this file. Nothing here uses a newer syntax.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const MIN_MAJOR = 22;

function major() {
  return Number(String(process.versions.node).replace(/^v/, "").split(".")[0]) || 0;
}

function dataDirectories() {
  const appRoot = path.resolve(__dirname, "..", "..");
  const directories = [];
  if (process.env.NOMREH_DATA_DIR) directories.push(path.resolve(process.env.NOMREH_DATA_DIR));
  directories.push(path.join(appRoot, "..", "nomreh-data"));
  directories.push(path.join(appRoot, "data"));
  return [...new Set(directories)];
}

function runtimeNode() {
  for (const directory of dataDirectories()) {
    const candidate = path.join(directory, "runtime", "node", "bin", "node");
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* not installed yet */
    }
  }
  return "";
}

/**
 * Ensures the current process runs on Node 22 or newer.
 *
 * Returns true when the caller should keep going (already new enough, or the
 * runtime is missing and the caller must degrade gracefully). Otherwise this
 * process is replaced by a fresh one and exits with its status.
 */
function ensureNode22(scriptPath) {
  if (major() >= MIN_MAJOR) return true;

  const binary = runtimeNode();
  if (!binary) {
    console.log(`Node ${process.versions.node} is the console runtime and no domain-local Node ${MIN_MAJOR} was found.`);
    console.log("Run `npm run setup:plesk` once, then this command again.");
    console.log(`Searched: ${dataDirectories().map((dir) => path.join(dir, "runtime", "node", "bin", "node")).join(", ")}`);
    return false;
  }

  console.log(
    `Console runtime is Node ${process.versions.node}; re-runs itself on the domain-local Node ${MIN_MAJOR} at ${binary}`,
  );
  const environment = Object.assign({}, process.env, { NOMREH_NODE22_DELEGATED: "1" });
  const result = spawnSync(binary, [scriptPath].concat(process.argv.slice(2)), {
    stdio: "inherit",
    env: environment,
  });
  if (result.error) {
    console.log(`Could not start the domain-local Node ${MIN_MAJOR}: ${result.error.message}`);
    return false;
  }
  process.exit(typeof result.status === "number" ? result.status : 1);
}

module.exports = { ensureNode22, runtimeNode, dataDirectories, major };
