import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import tls from "node:tls";
import test from "node:test";
import { resolveShecanDot } from "../lib/server/shecan-dot";

interface MockSocket extends EventEmitter {
  setTimeout: (milliseconds: number, callback: () => void) => void;
  destroy: () => void;
  write: (packet: Buffer, callback?: (error?: Error) => void) => void;
}

function responsePacket(id: number): Buffer {
  const header = Buffer.from([0, 0, 0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0]);
  header.writeUInt16BE(id, 0);
  const question = Buffer.from([4, 100, 100, 110, 115, 6, 115, 104, 101, 99, 97, 110, 2, 105, 114, 0, 0, 1, 0, 1]);
  const answer = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 180, 0, 4, 185, 143, 233, 133]);
  const packet = Buffer.concat([header, question, answer]);
  const prefix = Buffer.alloc(2);
  prefix.writeUInt16BE(packet.length, 0);
  return Buffer.concat([prefix, packet]);
}

test("official Shecan DoT pins only transport, preserves TLS identity, frames DNS and falls back to system lookup", async () => {
  const originalConnect = tls.connect;
  const calls: Array<{ options: { host?: string; port?: number; servername?: string; rejectUnauthorized?: boolean; lookup?: (hostname: string, options: { all: boolean }, callback: (error: Error | null, address: unknown, family?: number) => void) => void }; writes: Buffer[] }> = [];
  tls.connect = ((options: (typeof calls)[number]["options"]) => {
    const call = { options, writes: [] as Buffer[] };
    calls.push(call);
    const socket = new EventEmitter() as MockSocket;
    socket.setTimeout = () => undefined;
    socket.destroy = () => undefined;
    socket.write = (packet, callback) => {
      call.writes.push(packet);
      callback?.();
      process.nextTick(() => {
        if (calls.length === 1) {
          socket.emit("error", Object.assign(new Error("mock pinned DoT timeout"), { name: "TimeoutError" }));
          return;
        }
        const response = responsePacket(packet.readUInt16BE(2));
        socket.emit("data", response.subarray(0, 5));
        socket.emit("data", response.subarray(5));
      });
    };
    process.nextTick(() => socket.emit("secureConnect"));
    return socket as unknown as ReturnType<typeof tls.connect>;
  }) as typeof tls.connect;
  try {
    assert.deepEqual(await resolveShecanDot("ddns.shecan.ir"), [{ address: "185.143.233.133", ttl: 180 }]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.host, "pro.shecan.ir");
    assert.equal(calls[0].options.port, 853);
    assert.equal(calls[0].options.servername, "pro.shecan.ir");
    assert.notEqual(calls[0].options.rejectUnauthorized, false);
    assert.equal(calls[1].options.lookup, undefined);
    assert.equal(calls[0].writes[0].readUInt16BE(0), calls[0].writes[0].length - 2);
    const pinned = await new Promise<unknown>((resolve, reject) => {
      calls[0].options.lookup?.("pro.shecan.ir", { all: false }, (error, address) => error ? reject(error) : resolve(address));
    });
    assert.equal(pinned, "185.51.200.1");
  } finally {
    tls.connect = originalConnect;
  }
});

test("Shecan DoT dual timeout has a sanitized stable code", async () => {
  const originalConnect = tls.connect;
  tls.connect = (() => {
    const socket = new EventEmitter() as MockSocket;
    socket.setTimeout = () => undefined;
    socket.destroy = () => undefined;
    socket.write = (_packet, callback) => {
      callback?.();
      process.nextTick(() => socket.emit("error", Object.assign(new Error("mock DoT timeout"), { name: "TimeoutError" })));
    };
    process.nextTick(() => socket.emit("secureConnect"));
    return socket as unknown as ReturnType<typeof tls.connect>;
  }) as typeof tls.connect;
  try {
    await assert.rejects(resolveShecanDot("ddns.shecan.ir"), (error: unknown) => {
      return typeof error === "object" && error !== null && "code" in error && error.code === "DOT_DUAL_TIMEOUT";
    });
  } finally {
    tls.connect = originalConnect;
  }
});
