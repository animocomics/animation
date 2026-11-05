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
  : ["kayaai.ir", "api.deepseek.com", "generativelanguage.googleapis.com", "github.com"];

// github.com is the control: it is reachable from almost every network. If the
// control passes and the providers fail, the problem is the destination (filtering
// or an upstream block), not the server's internet connection.
const CONTROL = "github.com";

function verdict(hostname, steps) {
  const byStep = Object.fromEntries(steps.map((s) => [s.name, s]));
  if (!byStep.dns.ok) return "DNS does not resolve — the server's resolver is broken or blocking this name.";
  if (!byStep.tcp.ok) {
    return hostname === CONTROL
      ? "No TCP route out at all: the server cannot reach the internet on 443."
      : "TCP blocked or filtered: the server has no working route to this address (often outbound filtering on an Iranian host).";
  }
  if (!byStep.tls.ok) {
    return "TCP works but the TLS handshake is reset — traffic to this host is being interfered with (typical of filtering) or a proxy/tunnel is intercepting it. No API key can succeed here.";
  }
  if (!byStep.http.ok) return "TLS works but the HTTP request fails — check for a transparent proxy or an upstream outage.";
  return "Reachable; a failing request is then an API-key, quota or request-shape problem, not the network.";
}

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

// Raw-IP port matrix. The per-host probes show what fails; this shows whether any
// outbound path exists, which decides the fix.
const MATRIX = [
  ["1.1.1.1", 443],
  ["1.1.1.1", 80],
  ["8.8.8.8", 53],
  ["213.176.6.243", 443],
  ["213.176.6.243", 80],
  ["140.82.121.6", 443],
];

function plainHttpCheck(url) {
  return new Promise((resolve) => {
    const started = Date.now();
    const request = require("node:http").get(url, { timeout: 6000, headers: { "User-Agent": "nomreh-network-check" } }, (response) => {
      response.resume();
      resolve({ ok: true, detail: `HTTP ${response.statusCode} (${Date.now() - started}ms)` });
    });
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
    const collected = [];
    for (const [step, run] of [
      ["dns ", () => dnsCheck(hostname)],
      ["tcp ", () => tcpCheck(hostname)],
      ["tls ", () => tlsCheck(hostname)],
      ["http", () => httpCheck(hostname, path)],
    ]) {
      const result = await run();
      collected.push({ name: step.trim(), ...result });
      console.log(`  ${step} ${result.ok ? "OK  " : "FAIL"} ${result.detail}`);
      if (!result.ok && !firstFailure) firstFailure = `${hostname} ${step.trim()}: ${result.detail}`;
    }
    console.log(`  ->  ${verdict(hostname, collected)}`);
    process.stdout.write("\n");
  }

  console.log("== raw-IP port matrix (no DNS involved)");
  for (const [host, port] of MATRIX) {
    const result = await tcpCheck(host, port);
    console.log(`  ${host}:${port} ${result.ok ? "OK  " : "FAIL"} ${result.detail}`);
  }
  const probe80 = await plainHttpCheck("http://example.com/");
  console.log(`  http://example.com/ ${probe80.ok ? "OK  " : "FAIL"} ${probe80.detail}`);

  if (firstFailure) {
    console.log(`NOMREH_NETWORK_CHECK_FAILED ${firstFailure}`);
    console.log("");
    console.log("How to read this:");
    console.log("  every port times out, including :80 and a raw IP");
    console.log("    -> the host has no outbound internet. Nothing in the app can fix it;");
    console.log("       the provider/firewall (or the host's outbound ACL) must open egress.");
    console.log("  GitHub passes but the AI hosts time out");
    console.log("    -> egress works and the AI destinations are filtered; use a tunnel for");
    console.log("       AI traffic only, or open those addresses at the host.");
    console.log("  port 80 passes but every 443 times out");
    console.log("    -> outbound 443 is blocked; ask the host to allow it.");
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
