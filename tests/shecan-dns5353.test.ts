import test from "node:test";
import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { createServer } from "node:net";
import { resolveShecanDns5353 } from "../lib/server/shecan-dns5353";

function dnsResponse(query: Buffer, address: [number, number, number, number]): Buffer {
  const header = Buffer.alloc(12);
  query.copy(header, 0, 0, 2);
  header.writeUInt16BE(0x8180, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(1, 6);
  const answer = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 180, 0, 4, ...address]);
  return Buffer.concat([header, query.subarray(12), answer]);
}

test("documented Shecan DNS port 5353 accepts a matching UDP answer with a random query ID", async () => {
  const server = createSocket("udp4");
  server.on("message", (query, remote) => {
    const response = dnsResponse(query, [185, 143, 234, 133]);
    server.send(response, remote.port, remote.address);
  });
  await new Promise<void>((resolve) => server.bind(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const records = await resolveShecanDns5353("ddns.shecan.ir", ["127.0.0.1", "127.0.0.1"], { port: address.port, timeoutMs: 200 });
    assert.deepEqual(records, [{ address: "185.143.234.133", ttl: 180 }]);
  } finally {
    server.close();
  }
});

test("documented Shecan DNS port 5353 falls back from UDP to framed TCP", async () => {
  const server = createServer((socket) => {
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < 2) return;
      const size = buffered.readUInt16BE(0);
      if (buffered.length < size + 2) return;
      const response = dnsResponse(buffered.subarray(2, size + 2), [185, 143, 233, 133]);
      const prefix = Buffer.alloc(2);
      prefix.writeUInt16BE(response.length, 0);
      socket.write(Buffer.concat([prefix, response]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const records = await resolveShecanDns5353("ddns.shecan.ir", ["127.0.0.1", "127.0.0.1"], { port: address.port, timeoutMs: 150 });
    assert.deepEqual(records, [{ address: "185.143.233.133", ttl: 180 }]);
  } finally {
    server.close();
  }
});
