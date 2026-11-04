import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import test from "node:test";
import { createVncAuthFixture } from "./vnc-auth-fixture";

const require = createRequire(import.meta.url);
const { attachShecanVncWebSocket, WINDOWS_UPGRADE_PATH } = require("../scripts/shecan-vnc-websocket.cjs");
const { WebSocket, WebSocketServer } = require("ws");

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function closeHttp(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

test("Windows preview WebSocket requires admin/origin and bridges only bounded viewer messages", async () => {
  const oldPort = process.env.NOMREH_SHECAN_WINDOWS_PREVIEW_PORT;
  const restoreAuth = createVncAuthFixture();
  const target = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => target.once("listening", () => resolve()));
  const targetPort = (target.address() as AddressInfo).port;
  process.env.NOMREH_SHECAN_WINDOWS_PREVIEW_PORT = String(targetPort);
  let connections = 0;
  const received: string[] = [];
  target.on("connection", (socket: InstanceType<typeof WebSocket>) => {
    connections += 1;
    socket.on("message", (data: Buffer) => received.push(data.toString("utf8")));
    socket.send(JSON.stringify({ type: "frame", sequence: 1, data: "AAAA" }));
  });
  const application = http.createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  const applicationPort = await listen(application);
  attachShecanVncWebSocket(application, applicationPort);
  const url = `ws://127.0.0.1:${applicationPort}${WINDOWS_UPGRADE_PATH}`;
  const origin = `http://127.0.0.1:${applicationPort}`;
  let valid: InstanceType<typeof WebSocket> | undefined;
  const frames: string[] = [];
  try {
    const open = (headers: Record<string, string>) => new Promise<InstanceType<typeof WebSocket>>((resolve, reject) => {
      const client = new WebSocket(url, { headers });
      client.on("message", (data: Buffer) => frames.push(data.toString("utf8")));
      const timer = setTimeout(() => { client.terminate(); reject(new Error("Windows WebSocket test timeout")); }, 5000);
      client.once("open", () => { clearTimeout(timer); resolve(client); });
      client.once("error", (error: Error) => { clearTimeout(timer); reject(error); });
    });
    await assert.rejects(open({ Origin: origin }), /401/);
    await assert.rejects(open({ Origin: origin, Cookie: "nomreh_session=valid-teacher" }), /403/);
    await assert.rejects(open({ Origin: "https://attacker.invalid", Cookie: "nomreh_session=valid-admin" }), /403/);
    assert.equal(connections, 0, "unauthorized upgrades must never reach the Windows viewer");

    valid = await open({ Origin: origin, Cookie: "nomreh_session=valid-admin" });
    const deadline = Date.now() + 5000;
    while (!frames.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(JSON.parse(frames[0]), { type: "frame", sequence: 1, data: "AAAA" });
    valid.send(JSON.stringify({ type: "insertText", text: "x" }));
    valid.send(Buffer.from([1, 2, 3]));
    valid.send("x".repeat(5000));
    const inputDeadline = Date.now() + 5000;
    while (!received.length && Date.now() < inputDeadline) await new Promise((resolve) => setTimeout(resolve, 20));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(received.map((value) => JSON.parse(value)), [{ type: "insertText", text: "x" }]);
    assert.equal(connections, 1);
  } finally {
    valid?.terminate();
    for (const client of target.clients) client.terminate();
    await new Promise<void>((resolve) => target.close(() => resolve()));
    await closeHttp(application);
    if (oldPort === undefined) delete process.env.NOMREH_SHECAN_WINDOWS_PREVIEW_PORT;
    else process.env.NOMREH_SHECAN_WINDOWS_PREVIEW_PORT = oldPort;
    restoreAuth();
  }
});
