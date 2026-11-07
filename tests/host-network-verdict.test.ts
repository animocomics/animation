import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");

test("the network verdict does not blame the network when only one destination is blocked", () => {
  // This wording cost days. The panel said "packets are dropped before reaching
  // the server" while GitHub was answering from the same machine at the same
  // minute, so the operator kept looking for DNS and firewall faults that did not
  // exist. The verdict must describe a per-destination filter instead.
  const source = fs.readFileSync(path.join(root, "lib/server/host-network-inspect.ts"), "utf8");
  assert.ok(
    !/بسته‌ها قبل از رسیدن به سرور دور ریخته می‌شوند/.test(source),
    "the blanket packet-drop verdict must be replaced",
  );
  assert.match(source, /فقط مقصد مشخصی بسته است/, "the verdict must name a destination-specific block");
  // And the suggested command must test the destination that actually fails.
  assert.match(source, /kayaai\.ir\/   #/, "the operator must be given the failing destination to test");
});

test("the panel lists the addresses this machine owns", () => {
  // "Where do I get an Iranian address?" is answered by the machine, not by the
  // provider's marketing page. Only an address that is on an interface can be
  // bound, so it must be visible in the panel next to the egress verdict.
  const source = fs.readFileSync(path.join(root, "lib/server/host-network-inspect.ts"), "utf8");
  assert.match(source, /آدرس‌های روی این سرور/, "the local addresses must be listed");
  assert.match(source, /networkInterfaces/, "they must come from the machine, not a guess");
  assert.match(source, /فقط یکی از این‌ها را می‌توان به‌عنوان آدرس خروجی انتخاب کرد/, "and be tied to the egress field");
});
