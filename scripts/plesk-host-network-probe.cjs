#!/usr/bin/env node
"use strict";

// Read-only Plesk host network diagnostic. Node 17 compatible.
// No files/settings are written, no proxy is used, and no credentials are sent.
const dns = require("node:dns").promises;
const fs = require("node:fs");
const tls = require("node:tls");
const net = require("node:net");

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

function tlsProbe(host, address) {
  return new Promise((resolve) => {
    const started = Date.now();
    let tcp = false;
    let secure = false;
    let finished = false;
    let socket;
    let timer;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ host, address, tcp, secure, milliseconds: Date.now() - started, ...result });
    };
    try {
      socket = tls.connect({ host: address, port: 443, servername: host, rejectUnauthorized: true });
    } catch (error) {
      finish({ result: errorCode(error), remote: "NONE" });
      return;
    }
    timer = setTimeout(() => {
      socket.destroy();
      finish({ result: tcp ? "TLS_TIMEOUT_6000MS" : "TCP_TIMEOUT_6000MS", remote: socket.remoteAddress || "NONE" });
    }, 6000);
    socket.once("connect", () => { tcp = true; });
    socket.once("secureConnect", () => {
      tcp = true;
      secure = true;
      finish({ result: "TLS_OK", remote: socket.remoteAddress || "NONE" });
      socket.end();
    });
    socket.on("error", (error) => finish({ result: errorCode(error), remote: socket.remoteAddress || "NONE" }));
  });
}

function tcpProbe(host, address, port, expectSshBanner = false) {
  return new Promise((resolve) => {
    const started = Date.now();
    let socket;
    let timer;
    let connected = false;
    let finished = false;
    let banner = "";
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (socket && !socket.destroyed) socket.destroy();
      resolve({ host, address, port, connected, milliseconds: Date.now() - started, result });
    };
    try {
      socket = net.connect({ host: address, port });
    } catch (error) {
      finish(errorCode(error));
      return;
    }
    timer = setTimeout(() => finish(connected ? "TCP_CONNECTED_NO_SSH_BANNER" : "TCP_TIMEOUT_5000MS"), 5000);
    socket.once("connect", () => {
      connected = true;
      if (!expectSshBanner) finish("TCP_CONNECTED");
    });
    if (expectSshBanner) {
      socket.on("data", (chunk) => {
        banner = (banner + chunk.toString("ascii")).slice(0, 160);
        if (banner.includes("\n") || banner.length >= 60) {
          const match = banner.match(/^SSH-[\x20-\x7e]+/);
          finish(match ? `SSH_BANNER_${clean(match[0]).slice(0, 80)}` : "TCP_CONNECTED_NON_SSH_DATA");
        }
      });
    }
    socket.on("error", (error) => finish(errorCode(error)));
  });
}

function reportEnvironment() {
  const names = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "GIT_PROXY_COMMAND", "GIT_SSL_NO_VERIFY"];
  const present = names.filter((name) => Boolean(process.env[name]));
  console.log(`HOST_NETWORK_PROXY_ENV ${present.length ? present.join(",") + "=SET(values hidden)" : "NONE_DETECTED"}`);
  try {
    const resolv = fs.readFileSync("/etc/resolv.conf", "utf8");
    const nameservers = resolv.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("nameserver ")).map((line) => line.split(/\s+/)[1] || "");
    const classes = nameservers.map((address) => {
      if (SHECAN_DNS.has(address)) return "SHECAN";
      if (address === "127.0.0.1" || address === "::1") return "LOCAL";
      if (/^(10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.)/.test(address)) return "PRIVATE_OR_LOCAL";
      return "OTHER";
    });
    console.log(`HOST_NETWORK_RESOLVER count=${classes.length} classes=${[...new Set(classes)].join(",") || "NONE"} sinkholeIsResolver=${nameservers.includes("91.92.130.200") ? 1 : 0}`);
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
  console.log("HOST_NETWORK_STAGE TLS_BEGIN");
  const jobs = [];
  for (const record of records) {
    if (!record.addresses.length) console.log(`HOST_NETWORK_TLS ${record.host} SKIPPED_NO_BOUNDED_DNS_ADDRESS`);
    for (const address of record.addresses) jobs.push(tlsProbe(record.host, address));
  }
  const results = await Promise.all(jobs);
  for (const result of results) {
    console.log(`HOST_NETWORK_TLS ${result.host} target=${result.address} result=${result.result} tcp=${result.tcp ? 1 : 0} tls=${result.secure ? 1 : 0} remote=${result.remote} ms=${result.milliseconds}`);
  }
  console.log("HOST_NETWORK_STAGE PORT_MATRIX_BEGIN");
  const codeloadAddress = (records.find((record) => record.host === "codeload.github.com")?.addresses || []).find((address) => !address.includes(":"));
  const portJobs = [];
  if (codeloadAddress) {
    portJobs.push(tcpProbe("codeload.github.com", codeloadAddress, 80));
    portJobs.push(tcpProbe("codeload.github.com", codeloadAddress, 443));
  }
  // Public reference address observed outside the host; used only for this probe.
  const sshReference = "20.29.134.19";
  portJobs.push(tcpProbe("ssh.github.com", sshReference, 22, true));
  portJobs.push(tcpProbe("ssh.github.com", sshReference, 443, true));
  const portResults = await Promise.all(portJobs);
  for (const result of portResults) {
    console.log(`HOST_NETWORK_TCP ${result.host} target=${result.address} port=${result.port} result=${result.result} connected=${result.connected ? 1 : 0} ms=${result.milliseconds}`);
  }
  clearTimeout(watchdog);
  finish(0);
})().catch((error) => {
  console.log(`HOST_NETWORK_FATAL ${errorCode(error)}`);
  clearTimeout(watchdog);
  finish(1);
});
