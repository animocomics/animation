"use client";

import { useEffect, useRef } from "react";

type ViewerMessage = {
  type: "frame" | "status";
  data?: string;
  format?: string;
  connected?: boolean;
};

type Props = {
  active: boolean;
  session: number;
  onConnectionChange: (connected: boolean) => void;
};

/** Authenticated same-origin canvas for the real WebView2 CDP screencast. */
export function ShecanWindowsScreen({ active, session, onConnectionChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !active) {
      onConnectionChange(false);
      return;
    }
    const context = canvas.getContext("2d");
    if (!context) {
      onConnectionChange(false);
      return;
    }
    let disposed = false;
    let httpMode = false;
    let httpPollTimer: ReturnType<typeof setTimeout> | undefined;
    let httpSendQueue: Promise<void> = Promise.resolve();
    let httpQueuedInputs = 0;
    let frameSequence = 0;
    const listeners = new AbortController();
    const signal = listeners.signal;

    const send = (value: unknown) => {
      const body = JSON.stringify(value);
      if (httpMode) {
        if (body.length > 4000 || httpQueuedInputs >= 48) return;
        httpQueuedInputs += 1;
        httpSendQueue = httpSendQueue.then(async () => {
          if (disposed) return;
          const response = await fetch("/api/admin/shecan-runtime/windows-input", {
            method: "POST",
            credentials: "same-origin",
            cache: "no-store",
            headers: { "Content-Type": "application/json", "X-Nomreh-Windows-Client": "1" },
            body,
          });
          if (!response.ok) throw new Error("Windows HTTP input failed");
        }).catch(() => { if (!disposed) onConnectionChange(false); }).finally(() => {
          httpQueuedInputs = Math.max(0, httpQueuedInputs - 1);
        });
        return;
      }
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) socket.send(body);
    };

    const draw = (message: ViewerMessage) => {
      if (!message.data) return;
      const sequence = ++frameSequence;
      const image = new Image();
      image.onload = () => {
        if (disposed || sequence !== frameSequence) return;
        if (image.width !== canvas.width || image.height !== canvas.height) {
          canvas.width = image.width;
          canvas.height = image.height;
        }
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        onConnectionChange(true);
      };
      image.src = `data:image/${message.format || "jpeg"};base64,${message.data}`;
    };

    const pollHttp = async () => {
      if (disposed || !httpMode) return;
      try {
        const response = await fetch("/api/admin/shecan-runtime/windows-frame", { credentials: "same-origin", cache: "no-store" });
        if (!response.ok) throw new Error("Windows HTTP frame failed");
        const bitmap = await createImageBitmap(await response.blob());
        const sequence = ++frameSequence;
        if (disposed || sequence !== frameSequence) {
          bitmap.close();
          return;
        }
        if (bitmap.width !== canvas.width || bitmap.height !== canvas.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
        }
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
        onConnectionChange(true);
      } catch {
        if (!disposed) onConnectionChange(false);
      } finally {
        if (!disposed && httpMode) httpPollTimer = setTimeout(pollHttp, 300);
      }
    };

    const startHttpFallback = () => {
      if (disposed || httpMode) return;
      httpMode = true;
      socketRef.current = null;
      onConnectionChange(false);
      void pollHttp();
    };

    const connect = () => {
      if (disposed || httpMode) return;
      const scheme = window.location.protocol === "https:" ? "wss" : "ws";
      let socket: WebSocket;
      try { socket = new WebSocket(`${scheme}://${window.location.host}/api/admin/shecan-runtime/windows`); }
      catch { startHttpFallback(); return; }
      socketRef.current = socket;
      const connectionTimer = setTimeout(() => {
        if (socket.readyState === WebSocket.OPEN) return;
        try { socket.close(); } catch { /* HTTP fallback still starts. */ }
        startHttpFallback();
      }, 4000);
      socket.onopen = () => {
        clearTimeout(connectionTimer);
        if (httpMode) socket.close();
      };
      socket.onmessage = (event) => {
        if (disposed || httpMode || typeof event.data !== "string" || event.data.length > 2_000_000) return;
        try {
          const message = JSON.parse(event.data) as ViewerMessage;
          if (message.type === "frame") draw(message);
          if (message.type === "status" && !message.connected) onConnectionChange(false);
        } catch { /* Malformed frames are ignored. */ }
      };
      socket.onclose = () => {
        clearTimeout(connectionTimer);
        if (socketRef.current === socket) socketRef.current = null;
        if (!disposed) startHttpFallback();
      };
      socket.onerror = () => socket.close();
    };

    const point = (event: PointerEvent | WheelEvent) => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: Math.max(0, Math.min(canvas.width - 1, (event.clientX - rect.left) * canvas.width / rect.width)),
        y: Math.max(0, Math.min(canvas.height - 1, (event.clientY - rect.top) * canvas.height / rect.height)),
      };
    };
    const buttonNames = ["left", "middle", "right", "back", "forward"];
    const modifiers = (event: PointerEvent | WheelEvent | KeyboardEvent) => (event.altKey ? 1 : 0)
      | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
    const mouse = (event: PointerEvent | WheelEvent, kind: string, pressed: boolean) => {
      const position = point(event);
      send({
        type: "mouse",
        event: kind,
        x: position.x,
        y: position.y,
        button: kind === "mouseMoved" || kind === "mouseWheel" ? "none" : (buttonNames[event.button] || "left"),
        buttons: event.buttons,
        clickCount: pressed ? 1 : 0,
        modifiers: modifiers(event),
        deltaX: event instanceof WheelEvent ? event.deltaX : 0,
        deltaY: event instanceof WheelEvent ? event.deltaY : 0,
      });
    };
    const specialKeys: Record<string, number> = {
      Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18,
      Escape: 27, " ": 32, PageUp: 33, PageDown: 34, End: 35, Home: 36,
      ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
      Insert: 45, Delete: 46, F1: 112, F2: 113, F3: 114, F4: 115,
      F5: 116, F6: 117, F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123,
    };
    const keyEvent = (event: KeyboardEvent, kind: "keyDown" | "rawKeyDown" | "keyUp") => {
      const virtual = specialKeys[event.key] || event.key.toUpperCase().charCodeAt(0) || 0;
      send({
        type: "key",
        event: kind,
        key: event.key,
        code: event.code,
        windowsVirtualKeyCode: virtual,
        nativeVirtualKeyCode: virtual,
        modifiers: modifiers(event),
        text: kind === "keyDown" && event.key === "Enter" ? "\r" : "",
      });
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        send({ type: "insertText", text: event.key });
        return;
      }
      if (specialKeys[event.key] || event.ctrlKey || event.metaKey || event.altKey || event.key.length === 1) {
        event.preventDefault();
        keyEvent(event, event.key === "Enter" ? "keyDown" : "rawKeyDown");
      }
    };
    const keyUp = (event: KeyboardEvent) => {
      if (event.isComposing || (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey)) return;
      if (specialKeys[event.key] || event.key.length === 1) {
        event.preventDefault();
        keyEvent(event, "keyUp");
      }
    };
    const paste = (event: ClipboardEvent) => {
      event.preventDefault();
      const text = event.clipboardData?.getData("text/plain") || "";
      if (text) send({ type: "insertText", text });
    };

    canvas.addEventListener("contextmenu", (event) => event.preventDefault(), { signal });
    canvas.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      canvas.focus({ preventScroll: true });
      canvas.setPointerCapture(event.pointerId);
      mouse(event, "mousePressed", true);
    }, { signal });
    canvas.addEventListener("pointerup", (event) => {
      event.preventDefault();
      mouse(event, "mouseReleased", true);
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    }, { signal });
    canvas.addEventListener("pointermove", (event) => {
      event.preventDefault();
      mouse(event, "mouseMoved", false);
    }, { signal });
    canvas.addEventListener("pointercancel", (event) => {
      if (event.buttons) mouse(event, "mouseReleased", true);
    }, { signal });
    canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      mouse(event, "mouseWheel", false);
    }, { passive: false, signal });
    canvas.addEventListener("keydown", keyDown, { signal });
    canvas.addEventListener("keyup", keyUp, { signal });
    canvas.addEventListener("paste", paste, { signal });
    canvas.addEventListener("dragover", (event) => event.preventDefault(), { signal });
    canvas.addEventListener("drop", (event) => {
      event.preventDefault();
      const text = event.dataTransfer?.getData("text/plain") || "";
      if (text) send({ type: "insertText", text });
    }, { signal });

    connect();
    return () => {
      disposed = true;
      if (httpPollTimer) clearTimeout(httpPollTimer);
      listeners.abort();
      socketRef.current?.close();
      socketRef.current = null;
      onConnectionChange(false);
    };
  }, [active, session, onConnectionChange]);

  return <canvas ref={canvasRef} width={500} height={700} tabIndex={0} aria-label="صفحهٔ زندهٔ برنامهٔ رسمی ویندوز شکن" />;
}
