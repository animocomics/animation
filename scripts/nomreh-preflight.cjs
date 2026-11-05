#!/usr/bin/env node
"use strict";

// Local pre-flight for Nomreh deployments.
//
// The hosted deployment workflows cannot run while the repository owner's
// GitHub Actions billing gate rejects new jobs. This script performs the same
// checks those workflows rely on *before* a runner is available, so a later
// hosted run does not fail on a stale guard.
//
// It never prints secrets and never mutates the repository.

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

// Must stay identical to the DELTA_FILES list in
// .github/workflows/plesk-official-http-deploy.yml (38 entries, asserted below).
const DELTA_FILES = [
  "components/admin-panel.tsx",
  "components/v2ray-connection.tsx",
  "components/official-shecan-console.tsx",
  "components/official-vnc-http-channel.ts",
  "components/shecan-windows-screen.tsx",
  "app/features.css",
  "app/api/admin/v2ray/route.ts",
  "app/api/admin/shecan-runtime/route.ts",
  "app/api/admin/shecan-runtime/windows-frame/route.ts",
  "app/api/admin/shecan-runtime/windows-input/route.ts",
  "instrumentation.ts",
  "lib/api-network.ts",
  "lib/server/api-network.ts",
  "lib/server/db.ts",
  "lib/server/provider-config.ts",
  "lib/server/provider-network.ts",
  "lib/server/v2ray-config.ts",
  "lib/server/v2ray-runtime.ts",
  "lib/server/shecan-runtime.ts",
  "lib/server/shecan-windows-runtime.ts",
  "scripts/next-server.cjs",
  "scripts/nomreh-admin-readiness.cjs",
  "scripts/plesk-node22.cjs",
  "scripts/shecan-official-deploy.ts",
  "scripts/shecan-runtime-watchdog.cjs",
  "scripts/shecan-vm/official-guest-init.sh",
  "scripts/shecan-vm/patch-official-runtime.cjs",
  "scripts/shecan-vm/run-official.sh",
  "scripts/shecan-vm/live-preview.mjs",
  "scripts/shecan-vm/windows-supervisor.mjs",
  "scripts/shecan-vm/windows-ai-broker.mjs",
  "scripts/shecan-vm/preview-smoke.mjs",
  "scripts/shecan-vm/finalize-windows-runtime.mjs",
  "scripts/shecan-vm/patch-wine-udp.py",
  "scripts/shecan-vm/WINDOWS.md",
  "scripts/shecan-vnc-http.cjs",
  "scripts/shecan-vnc-websocket.cjs",
  "types/novnc.d.ts",
];

// Mirrors the `grep -F` assertions in the hosted deployment workflow.
const GUARDS = [
  ["new OfficialVncHttpChannel", "components/official-shecan-console.tsx"],
  ["handleShecanVncHttp(request, response, port)", "scripts/next-server.cjs"],
  ["startShecanVncReverseServer();", "scripts/next-server.cjs"],
  ["ShecanWindowsScreen", "components/shecan-windows-screen.tsx"],
  ["isWindowsRuntimeInstalled", "scripts/shecan-official-deploy.ts"],
  ["readBrokerStatus", "lib/server/shecan-windows-runtime.ts"],
  ["socket = await connectDirectVnc(request);", "scripts/shecan-vnc-http.cjs"],
  ["await authorizeUpgrade(request, applicationPort);", "scripts/shecan-vnc-http.cjs"],
  ["transport: network.transport", "lib/server/provider-config.ts"],
  ["v2rayProviderFetch", "lib/server/provider-network.ts"],
  ["parseV2RayConfigListDetailed", "lib/server/v2ray-config.ts"],
  ["last_error_code", "lib/server/v2ray-runtime.ts"],
  ['inboundTag: ["nomreh-loopback-only"]', "lib/server/v2ray-runtime.ts"],
  ["assertAiProviderUrl(url)", "lib/server/v2ray-runtime.ts"],
  ["waitForXrayListen", "lib/server/v2ray-runtime.ts"],
  ["coreValidation", "lib/server/v2ray-runtime.ts"],
  ['response: { type: "http" }', "lib/server/v2ray-runtime.ts"],
  ["new AbortController()", "lib/server/v2ray-runtime.ts"],
  ["reader.cancel()", "lib/server/v2ray-runtime.ts"],
  ["stderrTail", "lib/server/v2ray-runtime.ts"],
  ['loglevel: "info"', "lib/server/v2ray-runtime.ts"],
  ["startV2RayActivation", "app/api/admin/v2ray/route.ts"],
  ["safeChildErrorDetails", "scripts/plesk-node22.cjs"],
  ['stdio: ["inherit", "inherit", "pipe"]', "scripts/plesk-node22.cjs"],
];

// The Windows runtime manifest published on the nomreh-windows-complete tag.
const EXPECTED_MANIFEST_SHA256 =
  "0111a29979a377171766b004ea7322174478b1cd1a421f20bb6d3bd16202e4ab";
const EXPECTED_RUNTIME_BYTES = 3343228444;

const failures = [];
const notes = [];

function fail(message) {
  failures.push(message);
}

function ok(label, detail) {
  process.stdout.write(`ok   ${label}${detail ? ` — ${detail}` : ""}\n`);
}

function read(relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

// 1. Node version
{
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) {
    fail(`Node ${process.versions.node} is too old; Nomreh requires Node 22+.`);
  } else {
    ok("node runtime", process.version);
  }
}

// 2. Delta file inventory
{
  if (DELTA_FILES.length !== 38) {
    fail(`Delta must contain exactly 38 files, found ${DELTA_FILES.length}.`);
  }
  const missing = DELTA_FILES.filter((file) => !fs.existsSync(path.join(root, file)));
  if (missing.length) {
    fail(`Delta files missing from the tree: ${missing.join(", ")}`);
  } else {
    ok("deploy delta inventory", `${DELTA_FILES.length} files present`);
  }
}

// 3. Guard assertions
{
  let bad = 0;
  for (const [needle, file] of GUARDS) {
    let body = "";
    try {
      body = read(file);
    } catch {
      fail(`Guard file unreadable: ${file}`);
      bad += 1;
      continue;
    }
    if (!body.includes(needle)) {
      fail(`Guard missing in ${file}: ${needle}`);
      bad += 1;
    }
  }
  if (!bad) ok("deploy guards", `${GUARDS.length} assertions pass`);
}

// 4. Windows runtime manifest, when a copy is available locally.
{
  const candidates = [
    path.join(root, "deploy", "windows-runtime", "manifest.json"),
    process.env.NOMREH_WINDOWS_MANIFEST || "",
  ].filter(Boolean);
  const manifestPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!manifestPath) {
    notes.push(
      "Windows runtime manifest is not present in this checkout; verify it from the tag before assembly.",
    );
  } else {
    const crypto = require("node:crypto");
    const bytes = fs.readFileSync(manifestPath);
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    if (digest !== EXPECTED_MANIFEST_SHA256) {
      fail(`Runtime manifest SHA-256 mismatch: ${digest}`);
    } else {
      const manifest = JSON.parse(bytes.toString("utf8"));
      const chunks = (manifest.parts || []).flatMap((part) => part.chunks || []);
      const compressed = chunks.reduce((sum, chunk) => sum + (chunk.bytes || 0), 0);
      if (manifest.format !== 1) fail(`Unexpected runtime manifest format: ${manifest.format}`);
      if (manifest.extractedBytes !== EXPECTED_RUNTIME_BYTES) {
        fail(`Runtime extractedBytes is ${manifest.extractedBytes}, expected ${EXPECTED_RUNTIME_BYTES}.`);
      }
      if (chunks.length !== 81) fail(`Runtime manifest has ${chunks.length} parts, expected 81.`);
      ok(
        "windows runtime manifest",
        `sha256 ok, ${chunks.length} parts, ${compressed} compressed / ${manifest.extractedBytes} extracted bytes`,
      );
    }
  }
}

// 4b. Kaya AI catalogue check (optional, network dependent).
//     Kaya is served from inside Iran, so a host that cannot reach GitHub must
//     still be able to reach it. This verifies the URL, the auth shape and that
//     Nomreh's default model really exists in the live catalogue.
async function kayaCatalogueCheck() {
  if (process.env.NOMREH_PREFLIGHT_SKIP_KAYA === "1") {
    notes.push("Kaya catalogue check skipped by NOMREH_PREFLIGHT_SKIP_KAYA.");
    return;
  }
  const key = (process.env.NOMREH_KAYA_API_KEY || "").trim();
  const headers = key ? { Authorization: `Bearer ${key}` } : {};
  try {
    const https = require("node:https");
    const body = await new Promise((resolve, reject) => {
      const request = https.get("https://kayaai.ir/api/chat/completions", { headers, timeout: 20000 }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode || 0, text: Buffer.concat(chunks).toString("utf8") }));
      });
      request.on("timeout", () => request.destroy(new Error("Kaya catalogue request timed out.")));
      request.on("error", reject);
    });
    if (body.status !== 200) {
      notes.push(`Kaya catalogue returned HTTP ${body.status}; provider cannot be verified from here.`);
      return;
    }
    const payload = JSON.parse(body.text);
    const ids = new Set((payload.data || []).map((entry) => entry && entry.id).filter(Boolean));
    const wanted = ["deepseek/deepseek-v4.1-flash", "deepseek/deepseek-v4-flash", "google/gemini-2.5-flash"];
    const missing = wanted.filter((id) => !ids.has(id));
    if (missing.length) {
      fail(`Kaya catalogue is missing expected models: ${missing.join(", ")}`);
    } else {
      ok("kaya catalogue", `${ids.size} models, default model present${key ? ", key supplied" : ""}`);
    }
  } catch (error) {
    notes.push(`Kaya catalogue unreachable from this network (${error.message}); no provider claim made.`);
  }
}

// 5. Optional live smoke against a running server.
//    Credentials are read from the environment and never printed.
async function liveSmoke() {
  const base = process.env.NOMREH_SMOKE_BASE;
  if (!base) {
    notes.push("Set NOMREH_SMOKE_BASE to run the live HTTP smoke.");
    return;
  }
  const username = process.env.NOMREH_SMOKE_ADMIN_USERNAME;
  const password = process.env.NOMREH_SMOKE_ADMIN_PASSWORD;
  const origin = process.env.NOMREH_SMOKE_ORIGIN || base;

  try {
    const loginPage = await fetch(`${base}/login`, { redirect: "manual" });
    if (loginPage.status !== 200) fail(`/login returned ${loginPage.status}`);

    const anonymousAdmin = await fetch(`${base}/admin`, { redirect: "manual" });
    if (![307, 308, 302, 303].includes(anonymousAdmin.status)) {
      fail(`anonymous /admin returned ${anonymousAdmin.status}, expected a redirect`);
    }

    if (username && password) {
      const response = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({ username, password }),
      });
      const payload = await response.json().catch(() => ({}));
      if (response.status !== 200 || payload?.user?.role !== "admin") {
        fail(`admin login failed with HTTP ${response.status}`);
      } else {
        const cookie = (response.headers.get("set-cookie") || "").split(";")[0];
        const admin = await fetch(`${base}/admin`, {
          headers: { cookie },
          redirect: "manual",
        });
        if (admin.status !== 200) fail(`authenticated /admin returned ${admin.status}`);
        const runtime = await fetch(`${base}/api/admin/shecan-runtime`, {
          headers: { cookie },
        });
        if (runtime.status !== 200) {
          fail(`/api/admin/shecan-runtime returned ${runtime.status}`);
        } else {
          const status = await runtime.json();
          ok(
            "live smoke",
            `login ok, admin ok, runtime=${status?.runtime?.phase ?? "unknown"}`,
          );
        }
      }
    } else {
      ok("live smoke", "anonymous routes only (no smoke credentials supplied)");
    }
  } catch (error) {
    fail(`live smoke failed: ${error.message}`);
  }
}

kayaCatalogueCheck()
  .catch(() => undefined)
  .then(liveSmoke)
  .then(() => {
  for (const note of notes) process.stdout.write(`note ${note}\n`);
  if (failures.length) {
    for (const failure of failures) process.stdout.write(`FAIL ${failure}\n`);
    process.stdout.write(`NOMREH_PREFLIGHT_FAILED ${failures.length}\n`);
    process.exit(1);
  }
  process.stdout.write("NOMREH_PREFLIGHT_OK\n");
});
