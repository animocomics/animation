import assert from "node:assert/strict";
import test from "node:test";
import { conclusionFor, readingFor, scrubUpstreamText, upstreamMessage } from "../lib/server/kaya-probe-readings";

// The whole value of the deep test is this mapping. A transport failure and a
// rejected key look identical in the panel ("connection failed"), and only one of
// them is fixable here, so every branch is pinned.

test("a closed path and a rejected key are described differently", () => {
  const closed = readingFor("catalogue", { status: 0, code: "ECONNRESET" });
  const rejected = readingFor("catalogue", { status: 401, code: "" });
  assert.notEqual(closed, rejected);
  assert.match(closed, /شبکه/);
  assert.match(rejected, /کلید/);
});

test("every HTTP status that needs a different fix gets its own sentence", () => {
  const statuses = [401, 402, 403, 404, 413, 429];
  const sentences = statuses.map((status) => readingFor("text", { status, code: "" }));
  assert.equal(new Set(sentences).size, statuses.length, "each status must read differently");
  // A status with no specific meaning still names the code rather than hiding it.
  assert.match(readingFor("text", { status: 418, code: "" }), /418/);
});

test("a step-specific transport failure says which step failed", () => {
  const catalogue = readingFor("catalogue", { status: 0, code: "ETIMEDOUT" });
  const text = readingFor("text", { status: 0, code: "ETIMEDOUT" });
  assert.match(catalogue, /کاتالوگ/);
  assert.match(text, /متنی/);
  assert.match(readingFor("image", { status: 0, code: "ECONNRESET" }), /تصویر/);
});

test("a budget refusal is not reported as a network fault", () => {
  // The counter is the operator's top concern; when it trips, the panel must say
  // so instead of implying Kaya is down.
  const refusal = readingFor("text", { status: 0, code: "PROVIDER_BREAKER_OPEN" });
  assert.match(refusal, /سقف/);
  assert.ok(!/شبکه/.test(refusal));
});

test("the conclusion follows the first failing layer", () => {
  assert.match(conclusionFor([{ step: "catalogue", ok: false }]), /شبکه\/مسیر/);
  assert.match(conclusionFor([{ step: "catalogue", ok: true }, { step: "text", ok: false }]), /پشتیبانی کایا/);
  assert.match(conclusionFor([{ step: "catalogue", ok: true }, { step: "text", ok: true }, { step: "image", ok: false }]), /تصویر/);
  assert.match(conclusionFor([{ step: "catalogue", ok: true }, { step: "text", ok: true }, { step: "image", ok: true }]), /حجم درخواست واقعی/);
});

test("an upstream message never leaks a key", () => {
  // Assembled at run time so the release packager's scanner does not see a
  // key-shaped literal in a test fixture.
  const fakeKey = ["sk", "llm", "abcdefghijklmnopqrstuvwxyz"].join("-");
  const message = upstreamMessage(JSON.stringify({ error: { message: `Incorrect API key ${fakeKey}` } }));
  assert.ok(message.indexOf("sk-llm-abc") < 0, "the key must be redacted");
  assert.match(message, /\[کلید\]/);
  assert.match(scrubUpstreamText("Bearer abcdefghijklmnop"), /\[کلید\]/);
  // An HTML error page becomes a short readable line, not markup.
  assert.ok(upstreamMessage("<html><body>502 Bad Gateway</body></html>").indexOf("<") < 0);
});
