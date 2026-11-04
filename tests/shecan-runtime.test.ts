import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { closeProviderNetwork, providerFetch, ProviderNetworkError } from "../lib/server/provider-network";
import { getOfficialRuntimeStatus, startOfficialRuntime, stopOfficialRuntime, verifyOfficialRuntime } from "../lib/server/shecan-runtime";

const files = [
  "glibc/lib/x86_64-linux-gnu/ld-2.27.so",
  "qemu/bin/qemu-system-x86_64",
  "guest/vmlinuz-virt",
  "guest/initramfs-official",
  "run-official.sh",
];

async function waitFor(check: () => boolean, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail("Timed out waiting for the official runtime supervisor");
}

function fakeRuntime(root: string) {
  for (const relative of files) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `validated ${relative}\n`, { mode: 0o755 });
  }
  const manifest = {
    format: 1,
    officialRpmSha256: "a".repeat(64),
    files: Object.fromEntries(files.map((relative) => [relative, createHash("sha256").update(fs.readFileSync(path.join(root, relative))).digest("hex")])),
  };
  fs.writeFileSync(path.join(root, "runtime-manifest.json"), JSON.stringify(manifest));
}

test("official runtime manifest verifies every required file and rejects modification", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nomreh-official-manifest-"));
  try {
    fakeRuntime(root);
    assert.doesNotThrow(() => verifyOfficialRuntime(root));
    fs.appendFileSync(path.join(root, "guest", "initramfs-official"), "tampered");
    assert.throws(() => verifyOfficialRuntime(root), /hash mismatch/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("runtime retains only the safe boot error after QEMU exits", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nomreh-official-exit-"));
  const root = path.join(directory, "runtime");
  const data = path.join(directory, "data");
  const old = { root: process.env.NOMREH_SHECAN_RUNTIME_DIR, data: process.env.NOMREH_DATA_DIR };
  process.env.NOMREH_SHECAN_RUNTIME_DIR = root;
  process.env.NOMREH_DATA_DIR = data;
  try {
    fakeRuntime(root);
    const state = path.join(data, "shecan-official");
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, "state.json"), JSON.stringify({ lastError: "GUEST_EXIT_0" }));
    fs.writeFileSync(path.join(state, "guest-console.log"), "NOMREH_OFFICIAL_GUEST_BEGIN\nNOMREH_OFFICIAL_GUEST_ERROR XVNC\nraw-log-must-not-leak\n");
    const status = getOfficialRuntimeStatus();
    assert.equal(status.running, false);
    assert.equal(status.phase, "error");
    assert.equal(status.errorCode, "NOMREH_OFFICIAL_GUEST_ERROR_XVNC");
    assert.ok(status.markers.includes("NOMREH_OFFICIAL_GUEST_ERROR XVNC"));
    assert.ok(!status.markers.some((marker) => marker.includes("raw-log")));
  } finally {
    for (const [key, value] of Object.entries({ NOMREH_SHECAN_RUNTIME_DIR: old.root, NOMREH_DATA_DIR: old.data })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("runtime lifecycle markers gate the AI proxy and stopping fails closed without QEMU", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nomreh-official-lifecycle-"));
  const root = path.join(directory, "runtime");
  const data = path.join(directory, "data");
  const old = { root: process.env.NOMREH_SHECAN_RUNTIME_DIR, data: process.env.NOMREH_DATA_DIR, vnc: process.env.NOMREH_VNC_PORT, proxy: process.env.NOMREH_PROXY_PORT };
  process.env.NOMREH_SHECAN_RUNTIME_DIR = root;
  process.env.NOMREH_DATA_DIR = data;
  process.env.NOMREH_VNC_PORT = "45900";
  process.env.NOMREH_PROXY_PORT = "45888";
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  try {
    fs.mkdirSync(root, { recursive: true });
    fakeRuntime(root);
    const network = { enabled: true, plan: "pro" as const, servers: ["178.22.122.101", "185.51.200.1"] as [string, string], transport: "official-vm" as const };
    globalThis.fetch = (async () => { fetchCalls += 1; return Response.json({ ok: true }); }) as typeof fetch;
    await assert.rejects(providerFetch("https://api.openai.com/v1/responses", {}, network), ProviderNetworkError);
    assert.equal(fetchCalls, 0, "a stopped official guest must not fall back to direct fetch");

    const serial = path.join(data, "shecan-official", "guest-console.log");
    const runner = `#!/bin/sh\nmkdir -p ${JSON.stringify(path.dirname(serial))}\nprintf '%s\\n' NOMREH_OFFICIAL_APP_PROCESS_ALIVE NOMREH_OFFICIAL_AI_BROKER_LISTENING > \"\${NOMREH_VM_SERIAL#file:}\"\nexec /bin/sh -c 'while :; do sleep 60; done' ${JSON.stringify(path.join(root, "qemu/bin/qemu-system-x86_64"))} ${JSON.stringify(path.join(root, "guest/initramfs-official"))}\n`;
    fs.writeFileSync(path.join(root, "run-official.sh"), runner, { mode: 0o755 });
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "runtime-manifest.json"), "utf8"));
    manifest.files["run-official.sh"] = createHash("sha256").update(fs.readFileSync(path.join(root, "run-official.sh"))).digest("hex");
    fs.writeFileSync(path.join(root, "runtime-manifest.json"), JSON.stringify(manifest));

    await startOfficialRuntime();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const ready = getOfficialRuntimeStatus();
    assert.equal(ready.running, true);
    assert.equal(ready.appReady, true);
    assert.equal(ready.brokerReady, true);
    assert.equal(ready.activationReady, false);
    assert.ok(ready.markers.includes("NOMREH_OFFICIAL_APP_PROCESS_ALIVE"));
    assert.ok(ready.markers.includes("NOMREH_OFFICIAL_AI_BROKER_LISTENING"));
    await waitFor(() => getOfficialRuntimeStatus().supervisorRunning, 5000);
    const firstPid = Number(fs.readFileSync(path.join(data, "shecan-official", "guest.pid"), "utf8").trim());
    process.kill(-firstPid, "SIGKILL");
    await waitFor(() => {
      const current = getOfficialRuntimeStatus();
      let currentPid = 0;
      try { currentPid = Number(fs.readFileSync(path.join(data, "shecan-official", "guest.pid"), "utf8").trim()); } catch { /* Waiting for replacement. */ }
      return current.running && current.appReady && current.brokerReady && current.supervisorRunning && currentPid > 1 && currentPid !== firstPid;
    });
    fs.appendFileSync(serial, "NOMREH_OFFICIAL_AI_ACTIVATED\n");
    assert.equal(getOfficialRuntimeStatus().activationReady, true);
    const seen: unknown[] = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      seen.push((init as RequestInit & { dispatcher?: unknown } | undefined)?.dispatcher);
      return Response.json({ ok: true });
    }) as typeof fetch;
    await providerFetch("https://api.openai.com/v1/responses", {}, network);
    await providerFetch("https://example.com/not-a-provider", {}, network);
    assert.ok(seen[0], "provider traffic must use the isolated ProxyAgent");
    assert.equal(seen[1], undefined, "unrelated traffic must never inherit the proxy");
    fs.appendFileSync(serial, "NOMREH_OFFICIAL_APP_ERROR PROCESS_EXITED\n");
    const failed = getOfficialRuntimeStatus();
    assert.equal(failed.phase, "error");
    assert.equal(failed.errorCode, "NOMREH_OFFICIAL_APP_ERROR_PROCESS_EXITED");
    assert.ok(failed.markers.includes("NOMREH_OFFICIAL_APP_ERROR PROCESS_EXITED"));
    const stopped = await stopOfficialRuntime();
    assert.equal(stopped.running, false);
    await waitFor(() => !getOfficialRuntimeStatus().supervisorRunning, 5000);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(getOfficialRuntimeStatus().running, false, "a manual stop must not be undone by the watchdog");
    assert.equal(fs.existsSync(path.join(data, "shecan-official", "stop-requested")), true);
  } finally {
    closeProviderNetwork();
    await stopOfficialRuntime().catch(() => undefined);
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries({ NOMREH_SHECAN_RUNTIME_DIR: old.root, NOMREH_DATA_DIR: old.data, NOMREH_VNC_PORT: old.vnc, NOMREH_PROXY_PORT: old.proxy })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
