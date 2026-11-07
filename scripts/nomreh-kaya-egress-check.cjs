#!/usr/bin/env node
"use strict";

// "Which address can I give Kaya?" — answered from the machine itself.
//
//   npm run kaya:egress            # list the addresses this server owns
//   npm run kaya:egress -- --test  # plus: ask Kaya which of them it accepts
//
// Why this exists: the panel field "آدرس خروجی برای کایا" only accepts an address
// this server actually owns. A public IP that the hosting provider owns but has
// not put on this machine cannot be bound to, so typing it only produces
// EADDRNOTAVAIL. Rather than have the operator guess, this lists what is really
// here, says which one is already used by default, and — with --test — tries each
// one against Kaya without spending a single request on a model.
//
// Node 17 console runtime: everything below is safe there. When `--test` is used
// the script will not iterate more than four addresses, and each probe is one TCP
// connect plus one TLS handshake, not an API call.

const net = require("node:net");
const tls = require("node:tls");
const os = require("node:os");
const dns = require("node:dns");

const KAYA_HOST = "kayaai.ir";
const KAYA_ADDRESS = "213.176.6.243";
const TEST = process.argv.includes("--test");

function say(label, text) {
  console.log(`  ${String(label).padEnd(16)} ${text}`);
}

function localAddresses() {
  const found = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family !== "IPv4" || address.internal) continue;
      found.push({ name, address: address.address, netmask: address.netmask });
    }
  }
  return found;
}

function probeTcp(localAddress, host, port, timeout) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    let socket;
    const timer = setTimeout(() => settle("TIMEOUT"), timeout);
    function settle(detail) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
        /* closed */
      }
      resolve({ detail, ms: Date.now() - started });
    }
    try {
      socket = net.connect({ host, port, localAddress });
    } catch (error) {
      return settle(error.code || error.message);
    }
    socket.setTimeout(timeout);
    socket.once("connect", () => settle("CONNECTED"));
    socket.once("timeout", () => settle("TIMEOUT"));
    socket.once("error", (error) => settle(error.code || "ERROR"));
  });
}

function probeTls(localAddress, host, address, timeout) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    let socket;
    const timer = setTimeout(() => settle(false, "TIMEOUT"), timeout);
    function settle(ok, detail) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
        /* closed */
      }
      resolve({ ok, detail, ms: Date.now() - started });
    }
    try {
      socket = tls.connect({ host: address, port: 443, servername: host, localAddress });
    } catch (error) {
      return settle(false, error.code || error.message);
    }
    socket.setTimeout(timeout);
    socket.once("secureConnect", () => settle(true, "TLS OK"));
    socket.once("timeout", () => settle(false, "TIMEOUT"));
    socket.once("error", (error) => settle(false, error.code || "ERROR"));
  });
}

function resolveKaya() {
  return new Promise((resolve) => {
    dns.lookup(KAYA_HOST, { family: 4 }, (error, address) => resolve(error ? KAYA_ADDRESS : address));
  });
}

async function main() {
  console.log(`Nomreh egress addresses — node ${process.version}`);
  const addresses = localAddresses();

  console.log("\n== 1. addresses this server owns");
  if (!addresses.length) {
    say("result", "این سرور هیچ آدرس غیرلوکالی ندارد؛ با هاستینگ تماس بگیرید.");
    return;
  }
  for (const entry of addresses) say(entry.name, `${entry.address}  netmask ${entry.netmask}`);
  console.log("\n  هر آدرسی در این فهرست را می‌توانید در «آدرس خروجی برای کایا» بگذارید.");
  console.log("  هر آدرسی که اینجا نیست، حتی اگر مال شما باشد، روی این ماشین نیست و bind نمی‌شود.");

  console.log("\n== 2. the default route already in use");
  const defaultProbe = await probeTcp(undefined, "registry.npmjs.org", 443, 6000);
  say("default egress", defaultProbe.detail === "CONNECTED" ? "works for other sites (so the machine is online)" : `FAILED ${defaultProbe.detail}`);

  if (!TEST) {
    console.log("\n  برای اینکه ببینیم کایا کدام آدرس را قبول می‌کند:");
    console.log("    npm run kaya:egress -- --test");
    console.log("  (فقط اتصال TCP و TLS سنجیده می‌شود؛ هیچ کلید یا درخواست مدلی فرستاده نمی‌شود)");
    return;
  }

  const kayaAddress = await resolveKaya();
  console.log(`\n== 3. which of them Kaya accepts (${KAYA_HOST} = ${kayaAddress}:443)`);
  const candidates = [null].concat(addresses.map((entry) => entry.address)).slice(0, 5);
  let winner = "";
  for (const candidate of candidates) {
    const label = candidate || "kernel default";
    const tcp = await probeTcp(candidate, kayaAddress, 443, 6000);
    if (tcp.detail !== "CONNECTED") {
      say(label, `tcp ${tcp.detail} (${tcp.ms}ms)`);
      continue;
    }
    const secure = await probeTls(candidate, KAYA_HOST, kayaAddress, 6000);
    say(label, secure.ok ? `tcp open, TLS OK (${secure.ms}ms) ← کایا این آدرس را می‌پذیرد` : `tcp open, TLS ${secure.detail} (${secure.ms}ms)`);
    if (secure.ok && !winner) winner = candidate || "";
  }

  console.log("\n== verdict");
  if (winner) {
    console.log(`  آدرسی که کایا قبول کرد: ${winner}`);
    console.log(`  همین را در پنل، بخش «آدرس خروجی برای کایا»، بگذارید و ذخیره کنید.`);
    console.log("\nEGRESS_OK");
  } else {
    console.log("  هیچ‌کدام از آدرس‌های این سرور برای کایا باز نشد.");
    console.log("  یعنی مشکل فقط انتخاب آدرس نیست: خود مسیر یا خود کایا بسته است.");
    console.log("  خروجی بالا را برای هاستینگ بفرستید و بخواهید آدرس ایرانی را روی کارت شبکه بگذارند.");
    console.log("\nEGRESS_BLOCKED");
  }
}

main().catch((error) => {
  console.log(`\nlisting aborted: ${(error && error.message) || error}`);
  console.log("\nEGRESS_ABORTED");
});
