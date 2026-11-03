"use strict";

const crypto = require("node:crypto");
const net = require("node:net");
const { authorizeUpgrade } = require("./shecan-vnc-websocket.cjs");

const HTTP_CHANNEL_PATH = "/api/admin/shecan-runtime/vnc-http";
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_QUEUE_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_SESSIONS = 4;
const sessions = new Map();

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

async function createSession(request, response, applicationPort) {
  if (sessions.size >= MAX_SESSIONS) throw Object.assign(new Error("Too many VNC sessions"), { statusCode: 429 });
  try { await authorizeUpgrade(request, applicationPort); }
  catch (error) {
    error.vncCode = "AUTH";
    throw error;
  }
  const port = Number(process.env.NOMREH_VNC_PORT || 15900);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Object.assign(new Error("Invalid VNC port"), { statusCode: 503 });
  const socket = net.createConnection({ host: "127.0.0.1", port });
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
    throw Object.assign(new Error("VNC is unavailable"), { statusCode: 503, cause: error });
  });
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
  const originFailure = originError(request);
  if (originFailure) {
    sendJson(response, 403, { error: "Same-origin admin VNC access is required" }, originFailure);
    return;
  }
  if (request.method === "POST" && !request.headers["x-nomreh-vnc-session"]) {
    await createSession(request, response, applicationPort);
    return;
  }
  const session = requireSession(request);
  if (request.method === "DELETE") {
    destroySession(session);
    response.writeHead(204, baseHeaders());
    response.end();
    return;
  }
  if (request.method !== "POST") throw Object.assign(new Error("Unsupported VNC method"), { statusCode: 405 });
  await exchange(session, request, response);
}

function handleShecanVncHttp(request, response, applicationPort) {
  let pathname = "";
  try { pathname = new URL(request.url || "/", "http://localhost").pathname; } catch { return false; }
  if (pathname !== HTTP_CHANNEL_PATH) return false;
  void handle(request, response, applicationPort).catch((error) => {
    const status = [400, 401, 403, 405, 409, 410, 413, 429].includes(error.statusCode) ? error.statusCode : 503;
    sendJson(response, status, { error: "The authenticated VNC HTTP channel failed" }, error.vncCode || "RUNTIME");
  });
  return true;
}

function closeShecanVncHttpSessions() {
  for (const session of [...sessions.values()]) destroySession(session);
}

module.exports = { handleShecanVncHttp, closeShecanVncHttpSessions, HTTP_CHANNEL_PATH };
