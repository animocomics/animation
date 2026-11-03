"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const net = require("node:net");
const { DatabaseSync } = require("node:sqlite");
const { WebSocketServer, WebSocket } = require("ws");

const UPGRADE_PATH = "/api/admin/shecan-runtime/vnc";

function rejectSocket(socket, status, message) {
  if (!socket.destroyed) {
    socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\nCache-Control: no-store\r\n\r\n`);
  }
}

function authError(statusCode, vncCode, message = "Admin authentication required") {
  return Object.assign(new Error(message), { statusCode, vncCode });
}

function sessionToken(request) {
  for (const part of String(request.headers.cookie || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1 || part.slice(0, separator).trim() !== "nomreh_session") continue;
    const token = part.slice(separator + 1).trim();
    return /^[A-Za-z0-9_-]{1,256}$/.test(token) ? token : "";
  }
  return "";
}

/**
 * Authorize against the same SQLite sessions used by requireAdmin(). A custom
 * Node server cannot import the Next route's TypeScript auth helper, and a
 * loopback HTTP request loses the original session context on this Plesk
 * proxy. Read-only verification avoids that extra hop without weakening the
 * role, active-account, expiry, origin, or per-session cookie checks.
 */
async function authorizeUpgrade(request) {
  const token = sessionToken(request);
  if (!token) throw authError(401, `AUTH_401_SESSION${request.headers.cookie ? "" : "_NO_COOKIE"}`);
  const dataDirectory = process.env.NOMREH_DATA_DIR || path.join(process.cwd(), "data");
  let database;
  try {
    database = new DatabaseSync(path.join(dataDirectory, "nomreh.db"), { readOnly: true });
    database.exec("PRAGMA busy_timeout = 2000");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const row = database.prepare(`SELECT u.role
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`).get(tokenHash, new Date().toISOString());
    if (!row) throw authError(401, "AUTH_401_SESSION");
    if (row.role !== "admin") throw authError(403, "AUTH_403_ROLE");
  } catch (error) {
    if (error.vncCode) throw error;
    throw authError(503, "AUTH_STORAGE", "Admin session storage is unavailable");
  } finally {
    if (database) database.close();
  }
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
      // Authorization above paused the client socket. Resume both directions
      // only after the same-origin admin check and loopback VNC connection.
      socket.resume();
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

module.exports = { attachShecanVncWebSocket, authorizeUpgrade, UPGRADE_PATH };
