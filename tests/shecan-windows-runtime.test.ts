import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getOfficialRuntimeStatus } from "../lib/server/shecan-runtime";
import { REQUIRED_WINDOWS_RUNTIME_FILES, SHECAN_WINDOWS_INSTALLER_SHA256, verifyWindowsRuntime } from "../lib/server/shecan-windows-runtime";

function fakeWindowsRuntime(root: string): void {
  for (const relative of REQUIRED_WINDOWS_RUNTIME_FILES) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `validated ${relative}\n`, { mode: 0o755 });
  }
  const files = Object.fromEntries(REQUIRED_WINDOWS_RUNTIME_FILES.map((relative) => [
    relative,
    createHash("sha256").update(fs.readFileSync(path.join(root, relative))).digest("hex"),
  ]));
  fs.writeFileSync(path.join(root, "runtime-manifest.json"), JSON.stringify({
    format: 2,
    windowsInstallerSha256: SHECAN_WINDOWS_INSTALLER_SHA256,
    files,
  }));
}

function tokenProcess(token: string): ChildProcess {
  return spawn(process.execPath, ["-e", "setTimeout(() => undefined, 60000)", token], { stdio: "ignore" });
}

function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

test("Windows runtime manifest verifies the genuine application and rejects tampering", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nomreh-windows-manifest-"));
  try {
    fakeWindowsRuntime(root);
    assert.doesNotThrow(() => verifyWindowsRuntime(root));
    fs.appendFileSync(path.join(root, REQUIRED_WINDOWS_RUNTIME_FILES[2]), "tampered");
    assert.throws(() => verifyWindowsRuntime(root), /hash mismatch/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Windows readiness requires live application/viewer processes and a fresh supervisor status", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nomreh-windows-status-"));
  const root = path.join(directory, "runtime");
  const state = path.join(directory, "state");
  const oldRoot = process.env.NOMREH_SHECAN_WINDOWS_RUNTIME_DIR;
  const oldState = process.env.NOMREH_SHECAN_WINDOWS_STATE_DIR;
  const children: ChildProcess[] = [];
  try {
    fakeWindowsRuntime(root);
    fs.mkdirSync(state, { recursive: true });
    const application = tokenProcess("shecan-desktop.exe");
    const preview = tokenProcess("live-preview.mjs");
    const supervisor = tokenProcess("windows-supervisor.mjs");
    children.push(application, preview, supervisor);
    assert.ok(application.pid && preview.pid && supervisor.pid);
    fs.writeFileSync(path.join(state, "supervisor.pid"), `${supervisor.pid}\n`);
    const status = {
      phase: "ready",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      applicationPid: application.pid,
      previewPid: preview.pid,
      supervisorPid: supervisor.pid,
    };
    fs.writeFileSync(path.join(state, "status.json"), JSON.stringify(status));
    process.env.NOMREH_SHECAN_WINDOWS_RUNTIME_DIR = root;
    process.env.NOMREH_SHECAN_WINDOWS_STATE_DIR = state;
    const ready = getOfficialRuntimeStatus();
    assert.equal(ready.applicationKind, "windows");
    assert.equal(ready.displayTransport, "cdp-screencast");
    assert.equal(ready.running, true);
    assert.equal(ready.appReady, true);
    assert.equal(ready.supervisorRunning, true);
    assert.equal(ready.phase, "ready");
    assert.equal(ready.brokerReady, false, "a visible Windows form must not open the AI route");
    assert.equal(ready.activationReady, false);

    const brokerProcess = tokenProcess("bun.exe");
    children.push(brokerProcess);
    assert.ok(brokerProcess.pid);
    fs.writeFileSync(path.join(state, "status.json"), JSON.stringify({ ...status, brokerPid: brokerProcess.pid }));
    fs.writeFileSync(path.join(state, "broker-status.json"), JSON.stringify({ brokerReady: true, activationReady: false, updatedAt: new Date().toISOString() }));
    assert.equal(getOfficialRuntimeStatus().brokerReady, true);
    assert.equal(getOfficialRuntimeStatus().activationReady, false);
    fs.writeFileSync(path.join(state, "broker-status.json"), JSON.stringify({ brokerReady: true, activationReady: true, activatedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
    assert.equal(getOfficialRuntimeStatus().activationReady, true);
    fs.writeFileSync(path.join(state, "broker-status.json"), JSON.stringify({ brokerReady: true, activationReady: true, activatedAt: new Date().toISOString(), updatedAt: new Date(Date.now() - 20_000).toISOString() }));
    assert.equal(getOfficialRuntimeStatus().brokerReady, false, "a stale broker cannot carry AI traffic");
    assert.equal(getOfficialRuntimeStatus().activationReady, false);

    fs.writeFileSync(path.join(state, "status.json"), JSON.stringify({ ...status, updatedAt: new Date(Date.now() - 20_000).toISOString() }));
    assert.equal(getOfficialRuntimeStatus().appReady, false, "a stale status file is not live proof");

    fs.writeFileSync(path.join(state, "status.json"), JSON.stringify(status));
    application.kill("SIGKILL");
    await new Promise<void>((resolve) => application.once("exit", () => resolve()));
    const stopped = getOfficialRuntimeStatus();
    assert.equal(stopped.running, false);
    assert.equal(stopped.appReady, false);
    assert.equal(stopped.brokerReady, false);
  } finally {
    for (const child of children) {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        try { child.kill("SIGKILL"); } catch { /* Already exited. */ }
      }
    }
    restoreEnvironment("NOMREH_SHECAN_WINDOWS_RUNTIME_DIR", oldRoot);
    restoreEnvironment("NOMREH_SHECAN_WINDOWS_STATE_DIR", oldState);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
