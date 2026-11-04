import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import { getDb } from "../../lib/server/db";

const require = createRequire(import.meta.url);
const { WebSocket } = require("ws") as { WebSocket: any };
const origin = process.env.NOMREH_WINDOWS_ADMIN_ORIGIN || "http://127.0.0.1:3000";
const parsedOrigin = new URL(origin);
if (parsedOrigin.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(parsedOrigin.hostname)) {
  throw new Error("The temporary admin smoke session is restricted to a loopback HTTP origin");
}
const expected = process.env.SHECAN_SMOKE_VALUE || "test@example.invalid";
const cdpHttp = process.env.SHECAN_CDP_HTTP || "http://127.0.0.1:9222";
const screenshot = process.env.SHECAN_ADMIN_SCREENSHOT || "";
const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function openSocket(url: string, headers: Record<string, string> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    const timer = setTimeout(() => { socket.terminate(); reject(new Error("Socket connection timed out")); }, 10_000);
    socket.once("open", () => { clearTimeout(timer); resolve(socket); });
    socket.once("error", (error: Error) => { clearTimeout(timer); reject(error); });
  });
}

async function main(): Promise<void> {
  const targets = await (await fetch(`${cdpHttp}/json/list`, { signal: AbortSignal.timeout(5000) })).json() as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
  const target = targets.find((item) => item.type === "page" && item.url.startsWith("http://wails.localhost/"));
  if (!target) throw new Error("The genuine Shecan WebView2 page is unavailable");
  const cdp = await openSocket(target.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; method: string }>();
  cdp.on("message", (data: Buffer) => {
    const message = JSON.parse(data.toString());
    if (!message.id) return;
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    if (message.error) item.reject(new Error(`CDP ${item.method} failed`));
    else item.resolve(message.result);
  });
  function call(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject, method });
      cdp.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, 10_000).unref();
    });
  }
  async function readForm(): Promise<{ value: string; forms: number; ready: string }> {
    const result = await call("Runtime.evaluate", {
      expression: `({value:document.querySelector('input[name="username"]')?.value || '',forms:document.forms.length,ready:document.readyState})`,
      returnByValue: true,
    });
    return result.result.value;
  }

  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const db = getDb();
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' AND active = 1 ORDER BY created_at LIMIT 1").get() as { id?: string } | undefined;
  if (!admin?.id) throw new Error("No active local admin is available for the temporary smoke session");
  const now = new Date().toISOString();
  db.prepare("INSERT INTO sessions (id, token_hash, user_id, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(randomBytes(16).toString("hex"), tokenHash, admin.id, "2999-01-01T00:00:00.000Z", now, now);
  let viewer: any;
  try {
    const initial = await readForm();
    if (initial.forms !== 1 || initial.ready !== "complete") throw new Error("The genuine Shecan form is not ready");
    if (initial.value && initial.value !== expected) throw new Error("Refusing to replace an unrelated non-empty Shecan username");

    const cookie = `nomreh_session=${token}`;
    const [adminPage, runtimeResponse] = await Promise.all([
      fetch(`${origin}/admin`, { headers: { Cookie: cookie }, cache: "no-store" }),
      fetch(`${origin}/api/admin/shecan-runtime`, { headers: { Cookie: cookie }, cache: "no-store" }),
    ]);
    const runtimePayload = await runtimeResponse.json();
    await adminPage.text();
    if (adminPage.status !== 200 || !runtimeResponse.ok || runtimePayload.runtime?.applicationKind !== "windows" || !runtimePayload.runtime?.appReady || runtimePayload.runtime?.brokerReady) {
      throw new Error("The authenticated admin API did not preserve the Windows display/AI readiness boundary");
    }
    const wsOrigin = origin.replace(/^http:/, "ws:");
    const upgradeUrl = `${wsOrigin}/api/admin/shecan-runtime/windows`;
    let rejectedWithoutSession = false;
    try {
      const unauthorized = await openSocket(upgradeUrl, { Origin: origin });
      unauthorized.terminate();
    } catch { rejectedWithoutSession = true; }
    if (!rejectedWithoutSession) throw new Error("The Windows admin WebSocket accepted an anonymous session");

    viewer = await openSocket(upgradeUrl, { Origin: origin, Cookie: cookie });
    let receivedFrame = false;
    viewer.on("message", (data: Buffer) => {
      const message = JSON.parse(data.toString());
      if (message.type === "frame" && message.data) receivedFrame = true;
    });
    type Send = (value: unknown) => void | Promise<void>;
    const clearReservedValue = async (send: Send) => {
      await send({ type: "key", event: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 });
      await send({ type: "key", event: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 2 });
      await send({ type: "key", event: "rawKeyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 });
      await send({ type: "key", event: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 });
      await sleep(500);
      if ((await readForm()).value !== "") throw new Error("The admin channel could not clear the reserved smoke value");
    };
    const fillReservedValue = async (send: Send, clearFirst: boolean) => {
      await send({ type: "mouse", event: "mousePressed", x: 250, y: 405, button: "left", buttons: 1, clickCount: 1 });
      await sleep(80);
      await send({ type: "mouse", event: "mouseReleased", x: 250, y: 405, button: "left", buttons: 0, clickCount: 1 });
      await sleep(120);
      if (clearFirst) await clearReservedValue(send);
      await send({ type: "insertText", text: expected });
      await sleep(800);
      const filled = await readForm();
      if (filled.value !== expected) throw new Error("Admin keyboard/pointer input did not reach the genuine Shecan form");
      return filled;
    };
    const send = (value: unknown) => viewer.send(JSON.stringify(value));
    await fillReservedValue(send, Boolean(initial.value));
    const frameDeadline = Date.now() + 5000;
    while (!receivedFrame && Date.now() < frameDeadline) await sleep(50);
    if (!receivedFrame) throw new Error("The authenticated admin WebSocket did not deliver a genuine application frame");
    viewer.close();
    viewer = null;

    const anonymousFrame = await fetch(`${origin}/api/admin/shecan-runtime/windows-frame`, { cache: "no-store" });
    await anonymousFrame.text();
    if (anonymousFrame.status !== 401) throw new Error("The Windows HTTP frame endpoint accepted an anonymous session");
    const frameResponse = await fetch(`${origin}/api/admin/shecan-runtime/windows-frame`, { headers: { Cookie: cookie }, cache: "no-store" });
    const frameBytes = await frameResponse.arrayBuffer();
    if (!frameResponse.ok || frameResponse.headers.get("content-type") !== "image/jpeg" || frameBytes.byteLength < 1000) {
      throw new Error("The authenticated Windows HTTP frame endpoint did not return a real JPEG");
    }
    const httpInput: Send = async (value) => {
      const response = await fetch(`${origin}/api/admin/shecan-runtime/windows-input`, {
        method: "POST",
        headers: { Cookie: cookie, Origin: origin, "X-Nomreh-Windows-Client": "1", "Content-Type": "application/json" },
        body: JSON.stringify(value),
        cache: "no-store",
      });
      await response.text();
      if (!response.ok) throw new Error(`Windows HTTP input returned ${response.status}`);
    };
    const httpFilled = await fillReservedValue(httpInput, true);
    if (screenshot) {
      const capture = await call("Page.captureScreenshot", { format: "png", fromSurface: true });
      fs.writeFileSync(screenshot, Buffer.from(capture.data, "base64"));
    }
    console.log(`SHECAN_ADMIN_WINDOWS_SMOKE_OK form=${httpFilled.forms} filled=true websocket=true http=true authorized=true anonymous_rejected=true`);
  } finally {
    if (viewer) viewer.close();
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
    db.close();
    cdp.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Windows admin smoke failed");
  process.exitCode = 1;
});
