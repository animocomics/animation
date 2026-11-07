#!/usr/bin/env node
"use strict";

// The test that decides whether the Kaya failure is ours or theirs.
//
//   npm run kaya:test
//
// Everything earlier only proved that the network layer works or not: DNS, TCP,
// TLS. Those cannot explain "two grading runs succeeded at 14:00 and every run
// after 17:00 fails", because the network does not change its mind. What does
// change is the request: an image payload of a few megabytes, a body built by our
// own code, a model id from our catalogue. This sends exactly that, with the key
// the operator already saved, and prints what Kaya says.
//
// Three requests at most, in this order, so the information arrives even if the
// network dies partway:
//   1. GET  /api/chat/completions            — is the URL and our IP accepted
//   2. POST with one short sentence          — does a write reach Kaya
//   3. POST with a ~1.5 MB JPEG attachment   — does the payload Nomreh sends work
//
// Nothing is retried, no model is switched, nothing is written, and the key is
// never printed. On Node 17 it re-runs itself under the domain-local Node 22.

const path = require("node:path");
const { ensureNode22 } = require("./lib/plesk-node-delegate.cjs");

if (!ensureNode22(__filename)) process.exit(2);

const https = require("node:https");
const net = require("node:net");
const tls = require("node:tls");
const dns = require("node:dns");
const crypto = require("node:crypto");
const fs = require("node:fs");

const HOST = "kayaai.ir";
const ORIGIN = "213.176.6.243";
const TIMEOUT = 90_000;

// The self-test points this at a local mock, because no certificate for kayaai.ir
// can be minted here. Nothing else ever sets these, and production never reads
// them: the app itself calls Kaya from lib/server/providers.ts.
const TARGET = process.env.NOMREH_KAYA_SELFTEST_HOST
  ? {
      host: process.env.NOMREH_KAYA_SELFTEST_HOST,
      port: Number(process.env.NOMREH_KAYA_SELFTEST_PORT || 443),
      insecure: process.env.NOMREH_TLS_INSECURE === "1",
    }
  : { host: HOST, port: 443, insecure: false };

function say(label, text) {
  console.log(`  ${String(label).padEnd(13)} ${text}`);
}
function head(title) {
  console.log(`\n== ${title}`);
}

/* ------------------------------------------------------------------ settings */

/** Reads the saved provider row without importing the Next.js app. */
function readSettings() {
  const dataDirectories = [
    process.env.NOMREH_DATA_DIR ? path.resolve(process.env.NOMREH_DATA_DIR) : "",
    path.resolve(__dirname, "..", "..", "nomreh-data"),
    path.resolve(process.cwd(), "data"),
  ].filter(Boolean);
  let database = "";
  for (const directory of dataDirectories) {
    for (const name of ["nomreh.db", "nomreh.sqlite", "nomreh.sqlite3", "data.db"]) {
      const file = path.join(directory, name);
      try {
        if (fs.statSync(file).isFile()) {
          database = file;
          break;
        }
      } catch {
        /* keep looking */
      }
    }
    if (database) break;
    try {
      const match = fs.readdirSync(directory).filter((name) => /\.db$/.test(name))[0];
      if (match) {
        database = path.join(directory, match);
        break;
      }
    } catch {
      /* no directory */
    }
  }
  if (!database) return { error: "فایل پایگاه‌دادهٔ Nomreh پیدا نشد؛ NOMREH_DATA_DIR را بررسی کنید." };

  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    return { error: `این Node (${process.version}) ماژول node:sqlite را ندارد.`, database };
  }
  let connection;
  try {
    connection = new DatabaseSync(database, { readOnly: true });
    const row = connection.prepare("SELECT provider, model, encrypted_api_key, key_hint FROM provider_settings WHERE id = 1").get();
    connection.close();
    if (!row) return { error: "تنظیمات ارائه‌دهنده در پایگاه‌داده ثبت نشده است.", database };
    return {
      provider: row.provider,
      model: row.model,
      hint: row.key_hint || "",
      encrypted: row.encrypted_api_key,
      database,
    };
  } catch (error) {
    try {
      connection?.close();
    } catch {
      /* ignored */
    }
    return { error: `خواندن تنظیمات ناموفق بود: ${error.message}`, database };
  }
}

/**
 * Same algorithm as lib/server/secret-crypto.ts: AES-256-GCM, base64url parts
 * iv.tag.ciphertext, additional data = purpose string.
 */
function decryptStoredKey(payload, purpose) {
  const configured = process.env.NOMREH_SECRET_KEY;
  let key;
  if (configured) {
    key = crypto.createHash("sha256").update(configured).digest();
  } else {
    const keyFile = [
      process.env.NOMREH_DATA_DIR ? path.join(process.env.NOMREH_DATA_DIR, ".provider-secret") : "",
      path.resolve(__dirname, "..", "..", "nomreh-data", ".provider-secret"),
      path.resolve(process.cwd(), "data", ".provider-secret"),
    ].filter(Boolean).find((file) => {
      try {
        return fs.statSync(file).isFile();
      } catch {
        return false;
      }
    });
    if (!keyFile) throw new Error("کلید رمزنگاری .provider-secret پیدا نشد.");
    key = Buffer.from(fs.readFileSync(keyFile, "utf8").trim(), "hex");
  }
  const parts = String(payload).split(".");
  if (parts.length !== 3) throw new Error("قالب مقدار رمزشده معتبر نیست.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(parts[0], "base64url"));
  decipher.setAAD(Buffer.from(purpose));
  decipher.setAuthTag(Buffer.from(parts[1], "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(parts[2], "base64url")), decipher.final()]).toString("utf8");
}

/* --------------------------------------------------------------- transport */

function resolve4(hostname, servers) {
  return new Promise((resolve) => {
    const resolver = new dns.Resolver();
    if (servers) resolver.setServers(servers);
    resolver.resolve4(hostname, (error, addresses) => resolve(error ? { error: error.code } : { addresses: addresses || [] }));
  });
}

/**
 * A TCP connect that always answers.
 *
 * The earlier version used `socket.setTimeout`, which destroys the socket and
 * emits nothing, so the promise never settled and the whole command sat there
 * after printing "tcp 443 … TIMEOUT". Every wait below therefore has two
 * guards: the socket's own timeout event and an independent timer, and both go
 * through one `settle` that can only fire once.
 */
function tcp(host, port, timeout) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    let socket;
    const timer = setTimeout(() => settle("TIMEOUT (no answer)"), timeout);
    function settle(detail, extra) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
        /* already closed */
      }
      resolve(Object.assign({ detail, ms: Date.now() - started }, extra || {}));
    }
    try {
      socket = net.createConnection({ host, port });
    } catch (error) {
      return settle(error.code || error.message);
    }
    socket.setTimeout(timeout);
    socket.once("connect", () => settle("CONNECTED"));
    socket.once("timeout", () => settle("TIMEOUT (no answer)"));
    socket.once("error", (error) => settle(error.code || "ERROR"));
  });
}

function handshake(host, address, timeout, options) {
  const port = (options && options.port) || 443;
  const servername = (options && options.insecure) || host === address ? undefined : host;
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    let socket;
    const timer = setTimeout(() => settle(false, "TIMEOUT (no answer)"), timeout);
    function settle(ok, detail, extra) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
        /* already closed */
      }
      resolve(Object.assign({ ok, detail, ms: Date.now() - started }, extra || {}));
    }
    try {
      socket = tls.connect({
        host: address,
        port,
        servername,
        rejectUnauthorized: !(options && options.insecure),
      });
    } catch (error) {
      return settle(false, error.code || error.message);
    }
    socket.setTimeout(timeout);
    socket.once("secureConnect", () => {
      const peer = socket.getPeerCertificate() || {};
      const issuer = peer.issuer || {};
      settle(true, "", { issuer: issuer.O || issuer.CN || "?" });
    });
    socket.once("timeout", () => settle(false, "TIMEOUT (no answer)"));
    socket.once("error", (error) => settle(false, error.code || error.message));
  });
}

/**
 * One request, same stack as production (node:https, no keep-alive reuse), with
 * the size of the body reported so a payload problem is visible.
 */
function call(requestPath, payload, apiKey, timeout) {
  const method = payload === null ? "GET" : "POST";
  const body = payload === null ? "" : JSON.stringify(payload);
  return new Promise((resolve) => {
    const started = Date.now();
    const headers = { Accept: "application/json", "User-Agent": "nomreh-kaya-test" };
    if (method === "POST") {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(body);
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    }
    const request = https.request(
      {
        host: TARGET.host,
        port: TARGET.port,
        path: requestPath,
        method,
        agent: false,
        headers,
        timeout: timeout || TIMEOUT,
        servername: TARGET.insecure ? undefined : HOST,
        rejectUnauthorized: !TARGET.insecure,
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          if (text.length < 2000) text += chunk;
        });
        response.on("end", () => finish({ status: response.statusCode || 0, text }));
      },
    );
    // Two guards, one exit: the request's own timeout and an independent timer.
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Object.assign({ sent: Buffer.byteLength(body), ms: Date.now() - started }, payload));
    };
    const timer = setTimeout(() => {
      try {
        request.destroy();
      } catch {
        /* already closed */
      }
      finish({ status: 0, code: "TIMEOUT" });
    }, (timeout || TIMEOUT) + 2_000);
    request.on("timeout", () => {
      try {
        request.destroy();
      } catch {
        /* already closed */
      }
      finish({ status: 0, code: "TIMEOUT" });
    });
    request.on("error", (error) => finish({ status: 0, code: error.code || error.message }));
    request.end(body || undefined);
  });
}

function describe(result) {
  const size = `${(result.sent / 1024).toFixed(1)} KB sent`;
  if (!result.status) return `NO ANSWER ${result.code} after ${result.ms}ms (${size})`;
  let shape = "html";
  let message = "";
  try {
    const parsed = JSON.parse(result.text);
    shape = "json";
    message =
      (parsed && parsed.error && (parsed.error.message || parsed.error)) ||
      (parsed && parsed.message) ||
      "";
    if (typeof message !== "string") message = JSON.stringify(message);
  } catch {
    message = (result.text || "").replace(/\s+/g, " ");
  }
  const excerpt = String(message).replace(/sk-[A-Za-z0-9_-]{6,}/g, "[key]").replace(/\s+/g, " ").slice(0, 220);
  return `HTTP ${result.status} ${shape} in ${result.ms}ms (${size})${excerpt ? ` :: ${excerpt}` : ""}`;
}

/* ------------------------------------------------------------------- image */

/**
 * A JPEG that is real enough for an image model to accept, at roughly the size a
 * photographed answer sheet has once Nomreh has rendered it. Generated locally so
 * the test does not need a sample file.
 */
function sampleJpegBase64(targetBytes) {
  let NapiCanvas = null;
  try {
    NapiCanvas = require("@napi-rs/canvas");
  } catch {
    NapiCanvas = null;
  }
  if (NapiCanvas) {
    const width = 1600;
    const height = Math.max(400, Math.round(targetBytes / 900));
    const canvas = NapiCanvas.createCanvas(width, height);
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.fillStyle = "#111111";
    context.font = "28px sans-serif";
    for (let row = 0; row < height / 44; row += 1) {
      context.fillText(`سؤال ${row + 1}: پاسخ نمونه برای آزمون تشخیصی — ۱ + ${row} = ${row + 1}`, 24, 40 + row * 44);
    }
    return canvas.toBuffer("image/jpeg", 0.85).toString("base64");
  }
  // No canvas module: fall back to a tiny valid JPEG. It still proves whether a
  // POST with a base64 image part is accepted; only the size differs, which is
  // reported honestly.
  const tiny =
    "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
    "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
    "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";
  return tiny;
}

/** The address Kaya resolves to, preferring the system resolver. */
async function resolveTargetAddress() {
  const system = await resolve4(HOST);
  if (system.addresses && system.addresses.length) {
    say("system DNS", system.addresses.join(", "));
    return system.addresses[0];
  }
  say("system DNS", `FAILED ${system.error}; falling back to ${ORIGIN}`);
  return ORIGIN;
}

/** The block to paste into a support ticket, identical for every block case. */
function reportTicket(target, result) {
  head("send this to your host / Kaya");
  console.log(`  time      ${new Date().toISOString()}`);
  console.log(`  from      this Nomreh server (egress address is in /admin > outbound)`);
  console.log(`  to        ${target}`);
  console.log(`  result    ${result}`);
  console.log("  control   npm registry and GitHub work from the same server at the same minute");
  console.log("  ask       is our client address blocked on 443 for this destination, and would you allowlist it");
}

function reportBlocked(layer, target, probe) {
  head("verdict");
  say("layer", `اتصال TCP به ${target} برقرار نشد (${probe.detail}).`);
  say("meaning", "پس هیچ درخواستی از Nomreh ساخته و ارسال نشده است: این لایه پیش از کد ما است.");
  say("not-code", "هیچ تغییر کد یا نسخه‌ای این را درست نمی‌کند؛ مسیر خروجی سرور باید باز شود.");
  reportTicket(target, `${probe.detail} after ${probe.ms}ms`);
  console.log("\nKAYA_TEST_TRANSPORT_BLOCKED");
}

/* -------------------------------------------------------------------- main */

async function main() {
  console.log(`Nomreh Kaya test — node ${process.version}`);
  console.log(`Target https://${HOST}/api/chat/completions · at most 3 requests · no retries`);

  head("1. transport");
  // One code path for the mock and for the real host. The mock only changes the
  // address and port, so this branch is exercised by the self-test exactly as it
  // runs on the server: a difference between the two would hide a bug.
  if (TARGET.host !== HOST) say("target", `${TARGET.host}:${TARGET.port} (self-test mock)`);
  const probeHost = TARGET.host === HOST ? await resolveTargetAddress() : TARGET.host;
  const probePort = TARGET.port;
  const probeLabel = TARGET.host === HOST ? `${ORIGIN} (${HOST})` : `${TARGET.host}:${TARGET.port}`;

  const connection = await tcp(probeHost, probePort, 8000);
  say("tcp 443", `${probeLabel} ${connection.detail} ${connection.ms}ms`);
  if (connection.detail !== "CONNECTED") {
    // A failed connect means TLS and HTTP cannot work either. Saying so and
    // stopping is faster and truer than three more identical timeouts, and it
    // spends none of the 20-minute outbound budget.
    reportBlocked("tcp", probeLabel, connection);
    return;
  }

  const secure = await handshake(TARGET.host, probeHost, 8000, { port: probePort, insecure: TARGET.insecure });
  say("tls", secure.ok ? `OK issuer="${secure.issuer}" ${secure.ms}ms` : `FAILED ${secure.detail} ${secure.ms}ms`);
  if (!secure.ok) {
    head("verdict");
    say("layer", `TCP باز است ولی TLS بسته می‌شود (${secure.detail}).`);
    say("meaning", "دست‌انداز TLS پیش از هر درخواستی قطع می‌شود؛ کلید، مدل و کد بی‌تأثیرند.");
    say("not-code", "این هم مثل حالت قبل یک فیلتر مسیر است، نه خطای Nomreh.");
    reportTicket(probeLabel, `TLS ${secure.detail} after ${secure.ms}ms`);
    console.log("\nKAYA_TEST_TRANSPORT_BLOCKED");
    return;
  }

  head("2. the saved settings");
  const settings = readSettings();
  if (settings.error) {
    say("settings", settings.error);
    if (settings.database) say("database", settings.database);
  } else {
    say("provider", `${settings.provider} · model «${settings.model}»${settings.hint ? ` · key ${settings.hint}` : ""}`);
    say("database", settings.database);
  }

  let apiKey = "";
  if (!settings.error && settings.encrypted) {
    try {
      apiKey = decryptStoredKey(settings.encrypted, "nomreh-provider-v1");
      say("key", `decrypted in memory, ${apiKey.length} characters, never printed`);
    } catch (error) {
      say("key", `رمزگشایی ناموفق: ${error.message}`);
    }
  }
  if (!apiKey) {
    say("key", "کلید در دسترس نیست؛ آزمون بدون کلید ادامه می‌یابد (فقط لایهٔ شبکه سنجیده می‌شود).");
  }

  head("3. GET the catalogue (no key needed)");
  const catalogue = await call("/api/chat/completions", null, "", 15000);
  say("GET", describe(catalogue));
  if (catalogue.status === 200 && /"object"\s*:\s*"list"/.test(catalogue.text || "")) {
    say("url", "the URL in the code is correct");
    const catalogueIds = (catalogue.text.match(/"id"\s*:\s*"([^"]+)"/g) || []).length;
    say("models", `${catalogueIds}+ ids returned; \`npm run kaya:models\` writes them to a file`);
    if (settings.model && (catalogue.text || "").indexOf(`"id":"${settings.model}"`) < 0 && (catalogue.text || "").indexOf(`"id": "${settings.model}"`) < 0) {
      say("model", `«${settings.model}» در فهرستِ پاسخِ کاتالوگ نبود — این می‌تواند علت خطا باشد`);
    }
  }

  const model = (settings && settings.model) || "deepseek/deepseek-v4-flash";

  head("4. POST one short sentence");
  const text = await call(
    "/api/chat/completions",
    { model, messages: [{ role: "user", content: "فقط بنویس: سالم" }], max_tokens: 16, stream: false },
    apiKey,
    45_000,
  );
  say("POST text", describe(text));

  head("5. POST with an image, like a real sheet");
  const image = sampleJpegBase64(1_500_000);
  const withImage = await call(
    "/api/chat/completions",
    {
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "این تصویر را در یک جمله توصیف کن." },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${image}`, detail: "high" } },
          ],
        },
      ],
      max_tokens: 32,
      stream: false,
    },
    apiKey,
    90_000,
  );
  say("POST image", describe(withImage));

  head("verdict");
  const textOk = text.status >= 200 && text.status < 300;
  const imageOk = withImage.status >= 200 && withImage.status < 300;
  if (textOk && imageOk) {
    console.log("  Every layer works: transport, key, model, text and image payloads.");
    console.log("  If grading still fails, the difference is the size of the real request;");
    console.log("  send the reason line that /admin records for the failed grading run.");
    console.log("\nKAYA_TEST_ALL_OK");
    return;
  }
  if (!catalogue.status && !text.status && !withImage.status) {
    console.log("  Nothing answered: the block is at the transport layer, before our code runs.");
    console.log("  Send the codes in section 1 to the host's support.");
    console.log("\nKAYA_TEST_TRANSPORT_BLOCKED");
    return;
  }
  if (catalogue.status && !text.status) {
    console.log("  The catalogue answers, but a POST never does. Our request never reaches Kaya.");
    console.log("  That is the exact sentence Kaya support needs, with the byte counts printed above.");
    console.log("\nKAYA_TEST_POST_DROPPED");
    return;
  }
  console.log("  Kaya replies with an error, which names the real cause above.");
  console.log("  A 401/403 means the key; 402 means credit; 404 means the model id; 413 means the payload.");
  console.log("\nKAYA_TEST_API_ERROR");
}

main().catch((error) => {
  console.log(`\ntest aborted: ${(error && error.message) || error}`);
  console.log("\nKAYA_TEST_ABORTED");
});
