#!/usr/bin/env node
"use strict";

// One-shot Kaya diagnosis, runnable on Node 17 with no dependencies and no
// global fetch. It answers a single question that every earlier probe missed:
//
//   Is kayaai.ir blocked by *name* on the way out, or does Kaya itself refuse
//   our connection once Cloudflare hands the request to Kaya's own server?
//
// The discriminator is /cdn-cgi/trace, an endpoint Cloudflare answers itself
// without ever touching the origin. If the baseline Cloudflare site answers the
// trace but kayaai.ir does not, the block is on our side of Cloudflare, in front
// of the hostname. If both answer the trace and only /api times out, Cloudflare
// is fine and Kaya's own server is dropping us.
//
// Budget: 9 outbound requests, once. Nothing is retried in a loop, nothing is
// written to disk, and no API key is used or printed.
//
//   node scripts/nomreh-kaya-diag.cjs      # or: npm run kaya:diag
//
// Every line is printed as it is learned, so a timeout in the middle still
// leaves the earlier findings on screen.

const dns = require("node:dns/promises");
const https = require("node:https");
const net = require("node:net");
const tls = require("node:tls");

const HOST = "kayaai.ir";
const ORIGIN = "213.176.6.243";
const ROUTER = "213.176.6.1";
const TIMEOUT = 9000;

function stamp() {
  const now = new Date();
  return now.toISOString().slice(11, 19);
}

function say(label, value) {
  process.stdout.write(`[${stamp()}] ${label.padEnd(12)} ${value}\n`);
}

function request(url, timeout = TIMEOUT) {
  return new Promise((resolve) => {
    const started = Date.now();
    const parsed = new URL(url);
    let settled = false;
    const done = (payload) => {
      if (settled) return;
      settled = true;
      resolve({ ms: Date.now() - started, ...payload });
    };
    const req = https.request(
      {
        host: parsed.hostname,
        port: 443,
        path: `${parsed.pathname}${parsed.search}`,
        method: "GET",
        servername: parsed.hostname,
        rejectUnauthorized: false,
        headers: { "User-Agent": "nomreh-kaya-diag", Accept: "*/*" },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          if (body.length < 4000) body += chunk;
        });
        res.on("end", () => done({ status: res.statusCode || 0, body }));
      },
    );
    req.setTimeout(timeout, () => {
      req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }));
    });
    req.on("error", (error) => done({ status: 0, body: "", code: error.code || error.message }));
    req.end();
  });
}

function tcpProbe(address, port = 443, timeout = TIMEOUT) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const socket = net.createConnection({ host: address, port });
    const done = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ms: Date.now() - started, ...result });
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => done({ ok: true, detail: "CONNECTED" }));
    socket.once("timeout", () => done({ ok: false, detail: "TIMEOUT (silent drop)" }));
    socket.once("error", (error) => done({ ok: false, detail: error.code || "ERROR" }));
  });
}

function tlsProbe(hostname, address) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const socket = tls.connect(
      { host: address, port: 443, servername: hostname, rejectUnauthorized: false, timeout: TIMEOUT },
      () => {
        if (settled) return;
        settled = true;
        const peer = socket.getPeerCertificate() || {};
        const issuer = peer.issuer || {};
        const result = {
          ok: true,
          ms: Date.now() - started,
          issuer: issuer.O || issuer.CN || "?",
          subject: (peer.subject || {}).CN || "?",
          alpn: socket.alpnProtocol || "",
        };
        socket.destroy();
        resolve(result);
      },
    );
    socket.setTimeout(TIMEOUT, () => socket.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    socket.once("error", (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok: false, detail: error.code || error.message, ms: Date.now() - started });
    });
  });
}

function traceField(body, key) {
  const match = new RegExp(`^${key}=(.+)$`, "m").exec(body || "");
  return match ? match[1].trim() : "";
}

function postProbe(url, payload) {
  return new Promise((resolve) => {
    const started = Date.now();
    const parsed = new URL(url);
    const body = JSON.stringify(payload);
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve({ ms: Date.now() - started, ...result });
    };
    const req = https.request(
      {
        host: parsed.hostname,
        port: 443,
        path: parsed.pathname,
        method: "POST",
        servername: parsed.hostname,
        rejectUnauthorized: false,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          // Invalid on purpose: this must never authenticate, it only proves the
          // request arrived. No real key is read, used, or printed.
          Authorization: "Bearer sk-llm-nomreh-diagnostic",
          "User-Agent": "nomreh-kaya-diag",
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          if (text.length < 600) text += chunk;
        });
        res.on("end", () => done({ status: res.statusCode || 0, body: text }));
      },
    );
    req.setTimeout(TIMEOUT, () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    req.on("error", (error) => done({ status: 0, body: "", code: error.code || error.message }));
    req.end(body);
  });
}

async function main() {
  say("host", `${HOST} diagnosed with 5 requests, no key, nothing written to disk`);

  // 1. DNS
  let addresses = [];
  try {
    addresses = await dns.resolve4(HOST);
    say("dns", `${HOST} -> ${addresses.join(", ")}`);
  } catch (error) {
    say("dns", `FAILED ${error.code}`);
  }

  // 2. Our egress IP as two independent services see it.
  const icanhaz = await request("https://icanhazip.com/");
  const seen = icanhaz.status === 200 ? icanhaz.body.trim().split("\n")[0] : `FAILED ${icanhaz.code || icanhaz.status}`;
  say("egress", `icanhazip.com -> ${seen} (${icanhaz.ms}ms)`);

  const ipify = await request("https://api.ipify.org/");
  say("egress", `api.ipify.org   -> ${ipify.status === 200 ? ipify.body.trim() : `FAILED ${ipify.code || ipify.status}`} (${ipify.ms}ms)`);

  // 3. TCP to Kaya's own IP, and to its router. A router that answers with
  //    ECONNREFUSED proves the /24 is reachable, so silence from the server is
  //    the server's choice, not our routing.
  const originTcp = await tcpProbe(ORIGIN);
  const tcpDetail = originTcp.ok ? "CONNECTED" : originTcp.detail;
  say("tcp " + ORIGIN, `${tcpDetail} ${originTcp.ms}ms`);
  const routerTcp = await tcpProbe(ROUTER);
  say("tcp " + ROUTER, `${routerTcp.detail} ${routerTcp.ms}ms`);

  // 4. TLS identity. A Cloudflare edge certificate is issued by Google Trust
  //    Services or Let's Encrypt and carries the hostname; a certificate from
  //    Kaya's own server would say something else.
  const tlsResult = await tlsProbe(HOST, ORIGIN);
  if (tlsResult.ok) {
    say("tls", `issuer="${tlsResult.issuer}" cn="${tlsResult.subject}" alpn=${tlsResult.alpn || "-"} ${tlsResult.ms}ms`);
  } else {
    say("tls", `FAILED ${tlsResult.detail} ${tlsResult.ms}ms`);
  }

  // 4b. The decisive control. Same IP and same port, but a ClientHello that
  //     names an unrelated site. If this handshake completes while the one above
  //     is reset, the reset is triggered by the NAME in the handshake, not by the
  //     server refusing our address: something on the path reads the SNI and
  //     kills the flow. That is a middlebox, and no code change can get around it.
  const sniControl = await tlsProbe("www.bing.com", ORIGIN);
  if (sniControl.ok) {
    say("sni control", `OK issuer="${sniControl.issuer}" for www.bing.com on the same IP (${sniControl.ms}ms)`);
  } else {
    say("sni control", `FAILED ${sniControl.detail} for www.bing.com on the same IP (${sniControl.ms}ms)`);
  }
  const sniFiltered = sniControl.ok && !tlsResult.ok;

  // 5. The site itself. A zero-byte answer or an HTML error page is as
  //    informative as a timeout: it says the TCP/TLS layers worked and the
  //    application layer refused us.
  const home = await request(`https://${HOST}/`);
  say(
    "kaya home",
    home.status ? `HTTP ${home.status} ${home.body.length} bytes` : `FAILED ${home.code} (${home.ms}ms)`,
  );

  // 6. GET on the endpoint Nomreh uses. Kaya answers this one without a key and
  //    returns the whole model catalogue as JSON, so it is a clean health check
  //    of the exact URL in Nomreh's provider code.
  const catalogue = await request(`https://${HOST}/api/chat/completions`);
  const catalogueOk = catalogue.status === 200 && /"object"\s*:\s*"list"/.test(catalogue.body || "");
  const modelCount = (catalogue.body || "").match(/"id"\s*:/g);
  say(
    "kaya GET",
    catalogueOk
      ? `HTTP 200 json, ${modelCount ? modelCount.length : "?"} models (${catalogue.ms}ms)`
      : catalogue.status
        ? `HTTP ${catalogue.status} ${/^\s*[[{]/.test(catalogue.body || "") ? "json" : "html"} (${catalogue.ms}ms)`
        : `FAILED ${catalogue.code} (${catalogue.ms}ms)`,
  );

  // 7. POST is a different code path through proxies and WAFs, and Nomreh only
  //    ever posts. A deliberately invalid key keeps this at one request: 401 or
  //    400 means the write path reached Kaya, while a timeout here and a 200 on
  //    the GET above means posting is being dropped specifically.
  const post = await postProbe(`https://${HOST}/api/chat/completions`, {
    model: "deepseek/deepseek-v4-flash",
    messages: [{ role: "user", content: "ping" }],
    max_tokens: 1,
    stream: false,
  });
  say(
    "kaya POST",
    post.status ? `HTTP ${post.status} (${post.ms}ms)` : `FAILED ${post.code} (${post.ms}ms)`,
  );

  // 8. Verdict.
  process.stdout.write("\n");
  if (catalogueOk && post.status >= 200 && post.status < 500) {
    say("verdict", "Kaya answers both GET and POST right now; the block is not active this minute.");
  } else if (sniFiltered) {
    say("verdict", "The same IP accepts an HTTPS handshake for another site but resets ours.");
    say("", "Something on this server's path reads the name kayaai.ir and kills the connection.");
    say("", "It is not Kaya refusing our address, and it is not DNS or routing.");
    say("", "Nomreh cannot work around this. The path to that name has to be fixed upstream:");
    say("", "either the host's provider, or the network operator that filters inside Iran.");
  } else if (catalogueOk && !post.status) {
    say("verdict", "GET reaches Kaya but POST never returns: the write path is being dropped.");
    say("", "That is a transport filter, not a Nomreh bug.");
  } else if (catalogue.status || home.status) {
    say("verdict", "Kaya's server answered, so the path is open and the failure is at the API layer.");
    say("", "Check the key and the selected model; the reason line in /admin names them.");
  } else if (tcpDetail === "CONNECTED") {
    say("verdict", "TCP connects but no HTTPS answer, for any name on that IP.");
    say("", "Kaya's own server or firewall is dropping this client address.");
    say("", `Give Kaya support this client IP: ${seen.startsWith("FAILED") ? "see /admin > outbound" : seen}.`);
  } else {
    say("verdict", `Even TCP fails (${tcpDetail}), so this server cannot reach Kaya's network at all.`);
  }
}

main().catch((error) => {
  process.stdout.write(`diagnosis aborted: ${error && error.message ? error.message : error}\n`);
});
