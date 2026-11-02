import { createSocket } from "node:dgram";
import { createConnection, isIPv4 } from "node:net";
import { randomBytes } from "node:crypto";
import { encodeShecanDnsQuery, parseShecanDohMessage, type ShecanDohRecord } from "./shecan-doh";

const DEFAULT_PORT = 5353;
const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_TCP_MESSAGE_BYTES = 65_535;

interface Dns5353Options {
  port?: number;
  timeoutMs?: number;
}

function timeoutError(): Error {
  const error = new Error("Shecan DNS port 5353 timed out");
  error.name = "TimeoutError";
  return error;
}

async function queryUdp(hostname: string, server: string, port: number, timeoutMs: number): Promise<ShecanDohRecord[]> {
  const id = randomBytes(2).readUInt16BE(0);
  const query = encodeShecanDnsQuery(hostname, id);
  return new Promise((resolve, reject) => {
    const socket = createSocket("udp4");
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (error?: Error, records?: ShecanDohRecord[]) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { socket.close(); } catch { /* Already closed. */ }
      if (error) reject(error);
      else resolve(records || []);
    };
    socket.on("error", (error) => finish(error));
    socket.on("message", (packet, remote) => {
      if (settled || remote.address !== server || remote.port !== port) return;
      try { finish(undefined, parseShecanDohMessage(packet, id)); }
      catch (error) { finish(error instanceof Error ? error : new Error("Shecan DNS 5353 returned an invalid response")); }
    });
    timer = setTimeout(() => finish(timeoutError()), timeoutMs);
    socket.send(query, port, server, (error) => { if (error) finish(error); });
  });
}

async function queryTcp(hostname: string, server: string, port: number, timeoutMs: number): Promise<ShecanDohRecord[]> {
  const id = randomBytes(2).readUInt16BE(0);
  const query = encodeShecanDnsQuery(hostname, id);
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: server, port, family: 4 });
    let settled = false;
    let buffered = Buffer.alloc(0);
    let expectedSize: number | undefined;
    const finish = (error?: Error, records?: ShecanDohRecord[]) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(records || []);
    };
    socket.setTimeout(timeoutMs, () => finish(timeoutError()));
    socket.on("error", (error) => finish(error));
    socket.on("connect", () => {
      const prefix = Buffer.alloc(2);
      prefix.writeUInt16BE(query.length, 0);
      socket.write(Buffer.concat([prefix, query]));
    });
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > MAX_TCP_MESSAGE_BYTES + 2) {
        finish(Object.assign(new Error("Shecan DNS 5353 returned an oversized TCP response"), { code: "DNS_5353_TOO_LARGE" }));
        return;
      }
      if (expectedSize === undefined && buffered.length >= 2) expectedSize = buffered.readUInt16BE(0);
      if (expectedSize === undefined || buffered.length < expectedSize + 2) return;
      try { finish(undefined, parseShecanDohMessage(buffered.subarray(2, expectedSize + 2), id)); }
      catch (error) { finish(error instanceof Error ? error : new Error("Shecan DNS 5353 returned an invalid TCP response")); }
    });
    socket.on("end", () => {
      if (!settled) finish(Object.assign(new Error("Shecan DNS 5353 closed before a complete response"), { code: "DNS_5353_NO_RESPONSE" }));
    });
  });
}

/** Resolve only through Shecan's documented DNS-cache workaround, never the host resolver. */
export async function resolveShecanDns5353(
  hostname: string,
  servers: [string, string],
  options: Dns5353Options = {},
): Promise<ShecanDohRecord[]> {
  const port = options.port ?? DEFAULT_PORT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Shecan DNS 5353 received an invalid port");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 50 || timeoutMs > 10_000) throw new Error("Shecan DNS 5353 received an invalid timeout");
  let lastError: unknown;
  for (const server of [...new Set(servers)].filter(isIPv4)) {
    for (const query of [queryUdp, queryTcp]) {
      try {
        const records = await query(hostname, server, port, timeoutMs);
        if (records.length) return records;
      } catch (error) {
        lastError = error;
      }
    }
  }
  if (lastError) {
    const timedOut = lastError instanceof Error && lastError.name === "TimeoutError";
    throw Object.assign(new Error("Shecan DNS port 5353 did not return usable addresses"), {
      code: timedOut ? "DNS_5353_TIMEOUT" : "DNS_5353_FAILED",
      cause: lastError,
    });
  }
  throw Object.assign(new Error("Shecan DNS port 5353 returned no IPv4 addresses"), { code: "DNS_5353_EMPTY" });
}
