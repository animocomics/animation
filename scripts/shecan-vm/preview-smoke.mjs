import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WebSocket } = require('ws');
const expected = process.env.SHECAN_SMOKE_VALUE || 'test@example.invalid';
const leaveValue = process.argv.includes('--leave');
const previewUrl = process.env.SHECAN_PREVIEW_WS || 'ws://127.0.0.1:6099/ws';
const cdpHttp = process.env.SHECAN_CDP_HTTP || 'http://127.0.0.1:9222';
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error('Socket connection timed out')), 10_000);
    socket.once('open', () => { clearTimeout(timer); resolve(socket); });
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

let target;
const targetDeadline = Date.now() + 45_000;
while (!target && Date.now() < targetDeadline) {
  try {
    const response = await fetch(`${cdpHttp}/json/list`, { signal: AbortSignal.timeout(5000) });
    if (response.ok) {
      const targets = await response.json();
      target = targets.find((item) => item.type === 'page' && item.url.startsWith('http://wails.localhost/'));
    }
  } catch { /* The supervisor may still be starting Wine/CDP. */ }
  if (!target) await sleep(250);
}
if (!target) throw new Error('Shecan WebView2 page is not available');
const cdp = await openSocket(target.webSocketDebuggerUrl);
let nextId = 0;
const pending = new Map();
cdp.on('message', (data) => {
  const message = JSON.parse(data.toString());
  if (!message.id) return;
  const item = pending.get(message.id);
  if (!item) return;
  pending.delete(message.id);
  if (message.error) item.reject(new Error(`CDP ${item.method} failed`));
  else item.resolve(message.result);
});
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject, method });
    cdp.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
    }, 10_000).unref();
  });
}
async function readForm() {
  const result = await call('Runtime.evaluate', {
    expression: `({value:document.querySelector('input[name="username"]')?.value || '',forms:document.forms.length,ready:document.readyState})`,
    returnByValue: true,
  });
  return result.result.value;
}

let initial = await readForm();
const formDeadline = Date.now() + 15_000;
while ((initial.forms !== 1 || initial.ready !== 'complete') && Date.now() < formDeadline) {
  await sleep(250);
  initial = await readForm();
}
if (initial.forms !== 1 || initial.ready !== 'complete') throw new Error('Shecan login form is not ready');
if (initial.value && initial.value !== expected) throw new Error('Refusing to replace a non-empty username field');

const viewer = await openSocket(previewUrl);
let receivedFrame = false;
viewer.on('message', (data) => {
  const message = JSON.parse(data.toString());
  if (message.type === 'frame' && message.data) receivedFrame = true;
});
async function clearReservedValue() {
  viewer.send(JSON.stringify({ type: 'key', event: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 }));
  viewer.send(JSON.stringify({ type: 'key', event: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 }));
  viewer.send(JSON.stringify({ type: 'key', event: 'rawKeyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 }));
  viewer.send(JSON.stringify({ type: 'key', event: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 }));
  await sleep(500);
  const current = await readForm();
  if (current.value !== '') throw new Error('The reserved smoke value could not be cleared');
}

viewer.send(JSON.stringify({ type: 'mouse', event: 'mousePressed', x: 250, y: 405, button: 'left', buttons: 1, clickCount: 1 }));
await sleep(80);
viewer.send(JSON.stringify({ type: 'mouse', event: 'mouseReleased', x: 250, y: 405, button: 'left', buttons: 0, clickCount: 1 }));
await sleep(120);
if (initial.value) await clearReservedValue();
viewer.send(JSON.stringify({ type: 'insertText', text: expected }));
await sleep(700);
const filled = await readForm();
if (filled.value !== expected) throw new Error('Viewer input did not reach the real Shecan form');

if (process.env.SHECAN_SMOKE_SCREENSHOT) {
  const screenshot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.writeFileSync(process.env.SHECAN_SMOKE_SCREENSHOT, Buffer.from(screenshot.data, 'base64'));
}

if (!leaveValue) await clearReservedValue();

console.log(`SHECAN_PREVIEW_SMOKE_OK form=${filled.forms} filled=true cleared=${!leaveValue} frame=${receivedFrame}`);
viewer.close();
cdp.close();
