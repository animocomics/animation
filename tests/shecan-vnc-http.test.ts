import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { handleShecanVncHttp, closeShecanVncHttpSessions, HTTP_CHANNEL_PATH } = require("../scripts/shecan-vnc-http.cjs");

function listen(server: http.Server | net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

test("authenticated HTTP raw channel bridges both VNC directions without WebSocket upgrade", async () => {
  const oldPort = process.env.NOMREH_VNC_PORT;
  const targetSockets = new Set<net.Socket>();
  const targetFrames: Buffer[] = [];
  const target = net.createServer((socket) => {
    targetSockets.add(socket);
    socket.on("data", (chunk) => {
      targetFrames.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      socket.write(Buffer.from([1, 1]));
    });
    socket.on("close", () => targetSockets.delete(socket));
    socket.write("RFB 003.008\n");
  });
  const vncPort = await listen(target);
  process.env.NOMREH_VNC_PORT = String(vncPort);
  const application = http.createServer((request, response) => {
    if (handleShecanVncHttp(request, response, applicationPort)) return;
    if (request.url !== "/api/admin/shecan-runtime" || request.headers.cookie !== "nomreh_session=valid-admin") {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end("{\"error\":\"unauthorized\"}");
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ runtime: { appReady: true }, network: {} }));
  });
  const applicationPort = await listen(application);
  const endpoint = `http://127.0.0.1:${applicationPort}${HTTP_CHANNEL_PATH}`;
  const origin = `http://127.0.0.1:${applicationPort}`;
  const headers = { Origin: origin, Cookie: "nomreh_session=valid-admin", "X-Nomreh-VNC-Client": "1" };
  let session = "";
  try {
    const unauthorized = await fetch(endpoint, { method: "POST", headers: { ...headers, Cookie: "" } });
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get("x-nomreh-vnc-error"), "AUTH");
    const wrongOrigin = await fetch(endpoint, { method: "POST", headers: { ...headers, Origin: "https://attacker.invalid" } });
    assert.equal(wrongOrigin.status, 403);
    assert.equal(wrongOrigin.headers.get("x-nomreh-vnc-error"), "ORIGIN_HOST");
    const created = await fetch(endpoint, { method: "POST", headers });
    assert.equal(created.status, 200);
    const payload = await created.json() as { session?: string };
    session = payload.session || "";
    assert.match(session, /^[a-f0-9]{32}$/);
    const exchangeHeaders = { ...headers, "X-Nomreh-VNC-Session": session, "Content-Type": "application/octet-stream" };
    const initial = await fetch(endpoint, { method: "POST", headers: exchangeHeaders, body: Buffer.alloc(0) });
    assert.equal(initial.status, 200);
    assert.equal(Buffer.from(await initial.arrayBuffer()).toString("ascii"), "RFB 003.008\n");
    const reply = await fetch(endpoint, { method: "POST", headers: exchangeHeaders, body: Buffer.from("RFB 003.008\n") });
    assert.equal(reply.status, 200);
    assert.deepEqual([...new Uint8Array(await reply.arrayBuffer())], [1, 1]);
    assert.equal(Buffer.concat(targetFrames).subarray(0, 12).toString("ascii"), "RFB 003.008\n");
    const closed = await fetch(endpoint, { method: "DELETE", headers: exchangeHeaders });
    assert.equal(closed.status, 204);
    session = "";
  } finally {
    closeShecanVncHttpSessions();
    for (const socket of targetSockets) socket.destroy();
    application.closeAllConnections();
    await new Promise<void>((resolve) => application.close(() => resolve()));
    await new Promise<void>((resolve) => target.close(() => resolve()));
    if (oldPort === undefined) delete process.env.NOMREH_VNC_PORT; else process.env.NOMREH_VNC_PORT = oldPort;
  }
});
