#!/usr/bin/env node
"use strict";

// One-command network diagnosis for the Nomreh host.
//
// Written in plain CommonJS with no dependencies, so it runs from the panel's
// Node console even when only `npm` scripts are reachable:
//
//   npm run diagnose
//
// It is read-only: no file is written, no setting is changed, no secret is read.
// The same checks are also available in the admin console under "تشخیص شبکه".

const { ensureNode22 } = require("./lib/plesk-node-delegate.cjs");

// A Plesk subscription whose console runs Node 17 is the normal case here, and
// reporting "this needs Node 22" wasted the operator's time with no information.
// Switch to the domain-local Node 22 that `npm run setup:plesk` installs, and keep
// going on the old runtime only when there really is none.
const onSupportedRuntime = ensureNode22(__filename);

const dns = require("node:dns");
const net = require("node:net");
const tls = require("node:tls");
const fs = require("node:fs");
const { execFile } = require("node:child_process");

const TARGETS = [
  { label: "Kaya AI", host: "kayaai.ir", path: "/api/chat/completions" },
  { label: "GapGPT API", host: "api.gapgpt.app", path: "/v1/models" },
  { label: "GitHub", host: "api.github.com", path: "/" },
];
// Iranian destinations behave differently from foreign ones when traffic leaves
// through a foreign NAT: the app's server is in Iran, but its observed egress was
// an OVH US address, and Iranian sites commonly refuse foreign source IPs. Testing
// both classes side by side separates "Kaya blocks us" from "everything Iranian
// blocks us", which need different fixes.
const DESTINATIONS = {
  "ایرانی": ["kayaai.ir", "www.digikala.com", "www.aparat.com", "www.varzesh3.com"],
  "خارجی": ["api.github.com", "generativelanguage.googleapis.com", "api.deepseek.com"],
};
const MATRIX = [
  ["1.1.1.1", 443],
  ["1.1.1.1", 80],
  ["8.8.8.8", 53],
  ["213.176.6.243", 443],
  ["140.82.121.6", 443],
];
const PROXY_PROCESS = /^(v2ray|xray|sing-box|sing_box|dns2socks|psiphon|tun2socks|warp-svc|openvpn|wg-quick|wireguard|hysteria|naive|trojan|shadowsocks|ss-local|ss-redir|clash|mihomo)/i;
const OWN_PATHS = /(nomreh-vm|nomreh-data|next-server|server\.js)/;
const REDIRECT_RULE = /(REDIRECT|TPROXY|DNAT|REJECT|DROP)/;
const SERVICES = ["v2ray", "xray", "sing-box", "shecan", "tun2socks"];

const findings = [];

function line(ok, text) {
  console.log(`  ${ok === null ? "..  " : ok ? "OK  " : "FAIL"} ${text}`);
}
function code(error) {
  return (error && (error.code || (error.cause && error.cause.code))) || "unknown";
}
function run(command, args, timeout = 4000) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      resolve({ ok: !error, stdout: String(stdout || "") });
    });
  });
}

function resolveWith(server, hostname) {
  return new Promise((resolve) => {
    const resolver = new dns.Resolver({ timeout: 4000, tries: 1 });
    resolver.setServers([server]);
    resolver.resolve4(hostname, (error, addresses) => resolve(error ? [] : addresses));
  });
}

function tcp(host, port = 443, timeout = 5000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.createConnection({ host, port });
    const done = (ok, detail) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve({ ok, detail: `${detail} (${Date.now() - started}ms)` });
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => done(true, "connected"));
    socket.once("timeout", () => done(false, "ETIMEDOUT"));
    socket.once("error", (error) => done(false, code(error)));
  });
}

function handshake(host, servername, timeout = 6000) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port: 443, servername, rejectUnauthorized: false });
    const done = (ok, detail) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve({ ok, detail });
    };
    socket.setTimeout(timeout);
    socket.once("secureConnect", () => done(true, "handshake ok"));
    socket.once("timeout", () => done(false, "ETIMEDOUT"));
    socket.once("error", (error) => done(false, code(error)));
  });
}

async function main() {
  const node = process.version;
  const major = Number(String(node).replace("v", "").split(".")[0]);
  console.log(`Nomreh diagnosis — node ${node} on ${process.platform}`);
  console.log(`NODE_MAJOR=${major}`);
  if (major < 22 && !onSupportedRuntime) {
    // No domain-local Node 22 exists yet. The probes below use nothing newer than
    // Node 17, so the only thing lost is process introspection, not connectivity.
    line(null, `اجرای روی Node ${major}؛ نتایج اتصال معتبر است. برای تشخیص کامل یک‌بار npm run setup:plesk را اجرا کنید.`);
  }
  console.log("");

  // 1. resolver
  console.log("== 1. DNS configuration");
  let resolv = "";
  try {
    resolv = fs.readFileSync("/etc/resolv.conf", "utf8");
  } catch {
    resolv = "";
  }
  const nameservers = resolv
    .split("\n")
    .filter((row) => row.trim().startsWith("nameserver"))
    .map((row) => row.trim().split(/\s+/)[1])
    .filter(Boolean);
  line(nameservers.length > 0, `nameservers: ${nameservers.join(", ") || "none"}`);
  const localDns = nameservers.find((server) => /^(127\.|::1$|0\.0\.0\.0$)/.test(server));
  if (localDns) {
    line(false, `nameserver ${localDns} is local: a local DNS proxy was installed and may be dead`);
    findings.push("local-dns");
  }
  try {
    const target = fs.readlinkSync("/etc/resolv.conf");
    line(null, `resolv.conf is a symlink to ${target}`);
  } catch {
    /* not a symlink */
  }

  // 2. proxy processes, listeners, tun devices
  console.log("\n== 2. proxy / VPN artifacts");
  const ps = await run("ps", ["ax", "-o", "pid=,comm=,args="]);
  const proxyProcs = ps.stdout
    .split("\n")
    .map((row) => row.trim())
    .filter((row) => row && !OWN_PATHS.test(row))
    .filter((row) => PROXY_PROCESS.test(row.split(/\s+/)[1] || ""))
    .map((row) => row.slice(0, 120));
  line(proxyProcs.length === 0, proxyProcs.length ? `${proxyProcs.length} proxy process(es) running` : "no VPN/DNS proxy process");
  proxyProcs.slice(0, 6).forEach((row) => console.log(`         ${row}`));
  if (proxyProcs.length) findings.push("proxy-process");

  const ss = await run("ss", ["-lntup"]);
  // Exclude our own runtime: the app deliberately listens on loopback ports for
  // its providers, and counting those as "a proxy is installed" is wrong.
  const listeners = ss.stdout
    .split("\n")
    .filter((row) => /:(53|5353|1080|10808|10809|7300|8400)\b/.test(row))
    .filter((row) => !OWN_PATHS.test(row));
  line(listeners.length === 0, listeners.length ? `${listeners.length} local proxy port(s) listening` : "no local proxy port");
  if (listeners.length) findings.push("proxy-listener");

  const ipLink = await run("ip", ["link", "show"]);
  const tun = ipLink.stdout.split("\n").filter((row) => /^\d+:\s+(tun|tap|wg|utun|nordlynx)/i.test(row.trim()));
  line(tun.length === 0, tun.length ? `tunnel device: ${tun.map((row) => row.trim().split(":")[1]).join(", ")}` : "no TUN device");
  if (tun.length) findings.push("tun-device");

  // 2b. The addresses this machine owns. Only one of these can be bound as an
  // egress source, so printing them ends the "which IP do I give the provider?"
  // question without anyone needing a second command.
  const os = require("node:os");
  const localAddresses = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === "IPv4" && !address.internal) localAddresses.push(`${address.address} (${name})`);
    }
  }
  line(localAddresses.length > 0, `local IPv4 addresses: ${localAddresses.join(", ") || "none"}`);

  // 3. firewall + services
  console.log("\n== 3. firewall and services");
  const iptables = await run("iptables", ["-S"]);
  if (iptables.ok) {
    const rules = iptables.stdout.split("\n").filter((row) => REDIRECT_RULE.test(row));
    line(rules.length === 0, rules.length ? `${rules.length} redirect/drop rule(s)` : "no redirect/drop rules");
    rules.slice(0, 8).forEach((row) => console.log(`         ${row.trim().slice(0, 140)}`));
    if (rules.length) findings.push("firewall");
  } else {
    line(null, "iptables not readable (needs root)");
  }
  for (const service of SERVICES) {
    const result = await run("systemctl", ["is-active", service], 2500);
    const state = (result.stdout || "").trim().split("\n")[0] || "inactive";
    if (state === "active") {
      line(false, `service ${service} is ACTIVE and may be redirecting traffic`);
      findings.push(`service:${service}`);
    }
  }

  // 4. raw-IP egress
  console.log("\n== 4. raw-IP egress (no DNS)");
  let anyOpen = false;
  for (const [host, port] of MATRIX) {
    const result = await tcp(host, port);
    line(result.ok, `${host}:${port} ${result.detail}`);
    anyOpen = anyOpen || result.ok;
  }
  if (!anyOpen) findings.push("no-egress");

  // 5. per-host layers, comparing system and public DNS
  for (const target of TARGETS) {
    console.log(`\n== ${target.label} (${target.host})`);
    const system = await new Promise((resolve) => dns.lookup(target.host, { all: true }, (error, records) => resolve(error ? [] : records.map((r) => r.address))));
    const publicAddresses = [...new Set([...(await resolveWith("1.1.1.1", target.host)), ...(await resolveWith("8.8.8.8", target.host))])];
    line(system.length > 0, `system DNS: ${system.join(", ") || "no answer"}`);
    line(publicAddresses.length > 0, `public DNS: ${publicAddresses.join(", ") || "no answer"}`);

    const candidates = [...system.slice(0, 1).map((address) => ({ address, source: "system" }))];
    const alternative = publicAddresses.find((address) => !system.includes(address));
    if (alternative) candidates.push({ address: alternative, source: "public" });

    let anyTcp = false;
    let anyTls = false;
    for (const candidate of candidates) {
      const result = await tcp(candidate.address);
      line(result.ok, `${candidate.source} ${candidate.address}:443 ${result.detail}`);
      candidate.ok = result.ok;
      anyTcp = anyTcp || result.ok;
      if (result.ok) {
        const secure = await handshake(candidate.address, target.host);
        line(secure.ok, `${candidate.source} ${candidate.address} TLS ${secure.detail}`);
        candidate.tls = secure.ok;
        anyTls = anyTls || secure.ok;
      }
    }

    // A big host legitimately returns a different address to each resolver, so
    // only report a DNS problem when the system answer fails while a public
    // answer for the same name works.
    const publicWorks =
      candidates.some((candidate) => candidate.source === "public" && candidate.ok) ||
      (publicAddresses.length > 0 && system.length === 0);
    const systemFailed = candidates.some((candidate) => candidate.source === "system" && !candidate.ok);
    if (publicWorks && systemFailed) findings.push(`dns-mismatch:${target.host}`);
    if (!anyTcp) findings.push(`tcp-blocked:${target.host}`);
    else if (!anyTls) findings.push(`tls-reset:${target.host}`);
  }

  // 6. Iranian vs foreign destinations
  console.log("\n== 6. دستهٔ مقصد (ایرانی در برابر خارجی)");
  const classes = {};
  for (const [label, hosts] of Object.entries(DESTINATIONS)) {
    let okCount = 0;
    let total = 0;
    for (const host of hosts) {
      const addresses = await new Promise((resolve) => dns.lookup(host, { all: true }, (error, records) => resolve(error ? [] : records.map((r) => r.address))));
      if (!addresses.length) {
        line(false, `${label} ${host}: بدون آدرس`);
        continue;
      }
      total += 1;
      const result = await tcp(addresses[0]);
      if (result.ok) okCount += 1;
      line(result.ok, `${label} ${host} (${addresses[0]}) ${result.detail}`);
    }
    classes[label] = { ok: okCount, total };
  }
  const iranian = classes["ایرانی"] || { ok: 0, total: 0 };
  const foreign = classes["خارجی"] || { ok: 0, total: 0 };
  if (iranian.total && foreign.total && iranian.ok === 0 && foreign.ok === foreign.total) {
    findings.push("foreign-egress-ip");
    console.log("  -> همهٔ مقصدهای ایرانی بسته‌اند و همهٔ مقصدهای خارجی باز: ترافیک شما با یک IP غیرایرانی خارج می‌شود.");
  }

  // verdict
  console.log("\n== verdict");
  const unique = [...new Set(findings)];
  if (unique.filter((f) => !f.startsWith("dns-mismatch:")).length === 0) {
    console.log("  Nothing local is wrong. If a provider still fails, the block is upstream.");
    console.log("  NOMREH_DIAGNOSE_OK");
    return;
  }
  console.log(`  findings: ${unique.join(", ")}`);
  if (unique.includes("local-dns")) {
    console.log("  DNS points at a local resolver that is probably dead. Restore public DNS:");
    console.log("      cp /etc/resolv.conf /root/resolv.conf.bak");
    console.log("      printf 'nameserver 1.1.1.1\\nnameserver 8.8.8.8\\n' > /etc/resolv.conf");
  }
  if (unique.includes("tun-device") || unique.includes("proxy-process") || unique.some((f) => f.startsWith("service:"))) {
    console.log("  A VPN/tunnel is active on this server. Stop it, then test again:");
    unique.filter((f) => f.startsWith("service:")).forEach((f) => console.log(`      systemctl stop ${f.split(":")[1]}`));
    console.log("      ip link show            # a tun*/wg* device must disappear");
  }
  if (unique.includes("firewall")) {
    console.log("  Firewall redirects traffic. Back up, then remove only the VPN rules:");
    console.log("      iptables-save > /root/iptables.bak");
    console.log("      iptables -S | grep -E 'REDIRECT|TPROXY|DNAT'");
  }
  const tlsReset = unique.filter((f) => f.startsWith("tls-reset:"));
  if (tlsReset.length) {
    console.log(`  TCP reaches ${tlsReset.map((f) => f.split(":")[1]).join(", ")} but the TLS handshake is reset.`);
    console.log("  That is traffic interference or an intercepting proxy, not DNS and not an API key.");
    console.log("  Check for a transparent proxy: iptables -t nat -S | grep -i REDIRECT");
  }
  if (unique.includes("foreign-egress-ip")) {
    console.log("  ترافیک خروجی با IP غیرایرانی خارج می‌شود (NAT بالادست)، بنابراین سایت‌های ایرانی");
    console.log("  آن را رد می‌کنند. این تنظیم فقط از طرف سرویس‌دهنده اصلاح می‌شود: باید خروجی با");
    console.log("  IP ایرانی همان سرور (src 185.192.112.x) انجام شود، نه از gateway خارجی.");
  }
  if (unique.includes("no-egress")) {
    console.log("  No outbound connection works at all. Clear the local rules above first;");
    console.log("  if it still fails, the hosting provider must open egress on 443.");
  }
  console.log("  NOMREH_DIAGNOSE_FAILED");
}

main().catch((error) => {
  console.error(`NOMREH_DIAGNOSE_ERROR ${String(error && error.message ? error.message : error).slice(0, 200)}`);
  process.exitCode = 1;
});
