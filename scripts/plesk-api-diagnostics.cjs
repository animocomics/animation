#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const dns = require("node:dns").promises;

const DOMAIN = process.env.NOMREH_DOMAIN || "";
const OUTPUT = process.env.PLESK_DIAGNOSTICS_OUTPUT || path.join(os.tmpdir(), "nomreh-plesk-diagnostics.md");
const MAX_RESPONSE = 1024 * 1024;

function secrets() {
  return [
    process.env.PLESK_API_USERNAME,
    process.env.PLESK_API_PASSWORD,
    process.env.PLESK_API_KEY,
  ].filter(Boolean);
}

function redact(value) {
  let text = String(value ?? "");
  for (const secret of secrets()) {
    if (secret.length > 0) text = text.split(secret).join("[redacted]");
  }
  return text
    .replace(/(Authorization:\s*Basic\s+)[A-Za-z0-9+/=]+/gi, "$1[redacted]")
    .replace(/(X-API-Key:\s*)\S+/gi, "$1[redacted]")
    .replace(/(FTP Password:\s*).*$/gim, "$1[redacted]");
}

function normalizePanelUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("PLESK_PANEL_URL must use HTTPS.");
  if (url.username || url.password) throw new Error("Put credentials in their separate secrets, not in PLESK_PANEL_URL.");
  if (!url.port) throw new Error("PLESK_PANEL_URL must include the Plesk port, usually :8443.");
  return url.origin;
}

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      Accept: "application/json",
      "User-Agent": "Nomreh-Plesk-Diagnostics/1.0",
      ...(options.headers || {}),
    };
    const body = options.rawBody !== undefined
      ? options.rawBody
      : options.body === undefined ? undefined : JSON.stringify(options.body);
    if (body !== undefined && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
    const req = https.request(url, {
      method: options.method || "GET",
      headers,
      timeout: 20000,
      rejectUnauthorized: options.allowInvalidCertificate ? false : true,
    }, (res) => {
      let size = 0;
      const chunks = [];
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE) {
          req.destroy(new Error("The Plesk response exceeded the 1 MiB diagnostic limit."));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json;
        try { json = text ? JSON.parse(text) : undefined; } catch { /* HTML/error responses stay text. */ }
        resolve({ status: res.statusCode || 0, headers: res.headers, json, text });
      });
    });
    req.on("timeout", () => req.destroy(new Error("The request timed out after 20 seconds.")));
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function apiError(result) {
  const message = result.json && (result.json.message || result.json.error || result.json.code);
  return redact(message || result.text.slice(0, 300) || `HTTP ${result.status}`);
}

function authHeaders() {
  if (process.env.PLESK_API_KEY) return { "X-API-Key": process.env.PLESK_API_KEY };
  const basic = Buffer.from(`${process.env.PLESK_API_USERNAME}:${process.env.PLESK_API_PASSWORD}`, "utf8").toString("base64");
  return { Authorization: `Basic ${basic}` };
}

function selectedFields(source, fields) {
  const result = {};
  if (!source || typeof source !== "object") return result;
  for (const field of fields) {
    if (source[field] !== undefined && source[field] !== null && source[field] !== "") result[field] = source[field];
  }
  return result;
}

const CLI_LABELS = [
  "Domain status:",
  "Hosting type:",
  "SSL/TLS support:",
  "Permanent SEO-safe 301 redirect from HTTP to HTTPS:",
  "PHP support:",
  "Disk space limit:",
  "Size:",
  "--WWW-Root--:",
  "WWW-Root:",
];

function selectCliInfo(stdout) {
  return String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => CLI_LABELS.some((label) => line.startsWith(label)))
    .map(redact);
}

function xmlTag(source, tag) {
  const match = String(source || "").match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? redact(match[1].trim()) : "";
}

function xmlRequest(panel, packet, allowInvalidCertificate) {
  return request(`${panel}/enterprise/control/agent.php`, {
    method: "POST",
    allowInvalidCertificate,
    headers: {
      Accept: "text/xml",
      "Content-Type": "text/xml",
      HTTP_AUTH_LOGIN: process.env.PLESK_API_USERNAME || "",
      HTTP_AUTH_PASSWD: process.env.PLESK_API_PASSWORD || "",
      HTTP_PRETTY_PRINT: "TRUE",
    },
    rawBody: packet,
  });
}

function xmlError(result) {
  return redact(xmlTag(result.text, "errtext") || result.json?.message || result.text.slice(0, 300) || `HTTP ${result.status}`);
}

async function xmlFallback(panel, allowInvalidCertificate, lines) {
  lines.push("## XML API fallback", "", "REST API was unavailable, so a read-only XML API check was attempted.", "");
  const serverPacket = '<?xml version="1.0" encoding="UTF-8"?><packet version="1.6.9.0"><server><get><gen_info/></get></server></packet>';
  const server = await xmlRequest(panel, serverPacket, allowInvalidCertificate);
  lines.push(`- Server request HTTP status: ${server.status}`, "");
  if (server.status < 200 || server.status >= 300 || !/<status>\s*ok\s*<\/status>/i.test(server.text)) {
    throw new Error(`XML API server check failed: ${xmlError(server)}`);
  }
  const serverInfo = server.text.match(/<gen_info>([\s\S]*?)<\/gen_info>/i)?.[1] || "";
  const version = xmlTag(serverInfo, "version") || xmlTag(serverInfo, "plesk_version");
  if (version) lines.push(`- Plesk version: ${version}`, "");

  const domainPacket = `<?xml version="1.0" encoding="UTF-8"?><packet version="1.6.9.0"><domain><get><filter><name>${DOMAIN}</name></filter><dataset><hosting/></dataset></get></domain></packet>`;
  const domain = await xmlRequest(panel, domainPacket, allowInvalidCertificate);
  lines.push(`- Nomreh domain request HTTP status: ${domain.status}`, "");
  if (domain.status < 200 || domain.status >= 300 || !/<status>\s*ok\s*<\/status>/i.test(domain.text)) {
    throw new Error(`XML API domain check failed: ${xmlError(domain)}`);
  }
  const domainInfo = domain.text.match(/<gen_info>([\s\S]*?)<\/gen_info>/i)?.[1] || "";
  const name = xmlTag(domainInfo, "name");
  const status = xmlTag(domainInfo, "status");
  if (name && name !== DOMAIN) throw new Error("The XML API returned a different domain; its details were not inspected.");
  if (name) lines.push(`- Domain: ${name}`, "");
  if (status) lines.push(`- Domain status value: ${status}`, "");
  const allowedProperties = new Set(["www_root", "ssl", "ssl_redirect", "php", "fastcgi", "document_root"]);
  const properties = [];
  for (const match of domain.text.matchAll(/<property>\s*<name>([^<]+)<\/name>\s*<value>([\s\S]*?)<\/value>\s*<\/property>/gi)) {
    if (allowedProperties.has(match[1])) properties.push(`- ${match[1]}: ${redact(match[2].trim())}`);
  }
  lines.push(...properties, "");
}

async function main() {
  const panel = normalizePanelUrl(process.env.PLESK_PANEL_URL || "");
  const headers = authHeaders();
  const allowInvalidCertificate = process.env.PLESK_ALLOW_INVALID_CERTIFICATE === "1";
  const lines = ["# Plesk read-only diagnostics", "", "No settings, files, repositories or services were changed.", ""];
  if (allowInvalidCertificate) {
    lines.push("The user explicitly allowed this Plesk API connection to bypass its certificate hostname mismatch. HTTPS remained enabled; no credentials were logged.", "");
  }

  try {
    const addresses = await dns.lookup(DOMAIN, { all: true });
    lines.push("## Public DNS", "", `- ${DOMAIN} resolves to ${addresses.length} address(es): ${addresses.map((item) => item.address).join(", ")}`, "");
  } catch (error) {
    lines.push("## Public DNS", "", `- Lookup failed: ${redact(error.message)}`, "");
  }

  try {
    const publicResponse = await request(`https://${DOMAIN}/`, { headers: { Accept: "text/html" } });
    lines.push("## Public website", "", `- HTTP status: ${publicResponse.status}`, `- Server: ${redact(publicResponse.headers.server || "not reported")}`, "");
  } catch (error) {
    lines.push("## Public website", "", `- Request failed: ${redact(error.message)}`, "");
  }

  const server = await request(`${panel}/api/v2/server`, { headers, allowInvalidCertificate });
  lines.push("## Plesk API authentication", "", `- HTTP status: ${server.status}`, "");
  if (server.status < 200 || server.status >= 300) {
    lines.push(`- REST API was not available: ${apiError(server)}`, "");
    await xmlFallback(panel, allowInvalidCertificate, lines);
    lines.push("## Result", "", "Read-only XML diagnostics completed. No remediation was attempted.", "");
    const output = redact(lines.join("\n"));
    fs.writeFileSync(OUTPUT, output, { mode: 0o600 });
    console.log(output);
    return;
  }
  lines.push("## Plesk server", "", "```json", JSON.stringify(selectedFields(server.json, ["version", "revision", "os", "os_version", "status"]), null, 2), "```", "");

  const domainUrl = new URL(`${panel}/api/v2/domains`);
  domainUrl.searchParams.set("name", DOMAIN);
  const domains = await request(domainUrl, { headers, allowInvalidCertificate });
  if (domains.status < 200 || domains.status >= 300) throw new Error(`Plesk domain query failed (HTTP ${domains.status}): ${apiError(domains)}`);
  const matches = Array.isArray(domains.json)
    ? domains.json.filter((item) => item && (item.name === DOMAIN || item.ascii_name === DOMAIN))
    : [];
  lines.push("## Nomreh domain", "", `- Exact matches returned: ${matches.length}`, "");
  if (matches.length === 0) throw new Error("The Nomreh domain was not returned by the Plesk API. No other domains were inspected.");
  const domain = matches[0];
  lines.push("```json", JSON.stringify(selectedFields(domain, ["id", "name", "hosting_type", "www_root", "base_domain_id", "status", "ip_addresses"]), null, 2), "```", "");

  const domainInfo = await request(`${panel}/api/v2/cli/domain/call`, {
    method: "POST",
    headers,
    allowInvalidCertificate,
    body: { params: ["--info", DOMAIN] },
  });
  lines.push("## Read-only domain information", "", `- HTTP status: ${domainInfo.status}`, "");
  if (domainInfo.status >= 200 && domainInfo.status < 300 && domainInfo.json) {
    if (domainInfo.json.code !== 0 && domainInfo.json.code !== "0") {
      lines.push(`- Plesk CLI code: ${redact(domainInfo.json.code)}`, `- Message: ${redact(domainInfo.json.stderr || domainInfo.json.stdout || "not reported")}`, "");
    } else {
      const selected = selectCliInfo(domainInfo.json.stdout);
      lines.push(...(selected.length ? selected : ["- The command succeeded but no supported summary fields were returned."]), "");
    }
  } else {
    lines.push(`- Domain information was not available: ${apiError(domainInfo)}`, "");
  }

  lines.push("## Result", "", "Read-only diagnostics completed. No remediation was attempted.", "");
  const output = redact(lines.join("\n"));
  fs.writeFileSync(OUTPUT, output, { mode: 0o600 });
  console.log(output);
}

if (require.main === module) {
  main().catch((error) => {
    const output = redact(`# Plesk read-only diagnostics\n\nDiagnostics stopped: ${error.message}\n\nNo settings, files, repositories or services were changed.\n`);
    fs.writeFileSync(OUTPUT, output, { mode: 0o600 });
    console.error(output);
    process.exitCode = 1;
  });
}

module.exports = { normalizePanelUrl, redact, selectCliInfo, selectedFields };
