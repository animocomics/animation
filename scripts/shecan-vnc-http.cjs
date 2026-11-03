"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { authorizeUpgrade } = require("./shecan-vnc-websocket.cjs");

const HTTP_CHANNEL_PATH = "/api/admin/shecan-runtime/vnc-http";
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_QUEUE_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_SESSIONS = 4;
const sessions = new Map();
const reverseSockets = [];
const reverseWaiters = [];
let reverseServer = null;

function cookieHash(request) {
  return crypto.createHash("sha256").update(String(request.headers.cookie || "")).digest("hex");
}

function baseHeaders() {
  return { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
}

function sendJson(response, status, value, code = "") {
  if (response.writableEnded || response.destroyed) return;
  const body = JSON.stringify(value);
  response.writeHead(status, { ...baseHeaders(), ...(code ? { "X-Nomreh-VNC-Error": code } : {}), "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  response.end(body);
}

function originError(request) {
  if (request.headers["x-nomreh-vnc-client"] !== "1") return "CLIENT_HEADER";
  const raw = request.headers.origin;
  if (!raw) return "ORIGIN_MISSING";
  try {
    const origin = new URL(raw);
    if (!["http:", "https:"].includes(origin.protocol)) return "ORIGIN_PROTOCOL";
    if (origin.host !== request.headers.host) return "ORIGIN_HOST";
    return "";
  } catch { return "ORIGIN_INVALID"; }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        reject(Object.assign(new Error("VNC request is too large"), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function destroySession(session) {
  if (!session || session.destroyed) return;
  session.destroyed = true;
  clearTimeout(session.idleTimer);
  if (session.notify) session.notify();
  session.socket.destroy();
  if (sessions.get(session.id) === session) sessions.delete(session.id);
}

function touchSession(session) {
  clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => destroySession(session), 30_000);
  session.idleTimer.unref();
}

function takeQueued(session) {
  if (!session.chunks.length) return Buffer.alloc(0);
  const size = Math.min(session.queued, MAX_RESPONSE_BYTES);
  const output = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const first = session.chunks[0];
    const length = Math.min(first.length, size - offset);
    first.copy(output, offset, 0, length);
    offset += length;
    if (length === first.length) session.chunks.shift();
    else session.chunks[0] = first.subarray(length);
  }
  session.queued -= size;
  return output;
}

async function waitForQueued(session) {
  if (session.queued || session.closed) return;
  await new Promise((resolve) => {
    const timer = setTimeout(finish, 200);
    function finish() {
      clearTimeout(timer);
      if (session.notify === finish) session.notify = null;
      resolve();
    }
    session.notify = finish;
  });
}

function requireSession(request) {
  const id = String(request.headers["x-nomreh-vnc-session"] || "");
  if (!/^[a-f0-9]{32}$/.test(id)) throw Object.assign(new Error("Invalid VNC session"), { statusCode: 400, vncCode: "SESSION" });
  const session = sessions.get(id);
  if (!session || session.cookieHash !== cookieHash(request)) throw Object.assign(new Error("VNC session is unavailable"), { statusCode: 403, vncCode: "SESSION" });
  return session;
}

function configuredReversePort() {
  const port = Number(process.env.NOMREH_VNC_REVERSE_PORT ?? 15500);
  if (port === 0) return 0;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Object.assign(new Error("Invalid reverse VNC port"), { statusCode: 503, vncCode: "VNC_REVERSE_CONFIG" });
  return port;
}

function ensureReverseServer(port) {
  if (reverseServer) return;
  const server = net.createServer((socket) => {
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(String(socket.remoteAddress || ""))) {
      socket.destroy();
      return;
    }
    socket.setNoDelay(true);
    socket.pause();
    socket.on("error", () => undefined);
    socket.once("close", () => {
      const index = reverseSockets.indexOf(socket);
      if (index >= 0) reverseSockets.splice(index, 1);
    });
    const waiter = reverseWaiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(socket);
    } else if (reverseSockets.length < MAX_SESSIONS) {
      reverseSockets.push(socket);
    } else {
      socket.destroy();
    }
  });
  reverseServer = server;
  server.once("error", (error) => {
    if (reverseServer === server) reverseServer = null;
    for (const waiter of reverseWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(Object.assign(new Error("Reverse VNC listener is unavailable"), { statusCode: 503, vncCode: "VNC_REVERSE_LISTENER", cause: error }));
    }
  });
  server.listen({ host: "127.0.0.1", port, exclusive: true });
}

function takeReverseSocket(port) {
  ensureReverseServer(port);
  if (reverseSockets.length) return Promise.resolve(reverseSockets.shift());
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, timer: null };
    waiter.timer = setTimeout(() => {
      const index = reverseWaiters.indexOf(waiter);
      if (index >= 0) reverseWaiters.splice(index, 1);
      reject(Object.assign(new Error("Reverse VNC connection timed out"), { statusCode: 503, vncCode: "VNC_REVERSE_TIMEOUT" }));
    }, 20000);
    reverseWaiters.push(waiter);
  });
}

function listenerState(port) {
  const hex = port.toString(16).toUpperCase().padStart(4, "0");
  try {
    for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      const lines = fs.readFileSync(table, "utf8").split("\n").slice(1);
      for (const line of lines) {
        const fields = line.trim().split(/\s+/);
        if (!fields[1]?.endsWith(`:${hex}`) || fields[3] !== "0A") continue;
        const receiveQueue = Number.parseInt(String(fields[4] || "").split(":")[1] || "0", 16);
        const queue = Number.isFinite(receiveQueue) ? Math.min(receiveQueue, 9999) : 9999;
        const address = String(fields[1] || "").split(":")[0];
        const addressClass = table.endsWith("tcp6") ? "TCP6" : address === "0100007F" ? "LOOPBACK4" : address === "00000000" ? "ANY4" : "OTHER4";
        const inode = fields[9] || "";
        try {
          const dataDirectory = process.env.NOMREH_DATA_DIR || path.join(process.cwd(), "data");
          const pid = Number(fs.readFileSync(path.join(dataDirectory, "shecan-official", "guest.pid"), "utf8").trim());
          const command = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
          if (!command.includes("qemu-system-x86_64") || !command.includes("initramfs-official")) return `OTHER_LISTENER_Q${queue}_${addressClass}`;
          const forward = command.includes(`hostfwd=tcp:127.0.0.1:${port}-:5900`) ? "FWD_OK" : "FWD_BAD";
          for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
            if (fs.readlinkSync(`/proc/${pid}/fd/${fd}`) === `socket:[${inode}]`) return `QEMU_LISTENER_Q${queue}_${addressClass}_${forward}`;
          }
          return `OTHER_LISTENER_Q${queue}_${addressClass}`;
        } catch { return `LISTENER_OWNER_UNKNOWN_Q${queue}_${addressClass}`; }
      }
    }
    return "NO_LISTENER";
  } catch { return "LISTENER_UNKNOWN"; }
}

async function createSession(request, response, applicationPort) {
  request.nomrehVncStage = "SESSION_LIMIT";
  if (sessions.size >= MAX_SESSIONS) throw Object.assign(new Error("Too many VNC sessions"), { statusCode: 429 });
  request.nomrehVncStage = "AUTH";
  try { await authorizeUpgrade(request, applicationPort); }
  catch (error) {
    error.vncCode = error.vncCode || `AUTH_UNCLASSIFIED_${String(request.nomrehVncStage || "AUTH").replace(/[^A-Z_]/g, "").slice(0, 32) || "AUTH"}`;
    throw error;
  }
  request.nomrehVncStage = "VNC_CONFIG";
  const reversePort = configuredReversePort();
  let socket;
  if (reversePort) {
    request.nomrehVncStage = "VNC_REVERSE";
    socket = await takeReverseSocket(reversePort);
  } else {
    const port = Number(process.env.NOMREH_VNC_PORT || 15900);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Object.assign(new Error("Invalid VNC port"), { statusCode: 503 });
    request.nomrehVncStage = "VNC_CONNECT";
    socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setNoDelay(true);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("VNC connection timeout")), 8000);
      function finish(error) {
        clearTimeout(timer);
        socket.off("connect", onConnect);
        socket.off("error", onError);
        if (error) reject(error); else resolve();
      }
      const onConnect = () => finish();
      const onError = (error) => finish(error);
      socket.once("connect", onConnect);
      socket.once("error", onError);
    }).catch((error) => {
      socket.destroy();
      const rawCode = error.message === "VNC connection timeout" ? "TIMEOUT" : String(error.code || "UNKNOWN");
      const code = /^[A-Z0-9_]+$/.test(rawCode) ? rawCode : "UNKNOWN";
      throw Object.assign(new Error("VNC is unavailable"), { statusCode: 503, vncCode: `VNC_CONNECT_${code}_${listenerState(port)}`, cause: error });
    });
  }
  socket.pause();
  request.nomrehVncStage = "SESSION_CREATE";
  const id = crypto.randomBytes(16).toString("hex");
  const session = { id, socket, cookieHash: cookieHash(request), chunks: [], queued: 0, closed: false, destroyed: false, exchanging: false, notify: null, idleTimer: null };
  sessions.set(id, session);
  touchSession(session);
  socket.on("data", (chunk) => {
    session.chunks.push(chunk);
    session.queued += chunk.length;
    if (session.queued > MAX_QUEUE_BYTES) {
      destroySession(session);
      return;
    }
    if (session.notify) session.notify();
  });
  const closed = () => {
    session.closed = true;
    if (session.notify) session.notify();
  };
  socket.once("close", closed);
  socket.once("error", closed);
  request.once("aborted", () => destroySession(session));
  sendJson(response, 200, { session: id });
  socket.resume();
}

async function exchange(session, request, response) {
  if (session.exchanging) throw Object.assign(new Error("Concurrent VNC exchange"), { statusCode: 409 });
  session.exchanging = true;
  try {
    touchSession(session);
    const body = await readBody(request);
    if (body.length) {
      if (session.closed || session.destroyed) throw Object.assign(new Error("VNC connection is closed"), { statusCode: 410 });
      if (!session.socket.write(body)) await new Promise((resolve) => session.socket.once("drain", resolve));
    }
    await waitForQueued(session);
    const output = takeQueued(session);
    if (!output.length && session.closed) throw Object.assign(new Error("VNC connection is closed"), { statusCode: 410 });
    response.writeHead(200, { ...baseHeaders(), "Content-Type": "application/octet-stream", "Content-Length": output.length });
    response.end(output);
  } finally {
    session.exchanging = false;
    if (!session.destroyed) touchSession(session);
  }
}

async function handle(request, response, applicationPort) {
  request.nomrehVncStage = "ORIGIN";
  const originFailure = originError(request);
  if (originFailure) {
    sendJson(response, 403, { error: "Same-origin admin VNC access is required" }, originFailure);
    return;
  }
  if (request.method === "POST" && !request.headers["x-nomreh-vnc-session"]) {
    await createSession(request, response, applicationPort);
    return;
  }
  request.nomrehVncStage = "SESSION_LOOKUP";
  const session = requireSession(request);
  if (request.method === "DELETE") {
    destroySession(session);
    response.writeHead(204, baseHeaders());
    response.end();
    return;
  }
  if (request.method !== "POST") throw Object.assign(new Error("Unsupported VNC method"), { statusCode: 405 });
  request.nomrehVncStage = "EXCHANGE";
  await exchange(session, request, response);
}

function handleShecanVncHttp(request, response, applicationPort) {
  let pathname = "";
  try { pathname = new URL(request.url || "/", "http://localhost").pathname; } catch { return false; }
  if (pathname !== HTTP_CHANNEL_PATH) return false;
  void handle(request, response, applicationPort).catch((error) => {
    const status = [400, 401, 403, 405, 409, 410, 413, 429].includes(error.statusCode) ? error.statusCode : 503;
    const stage = String(request.nomrehVncStage || "UNKNOWN").replace(/[^A-Z_]/g, "").slice(0, 32) || "UNKNOWN";
    sendJson(response, status, { error: "The authenticated VNC HTTP channel failed" }, error.vncCode || `RUNTIME_${status}_${stage}`);
  });
  return true;
}

function closeShecanVncHttpSessions() {
  for (const session of [...sessions.values()]) destroySession(session);
  for (const socket of reverseSockets.splice(0)) socket.destroy();
  for (const waiter of reverseWaiters.splice(0)) {
    clearTimeout(waiter.timer);
    waiter.reject(Object.assign(new Error("Reverse VNC listener closed"), { statusCode: 503, vncCode: "VNC_REVERSE_CLOSED" }));
  }
  if (reverseServer) {
    reverseServer.close();
    reverseServer = null;
  }
}

module.exports = { handleShecanVncHttp, closeShecanVncHttpSessions, HTTP_CHANNEL_PATH };
