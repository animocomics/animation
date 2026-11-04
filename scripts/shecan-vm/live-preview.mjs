import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WebSocket, WebSocketServer } = require('ws');

const port = Number(process.env.SHECAN_PREVIEW_PORT || 6099);
const host = process.env.SHECAN_PREVIEW_HOST || '0.0.0.0';
const cdpHttp = process.env.SHECAN_CDP_HTTP || 'http://127.0.0.1:9222';
const clients = new Set();
const pending = new Map();
let cdp = null;
let cdpReady = false;
let nextId = 1;
let reconnectTimer = null;
let lastFrame = null;
let lastFrameAt = 0;
let captureInFlight = false;
let stopping = false;

const pageHtml = `<!doctype html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Shecan Desktop — نمای زندهٔ ویندوز</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: #0c1117; color: #e8eef4;
      font-family: Tahoma, Arial, sans-serif; display: flex; flex-direction: column;
      align-items: center; padding: 14px 12px 22px; }
    header { width: min(500px, 100%); display: flex; align-items: center;
      justify-content: space-between; gap: 12px; margin-bottom: 12px; }
    h1 { font-size: 16px; margin: 0; font-weight: 600; }
    #status { direction: rtl; font-size: 12px; color: #b8c4cf; display: flex;
      align-items: center; gap: 7px; white-space: nowrap; }
    #dot { width: 9px; height: 9px; border-radius: 50%; background: #d69e2e; }
    #dot.ready { background: #20b486; }
    #screen { display: block; width: min(500px, calc(100vw - 24px)); height: auto;
      aspect-ratio: 5 / 7; background: #fff; border-radius: 3px; outline: none;
      box-shadow: 0 12px 44px #0009; touch-action: none; user-select: none;
      -webkit-user-select: none; cursor: default; }
    #screen:focus { box-shadow: 0 0 0 2px #20b486, 0 12px 44px #0009; }
    .hint { font-size: 12px; color: #93a2af; margin: 12px 0 0; text-align: center; }
  </style>
</head>
<body>
  <header>
    <h1>Shecan Desktop — نمای زندهٔ برنامهٔ ویندوز</h1>
    <div id="status"><span id="dot"></span><span id="statusText">در حال اتصال…</span></div>
  </header>
  <canvas id="screen" width="500" height="700" tabindex="0"
    aria-label="نمای زندهٔ همان برنامهٔ Shecan Desktop"></canvas>
  <p class="hint">برای تایپ در فرم واقعی برنامه، ابتدا داخل تصویر کلیک کنید.</p>
  <script src="/app.js"></script>
</body>
</html>`;

const browserJs = `(() => {
  const canvas = document.getElementById('screen');
  const context = canvas.getContext('2d', { alpha: false });
  const statusText = document.getElementById('statusText');
  const dot = document.getElementById('dot');
  let socket;
  let frameSequence = 0;
  let reconnectTimer;

  function send(message) {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  function showFrame(message) {
    const sequence = ++frameSequence;
    const image = new Image();
    image.onload = () => {
      if (sequence !== frameSequence) return;
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
    };
    image.src = 'data:image/' + (message.format || 'jpeg') + ';base64,' + message.data;
  }

  function connect() {
    clearTimeout(reconnectTimer);
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(scheme + '://' + location.host + '/ws');
    socket.addEventListener('open', () => { statusText.textContent = 'اتصال برقرار شد'; });
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.type === 'frame') showFrame(message);
      if (message.type === 'status') {
        statusText.textContent = message.connected ? 'برنامهٔ واقعی متصل است' : 'در انتظار برنامهٔ ویندوز…';
        dot.classList.toggle('ready', Boolean(message.connected));
      }
    });
    socket.addEventListener('close', () => {
      statusText.textContent = 'در حال اتصال دوباره…';
      dot.classList.remove('ready');
      reconnectTimer = setTimeout(connect, 1200);
    });
    socket.addEventListener('error', () => socket.close());
  }

  function point(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * canvas.width / rect.width,
      y: (event.clientY - rect.top) * canvas.height / rect.height,
    };
  }

  const buttonNames = ['left', 'middle', 'right', 'back', 'forward'];
  function modifiers(event) {
    return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) |
      (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
  }
  function mouse(event, kind, pressed) {
    const position = point(event);
    send({ type: 'mouse', event: kind, x: position.x, y: position.y,
      button: kind === 'mouseMoved' ? 'none' : (buttonNames[event.button] || 'left'),
      buttons: event.buttons, clickCount: pressed ? 1 : 0,
      modifiers: modifiers(event), deltaX: event.deltaX || 0, deltaY: event.deltaY || 0 });
  }

  canvas.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture(event.pointerId);
    mouse(event, 'mousePressed', true);
  });
  canvas.addEventListener('pointerup', (event) => {
    event.preventDefault();
    mouse(event, 'mouseReleased', true);
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    event.preventDefault();
    mouse(event, 'mouseMoved', false);
  });
  canvas.addEventListener('pointercancel', (event) => {
    if (event.buttons) mouse(event, 'mouseReleased', true);
  });
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    mouse(event, 'mouseWheel', false);
  }, { passive: false });
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());

  const specialKeys = {
    Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18,
    Escape: 27, ' ': 32, PageUp: 33, PageDown: 34, End: 35, Home: 36,
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
    Insert: 45, Delete: 46, F1: 112, F2: 113, F3: 114, F4: 115,
    F5: 116, F6: 117, F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123,
  };
  function keyEvent(event, kind) {
    const virtual = specialKeys[event.key] || event.key.toUpperCase().charCodeAt(0) || 0;
    send({ type: 'key', event: kind, key: event.key, code: event.code,
      windowsVirtualKeyCode: virtual, nativeVirtualKeyCode: virtual,
      modifiers: modifiers(event), text: kind === 'keyDown' && event.key === 'Enter' ? '\\r' : '' });
  }
  canvas.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      send({ type: 'insertText', text: event.key });
      return;
    }
    if (specialKeys[event.key] || event.ctrlKey || event.metaKey || event.altKey || event.key.length === 1) {
      event.preventDefault();
      keyEvent(event, event.key === 'Enter' ? 'keyDown' : 'rawKeyDown');
    }
  });
  canvas.addEventListener('keyup', (event) => {
    if (event.isComposing || (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey)) return;
    if (specialKeys[event.key] || event.key.length === 1) {
      event.preventDefault();
      keyEvent(event, 'keyUp');
    }
  });
  connect();
})();`;

function broadcast(message) {
  const data = JSON.stringify(message);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  }
}

function cdpCall(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!cdp || cdp.readyState !== WebSocket.OPEN) {
      reject(new Error('CDP is not connected'));
      return;
    }
    const id = nextId++;
    pending.set(id, { resolve, reject, method });
    cdp.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
    }, 15000).unref();
  });
}

async function captureOnce() {
  if (!cdpReady || captureInFlight) return;
  captureInFlight = true;
  try {
    const result = await cdpCall('Page.captureScreenshot', { format: 'jpeg', quality: 90, fromSurface: true });
    lastFrame = { data: result.data, format: 'jpeg' };
    lastFrameAt = Date.now();
    broadcast({ type: 'frame', ...lastFrame });
  } catch {
    // A later screencast frame or reconnect will recover the view.
  } finally {
    captureInFlight = false;
  }
}

function closeCdp() {
  cdpReady = false;
  for (const item of pending.values()) item.reject(new Error('CDP disconnected'));
  pending.clear();
  broadcast({ type: 'status', connected: false });
}

function scheduleReconnect() {
  if (stopping || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectCdp();
  }, 1000);
  reconnectTimer.unref();
}

async function connectCdp() {
  if (stopping) return;
  try {
    const response = await fetch(`${cdpHttp}/json/list`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`CDP HTTP ${response.status}`);
    const targets = await response.json();
    const target = targets.find((item) => item.type === 'page' && item.url.startsWith('http://wails.localhost/'));
    if (!target) throw new Error('Shecan page is not ready');
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    cdp = socket;
    socket.on('open', async () => {
      if (cdp !== socket) return;
      cdpReady = true;
      broadcast({ type: 'status', connected: true });
      try {
        await cdpCall('Page.enable');
        await cdpCall('Page.startScreencast', {
          format: 'jpeg', quality: 90, maxWidth: 500, maxHeight: 700, everyNthFrame: 1,
        });
        await captureOnce();
      } catch {
        socket.close();
      }
    });
    socket.on('message', (data) => {
      let message;
      try { message = JSON.parse(data.toString()); } catch { return; }
      if (message.id) {
        const item = pending.get(message.id);
        if (!item) return;
        pending.delete(message.id);
        if (message.error) item.reject(new Error(`CDP ${item.method} failed`));
        else item.resolve(message.result);
        return;
      }
      if (message.method === 'Page.screencastFrame') {
        lastFrame = { data: message.params.data, format: 'jpeg' };
        lastFrameAt = Date.now();
        broadcast({ type: 'frame', ...lastFrame });
        cdpCall('Page.screencastFrameAck', { sessionId: message.params.sessionId }).catch(() => {});
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      if (cdp === socket) cdp = null;
      closeCdp();
      scheduleReconnect();
    });
  } catch {
    closeCdp();
    scheduleReconnect();
  }
}

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

async function forwardInput(message) {
  if (!cdpReady) return;
  if (message.type === 'mouse') {
    const allowed = new Set(['mousePressed', 'mouseReleased', 'mouseMoved', 'mouseWheel']);
    if (!allowed.has(message.event)) return;
    const buttons = new Set(['none', 'left', 'middle', 'right', 'back', 'forward']);
    await cdpCall('Input.dispatchMouseEvent', {
      type: message.event,
      x: clamp(finite(message.x), 0, 500),
      y: clamp(finite(message.y), 0, 700),
      button: buttons.has(message.button) ? message.button : 'none',
      buttons: clamp(Math.trunc(finite(message.buttons)), 0, 255),
      clickCount: clamp(Math.trunc(finite(message.clickCount)), 0, 3),
      modifiers: clamp(Math.trunc(finite(message.modifiers)), 0, 15),
      deltaX: clamp(finite(message.deltaX), -1000, 1000),
      deltaY: clamp(finite(message.deltaY), -1000, 1000),
      pointerType: 'mouse',
    });
  } else if (message.type === 'key') {
    const allowed = new Set(['keyDown', 'rawKeyDown', 'keyUp', 'char']);
    if (!allowed.has(message.event) || typeof message.key !== 'string' || message.key.length > 32) return;
    await cdpCall('Input.dispatchKeyEvent', {
      type: message.event,
      key: message.key,
      code: typeof message.code === 'string' ? message.code.slice(0, 64) : '',
      windowsVirtualKeyCode: clamp(Math.trunc(finite(message.windowsVirtualKeyCode)), 0, 255),
      nativeVirtualKeyCode: clamp(Math.trunc(finite(message.nativeVirtualKeyCode)), 0, 255),
      modifiers: clamp(Math.trunc(finite(message.modifiers)), 0, 15),
      text: typeof message.text === 'string' ? message.text.slice(0, 16) : '',
    });
  } else if (message.type === 'insertText') {
    if (typeof message.text !== 'string' || !message.text.length || message.text.length > 64) return;
    await cdpCall('Input.insertText', { text: message.text });
  } else {
    return;
  }
  if (Date.now() - lastFrameAt > 400) setTimeout(captureOnce, 60);
}

function readInputJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 4096) { tooLarge = true; return; }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (tooLarge) { reject(new Error('Input too large')); return; }
      try {
        const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid input');
        resolve(message);
      } catch { reject(new Error('Invalid input')); }
    });
    request.on('error', reject);
  });
}

function loopbackRequest(request) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(String(request.socket.remoteAddress || ''));
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (request.method === 'GET' && url.pathname === '/healthz') {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ ok: cdpReady, application: 'Shecan Desktop', transport: 'CDP screencast', frame: Boolean(lastFrame), clients: clients.size }));
  } else if (request.method === 'GET' && url.pathname === '/frame') {
    if (!lastFrame) {
      response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: 'No application frame is available' }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'image/jpeg' });
    response.end(Buffer.from(lastFrame.data, 'base64'));
  } else if (request.method === 'POST' && url.pathname === '/input') {
    if (!loopbackRequest(request)) {
      response.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: 'Loopback input only' }));
      return;
    }
    readInputJson(request)
      .then((message) => forwardInput(message))
      .then(() => {
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ ok: true }));
      })
      .catch(() => {
        if (response.writableEnded) return;
        response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'Input was not accepted' }));
      });
  } else if (request.method === 'GET' && url.pathname === '/') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(pageHtml);
  } else if (request.method === 'GET' && url.pathname === '/app.js') {
    response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    response.end(browserJs);
  } else {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
wss.on('connection', (client) => {
  clients.add(client);
  client.send(JSON.stringify({ type: 'status', connected: cdpReady }));
  if (lastFrame) client.send(JSON.stringify({ type: 'frame', ...lastFrame }));
  client.on('message', (data) => {
    let message;
    try { message = JSON.parse(data.toString()); } catch { return; }
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    forwardInput(message).catch(() => {});
  });
  client.on('close', () => clients.delete(client));
  client.on('error', () => clients.delete(client));
});

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (client) => wss.emit('connection', client, request));
});

server.listen(port, host, () => {
  console.log(`Shecan live preview listening on ${host}:${port}`);
  connectCdp();
});

function shutdown() {
  if (stopping) return;
  stopping = true;
  clearTimeout(reconnectTimer);
  if (cdp && cdp.readyState === WebSocket.OPEN) {
    cdpCall('Page.stopScreencast').catch(() => {}).finally(() => cdp.close());
  }
  for (const client of clients) client.close(1001, 'Server shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
