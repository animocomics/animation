import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(__dirname, "..");
const launcherPath = path.join(root, "scripts", "plesk-node22.cjs");
const { discardPublicStaticBackup, passengerLaunchArguments, probeNode, restoreObsoleteRouteConflicts, restorePublicStaticAfterBuild, stashObsoleteRouteConflicts, stashPublicStaticForBuild, syncPublicStatic } = require(launcherPath);

function fakeNode(directory: string, version: string) {
  const binary = path.join(directory, "node");
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, { mode: 0o755 });
  return binary;
}

test("Plesk bootstrap pins Node 22 and delegates both build and production startup", () => {
  const launcher = fs.readFileSync(launcherPath, "utf8");
  const cacheWorkflow = fs.readFileSync(path.join(root, ".github", "workflows", "cache-node-runtime.yml"), "utf8");
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const runtimePackage = JSON.parse(fs.readFileSync(path.join(root, "scripts", "plesk-runtime", "package.json"), "utf8"));
  const version = launcher.match(/const NODE_VERSION = "([0-9.]+)"/)?.[1];

  assert.equal(version, "22.22.3");
  assert.equal(runtimePackage.dependencies.node, version);
  assert.equal(packageJson.scripts["build:plesk"], "\"$npm_node_execpath\" scripts/plesk-node22.cjs build");
  assert.equal(packageJson.scripts.build, "next build --webpack");
  assert.equal(packageJson.dependencies["better-sqlite3"], undefined);
  assert.match(launcher, /require\("node:sqlite"\)/);
  assert.match(launcher, /NEXT_TEST_WASM: "1"/);
  const nextConfig = fs.readFileSync(path.join(root, "next.config.ts"), "utf8");
  assert.match(nextConfig, /webpackBuildWorker: false/);
  assert.match(packageJson.engines.node, />=22/);
  assert.match(server, /major >= 22/);
  assert.match(server, /launchServer\(\)/);
  assert.match(launcher, /passengerLaunchArguments\(serverFile\)/);
  assert.match(launcher, /Passenger's application loader/);
  const sha256 = launcher.match(/sha256: "([a-f0-9]{64})"/)?.[1];
  const archiveSize = launcher.match(/size: ([0-9]+)/)?.[1];
  assert.ok(sha256);
  assert.ok(archiveSize);
  assert.match(cacheWorkflow, new RegExp(`NODE_VERSION: ${version}`));
  assert.match(cacheWorkflow, new RegExp(`EXPECTED_SHA256: ${sha256}`));
  assert.match(cacheWorkflow, new RegExp(`EXPECTED_SIZE: ${archiveSize}`));
  assert.match(cacheWorkflow, /git push origin HEAD:arena\/f4b832aa-animation/);
  assert.match(launcher, /Using the verified Node runtime archive bundled in the GitHub deployment/);
  assert.match(launcher, /cdn\.npmmirror\.com/);
  assert.match(launcher, /unofficial-builds\.nodejs\.org/);
  assert.match(launcher, /nodejs-unofficial-glibc-217/);
});

test("Node 22 delegation preserves Passenger's loader and direct non-Passenger startup", () => {
  const serverFile = path.join(root, "server.js");
  const environment = { ...process.env };
  delete environment.PASSENGER_SPAWN_WORK_DIR;
  const directSource = `process.stdout.write(JSON.stringify(require(${JSON.stringify(launcherPath)}).passengerLaunchArguments(${JSON.stringify(serverFile)})))`;
  const direct = spawnSync(process.execPath, ["-e", directSource], { encoding: "utf8", env: environment });
  assert.equal(direct.status, 0, direct.stderr);
  assert.deepEqual(JSON.parse(direct.stdout), [serverFile]);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nomreh-passenger-loader-"));
  try {
    const loader = path.join(directory, "node-loader.js");
    const loaderSource = `global.PhusionPassenger = {}; const { passengerLaunchArguments } = require(${JSON.stringify(launcherPath)}); process.stdout.write(JSON.stringify(passengerLaunchArguments(${JSON.stringify(serverFile)})));`;
    fs.writeFileSync(loader, loaderSource);
    const delegated = spawnSync(process.execPath, [loader], { encoding: "utf8", env: environment });
    assert.equal(delegated.status, 0, delegated.stderr);
    const output = delegated.stdout.trim().split(/\r?\n/).pop() || "";
    assert.deepEqual(JSON.parse(output), [loader]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Plesk build publishes only generated Next.js assets for nginx and preserves other public files", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nomreh-public-static-"));
  try {
    const sourceChunks = path.join(directory, ".next", "static", "chunks");
    const target = path.join(directory, "public", "_next", "static");
    fs.mkdirSync(sourceChunks, { recursive: true });
    fs.mkdirSync(path.join(target, "chunks"), { recursive: true });
    fs.writeFileSync(path.join(directory, ".next", "BUILD_ID"), "test-build");
    fs.writeFileSync(path.join(sourceChunks, "app.js"), "new-assets");
    fs.writeFileSync(path.join(target, "chunks", "stale.js"), "stale-assets");
    fs.writeFileSync(path.join(directory, "public", "nomreh-mark.svg"), "preserved");
    fs.writeFileSync(path.join(directory, "public", "_next", "keep.txt"), "preserved");

    assert.equal(syncPublicStatic(directory), target);
    assert.equal(fs.readFileSync(path.join(target, "chunks", "app.js"), "utf8"), "new-assets");
    assert.equal(fs.existsSync(path.join(target, "chunks", "stale.js")), false);
    assert.equal(fs.readFileSync(path.join(directory, "public", "nomreh-mark.svg"), "utf8"), "preserved");
    assert.equal(fs.readFileSync(path.join(directory, "public", "_next", "keep.txt"), "utf8"), "preserved");

    fs.writeFileSync(path.join(sourceChunks, "app.js"), "next-build");
    syncPublicStatic(directory);
    assert.equal(fs.readFileSync(path.join(target, "chunks", "app.js"), "utf8"), "next-build");
    assert.equal(fs.readdirSync(path.join(directory, "public", "_next")).some((entry) => entry.startsWith(".static-")), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Plesk build preserves an extraction-retained obsolete route without a parallel-page conflict", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nomreh-route-stash-"));
  try {
    const obsolete = path.join(directory, "app", "(workspace)", "admin", "page.tsx");
    const replacement = path.join(directory, "app", "admin", "page.tsx");
    fs.mkdirSync(path.dirname(obsolete), { recursive: true });
    fs.mkdirSync(path.dirname(replacement), { recursive: true });
    fs.writeFileSync(obsolete, "old-route");
    fs.writeFileSync(replacement, "new-route");
    const stash = stashObsoleteRouteConflicts(directory);
    assert.equal(fs.existsSync(obsolete), false);
    assert.equal(fs.readFileSync(`${obsolete}.nomreh-obsolete`, "utf8"), "old-route");
    restoreObsoleteRouteConflicts(stash);
    assert.equal(fs.readFileSync(obsolete, "utf8"), "old-route");
    assert.equal(fs.existsSync(`${obsolete}.nomreh-obsolete`), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Plesk build stashes public Next assets for conflict-free builds and safe rollback", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nomreh-public-build-stash-"));
  try {
    const publicNext = path.join(directory, "public", "_next");
    const oldStatic = path.join(publicNext, "static", "chunks");
    const newSource = path.join(directory, ".next", "static", "chunks");
    fs.mkdirSync(oldStatic, { recursive: true });
    fs.mkdirSync(newSource, { recursive: true });
    fs.writeFileSync(path.join(directory, ".next", "BUILD_ID"), "new-build");
    fs.writeFileSync(path.join(oldStatic, "old.js"), "old-assets");
    fs.writeFileSync(path.join(publicNext, "keep.txt"), "preserved-public-entry");
    fs.writeFileSync(path.join(newSource, "new.js"), "new-assets");

    const rollback = stashPublicStaticForBuild(directory);
    assert.equal(fs.existsSync(publicNext), false);
    fs.mkdirSync(path.join(publicNext, "static"), { recursive: true });
    fs.writeFileSync(path.join(publicNext, "static", "incomplete.js"), "incomplete");
    restorePublicStaticAfterBuild(rollback);
    assert.equal(fs.readFileSync(path.join(oldStatic, "old.js"), "utf8"), "old-assets");
    assert.equal(fs.existsSync(path.join(publicNext, "static", "incomplete.js")), false);
    assert.equal(fs.readFileSync(path.join(publicNext, "keep.txt"), "utf8"), "preserved-public-entry");

    const successful = stashPublicStaticForBuild(directory);
    restorePublicStaticAfterBuild(successful, true);
    syncPublicStatic(directory);
    assert.equal(fs.readFileSync(path.join(publicNext, "static", "chunks", "new.js"), "utf8"), "new-assets");
    assert.equal(fs.existsSync(path.join(publicNext, "static", "chunks", "old.js")), false);
    assert.equal(fs.readFileSync(path.join(publicNext, "keep.txt"), "utf8"), "preserved-public-entry");
    discardPublicStaticBackup(successful);
    assert.equal(fs.existsSync(successful.backup), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Plesk disk report is read-only and separately reports Git, application and upload usage", () => {
  const report = fs.readFileSync(path.join(root, "scripts", "plesk-space.cjs"), "utf8");
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

  assert.equal(packageJson.scripts["space:plesk"], "\"$npm_node_execpath\" scripts/plesk-space.cjs");
  assert.match(report, /Git history \(\.git\)/);
  assert.match(report, /Teacher uploads/);
  assert.match(report, /Report complete\. No files were changed or deleted\./);
  assert.doesNotMatch(report, /\b(?:rmSync|unlinkSync|writeFileSync|mkdirSync|renameSync)\s*\(/);
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
