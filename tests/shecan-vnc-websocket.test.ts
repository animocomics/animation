import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { attachShecanVncWebSocket, UPGRADE_PATH } = require("../scripts/shecan-vnc-websocket.cjs");
const WebSocket = require("ws");

function listen(server: http.Server | net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function closeServer(server: http.Server | net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

test("VNC WebSocket requires same-origin admin authorization and only bridges the loopback guest", async () => {
  const oldPort = process.env.NOMREH_VNC_PORT;
  const targetSockets = new Set<net.Socket>();
  const targetFrames: Buffer[] = [];
  const target = net.createServer((socket) => {
    targetSockets.add(socket);
    socket.on("data", (chunk) => targetFrames.push(chunk));
    socket.on("close", () => targetSockets.delete(socket));
    socket.write("RFB 003.008\n");
  });
  const vncPort = await listen(target);
  process.env.NOMREH_VNC_PORT = String(vncPort);
  const application = http.createServer((request, response) => {
    if (request.url !== "/api/admin/shecan-runtime" || request.headers.cookie !== "nomreh_session=valid-admin") {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end("{\"error\":\"unauthorized\"}");
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ runtime: { appReady: true }, network: {} }));
  });
  const applicationPort = await listen(application);
  attachShecanVncWebSocket(application, applicationPort);
  const url = `ws://127.0.0.1:${applicationPort}${UPGRADE_PATH}`;
  const origin = `http://127.0.0.1:${applicationPort}`;
  type TestSocket = { terminate: () => void; send: (data: Buffer) => void };
  let valid: TestSocket | undefined;
  const frames: Buffer[] = [];
  try {
    const open = (headers: Record<string, string>) => new Promise<TestSocket>((resolve, reject) => {
      const client = new WebSocket(url, "binary", { headers });
      client.on("message", (data: Buffer) => frames.push(data));
      const timer = setTimeout(() => { client.terminate(); reject(new Error("WebSocket test timeout")); }, 5000);
      client.once("open", () => { clearTimeout(timer); resolve(client); });
      client.once("error", (error: Error) => { clearTimeout(timer); reject(error); });
    });
    await assert.rejects(open({ Origin: origin }), /401/);
    await assert.rejects(open({ Origin: "https://attacker.invalid", Cookie: "nomreh_session=valid-admin" }), /403/);
    valid = await open({ Origin: origin, Cookie: "nomreh_session=valid-admin" });
    const deadline = Date.now() + 5000;
    while (!frames.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(frames[0]?.toString("ascii"), "RFB 003.008\n");
    valid.send(Buffer.from("RFB 003.008\n", "ascii"));
    const replyDeadline = Date.now() + 5000;
    while (Buffer.concat(targetFrames).length < 12 && Date.now() < replyDeadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(Buffer.concat(targetFrames).subarray(0, 12).toString("ascii"), "RFB 003.008\n");
  } finally {
    if (valid) valid.terminate();
    for (const socket of targetSockets) socket.destroy();
    await closeServer(application);
    await closeServer(target);
    if (oldPort === undefined) delete process.env.NOMREH_VNC_PORT; else process.env.NOMREH_VNC_PORT = oldPort;
  }
});
