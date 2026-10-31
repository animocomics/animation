import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(__dirname, "..");
const launcherPath = path.join(root, "scripts", "plesk-node22.cjs");
const { probeNode } = require(launcherPath);

function fakeNode(directory: string, version: string) {
  const binary = path.join(directory, "node");
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, { mode: 0o755 });
  return binary;
}

test("Plesk bootstrap pins Node 22 and delegates both build and production startup", () => {
  const launcher = fs.readFileSync(launcherPath, "utf8");
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const runtimePackage = JSON.parse(fs.readFileSync(path.join(root, "scripts", "plesk-runtime", "package.json"), "utf8"));
  const version = launcher.match(/const NODE_VERSION = "([0-9.]+)"/)?.[1];

  assert.equal(version, "22.22.3");
  assert.equal(runtimePackage.dependencies.node, version);
  assert.equal(packageJson.scripts["build:plesk"], "node scripts/plesk-node22.cjs build");
  assert.match(packageJson.engines.node, />=22/);
  assert.match(server, /major >= 22/);
  assert.match(server, /launchServer\(\)/);
  assert.match(launcher, /sha256: "[a-f0-9]{64}"/);
  assert.match(launcher, /nodejs-unofficial-glibc-217/);
});

test("runtime probe accepts the pinned binary and rejects an incompatible one", { skip: process.platform === "win32" }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nomreh-node-probe-"));
  try {
    assert.deepEqual(probeNode(fakeNode(directory, "v22.22.3")).ok, true);
    const incompatible = path.join(directory, "incompatible");
    fs.mkdirSync(incompatible, { recursive: true });
    assert.equal(probeNode(fakeNode(incompatible, "v17.9.1")).ok, false);
    assert.equal(probeNode(path.join(directory, "missing-node")).ok, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("active runtime manifest is read from the persistent data directory", { skip: process.platform === "win32" }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nomreh-runtime-manifest-"));
  try {
    const dataDirectory = path.join(directory, "data");
    const runtimeDirectory = path.join(dataDirectory, "runtime");
    fakeNode(path.join(runtimeDirectory, "node", "bin"), "v22.22.3");
    fs.writeFileSync(path.join(runtimeDirectory, "runtime.json"), JSON.stringify({ nodeVersion: "22.22.3", kind: "test-runtime" }));
    const source = `process.stdout.write(JSON.stringify(require(${JSON.stringify(launcherPath)}).readActiveRuntime()))`;
    const result = spawnSync(process.execPath, ["-e", source], {
      encoding: "utf8",
      env: { ...process.env, NOMREH_DATA_DIR: dataDirectory },
    });
    assert.equal(result.status, 0, result.stderr);
    const runtime = JSON.parse(result.stdout);
    assert.equal(runtime.kind, "test-runtime");
    assert.equal(runtime.nodeBinary, path.join(runtimeDirectory, "node", "bin", "node"));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
