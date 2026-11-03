import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import test from "node:test";
import { createVncAuthFixture } from "./vnc-auth-fixture";

const require = createRequire(import.meta.url);
const { handleShecanVncHttp, closeShecanVncHttpSessions, startShecanVncReverseServer, HTTP_CHANNEL_PATH } = require("../scripts/shecan-vnc-http.cjs");

function listen(server: http.Server | net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

test("authenticated HTTP raw channel accepts reverse VNC and bridges both directions", async () => {
  const oldReversePort = process.env.NOMREH_VNC_REVERSE_PORT;
  const restoreAuth = createVncAuthFixture();
  const reservation = net.createServer();
  const reversePort = await listen(reservation);
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  process.env.NOMREH_VNC_REVERSE_PORT = String(reversePort);
  const targetSockets = new Set<net.Socket>();
  const targetFrames: Buffer[] = [];
  let targetStopped = false;
  const connectTarget = () => {
    if (targetStopped) return;
    const socket = net.createConnection({ host: "127.0.0.1", port: reversePort });
    targetSockets.add(socket);
    socket.setNoDelay(true);
    socket.on("connect", () => socket.write("RFB 003.008\n"));
    socket.on("data", (chunk) => {
      targetFrames.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      socket.write(Buffer.from([1, 1]));
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      targetSockets.delete(socket);
      if (!targetStopped) setTimeout(connectTarget, 20);
    });
  };
  startShecanVncReverseServer();
  connectTarget();
  const application = http.createServer((request, response) => {
    if (handleShecanVncHttp(request, response, applicationPort)) return;
    response.writeHead(404);
    response.end();
  });
  const applicationPort = await listen(application);
  const endpoint = `http://127.0.0.1:${applicationPort}${HTTP_CHANNEL_PATH}`;
  const origin = `http://127.0.0.1:${applicationPort}`;
  const headers = { Origin: origin, Cookie: "nomreh_session=valid-admin", "X-Nomreh-VNC-Client": "1" };
  let session = "";
  try {
    const unauthorized = await fetch(endpoint, { method: "POST", headers: { ...headers, Cookie: "" } });
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get("x-nomreh-vnc-error"), "AUTH_401_SESSION_NO_COOKIE");
    const teacher = await fetch(endpoint, { method: "POST", headers: { ...headers, Cookie: "nomreh_session=valid-teacher" } });
    assert.equal(teacher.status, 403);
    assert.equal(teacher.headers.get("x-nomreh-vnc-error"), "AUTH_403_ROLE");
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
    targetStopped = true;
    closeShecanVncHttpSessions();
    for (const socket of targetSockets) socket.destroy();
    application.closeAllConnections();
    await new Promise<void>((resolve) => application.close(() => resolve()));
    if (oldReversePort === undefined) delete process.env.NOMREH_VNC_REVERSE_PORT;
    else process.env.NOMREH_VNC_REVERSE_PORT = oldReversePort;
    restoreAuth();
  }
});
