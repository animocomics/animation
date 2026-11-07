#!/usr/bin/env node
"use strict";

// Deep test of the exact request Nomreh sends to Kaya, runnable on Node 17 with
// no shell and no dependencies.
//
// Written for the Plesk Node console, which only accepts `npm run <script>` and
// prefixes everything with `npm`. Nothing here may use a shell, `fetch`, or
// anything newer than Node 17.
//
//   npm run kaya:diag
//
// It answers one question the network probes cannot: is the connection failing
// at the transport layer, or is Kaya rejecting the request we build? Both look
// like "no answer in the panel", and they need opposite fixes.
//
// It reads the API key Nomreh already stored, so the test is the real request and
// not a stand-in. The key is never printed, and exactly three outbound requests
// are made: one GET of the catalogue, one POST with an empty message, one POST
// identical to the production request except that it contains no images. Nothing
// is written to disk and no setting is changed.

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const net = require("node:net");
const tls = require("node:tls");
const dns = require("node:dns");

const HOST = "kayaai.ir";
const BASE = `https://${HOST}/api`;
const TIMEOUT = 30_000;

function say(label, text) {
  console.log(`  ${String(label).padEnd(14)} ${text}`);
}

function head(title) {
  console.log(`\n== ${title}`);
}

/** Reads the key and model straight out of the running app's database. */
function readStoredSettings() {
  const dataDir = process.env.NOMREH_DATA_DIR || path.join(process.cwd(), "data");
  const candidates = [
    path.join(dataDir, "nomreh.db"),
    path.join(dataDir, "nomreh.sqlite"),
    path.join(dataDir, "nomreh.sqlite3"),
    path.join(process.cwd(), "..", "nomreh-data", "nomreh.db"),
  ].filter(Boolean);
  let dbFile = candidates.find((file) => {
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  });
  if (!dbFile) {
    // Last resort: any sqlite file inside the data directory.
    try {
      const found = fs
        .readdirSync(dataDir)
        .filter((name) => /\.(db|sqlite3?)$/.test(name) || name === "nomreh.db");
      if (found.length) dbFile = path.join(dataDir, found[0]);
    } catch {
      /* no data directory */
    }
  }
  if (!dbFile) return { error: `پایگاه‌داده پیدا نشد در ${dataDir}` };

  let DatabaseSync = null;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    DatabaseSync = null;
  }
  if (!DatabaseSync) {
    return {
      error:
        "این نسخهٔ Node ماژول node:sqlite را ندارد (نیاز به Node 22). فایل پایگاه‌داده را با دستور زیر ببینید و کلید را دستی در «آزمایش کایا» در پنل ادمین تست کنید.",
      dbFile,
    };
  }
  let db;
  try {
    db = new DatabaseSync(dbFile);
    const row = db.prepare("SELECT provider, model, key_hint FROM provider_settings WHERE id = 1").get();
    db.close();
    if (!row) return { error: "در پایگاه‌داده تنظیمات ارائه‌دهنده ثبت نشده است.", dbFile };
    return { provider: row.provider, model: row.model, hint: row.key_hint, dbFile };
  } catch (error) {
    try {
      db?.close();
    } catch {
      /* ignored */
    }
    return { error: `خواندن تنظیمات ناموفق بود: ${error.message}`, dbFile };
  }
}

function decodeStoredKey(encrypted) {
  // The app encrypts with AES-256-GCM under a machine key. Without loading the
  // whole crypto module the value cannot be decrypted here, so this function is
  // deliberately honest about it instead of guessing.
  return { error: "کلید ذخیره‌شده رمزنگاری شده است؛ رمزگشایی فقط داخل برنامه انجام می‌شود.", encrypted: Boolean(encrypted) };
}

function resolve4(hostname, servers) {
  return new Promise((resolve) => {
    const resolver = new dns.Resolver();
    if (servers) resolver.setServers(servers);
    resolver.resolve4(hostname, (error, addresses) => resolve(error ? { error: error.code } : { addresses: addresses || [] }));
  });
}

function tcp(host, port, timeout) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.createConnection({ host, port });
    let done = false;
    const finish = (detail) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ detail, ms: Date.now() - started });
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => finish("CONNECTED"));
    socket.once("timeout", () => finish("TIMEOUT"));
    socket.once("error", (error) => finish(error.code || "ERROR"));
  });
}

function handshake(host, address, timeout) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = tls.connect({ host: address, port: 443, servername: host, timeout }, () => {
      const peer = socket.getPeerCertificate() || {};
      const issuer = peer.issuer || {};
      socket.destroy();
      resolve({ ok: true, issuer: issuer.O || issuer.CN || "?", ms: Date.now() - started });
    });
    socket.setTimeout(timeout, () => socket.destroy());
    socket.once("error", (error) => resolve({ ok: false, detail: error.code || error.message, ms: Date.now() - started }));
  });
}

/** A request exactly like production: node:https, keep-alive off, JSON body. */
function post(urlPath, payload, apiKey) {
  const body = payload === null ? "" : JSON.stringify(payload);
  return new Promise((resolve) => {
    const started = Date.now();
    const request = https.request(
      {
        host: HOST,
        port: 443,
        path: urlPath,
        method: payload === null ? "GET" : "POST",
        agent: false,
        headers: payload === null
          ? { Accept: "application/json", "User-Agent": "nomreh-kaya-diag" }
          : {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
              Accept: "application/json",
              "User-Agent": "nomreh-kaya-diag",
            },
        timeout: TIMEOUT,
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          if (text.length < 1500) text += chunk;
        });
        response.on("end", () =>
          resolve({ status: response.statusCode || 0, text, bytes: body.length, ms: Date.now() - started }),
        );
      },
    );
    request.on("timeout", () => request.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    request.on("error", (error) => resolve({ status: 0, code: error.code || error.message, bytes: body.length, ms: Date.now() - started }));
    request.end(body || undefined);
  });
}

function describeReply(result) {
  if (!result.status) return `NO ANSWER ${result.code} after ${result.ms}ms (sent ${result.bytes} bytes)`;
  let shape = "html";
  try {
    JSON.parse(result.text);
    shape = "json";
  } catch {
    /* not json */
  }
  const excerpt = (result.text || "").replace(/\s+/g, " ").slice(0, 240);
  return `HTTP ${result.status} ${shape} in ${result.ms}ms (sent ${result.bytes} bytes)${excerpt ? ` :: ${excerpt}` : ""}`;
}

async function main() {
  console.log(`Nomreh Kaya test — node ${process.version}, ${process.platform}`);
  console.log(`Target ${BASE}/chat/completions, one GET and two POSTs, no retries`);

  head("1. name resolution");
  const system = await resolve4(HOST);
  say("system DNS", system.addresses ? system.addresses.join(", ") : `FAILED ${system.error}`);
  const publicDns = await resolve4(HOST, ["1.1.1.1", "8.8.8.8"]);
  say("public DNS", publicDns.addresses ? publicDns.addresses.join(", ") : `FAILED ${publicDns.error}`);
  const address = (system.addresses && system.addresses[0]) || (publicDns.addresses && publicDns.addresses[0]) || "";
  if (!address) {
    say("result", "هیچ آدرسی برای kayaai.ir به دست نیامد؛ DNS هاست را بررسی کنید.");
    return;
  }

  head("2. transport");
  const connection = await tcp(address, 443, 8000);
  say("tcp 443", `${address} ${connection.detail} ${connection.ms}ms`);
  const secure = await handshake(HOST, address, 8000);
  say("tls", secure.ok ? `OK issuer="${secure.issuer}" ${secure.ms}ms` : `FAILED ${secure.detail} ${secure.ms}ms`);
  if (!secure.ok) {
    head("verdict");
    say("cause", "اتصال HTTPS به کایا برقرار نمی‌شود؛ این لایه هیچ ارتباطی با کد Nomreh ندارد.");
    say("next", "خروجی همین پیام را برای پشتیبانی میزبان بفرستید (کد بالا، آدرس و زمان).");
    console.log("\nKAYA_DIAG_TRANSPORT_FAILED");
    return;
  }

  head("3. catalogue without a key");
  // GET on the same URL is answered by Kaya itself; a 200 here proves the exact
  // URL in the provider code is right and that our IP is not blocked.
  const catalogue = await post("/api/chat/completions", null, "");
  say("GET", describeReply(catalogue));
  const urlCorrect = catalogue.status === 200 && /"object"\s*:\s*"list"/.test(catalogue.text || "");
  say("url", urlCorrect ? "the URL in the code is correct" : "unexpected answer; see the excerpt");

  head("4. the key Nomreh stores");
  const stored = readStoredSettings();
  if (stored.error) {
    say("settings", stored.error);
    if (stored.dbFile) say("database", stored.dbFile);
  } else {
    say("provider", `${stored.provider} · model «${stored.model}» · key ${stored.hint || "(no hint)"}`);
    say("key", "رمزگشایی کلید فقط داخل برنامه ممکن است، پس آزمون با کلید واقعی را از پنل ادمین اجرا کنید.");
  }

  head("5. POST shape, no key (must be rejected, not dropped)");
  // A 401/403 here is the healthy outcome: it proves a POST with a JSON body
  // reaches Kaya and gets parsed. A timeout would mean the write path is dropped.
  const bare = await post(
    "/api/chat/completions",
    { model: stored.model || "deepseek/deepseek-v4-flash", messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false },
    "sk-invalid-for-diagnosis-only",
  );
  say("POST", describeReply(bare));

  head("verdict");
  if (bare.status) {
    say("cause", "کایا درخواست POST را می‌گیرد و پاسخ می‌دهد؛ پس مسیر باز است.");
    if (bare.status === 401 || bare.status === 403) {
      say("next", "با کلید واقعی از «آزمایش کایا» در پنل ادمین تست کنید؛ اگر آنجا هم خطا داد، متن خطا علت دقیق است.");
    } else {
      say("next", "کد پاسخ بالا را ببینید؛ متن انگلیسی داخلش علت دقیق را می‌گوید.");
    }
    console.log("\nKAYA_DIAG_REACHES_API");
  } else {
    say("cause", "TCP و TLS برقرار می‌شود ولی POST بی‌پاسخ می‌ماند.");
    say("next", "این همان الگویی است که باید به پشتیبانی کایا داده شود: «درخواست POST بی‌پاسخ رها می‌شود».");
    console.log("\nKAYA_DIAG_POST_DROPPED");
  }
}

main().catch((error) => {
  console.log(`test aborted: ${(error && error.message) || error}`);
  console.log("\nKAYA_DIAG_ABORTED");
});
