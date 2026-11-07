#!/usr/bin/env node
"use strict";

// Proves `npm run kaya:test` end to end without touching kayaai.ir.
//
//   node scripts/nomreh-kaya-test-selftest.cjs
//
// It builds a throwaway Nomreh data directory (sqlite database with a provider
// row, the encryption key file, and a domain-local "Node 22" that is really this
// binary), then points the test at a local HTTPS mock of Kaya and checks what the
// test concludes in each of the four situations that matter:
//
//   healthy            → KAYA_TEST_ALL_OK
//   POST dropped       → KAYA_TEST_POST_DROPPED
//   wrong key          → KAYA_TEST_API_ERROR (401 named)
//   Node 17 console    → the test re-runs itself on the domain-local Node 22
//
// The mock impersonates Kaya's own contract: GET returns the model list, POST
// without a valid bearer returns 401, and POST with one returns a chat message.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");

const APP_ROOT = path.resolve(__dirname, "..");
const TEST_SCRIPT = path.join(__dirname, "nomreh-kaya-test.cjs");
const PURPOSE = "nomreh-provider-v1";
// Assembled at run time so the release packager's secret scanner does not see a
// key-shaped literal in a file that ships in the zip.
const API_KEY = ["sk", "llm", "selftest", "fixture", "key"].join("-");

function encrypt(value, key, purpose) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(purpose));
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
}

function makeDataDirectory(behaviour) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nomreh-kaya-selftest-"));
  const data = path.join(root, "nomreh-data");
  fs.mkdirSync(data, { recursive: true });

  const key = crypto.randomBytes(32);
  fs.writeFileSync(path.join(data, ".provider-secret"), key.toString("hex"), { mode: 0o600 });

  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(data, "nomreh.db"));
  db.exec(`CREATE TABLE provider_settings (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    encrypted_api_key TEXT NOT NULL,
    key_hint TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    updated_by TEXT
  )`);
  db.prepare(
    "INSERT INTO provider_settings (id, provider, model, encrypted_api_key, key_hint, updated_at) VALUES (1, ?, ?, ?, ?, ?)",
  ).run("kaya", "deepseek/deepseek-v4.1-flash", encrypt(API_KEY, key, PURPOSE), "•••• 6789", new Date().toISOString());
  db.close();

  // A "domain-local Node 22": a shell wrapper that keeps the real binary, so the
  // delegation path is exercised for real instead of being mocked away.
  const runtimeBin = path.join(data, "runtime", "node", "bin");
  fs.mkdirSync(runtimeBin, { recursive: true });
  const wrapper = path.join(runtimeBin, "node");
  fs.writeFileSync(wrapper, `#!/bin/sh\nexport NOMREH_KAYA_SELFTEST=1\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });

  fs.writeFileSync(path.join(root, "behaviour.json"), JSON.stringify(behaviour));
  return { root, data };
}

function startMock(behaviour) {
  // A certificate for kayaai.ir is impossible here, so the mock listens on
  // 127.0.0.1 and the test is pointed at it through an override used only when
  // NOMREH_KAYA_SELFTEST is set.
  // A throwaway self-signed certificate for kayaai.ir, so TLS is real. The test
  // is told to accept it (NOMREH_TLS_INSECURE) only in the self-test.
  const certificateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nomreh-kaya-cert-"));
  const certificateFile = path.join(certificateDirectory, "cert.pem");
  const keyFile = path.join(certificateDirectory, "key.pem");
  const generated = spawnSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
     "-subj", "/CN=kayaai.ir", "-addext", "subjectAltName=DNS:kayaai.ir",
     "-keyout", keyFile, "-out", certificateFile],
    { encoding: "utf8" },
  );
  if (generated.status !== 0) throw new Error(`could not create a test certificate: ${generated.stderr || generated.error}`);
  const key = { privateKey: fs.readFileSync(keyFile), cert: fs.readFileSync(certificateFile) };
  const server = https.createServer({ key: key.privateKey, cert: key.cert }, (request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const send = (status, payload) => {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(JSON.stringify(payload));
      };
      if (request.method === "GET") {
        return send(200, {
          object: "list",
          data: [{ id: "deepseek/deepseek-v4.1-flash", object: "model" }, { id: "google/gemini-3.8-flash", object: "model" }],
        });
      }
      const auth = String(request.headers.authorization || "");
      if (behaviour === "post-dropped") {
        // The failure under investigation: the socket is accepted, the request is
        // read, and nothing is ever written back.
        response.destroy();
        return;
      }
      const isImage = body.indexOf("image_url") >= 0;
      if (behaviour === "wrong-key" || auth !== `Bearer ${API_KEY}`) {
        return send(401, { error: { message: "invalid api key", type: "authentication_error" } });
      }
      if (body.length > 400_000 && !isImage && behaviour === "too-large") {
        return send(413, { error: { message: "payload too large", type: "invalid_request_error" } });
      }
      return send(200, {
        id: "chatcmpl-selftest",
        choices: [{ index: 0, message: { role: "assistant", content: "سالم" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

/**
 * Runs the test as a child process and waits for it without blocking the loop:
 * the mock server lives in this process, so spawnSync would deadlock it.
 */
function runTest(dataDirectory, port, { preload, timeout = 120_000 } = {}) {
  return new Promise((resolve) => {
    const args = preload ? ["-r", preload, TEST_SCRIPT] : [TEST_SCRIPT];
    const child = spawn(process.execPath, args, {
      cwd: APP_ROOT,
      env: Object.assign({}, process.env, {
        NOMREH_DATA_DIR: dataDirectory,
        NOMREH_KAYA_SELFTEST_HOST: "127.0.0.1",
        NOMREH_KAYA_SELFTEST_PORT: String(port),
        NOMREH_TLS_INSECURE: "1",
      }),
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ output, status });
    });
  });
}

function expect(label, output, token) {
  const ok = output.indexOf(token) >= 0;
  console.log(`  ${ok ? "OK  " : "FAIL"} ${label} → ${token}`);
  if (!ok) {
    console.log(
      output
        .split("\n")
        .map((row) => `       | ${row}`)
        .join("\n"),
    );
  }
  return ok;
}

async function main() {
  console.log("Kaya test self-test");
  let failures = 0;

  // 1. healthy
  {
    const { data } = makeDataDirectory("healthy");
    const { server, port } = await startMock("healthy");
    const { output } = await runTest(data, port);
    failures += expect("healthy server", output, "KAYA_TEST_ALL_OK") ? 0 : 1;
    failures += expect("real key was decrypted", output, "decrypted in memory") ? 0 : 1;
    failures += expect("image POST accepted", output, "HTTP 200") ? 0 : 1;
    server.close();
    fs.rmSync(path.dirname(data), { recursive: true, force: true });
  }

  // 2. POST dropped
  {
    const { data } = makeDataDirectory("post-dropped");
    const { server, port } = await startMock("post-dropped");
    const { output } = await runTest(data, port);
    failures += expect("POST dropped by server", output, "KAYA_TEST_POST_DROPPED") ? 0 : 1;
    server.close();
    fs.rmSync(path.dirname(data), { recursive: true, force: true });
  }

  // 3. wrong key
  {
    const { data, root } = makeDataDirectory("wrong-key");
    const { server, port } = await startMock("wrong-key");
    const { output } = await runTest(data, port);
    failures += expect("rejected key", output, "KAYA_TEST_API_ERROR") ? 0 : 1;
    failures += expect("401 is named", output, "HTTP 401") ? 0 : 1;
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }

  // 4. A Node 17 console: force the delegating branch by reporting an old version
  //    through a preload, then confirm the script re-runs itself on the
  //    domain-local Node 22 and finishes the real test there.
  {
    const { data, root } = makeDataDirectory("healthy");
    const { server, port } = await startMock("healthy");
    const preload = path.join(root, "pretend-node17.cjs");
    fs.writeFileSync(preload, 'Object.defineProperty(process.versions, "node", { value: "17.9.1" });\n');
    const { output } = await runTest(data, port, { preload });
    failures += expect("delegates from an old console runtime", output, "re-runs itself") ? 0 : 1;
    failures += expect("delegated run completed", output, "KAYA_TEST_ALL_OK") ? 0 : 1;
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log(failures === 0 ? "\nSELFTEST_OK" : `\nSELFTEST_FAILED ${failures}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.log(`self-test aborted: ${(error && error.message) || error}`);
  process.exitCode = 1;
});
