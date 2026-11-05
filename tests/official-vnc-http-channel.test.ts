import assert from "node:assert/strict";
import test from "node:test";
import { OfficialVncHttpChannel } from "../components/official-vnc-http-channel";

test("noVNC HTTP raw channel opens, sends, receives and closes without a WebSocket", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { input: unknown; init?: RequestInit }[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ input, init });
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    if (!init?.headers || !("X-Nomreh-VNC-Session" in init.headers)) {
      return new Response(JSON.stringify({ session: "a".repeat(32) }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(Buffer.from("RFB 003.008\n"), { status: 200, headers: { "Content-Type": "application/octet-stream" } });
  };
  let channel: OfficialVncHttpChannel | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("HTTP raw-channel test timed out")), 3000);
      channel = new OfficialVncHttpChannel("/api/admin/shecan-runtime/vnc-http");
      channel.onerror = () => {
        clearTimeout(timer);
        reject(new Error("HTTP raw channel failed"));
      };
      channel.onopen = () => channel?.send(Buffer.from("RFB 003.008\n"));
      channel.onmessage = (event) => {
        assert.equal(Buffer.from(event.data).toString("ascii"), "RFB 003.008\n");
        channel?.close();
      };
      channel.onclose = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    assert.equal(calls.length, 3);
    assert.equal(calls[0].init?.method, "POST");
    assert.equal(calls[1].init?.method, "POST");
    assert.equal(Buffer.from(calls[1].init?.body as ArrayBuffer).toString("ascii"), "RFB 003.008\n");
    assert.equal(calls[2].init?.method, "DELETE");
  } finally {
    channel?.close();
    globalThis.fetch = originalFetch;
  }
});
