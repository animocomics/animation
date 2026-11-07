#!/usr/bin/env node
"use strict";

// Does this host actually reach each service? One command, plain CommonJS, no
// dependencies — so it runs on Plesk's Node 17 console as well as on Node 22.
//
//   npm run reach
//   npm run reach -- --gapgpt     # only the GapGPT checks
//   npm run reach -- --json       # machine-readable, for pasting into a ticket
//
// Why this exists next to `npm run diagnose`: that one answers "is anything on
// this machine in the way" (resolvers, proxy processes, TUN devices, routing).
// This one answers the plainer question the operator actually asks: for each
// service, does the request leave this host and come back?
//
// It reports the layer that failed, because they need different fixes:
//   DNS      -> the name does not resolve here
//   TCP      -> nothing accepted the connection; the route or the destination is closed
//   TLS      -> it connected but the handshake was cut; something is intercepting or filtering
//   HTTP     -> we got an answer; the status code is the service's opinion, not the network's
//
// An HTTP 401/403/404 means the service ANSWERED. That is a success for this check:
// it means the host reached it, and only a credential or a URL was refused. This is
// the distinction that cost days when a blocked route and a bad API key looked
// identical.
//
// Budget: this sends one request per target, once, and never loops. It is well
// inside the host's 200-per-20-minutes allowance. Do not put it on a timer.

const https = require("node:https");
const dns = require("node:dns");
const net = require("node:net");
const tls = require("node:tls");

const TIMEOUT_MS = 10000;

// `path` is chosen to be something a GET can legitimately hit. For the AI services
// the catalogue endpoint is used without a key on purpose: a 401 there is proof of
// reachability and spends no tokens.
const TARGETS = [
  { group: "ai", label: "Kaya AI", host: "kayaai.ir", path: "/api/models", note: "سرویس فعلی" },
  { group: "ai", label: "GapGPT API", host: "api.gapgpt.app", path: "/v1/models", note: "درگاه چندمدلی" },
  { group: "ai", label: "GapGPT (سایت)", host: "gapgpt.app", path: "/", note: "فقط وب‌سایت؛ باز بودنش درگاه را ثابت نمی‌کند" },
  { group: "ir", label: "دیجی‌کالا", host: "www.digikala.com", path: "/", note: "مرجع مقصد ایرانی" },
  { group: "ir", label: "آپارات", host: "www.aparat.com", path: "/", note: "مرجع مقصد ایرانی" },
  { group: "foreign", label: "GitHub API", host: "api.github.com", path: "/", note: "مرجع مقصد خارجی" },
  { group: "foreign", label: "OpenAI", host: "api.openai.com", path: "/v1/models", note: "مرجع مقصد خارجی" },
];

function lookup(host) {
  return new Promise((resolve) => {
    dns.lookup(host, { all: true }, (error, records) => {
      if (error) resolve({ ok: false, detail: error.code || "ENOTFOUND", addresses: [] });
      else resolve({ ok: true, detail: records.map((record) => record.address).join(", "), addresses: records.map((record) => record.address) });
    });
  });
}

function tcpConnect(host, port = 443) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.createConnection({ host, port });
    const finish = (ok, detail) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve({ ok, detail: `${detail} (${Date.now() - started}ms)` });
    };
    socket.setTimeout(TIMEOUT_MS);
    socket.once("connect", () => finish(true, "connected"));
    socket.once("timeout", () => finish(false, "ETIMEDOUT"));
    socket.once("error", (error) => finish(false, error.code || "ECONNERROR"));
  });
}

function tlsHandshake(host) {
  return new Promise((resolve) => {
    const started = Date.now();
    // rejectUnauthorized:false on purpose — this measures whether the handshake can
    // complete at all, not whether the certificate is valid. The real app still
    // verifies certificates normally; saying "untrusted certificate" here would
    // hide the more useful fact that something reset the connection.
    const socket = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false });
    const finish = (ok, detail) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve({ ok, detail: `${detail} (${Date.now() - started}ms)` });
    };
    socket.setTimeout(TIMEOUT_MS);
    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate() || {};
      const issuer = cert.issuer && (cert.issuer.O || cert.issuer.CN) ? String(cert.issuer.O || cert.issuer.CN) : "unknown";
      finish(true, `handshake ok, issuer ${issuer}`);
    });
    socket.once("timeout", () => finish(false, "ETIMEDOUT"));
    socket.once("error", (error) => finish(false, error.code || "ECONNERROR"));
  });
}

function httpGet(host, path) {
  return new Promise((resolve) => {
    const started = Date.now();
    const request = https.request(
      { host, port: 443, path, method: "GET", headers: { "user-agent": "nomreh-reachability/1", accept: "*/*" } },
      (response) => {
        // Drain so the socket closes and the process can exit.
        response.resume();
        response.once("end", () =>
          resolve({ ok: true, status: response.statusCode, detail: `HTTP ${response.statusCode} (${Date.now() - started}ms)` }),
        );
      },
    );
    request.setTimeout(TIMEOUT_MS, () => request.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    request.once("error", (error) => resolve({ ok: false, status: 0, detail: error.code || error.message }));
    request.end();
  });
}

/** Did the service answer, whatever it answered? */
function answered(status) {
  return status > 0;
}

const CERT_ERRORS = /CERT|UNABLE_TO_VERIFY|SELF_SIGNED|ERR_TLS_CERT|DEPTH_ZERO/;

function verdictFor(result) {
  if (!result.dns.ok) return { ok: false, layer: "DNS", text: "نام روی این سرور حل نمی‌شود" };
  if (!result.tcp.ok) return { ok: false, layer: "TCP", text: "اتصال برقرار نشد؛ مسیر یا مقصد بسته است" };
  if (!result.tls.ok) return { ok: false, layer: "TLS", text: "وصل شد ولی دست‌دادن TLS قطع شد؛ چیزی در مسیر فیلتر می‌کند" };
  if (!answered(result.http.status)) {
    // A certificate that does not verify is not a network failure: the service
    // answered and something in the path is presenting a certificate this host does
    // not trust. Reporting it as "no answer" would send the operator hunting for a
    // network problem that is not there.
    if (CERT_ERRORS.test(String(result.http.detail || ""))) {
      return { ok: false, layer: "CERT", text: "پاسخ آمد ولی گواهی TLS تأیید نشد؛ ممکن است مسیر دستکاری شود" };
    }
    return { ok: false, layer: "HTTP", text: "TLS برقرار شد ولی هیچ پاسخی برنگشت" };
  }
  return { ok: true, layer: "HTTP", text: "سرویس جواب داد" };
}

async function probe(target) {
  const result = { target, dns: { ok: false }, tcp: { ok: false }, tls: { ok: false }, http: { ok: false, status: 0 } };
  result.dns = await lookup(target.host);
  if (!result.dns.ok) return { ...result, verdict: verdictFor(result) };
  // Probe the first address we were given: a host with several A records can be
  // reachable on one and blocked on another, and that difference is worth seeing.
  const address = result.dns.addresses[0];
  result.tcp = await tcpConnect(address);
  if (!result.tcp.ok) return { ...result, verdict: verdictFor(result) };
  result.tls = await tlsHandshake(target.host);
  if (!result.tls.ok) return { ...result, verdict: verdictFor(result) };
  result.http = await httpGet(target.host, target.path);
  return { ...result, verdict: verdictFor(result) };
}

function line(ok, text) {
  console.log(`  ${ok ? "OK  " : "FAIL"} ${text}`);
}

async function main() {
  const args = process.argv.slice(2);
  const only = args.includes("--gapgpt") ? "ai-gapgpt" : args.includes("--kaya") ? "ai-kaya" : "";
  const asJson = args.includes("--json");

  const selected = TARGETS.filter((target) => {
    if (only === "ai-gapgpt") return target.host.includes("gapgpt");
    if (only === "ai-kaya") return target.host.includes("kaya");
    return true;
  });

  if (!asJson) {
    console.log(`Nomreh reachability — node ${process.version} on ${process.platform}`);
    console.log("یک درخواست برای هر مقصد، یک‌بار. روی تایمر نگذارید (سقف کل سرور ۲۰۰ در ۲۰ دقیقه است).");
    console.log("");
  }

  const results = [];
  for (const target of selected) {
    const result = await probe(target);
    results.push(result);
    if (asJson) continue;

    const name = `${target.label} — ${target.host}`;
    console.log(`== ${name}${target.note ? `  (${target.note})` : ""}`);
    line(result.dns.ok, `DNS: ${result.dns.detail}`);
    if (result.dns.ok) {
      line(result.tcp.ok, `TCP 443: ${result.tcp.detail}`);
      if (result.tcp.ok) {
        line(result.tls.ok, `TLS: ${result.tls.detail}`);
        if (result.tls.ok) {
          // A 401/403 here is a pass: the service replied and only refused the
          // credential, which is exactly what an unauthenticated GET should get.
          const status = result.http.status;
          const note = status === 401 || status === 403 ? " (پاسخ داد؛ فقط کلید نفرستادیم — این یعنی مسیر باز است)" : "";
          line(answered(status), `HTTP GET ${target.path}: ${result.http.detail}${note}`);
        }
      }
    }
    console.log("");
  }

  if (asJson) {
    console.log(JSON.stringify(
      results.map((result) => ({
        host: result.target.host,
        label: result.target.label,
        dns: result.dns.ok,
        tcp: result.tcp.ok,
        tls: result.tls.ok,
        http: result.http.status,
        verdict: result.verdict,
      })),
      null,
      2,
    ));
    return;
  }

  console.log("== خلاصه");
  for (const result of results) {
    const mark = result.verdict.ok ? "OK  " : "FAIL";
    console.log(`  ${mark} ${result.target.label.padEnd(16)} ${result.verdict.layer}: ${result.verdict.text}`);
  }

  const gapgpt = results.find((result) => result.target.host === "api.gapgpt.app");
  console.log("");
  if (gapgpt) {
    if (gapgpt.verdict.ok) {
      console.log("GapGPT: درگاه از این سرور جواب می‌دهد. کلید را در پنل مدیر ذخیره کنید و «تست اتصال» را بزنید.");
    } else {
      console.log("GapGPT: درگاه از این سرور جواب نداد. اگر gapgpt.app باز بود ولی api.gapgpt.app نه،");
      console.log("یعنی فقط دامنهٔ سایت باز است و درگاه بسته — همان الگویی که کایا داشت.");
    }
  }
  const anyFail = results.some((result) => !result.verdict.ok);
  console.log("");
  console.log(anyFail ? "NOMREH_REACH_HAS_FAILURES" : "NOMREH_REACH_OK");
}

main().catch((error) => {
  console.error(`NOMREH_REACH_ERROR ${String(error && error.message ? error.message : error).slice(0, 300)}`);
  process.exitCode = 1;
});
