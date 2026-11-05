import tls from "node:tls";
import { randomBytes } from "node:crypto";
import type { LookupOptions } from "node:dns";
import type { TcpSocketConnectOpts } from "node:net";
import { encodeShecanDnsQuery, parseShecanDohMessage, type ShecanDohRecord } from "./shecan-doh";

const SHECAN_DOT_HOSTNAME = "pro.shecan.ir";
const SHECAN_DOT_IPV4 = "185.51.200.1";
const SHECAN_DOT_PORT = 853;
const MAX_DNS_MESSAGE_BYTES = 65_535;

const officialDotLookup: NonNullable<TcpSocketConnectOpts["lookup"]> = (_hostname, options: LookupOptions, callback) => {
  if (options.all) callback(null, [{ address: SHECAN_DOT_IPV4, family: 4 }]);
  else callback(null, SHECAN_DOT_IPV4, 4);
};

function timeoutError(): Error {
  const error = new Error("Shecan DoT request timed out");
  error.name = "TimeoutError";
  return error;
}

async function requestShecanDot(hostname: string, pinnedOfficialAddress: boolean): Promise<ShecanDohRecord[]> {
  const id = randomBytes(2).readUInt16BE(0);
  const query = encodeShecanDnsQuery(hostname, id);
  return new Promise<ShecanDohRecord[]>((resolve, reject) => {
    const socket = tls.connect({
      host: SHECAN_DOT_HOSTNAME,
      port: SHECAN_DOT_PORT,
      servername: SHECAN_DOT_HOSTNAME,
      lookup: pinnedOfficialAddress ? officialDotLookup : undefined,
    });
    let settled = false;
    let buffered = Buffer.alloc(0);
    let expectedSize: number | undefined;
    let timer: NodeJS.Timeout | undefined;
    const finish = (error?: Error, records?: ShecanDohRecord[]) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(records || []);
    };
    socket.setTimeout(8_000, () => finish(timeoutError()));
    timer = setTimeout(() => finish(timeoutError()), 10_000);
    socket.on("secureConnect", () => {
      const prefix = Buffer.alloc(2);
      prefix.writeUInt16BE(query.length, 0);
      socket.write(Buffer.concat([prefix, query]), (error) => { if (error) finish(error); });
    });
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > MAX_DNS_MESSAGE_BYTES + 2) {
        finish(Object.assign(new Error("Shecan DoT returned an oversized DNS response"), { code: "DOT_TOO_LARGE" }));
        return;
      }
      if (expectedSize === undefined && buffered.length >= 2) expectedSize = buffered.readUInt16BE(0);
      if (expectedSize === undefined || buffered.length < expectedSize + 2) return;
      try { finish(undefined, parseShecanDohMessage(buffered.subarray(2, expectedSize + 2), id)); }
      catch (error) { finish(error instanceof Error ? error : new Error("Shecan DoT returned an invalid DNS response")); }
    });
    socket.on("error", (error) => finish(error));
    socket.on("end", () => {
      if (!settled) finish(Object.assign(new Error("Shecan DoT closed before a complete response"), { code: "DOT_NO_RESPONSE" }));
    });
  });
}

/** Official Pro DNS-over-TLS, scoped to one query with certificate validation. */
export async function resolveShecanDot(hostname: string): Promise<ShecanDohRecord[]> {
  try {
    // Pin only the transport address; TLS still validates pro.shecan.ir.
    return await requestShecanDot(hostname, true);
  } catch (pinnedError) {
    try { return await requestShecanDot(hostname, false); }
    catch (systemError) {
      const timedOut = [pinnedError, systemError].every((error) => error instanceof Error && error.name === "TimeoutError");
      throw Object.assign(new Error("Shecan DoT failed through both pinned and system resolution"), {
        code: timedOut ? "DOT_DUAL_TIMEOUT" : "DOT_DUAL_FAILED",
        cause: systemError,
      });
    }
  }
}
