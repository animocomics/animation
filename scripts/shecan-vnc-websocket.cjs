"use strict";

const http = require("node:http");
const net = require("node:net");
const { WebSocketServer, WebSocket } = require("ws");

const UPGRADE_PATH = "/api/admin/shecan-runtime/vnc";

function rejectSocket(socket, status, message) {
  if (!socket.destroyed) {
    socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\nCache-Control: no-store\r\n\r\n`);
  }
}

function authorizeUpgrade(request, applicationPort) {
  return new Promise((resolve, reject) => {
    const auth = http.request({
      host: "127.0.0.1",
      port: applicationPort,
      path: "/api/admin/shecan-runtime",
      method: "GET",
      headers: {
        Host: request.headers.host || "localhost",
        Cookie: request.headers.cookie || "",
        Accept: "application/json",
      },
      timeout: 8000,
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 65536) response.destroy();
      });
      response.on("end", () => {
        if (response.statusCode !== 200) {
          const error = new Error("Admin authentication required");
          error.statusCode = response.statusCode === 401 || response.statusCode === 403 ? response.statusCode : 503;
          reject(error);
          return;
        }
        try {
          const value = JSON.parse(body);
          if (!value.runtime?.appReady) {
            const error = new Error("Official runtime is not ready");
            error.statusCode = 503;
            reject(error);
            return;
          }
          resolve();
        } catch {
          const error = new Error("Runtime authorization response was invalid");
          error.statusCode = 503;
          reject(error);
        }
      });
    });
    auth.on("timeout", () => auth.destroy(Object.assign(new Error("Authorization timeout"), { statusCode: 503 })));
    auth.on("error", (error) => {
      if (!error.statusCode) error.statusCode = 503;
      reject(error);
    });
    auth.end();
  });
}

function attachShecanVncWebSocket(server, applicationPort) {
  const wss = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    perMessageDeflate: false,
    maxPayload: 1024 * 1024,
    handleProtocols: (protocols) => protocols.has("binary") ? "binary" : false,
  });

  server.on("upgrade", async (request, socket, head) => {
    let pathname = "";
    try { pathname = new URL(request.url || "/", "http://localhost").pathname; } catch { /* Rejected below. */ }
    if (pathname !== UPGRADE_PATH) {
      rejectSocket(socket, 404, "Not Found");
      return;
    }
    socket.pause();
    try {
      const origin = new URL(request.headers.origin || "");
      if (origin.host !== request.headers.host || !["http:", "https:"].includes(origin.protocol)) {
        rejectSocket(socket, 403, "Forbidden");
        return;
      }
      await authorizeUpgrade(request, applicationPort);
    } catch (error) {
      const status = error.statusCode === 401 || error.statusCode === 403 ? error.statusCode : 503;
      rejectSocket(socket, status, status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Service Unavailable");
      return;
    }

    const vncPort = Number(process.env.NOMREH_VNC_PORT || 15900);
    if (!Number.isInteger(vncPort) || vncPort < 1024 || vncPort > 65535) {
      rejectSocket(socket, 503, "Service Unavailable");
      return;
    }
    const target = net.createConnection({ host: "127.0.0.1", port: vncPort });
    target.setNoDelay(true);
    target.pause();
    const connected = new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("VNC connection timeout")), 8000);
      const finish = (error) => {
        clearTimeout(timer);
        target.off("connect", onConnect);
        target.off("error", onError);
        if (error) reject(error); else resolve();
      };
      const onConnect = () => finish();
      const onError = (error) => finish(error);
      target.once("connect", onConnect);
      target.once("error", onError);
    });
    try {
      await connected;
    } catch {
      target.destroy();
      rejectSocket(socket, 503, "Service Unavailable");
      return;
    }

    wss.handleUpgrade(request, socket, head, (websocket) => {
      target.resume();
      websocket.on("message", (data, isBinary) => {
        if (!isBinary || websocket.readyState !== WebSocket.OPEN) return;
        // Keyboard/pointer frames are small; net.Socket keeps ordered
        // backpressure internally without exposing private ws socket state.
        target.write(data);
      });
      target.on("data", (chunk) => {
        if (websocket.readyState !== WebSocket.OPEN) return;
        if (websocket.bufferedAmount > 4 * 1024 * 1024) target.pause();
        websocket.send(chunk, { binary: true }, () => {
          if (websocket.bufferedAmount <= 1024 * 1024) target.resume();
        });
      });
      const close = () => {
        if (!target.destroyed) target.destroy();
        if (websocket.readyState === WebSocket.OPEN) websocket.close();
      };
      websocket.once("close", close);
      websocket.once("error", close);
      target.once("close", close);
      target.once("error", close);
    });
  });

  const shutdown = () => wss.close();
  server.once("close", shutdown);
  return wss;
}

module.exports = { attachShecanVncWebSocket, UPGRADE_PATH };
