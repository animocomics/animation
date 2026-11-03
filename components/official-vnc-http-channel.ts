type OpenEvent = { type: "open" };
type ErrorEvent = { type: "error" };
type MessageEvent = { type: "message"; data: ArrayBuffer };
type CloseEvent = { type: "close"; code: number; reason: string; wasClean: boolean };

/** A small noVNC raw channel for hosts that do not forward WebSocket upgrades. */
export class OfficialVncHttpChannel {
  binaryType = "arraybuffer";
  protocol = "binary";
  readyState = 0;
  onopen: ((event: OpenEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  private session = "";
  private outgoing: Uint8Array[] = [];
  private outgoingBytes = 0;

  constructor(private readonly endpoint: string) {
    void this.open();
  }

  private request(init: RequestInit = {}, session = this.session): Promise<Response> {
    return fetch(this.endpoint, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        "X-Nomreh-VNC-Client": "1",
        ...(session ? { "X-Nomreh-VNC-Session": session } : {}),
        ...init.headers,
      },
    });
  }

  private async open(): Promise<void> {
    try {
      const response = await this.request({ method: "POST" }, "");
      const payload = await response.json().catch(() => ({})) as { session?: unknown };
      if (!response.ok || typeof payload.session !== "string" || !/^[a-f0-9]{32}$/.test(payload.session)) throw new Error("VNC session was not created");
      if (this.readyState !== 0) {
        void this.request({ method: "DELETE" }, payload.session).catch(() => undefined);
        return;
      }
      this.session = payload.session;
      this.readyState = 1;
      this.onopen?.({ type: "open" });
      void this.poll();
    } catch {
      this.fail();
    }
  }

  private takeOutgoing(): ArrayBuffer {
    const output = new Uint8Array(this.outgoingBytes);
    let offset = 0;
    for (const chunk of this.outgoing) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    this.outgoing = [];
    this.outgoingBytes = 0;
    return output.buffer;
  }

  private async poll(): Promise<void> {
    try {
      while (this.readyState === 1 && this.session) {
        const body = this.takeOutgoing();
        const response = await this.request({ method: "POST", headers: { "Content-Type": "application/octet-stream" }, body });
        if (!response.ok) throw new Error("VNC exchange failed");
        const data = await response.arrayBuffer();
        if (this.readyState !== 1) return;
        if (data.byteLength) this.onmessage?.({ type: "message", data });
      }
    } catch {
      this.fail();
    }
  }

  private fail(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onerror?.({ type: "error" });
    this.closeSession();
    this.onclose?.({ type: "close", code: 1006, reason: "VNC HTTP channel closed", wasClean: false });
  }

  private closeSession(): void {
    const session = this.session;
    this.session = "";
    this.outgoing = [];
    this.outgoingBytes = 0;
    if (session) void this.request({ method: "DELETE" }, session).catch(() => undefined);
  }

  send(data: ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== 1) throw new Error("VNC channel is not open");
    const chunk = data instanceof ArrayBuffer
      ? new Uint8Array(data.slice(0))
      : new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    if (this.outgoingBytes + chunk.length > 1024 * 1024) {
      this.fail();
      throw new Error("VNC send queue is full");
    }
    this.outgoing.push(chunk);
    this.outgoingBytes += chunk.length;
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closeSession();
    this.onclose?.({ type: "close", code: 1000, reason: "VNC HTTP channel closed", wasClean: true });
  }
}
