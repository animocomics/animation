#!/usr/bin/env node
"use strict";

// Read-only Plesk host network diagnostic. Node 17 compatible.
// No files/settings are written, no proxy is used, and no credentials are sent.
const dns = require("node:dns").promises;
const fs = require("node:fs");
const https = require("node:https");

const TARGETS = ["example.com", "registry.npmjs.org", "github.com", "api.github.com", "codeload.github.com"];
const SHECAN_DNS = new Set(["178.22.122.100", "185.51.200.2", "178.22.122.101", "185.51.200.1"]);
let exiting = false;
function finish(code) {
  if (exiting) return;
  exiting = true;
  process.stdout.write("HOST_NETWORK_COMPLETE\n", () => process.exit(code));
}
const watchdog = setTimeout(() => {
  console.log("HOST_NETWORK_FATAL GLOBAL_TIMEOUT_45000MS");
  finish(1);
}, 45000);

function clean(value) {
  return String(value || "")
    .replace(/(https?:\/\/)[^/\s:@]+(?::[^/\s@]*)?@/gi, "$1[redacted]@")
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function errorCode(error) {
  return clean(error && (error.code || error.message)) || "ERROR";
}

async function dnsAttempt(operation) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ values: [], error: "DNS_TIMEOUT_5000MS" }), 5000);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(operation).then((values) => ({ values, error: "" })).catch((error) => ({ values: [], error: errorCode(error) })),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function readDns(host) {
  const [lookup, ipv4, ipv6] = await Promise.all([
    dnsAttempt(() => dns.lookup(host, { all: true, verbatim: true }).then((items) => items.map((item) => item.address))),
    dnsAttempt(() => dns.resolve4(host)),
    dnsAttempt(() => dns.resolve6(host)),
  ]);
  return {
    host,
    lookup,
    ipv4,
    ipv6,
    addresses: [...new Set([...lookup.values, ...ipv4.values, ...ipv6.values])].slice(0, 4),
  };
}

function httpsProbe(host, address) {
  return new Promise((resolve) => {
    const started = Date.now();
    let tcp = false;
    let tls = false;
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      resolve({ host, address: address || "AUTO", tcp, tls, milliseconds: Date.now() - started, ...result });
    };
    const options = {
      hostname: address || host,
      servername: host,
      port: 443,
      path: "/",
      method: "HEAD",
      headers: { Host: host, "User-Agent": "Nomreh-ReadOnly-Network-Probe/1.0", Connection: "close" },
      rejectUnauthorized: true,
      agent: false,
    };
    if (address) options.family = address.includes(":") ? 6 : 4;
    const request = https.request(options, (response) => {
      tls = true;
      response.resume();
      finish({ result: `HTTP_${response.statusCode}`, remote: response.socket.remoteAddress || "NONE" });
    });
    request.on("socket", (socket) => {
      socket.once("connect", () => { tcp = true; });
      socket.once("secureConnect", () => { tls = true; });
    });
    request.setTimeout(7000, () => {
      const error = new Error("PROBE_TIMEOUT_7000MS");
      error.code = "ETIMEDOUT";
      request.destroy(error);
    });
    request.on("error", (error) => finish({ result: errorCode(error), remote: "NONE" }));
    request.end();
  });
}

function reportEnvironment() {
  const names = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "GIT_PROXY_COMMAND", "GIT_SSL_NO_VERIFY"];
  const present = names.filter((name) => Boolean(process.env[name]));
  console.log(`HOST_NETWORK_PROXY_ENV ${present.length ? present.join(",") + "=SET(values hidden)" : "NONE_DETECTED"}`);
  try {
    const resolv = fs.readFileSync("/etc/resolv.conf", "utf8");
    const classes = resolv.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("nameserver ")).map((line) => {
      const address = line.split(/\s+/)[1] || "";
      if (SHECAN_DNS.has(address)) return "SHECAN";
      if (address === "127.0.0.1" || address === "::1") return "LOCAL";
      return "OTHER";
    });
    console.log(`HOST_NETWORK_RESOLVER count=${classes.length} classes=${[...new Set(classes)].join(",") || "NONE"}`);
  } catch (error) {
    console.log(`HOST_NETWORK_RESOLVER ERROR_${errorCode(error)}`);
  }
  try {
    const routes = fs.readFileSync("/proc/net/route", "utf8").split(/\r?\n/).slice(1).filter((line) => /^\S+\s+00000000\s/.test(line)).map((line) => line.split(/\s+/)[0]);
    console.log(`HOST_NETWORK_IPV4_DEFAULT_ROUTE present=${routes.length > 0} interfaces=${[...new Set(routes)].join(",") || "NONE"}`);
  } catch (error) {
    console.log(`HOST_NETWORK_IPV4_DEFAULT_ROUTE ERROR_${errorCode(error)}`);
  }
}

(async () => {
  console.log("HOST_NETWORK_BEGIN");
  reportEnvironment();
  console.log("HOST_NETWORK_STAGE DNS_BEGIN");
  const records = await Promise.all(TARGETS.map(readDns));
  for (const record of records) {
    console.log(`HOST_NETWORK_DNS ${record.host} lookup=${record.lookup.values.join("/") || "NONE"} lookupError=${record.lookup.error || "NONE"} A=${record.ipv4.values.join("/") || "NONE"} AAAA=${record.ipv6.values.join("/") || "NONE"}`);
  }
  console.log("HOST_NETWORK_STAGE HTTPS_BEGIN");
  const jobs = [];
  for (const record of records) {
    if (!record.addresses.length) console.log(`HOST_NETWORK_HTTPS ${record.host} SKIPPED_NO_BOUNDED_DNS_ADDRESS`);
    for (const address of record.addresses) jobs.push(httpsProbe(record.host, address));
  }
  const results = await Promise.all(jobs);
  for (const result of results) {
    console.log(`HOST_NETWORK_HTTPS ${result.host} target=${result.address} result=${result.result} tcp=${result.tcp ? 1 : 0} tls=${result.tls ? 1 : 0} remote=${result.remote} ms=${result.milliseconds}`);
  }
  clearTimeout(watchdog);
  finish(0);
})().catch((error) => {
  console.log(`HOST_NETWORK_FATAL ${errorCode(error)}`);
  clearTimeout(watchdog);
  finish(1);
});
