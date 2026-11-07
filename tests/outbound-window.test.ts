import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createOutboundWindow } from "../lib/server/outbound-window";

// The hosting provider blocks the whole subscription at 200 requests in 20
// minutes. The old gate counted per destination, so two destinations at 120 each
// sailed past it, and each worker process kept its own count. Both holes are
// closed here and must stay closed: a worker that sends 3000 requests is exactly
// the failure the operator asked never to happen again.

function fresh() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "outbound-window-"));
  return { directory, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

test("the ceiling counts every destination together, not one host at a time", () => {
  const { directory, cleanup } = fresh();
  const window = createOutboundWindow({ dataDirectory: directory, max: 5, windowMs: 60_000 });
  // Two "destinations" are irrelevant here: the window does not know about hosts.
  for (let index = 0; index < 5; index += 1) assert.equal(window.take().ok, true, `request ${index + 1} must pass`);
  const refused = window.take();
  assert.equal(refused.ok, false, "the sixth request must be refused");
  assert.equal(refused.remaining, 0);
  assert.ok(refused.retryAfterMs > 0, "a refused caller must be told how long to wait");
  cleanup();
});

test("the ceiling is shared by separate processes on the same machine", () => {
  const { directory, cleanup } = fresh();
  // A second worker, a console script, or a widget must spend from the same
  // budget. Simulated with a child process that takes four slots first.
  const script = `
    const { createOutboundWindow } = require(${JSON.stringify(path.resolve(__dirname, "../lib/server/outbound-window.ts"))});
    const window = createOutboundWindow({ dataDirectory: ${JSON.stringify(directory)}, max: 5, windowMs: 60000 });
    for (let index = 0; index < 4; index += 1) window.take();
  `;
  execFileSync(process.execPath, ["--import", "tsx", "-e", script], { stdio: "ignore" });

  const window = createOutboundWindow({ dataDirectory: directory, max: 5, windowMs: 60_000 });
  assert.equal(window.snapshot().used, 4, "this process must see the other process's requests");
  assert.equal(window.take().ok, true, "one slot is left");
  assert.equal(window.take().ok, false, "and the next one is refused");
  cleanup();
});

test("a burst of 3000 is capped at the limit, not queued", () => {
  const { directory, cleanup } = fresh();
  const window = createOutboundWindow({ dataDirectory: directory, max: 120, windowMs: 20 * 60_000 });
  let accepted = 0;
  for (let index = 0; index < 3000; index += 1) if (window.take().ok) accepted += 1;
  assert.equal(accepted, 120, "exactly the limit can pass; the rest are refused immediately");
  assert.equal(window.snapshot().used, 120);
  cleanup();
});

test("the window slides: a slot returns after twenty minutes", () => {
  const { directory, cleanup } = fresh();
  let clock = 1_000_000;
  const window = createOutboundWindow({ dataDirectory: directory, max: 2, windowMs: 60_000, now: () => clock });
  assert.equal(window.take().ok, true);
  assert.equal(window.take().ok, true);
  assert.equal(window.take().ok, false);
  clock += 30_000;
  assert.equal(window.take().ok, false, "half the window is not enough");
  clock += 31_000;
  assert.equal(window.take().ok, true, "after the window, one slot is free again");
  assert.equal(window.snapshot().used, 1);
  cleanup();
});

test("a missing or corrupt counter file never blocks all traffic", () => {
  const { directory, cleanup } = fresh();
  const window = createOutboundWindow({ dataDirectory: directory, max: 3, windowMs: 60_000 });
  fs.writeFileSync(path.join(directory, "outbound-window.json"), "{not json");
  assert.equal(window.take().ok, true, "a corrupt file must be treated as an empty window");
  cleanup();
});
