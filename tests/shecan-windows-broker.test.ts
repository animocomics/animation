import { createRequire } from "node:module";
import net from "node:net";
import { once } from "node:events";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const broker = require("../scripts/shecan-vm/windows-ai-broker.mjs") as {
  encodeDnsQuery: (hostname: string, id?: number) => Buffer;
  parseDnsMessage: (packet: Buffer, id: number) => Array<{ address: string; ttl: number }>;
  parseConnectTarget: (line: string) => { hostname: string; port: number } | null;
  parseHttpResponse: (packet: Buffer) => { status: number; body: Buffer };
  createActivator: (options: { resolve: (hostname: string) => Promise<string[]>; request: (options: Record<string, unknown>) => Promise<{ status: number; headers: Record<string, string> }> }) => (url: string, servers: [string, string]) => Promise<string>;
  createConnectServer: (options: Record<string, unknown>) => net.Server & { closeAll: () => void };
  createControlServer: (options: Record<string, unknown>) => net.Server & { closeAll: () => void };
};

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port));
  });
}

async function close(server: net.Server & { closeAll?: () => void }) {
  server.closeAll?.();
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function readUntil(socket: net.Socket, predicate: (data: Buffer) => boolean, timeout = 4000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error("socket read timed out")), timeout);
    const onData = (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      if (predicate(data)) finish(undefined, data);
    };
    const onError = (error: Error) => finish(error);
    function finish(error?: Error, value?: Buffer) {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      if (error) reject(error);
      else resolve(value || data);
    }
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

describe("Windows Shecan AI broker", () => {
  it("encodes and parses bounded DNS A responses", () => {
    const packet = Buffer.from(broker.encodeDnsQuery("example.com", 0x1234));
    packet.writeUInt16BE(0x8000, 2);
    packet.writeUInt16BE(1, 6);
    const answer = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 192, 0, 2, 10]);
    const records = broker.parseDnsMessage(Buffer.concat([packet, answer]), 0x1234);
    assert.deepEqual(records, [{ address: "192.0.2.10", ttl: 60 }]);
    assert.equal(broker.parseConnectTarget("CONNECT api.openai.com:443 HTTP/1.1")?.hostname, "api.openai.com");
    assert.equal(broker.parseConnectTarget("CONNECT api.openai.com:80 HTTP/1.1"), null);
  });

  it("parses chunked HTTP without accepting a truncated body", () => {
    const text = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n";
    const parsed = broker.parseHttpResponse(Buffer.from(text));
    assert.equal(parsed.status, 200);
    assert.equal(parsed.body.toString(), "Wikipedia");
    assert.throws(() => broker.parseHttpResponse(Buffer.from(text.replace("0\r\n\r\n", "999999\r\n"))), /content|chunk|body|truncated/i);
  });

  it("retries activation through the scoped resolver after verified addresses fail", async () => {
    const requested: string[] = [];
    const activate = broker.createActivator({
      resolve: async () => ["192.0.2.20"],
      request: async (options) => {
        const address = String(options.address);
        requested.push(address);
        if (address !== "192.0.2.20") throw Object.assign(new Error("closed"), { code: "ECONNRESET" });
        return { status: 204, headers: {} };
      },
    });
    const result = await activate("https://nddns.shecan.ir/update?reserved=invalid", ["178.22.122.101", "185.51.200.1"]);
    assert.ok(Date.parse(result) > 0);
    assert.deepEqual(requested, ["188.245.62.250", "192.0.2.20"]);
  });

  it("tunnels only an allowlisted CONNECT target and forwards bytes", async () => {
    const target = net.createServer((socket) => {
        let request = Buffer.alloc(0);
        socket.on("data", (chunk: Buffer) => {
          request = Buffer.concat([request, chunk]);
          if (request.includes(Buffer.from("\r\n\r\n"))) {
            socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK");
          }
        });
      });
    const targetPort = await listen(target);
    const proxy = broker.createConnectServer({
      resolve: async () => ["192.0.2.30"],
      allowedHosts: new Set(["provider.test"]),
      connect: () => net.connect({ host: "127.0.0.1", port: targetPort }),
    });
    const proxyPort = await listen(proxy);
    try {
      const forbidden = net.connect({ host: "127.0.0.1", port: proxyPort });
      await once(forbidden, "connect");
      const forbiddenRead = readUntil(forbidden, (data) => data.includes(Buffer.from("403 Forbidden")));
      forbidden.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\n\r\n");
      await forbiddenRead;
      forbidden.destroy();

      const client = net.connect({ host: "127.0.0.1", port: proxyPort });
      await once(client, "connect");
      const established = readUntil(client, (data) => data.includes(Buffer.from("200 Connection Established")));
      client.write("CONNECT provider.test:443 HTTP/1.1\r\nHost: provider.test\r\n\r\n");
      await established;
      const response = readUntil(client, (data) => data.toString().endsWith("OK"));
      client.write("GET / HTTP/1.1\r\nHost: provider.test\r\nConnection: close\r\n\r\n");
      assert.ok((await response).toString().includes("200 OK"));
      client.destroy();
    } finally {
      await close(proxy);
      await close(target);
    }
  });

  it("authenticates the local activation control channel", async () => {
    const token = "a".repeat(64);
    const nonce = "0123456789abcdef";
    const updateUrl = "https://nddns.shecan.ir/update?reserved=invalid";
    let received = "";
    const control = broker.createControlServer({
      token,
      activate: async (url: string) => { received = url; },
    });
    const port = await listen(control);
    try {
      const encode = (value: string) => Buffer.from(value).toString("base64");
      const client = net.connect({ host: "127.0.0.1", port });
      await once(client, "connect");
      const response = readUntil(client, (data) => data.includes(Buffer.from("\n")));
      client.write(`ACTIVATE ${nonce} ${token} ${encode(updateUrl)} ${encode("178.22.122.101")} ${encode("185.51.200.1")}\n`);
      assert.match((await response).toString(), /^OK /);
      assert.equal(received, updateUrl);
      client.destroy();
    } finally { await close(control); }
  });
});
