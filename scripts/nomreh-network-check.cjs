#!/usr/bin/env node
"use strict";

// Standalone egress check for the Nomreh host.
//
// Run it on the server when the admin console says "connection failed" but the
// host appears to have internet. It separates DNS, TCP, TLS and HTTP so the
// failing layer is obvious, and it prints the real error code for each step.
//
// It needs no API key, sends no credentials, changes nothing, and only issues
// GET requests to the hosts below.
//
//   node scripts/nomreh-network-check.cjs
//   node scripts/nomreh-network-check.cjs kayaai.ir

const dns = require("node:dns");
const net = require("node:net");
const tls = require("node:tls");
const https = require("node:https");

const TARGETS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["kayaai.ir", "api.deepseek.com", "generativelanguage.googleapis.com"];

function codeOf(error) {
  if (!error) return "unknown";
  return error.code || (error.cause && error.cause.code) || error.name || "unknown";
}

function dnsCheck(hostname) {
  return new Promise((resolve) => {
    dns.lookup(hostname, { all: true }, (error, addresses) => {
      if (error) return resolve({ ok: false, detail: codeOf(error) });
      if (!addresses || !addresses.length) return resolve({ ok: false, detail: "no address" });
      resolve({ ok: true, detail: addresses.map((a) => `${a.address}/v${a.family}`).join(", ") });
    });
  });
}

function tcpCheck(hostname, port = 443) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.createConnection({ host: hostname, port });
    const finish = (ok, detail) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve({ ok, detail: `${detail} (${Date.now() - started}ms)` });
    };
    socket.setTimeout(8000);
    socket.once("connect", () => finish(true, "connected"));
    socket.once("timeout", () => finish(false, "ETIMEDOUT"));
    socket.once("error", (error) => finish(false, codeOf(error)));
  });
}

function tlsCheck(hostname, port = 443) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = tls.connect({ host: hostname, port, servername: hostname, rejectUnauthorized: false });
    const finish = (ok, detail) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve({ ok, detail: `${detail} (${Date.now() - started}ms)` });
    };
    socket.setTimeout(10000);
    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate() || {};
      const issuer = (cert.issuer && (cert.issuer.O || cert.issuer.CN)) || "unknown";
      const expires = cert.valid_to ? `, valid to ${cert.valid_to}` : "";
      finish(true, `handshake ok, issuer ${issuer}${expires}`);
    });
    socket.once("timeout", () => finish(false, "ETIMEDOUT"));
    socket.once("error", (error) => finish(false, codeOf(error)));
  });
}

function httpCheck(hostname, path = "/") {
  return new Promise((resolve) => {
    const started = Date.now();
    const request = https.get(
      { host: hostname, port: 443, path, headers: { "User-Agent": "nomreh-network-check" }, timeout: 15000 },
      (response) => {
        let bytes = 0;
        response.on("data", (chunk) => { bytes += chunk.length; });
        response.on("end", () =>
          resolve({ ok: response.statusCode < 500, detail: `HTTP ${response.statusCode}, ${bytes} bytes (${Date.now() - started}ms)` }),
        );
      },
    );
    request.on("timeout", () => request.destroy(new Error("ETIMEDOUT")));
    request.on("error", (error) => resolve({ ok: false, detail: `${codeOf(error)} (${Date.now() - started}ms)` }));
  });
}

async function main() {
  console.log(`Nomreh egress check — node ${process.version} on ${process.platform}`);
  console.log("No API key is used and no setting is changed.\n");
  let firstFailure = null;

  for (const target of TARGETS) {
    const hostname = target.replace(/^https?:\/\//, "").split("/")[0];
    const path = target.startsWith("https://kayaai.ir") ? "/api/chat/completions" : "/";
    process.stdout.write(`== ${hostname}\n`);
    for (const [step, run] of [
      ["dns ", () => dnsCheck(hostname)],
      ["tcp ", () => tcpCheck(hostname)],
      ["tls ", () => tlsCheck(hostname)],
      ["http", () => httpCheck(hostname, path)],
    ]) {
      const result = await run();
      console.log(`  ${step} ${result.ok ? "OK  " : "FAIL"} ${result.detail}`);
      if (!result.ok && !firstFailure) firstFailure = `${hostname} ${step.trim()}: ${result.detail}`;
    }
    process.stdout.write("\n");
  }

  if (firstFailure) {
    console.log(`NOMREH_NETWORK_CHECK_FAILED ${firstFailure}`);
    console.log("Interpretation: DNS ok + TCP fails means the server has no route to that address");
    console.log("(often an Iranian host reaching a blocked destination). TCP ok + TLS fails means");
    console.log("something is resetting the handshake. Any failure here means no key can work.");
    process.exitCode = 1;
    return;
  }
  console.log("NOMREH_NETWORK_CHECK_OK all layers reachable");
}

main().catch((error) => {
  console.error(`NOMREH_NETWORK_CHECK_ERROR ${String(error && error.message ? error.message : error).slice(0, 300)}`);
  process.exitCode = 1;
});
