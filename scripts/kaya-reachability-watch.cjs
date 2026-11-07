#!/usr/bin/env node
"use strict";

// Watches whether kayaai.ir is reachable from this host.
//
// The path to Kaya opens and closes on a schedule nobody here controls, so a human
// cannot sit and retry by hand: each attempt costs a request against the host's
// 200-per-20-minutes egress budget, and the operator was testing repeatedly.
//
// This runs one probe every 10 minutes (at most 144 per day, and at most 2 inside
// any 20-minute window, well under the budget), stores the result, and lets the
// admin panel show a green light the moment the path reopens.
//
//   node scripts/kaya-reachability-watch.cjs            # loop forever
//   node scripts/kaya-reachability-watch.cjs --once     # one probe, print JSON
//
// A probe is: TCP connect to the IP, then an HTTPS GET of the public model
// catalogue. No API key, no credentials, nothing written outside the status file.

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const tls = require("node:tls");

const HOST = "kayaai.ir";
const INTERVAL_MS = 10 * 60 * 1000;
const APP_ROOT = path.resolve(__dirname, "..");
const DATA_DIR = process.env.NOMREH_DATA_DIR
  ? path.resolve(process.env.NOMREH_DATA_DIR)
  : path.resolve(APP_ROOT, "..", "nomreh-data");
const STATUS_FILE = path.join(DATA_DIR, "kaya-status.json");
const STOP_FILE = path.join(DATA_DIR, "kaya-watch-disabled");
const ONCE = process.argv.includes("--once");

function logJson(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function tcpProbe(address, port = 443, timeout = 6000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.createConnection({ host: address, port });
    const finish = (ok, detail) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve({ ok, detail, ms: Date.now() - started });
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => finish(true, "connected"));
    socket.once("timeout", () => finish(false, `ETIMEDOUT ${timeout}ms`));
    socket.once("error", (error) => finish(false, error.code || "error"));
  });
}

function httpsProbe(hostname) {
  return new Promise((resolve) => {
    const started = Date.now();
    const request = require("node:https").get(
      { host: hostname, port: 443, path: "/api/chat/completions", timeout: 9000, headers: { "User-Agent": "nomreh-kaya-watch" } },
      (response) => {
        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.length;
        });
        response.on("end", () =>
          resolve({ ok: response.statusCode < 500, status: response.statusCode, bytes, ms: Date.now() - started }),
        );
      },
    );
    request.on("timeout", () => request.destroy(new Error("ETIMEDOUT")));
    request.on("error", (error) => resolve({ ok: false, status: 0, code: error.code || String(error.message), ms: Date.now() - started }));
  });
}

async function resolveAddresses(hostname) {
  const dns = require("node:dns/promises");
  try {
    return await dns.resolve4(hostname);
  } catch {
    return [];
  }
}

async function probe() {
  const addresses = await resolveAddresses(HOST);
  const tcp = addresses.length ? await tcpProbe(addresses[0]) : { ok: false, detail: "NO_DNS", ms: 0 };
  const http = tcp.ok ? await httpsProbe(HOST) : { ok: false, status: 0, code: "skipped", ms: 0 };
  const at = new Date().toISOString();

  let previous = {};
  try {
    previous = JSON.parse(fs.readFileSync(STATUS_FILE, "utf8"));
  } catch {
    previous = {};
  }

  return {
    at,
    host: HOST,
    address: addresses[0] || "",
    tcp,
    http,
    reachable: Boolean(tcp.ok && http.ok),
    // When it first became unreachable, so the panel can say "blocked for N hours".
    blockedSince: tcp.ok && http.ok ? null : previous.blockedSince || (previous.reachable === false ? previous.blockedSince : at),
    history: [...(Array.isArray(previous.history) ? previous.history : []), { at, reachable: Boolean(tcp.ok && http.ok), detail: tcp.ok ? `HTTP ${http.status}` : tcp.detail }].slice(-48),
  };
}

function write(status) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temporary = `${STATUS_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(status, null, 2));
  fs.renameSync(temporary, STATUS_FILE);
}

async function main() {
  if (ONCE) {
    const status = await probe();
    write(status);
    logJson(status);
    return;
  }

  // A marker file stops the loop without needing the panel.
  if (fs.existsSync(STOP_FILE)) {
    logJson({ stopped: true, reason: "kaya-watch-disabled marker present" });
    return;
  }

  const run = async () => {
    try {
      const status = await probe();
      write(status);
      console.log(`[kaya-watch] ${status.at} reachable=${status.reachable} ${status.tcp.detail}`);
    } catch (error) {
      console.log(`[kaya-watch] probe failed: ${String(error && error.message ? error.message : error).slice(0, 160)}`);
    }
  };

  await run();
  setInterval(run, INTERVAL_MS);
}

main().catch((error) => {
  console.error(`kaya-watch failed: ${String(error && error.message ? error.message : error).slice(0, 200)}`);
  process.exitCode = 1;
});
