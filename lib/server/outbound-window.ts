// One hard ceiling for the whole server, shared by every process.
//
// The hosting rule is about the subscription's egress, not about one API: 200
// requests to anything inside 20 minutes blocks the server's outbound traffic.
// A per-destination counter therefore protected nothing — 120 to Kaya plus 120 to
// Gemini plus a retry loop elsewhere is still the same 200. That was a real hole.
//
// It also cannot live only in memory. Next.js may run more than one worker, and a
// separate script or a widget can send requests in its own process; each would
// have counted to 120 on its own. The window is kept in a small file in the data
// directory, written under a lock, so every process on this machine sees the same
// number.
//
// Nothing here talks to the network and nothing is secret: the file holds a list
// of timestamps.

import fs from "node:fs";
import path from "node:path";

export interface OutboundWindowLimits {
  /** Directory the counter file lives in. */
  dataDirectory: string;
  /** Requests allowed per window, for everything combined. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Injectable clock, used by the tests. */
  now?: () => number;
}

export interface OutboundTakeResult {
  ok: boolean;
  used: number;
  limit: number;
  remaining: number;
  /** When the oldest request ages out, so a refused caller knows how long to wait. */
  retryAfterMs: number;
}

export interface OutboundSnapshot {
  used: number;
  limit: number;
  remaining: number;
  windowMinutes: number;
}

const FILE_NAME = "outbound-window.json";
const LOCK_NAME = "outbound-window.lock";
const LOCK_STALE_MS = 5_000;
const LOCK_RETRIES = 40;

interface StoredWindow {
  /** Epoch milliseconds of each request still inside the window. */
  hits: number[];
}

/**
 * A lock that every process on the machine honours.
 *
 * `mkdir` is atomic on every filesystem we care about; a file created with `wx`
 * would work too, but a stale lock from a killed process is easier to detect and
 * remove with a directory's mtime.
 */
function withLock<T>(directory: string, action: () => T): T {
  const lockPath = path.join(directory, LOCK_NAME);
  let acquired = false;
  for (let attempt = 0; attempt < LOCK_RETRIES && !acquired; attempt += 1) {
    try {
      fs.mkdirSync(lockPath);
      acquired = true;
    } catch {
      // Someone else holds it. If it is old, it belonged to a dead process.
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age > LOCK_STALE_MS) fs.rmdirSync(lockPath);
      } catch {
        /* released between the two calls */
      }
      // Busy-wait briefly: this is a few microseconds of work, and the alternative
      // is a race that lets a burst through.
      const until = Date.now() + 25;
      while (Date.now() < until) {
        /* spin */
      }
    }
  }
  try {
    return action();
  } finally {
    if (acquired) {
      try {
        fs.rmdirSync(lockPath);
      } catch {
        /* already gone */
      }
    }
  }
}

export function createOutboundWindow(limits: OutboundWindowLimits) {
  const clock = limits.now || (() => Date.now());
  const file = path.join(limits.dataDirectory, FILE_NAME);

  function read(): StoredWindow {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as StoredWindow;
      if (!parsed || !Array.isArray(parsed.hits)) return { hits: [] };
      return { hits: parsed.hits.filter((value) => typeof value === "number") };
    } catch {
      // Missing or corrupt: an empty window is the safe reading, because the
      // alternative is never sending anything again.
      return { hits: [] };
    }
  }

  function write(window: StoredWindow): void {
    try {
      fs.mkdirSync(limits.dataDirectory, { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(window));
      fs.renameSync(temporary, file);
    } catch {
      /* The in-memory copy still applies for this process; see take(). */
    }
  }

  function prune(window: StoredWindow, now: number): StoredWindow {
    const cutoff = now - limits.windowMs;
    return { hits: window.hits.filter((at) => at > cutoff) };
  }

  /** In-process fallback when the data directory is not writable. */
  let fallback: StoredWindow = { hits: [] };

  return {
    /**
     * Reserves one request, or refuses it.
     *
     * The reservation happens before the request is attempted, so a refused call
     * costs nothing and cannot leave a half-sent request behind.
     */
    take(): OutboundTakeResult {
      const now = clock();
      let result: OutboundTakeResult | undefined;
      const update = (current: StoredWindow): StoredWindow => {
        const window = prune(current, now);
        if (window.hits.length >= limits.max) {
          const oldest = window.hits[0] ?? now;
          const retryAfterMs = Math.max(0, oldest + limits.windowMs - now);
          result = {
            ok: false,
            used: window.hits.length,
            limit: limits.max,
            remaining: 0,
            retryAfterMs,
          };
          return window;
        }
        window.hits.push(now);
        result = {
          ok: true,
          used: window.hits.length,
          limit: limits.max,
          remaining: Math.max(0, limits.max - window.hits.length),
          retryAfterMs: 0,
        };
        return window;
      };

      try {
        fs.mkdirSync(limits.dataDirectory, { recursive: true });
        withLock(limits.dataDirectory, () => {
          write(update(read()));
        });
      } catch {
        // Disk trouble must not become an outage: fall back to this process.
        fallback = update(prune(fallback, now));
      }

      return (
        result || {
          ok: true,
          used: 0,
          limit: limits.max,
          remaining: limits.max,
          retryAfterMs: 0,
        }
      );
    },

    /** What the panel shows. */
    snapshot(): OutboundSnapshot {
      const now = clock();
      let used = 0;
      try {
        used = prune(read(), now).hits.length;
      } catch {
        used = prune(fallback, now).hits.length;
      }
      return {
        used,
        limit: limits.max,
        remaining: Math.max(0, limits.max - used),
        windowMinutes: Math.round(limits.windowMs / 60_000),
      };
    },
  };
}

export type OutboundWindow = ReturnType<typeof createOutboundWindow>;
