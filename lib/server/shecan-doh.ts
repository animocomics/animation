import https from "node:https";
import { isIPv4 } from "node:net";

const SHECAN_DOH_ENDPOINT = "https://pro.shecan.ir/dns-query";
const MAX_DNS_MESSAGE_BYTES = 65_535;

export interface ShecanDohRecord {
  address: string;
  ttl: number;
}

function encodeQuery(hostname: string): Buffer {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (!normalized || normalized.length > 253 || !/^[a-z0-9.-]+$/.test(normalized)) {
    throw new Error("Shecan DoH received an invalid hostname");
  }
  const labels = normalized.split(".");
  if (labels.some((label) => !label.length || label.length > 63)) throw new Error("Shecan DoH received an invalid hostname");
  const name = Buffer.alloc(normalized.length + 2);
  let offset = 0;
  for (const label of labels) {
    name.writeUInt8(label.length, offset);
    offset += 1;
    name.write(label, offset, "ascii");
    offset += label.length;
  }
  name.writeUInt8(0, offset);
  const header = Buffer.alloc(12);
  // ID zero is valid for a cacheable RFC 8484 GET request. RD is set; no
  // cookies, update-link paths, credentials, or client identifiers are sent.
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);
  const question = Buffer.alloc(4);
  question.writeUInt16BE(1, 0); // A
  question.writeUInt16BE(1, 2); // IN
  return Buffer.concat([header, name, question]);
}

function skipName(packet: Buffer, initialOffset: number): number {
  let offset = initialOffset;
  for (let steps = 0; steps < 128; steps += 1) {
    if (offset >= packet.length) throw new Error("Shecan DoH returned a truncated DNS name");
    const length = packet[offset];
    if ((length & 0xc0) === 0xc0) {
      if (offset + 1 >= packet.length) throw new Error("Shecan DoH returned a truncated DNS pointer");
      return offset + 2;
    }
    if (length > 63) throw new Error("Shecan DoH returned an invalid DNS label");
    offset += 1;
    if (length === 0) return offset;
    offset += length;
  }
  throw new Error("Shecan DoH returned too many DNS labels");
}

export function parseShecanDohMessage(packet: Buffer): ShecanDohRecord[] {
  if (packet.length < 12 || packet.length > MAX_DNS_MESSAGE_BYTES) throw new Error("Shecan DoH returned an invalid DNS message size");
  if (packet.readUInt16BE(0) !== 0 || !(packet.readUInt16BE(2) & 0x8000)) throw new Error("Shecan DoH returned a mismatched DNS response");
  const flags = packet.readUInt16BE(2);
  if (flags & 0x0200) throw new Error("Shecan DoH returned a truncated DNS response");
  if ((flags & 0x000f) !== 0) throw new Error(`Shecan DoH returned DNS status ${flags & 0x000f}`);
  const questions = packet.readUInt16BE(4);
  const answers = packet.readUInt16BE(6);
  if (questions > 16 || answers > 256) throw new Error("Shecan DoH returned an unreasonable DNS response");
  let offset = 12;
  for (let index = 0; index < questions; index += 1) {
    offset = skipName(packet, offset);
    if (offset + 4 > packet.length) throw new Error("Shecan DoH returned a truncated DNS question");
    offset += 4;
  }
  const records: ShecanDohRecord[] = [];
  for (let index = 0; index < answers; index += 1) {
    offset = skipName(packet, offset);
    if (offset + 10 > packet.length) throw new Error("Shecan DoH returned a truncated DNS answer");
    const type = packet.readUInt16BE(offset);
    const recordClass = packet.readUInt16BE(offset + 2);
    const ttl = packet.readUInt32BE(offset + 4);
    const length = packet.readUInt16BE(offset + 8);
    offset += 10;
    if (offset + length > packet.length) throw new Error("Shecan DoH returned truncated DNS data");
    if (type === 1 && recordClass === 1 && length === 4) {
      const address = `${packet[offset]}.${packet[offset + 1]}.${packet[offset + 2]}.${packet[offset + 3]}`;
      if (isIPv4(address)) records.push({ address, ttl });
    }
    offset += length;
  }
  return records;
}

export async function resolveShecanDoh(hostname: string): Promise<ShecanDohRecord[]> {
  const endpoint = new URL(SHECAN_DOH_ENDPOINT);
  endpoint.searchParams.set("dns", encodeQuery(hostname).toString("base64url"));
  return new Promise<ShecanDohRecord[]>((resolve, reject) => {
    const request = https.request(endpoint, {
      method: "GET",
      agent: false,
      servername: endpoint.hostname,
      timeout: 8_000,
      signal: AbortSignal.timeout(10_000),
      headers: { Accept: "application/dns-message", "User-Agent": "Nomreh-Shecan-DoH/1.0" },
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_DNS_MESSAGE_BYTES) {
          response.destroy(new Error("Shecan DoH response exceeded the DNS message limit"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        if (response.statusCode !== 200) {
          reject(Object.assign(new Error("Shecan DoH returned a non-success HTTP status"), { code: "DOH_HTTP_ERROR" }));
          return;
        }
        try { resolve(parseShecanDohMessage(Buffer.concat(chunks))); }
        catch (error) { reject(error); }
      });
    });
    request.on("timeout", () => {
      const error = new Error("Shecan DoH request timed out");
      error.name = "TimeoutError";
      request.destroy(error);
    });
    request.on("error", reject);
    request.end();
  });
}
