import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";

// Compares what the host's own resolver says with what independent public
// resolvers say about the same name, then connects to each address directly.
//
// This separates the two causes that look identical from the outside:
//   - a firewall blocking outbound traffic  -> every address times out
//   - a hijacked/redirected resolver        -> the system address times out
//                                              while the public address works
//
// Only reads DNS and opens TCP/TLS connections; changes nothing.

export interface AddressReport {
  hostname: string;
  systemAddresses: string[];
  publicAddresses: Array<{ server: string; addresses: string[]; error?: string }>;
  mismatch: boolean;
  connects: Array<{ address: string; source: string; tcp: string; tls: string; certificateMatches: boolean }>;
}

async function systemResolve(hostname: string): Promise<string[]> {
  try {
    const dns = await import("node:dns/promises");
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    return records.map((record) => record.address);
  } catch {
    return [];
  }
}

async function publicResolve(hostname: string, server: string): Promise<{ server: string; addresses: string[]; error?: string }> {
  try {
    const resolver = new Resolver({ timeout: 4000, tries: 1 });
    resolver.setServers([server]);
    const records = await resolver.resolve4(hostname);
    return { server, addresses: records };
  } catch (error) {
    const value = error as { code?: string };
    return { server, addresses: [], error: value?.code || "query failed" };
  }
}

function tcpConnect(address: string, port = 443, timeout = 5000): Promise<string> {
  return new Promise((resolve) => {
    const net = require("node:net") as typeof import("node:net");
    const socket = net.createConnection({ host: address, port });
    const finish = (value: string) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => finish("connected"));
    socket.once("timeout", () => finish(`ETIMEDOUT ${timeout}ms`));
    socket.once("error", (error: { code?: string }) => finish(error?.code || "error"));
  });
}

function tlsConnect(address: string, hostname: string, timeout = 6000): Promise<{ result: string; matches: boolean }> {
  return new Promise((resolve) => {
    const tls = require("node:tls") as typeof import("node:tls");
    const socket = tls.connect({ host: address, port: 443, servername: hostname, rejectUnauthorized: false });
    const finish = (result: string, matches: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve({ result, matches });
    };
    socket.setTimeout(timeout);
    socket.once("secureConnect", () => {
      const certificate = socket.getPeerCertificate() || {};
      const names = [certificate.subject?.CN, ...(Array.isArray(certificate.subjectaltname) ? [] : String(certificate.subjectaltname || "").split(", "))]
        .filter(Boolean)
        .map((name) => String(name).replace(/^DNS:/, ""));
      const matches = names.some((name) => name === hostname || (name.startsWith("*.") && hostname.endsWith(name.slice(1))));
      finish("handshake ok", matches);
    });
    socket.once("timeout", () => finish(`ETIMEDOUT ${timeout}ms`, false));
    socket.once("error", (error: { code?: string }) => finish(error?.code || "error", false));
  });
}

export async function inspectAddresses(hostname: string): Promise<AddressReport> {
  const [systemAddresses, cloudflare, google] = await Promise.all([
    systemResolve(hostname),
    publicResolve(hostname, "1.1.1.1"),
    publicResolve(hostname, "8.8.8.8"),
  ]);

  const publicSet = new Set([...cloudflare.addresses, ...google.addresses]);
  const mismatch = systemAddresses.length > 0 && publicSet.size > 0 && !systemAddresses.some((address) => publicSet.has(address));

  // Try the system answer first, then one public answer that the system did not
  // give, so a poisoned resolver cannot hide a working route.
  const candidates: Array<{ address: string; source: string }> = [];
  for (const address of systemAddresses.slice(0, 2)) candidates.push({ address, source: "system-dns" });
  for (const address of [...publicSet]) {
    if (!systemAddresses.includes(address) && isIP(address) === 4) {
      candidates.push({ address, source: "public-dns" });
      break;
    }
  }

  const connects = [];
  for (const candidate of candidates) {
    const tcp = await tcpConnect(candidate.address);
    const tls = tcp === "connected" ? await tlsConnect(candidate.address, hostname) : { result: "skipped", matches: false };
    connects.push({ address: candidate.address, source: candidate.source, tcp, tls: tls.result, certificateMatches: tls.matches });
  }

  return {
    hostname,
    systemAddresses,
    publicAddresses: [cloudflare, google],
    mismatch,
    connects,
  };
}

export function addressConclusion(report: AddressReport): string {
  const system = report.connects.find((entry) => entry.source === "system-dns");
  const publicAnswer = report.connects.find((entry) => entry.source === "public-dns");
  if (publicAnswer && publicAnswer.tcp === "connected" && system && system.tcp !== "connected") {
    return `resolver هاست برای ${report.hostname} آدرس اشتباه می‌دهد (${system.address} پاسخ نمی‌دهد ولی ${publicAnswer.address} وصل می‌شود). DNS هاست تغییر کرده و باید به حالت قبل برگردد.`;
  }
  if (!report.connects.some((entry) => entry.tcp === "connected")) {
    return `هیچ آدرسی برای ${report.hostname} پاسخ نمی‌دهد؛ خروجی شبکهٔ سرور بسته است، نه DNS.`;
  }
  if (report.mismatch) {
    return `پاسخ resolver هاست با resolverهای عمومی برای ${report.hostname} یکی نیست؛ احتمال دست‌کاری DNS وجود دارد.`;
  }
  const connected = report.connects.filter((entry) => entry.tcp === "connected");
  if (connected.length && connected.every((entry) => entry.tls !== "handshake ok")) {
    const codes = [...new Set(connected.map((entry) => entry.tls))].join(", ");
    return `آدرس ${report.hostname} درست است و TCP وصل می‌شود، ولی TLS شکسته می‌شود (${codes}). DNS سالم است؛ مانع در لایهٔ TLS/فیلترینگ است، نه در آدرس‌دهی.`;
  }
  return `${report.hostname} کامل قابل دسترسی است (TCP و TLS سالم).`;
}
