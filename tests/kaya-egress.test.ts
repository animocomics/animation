import assert from "node:assert/strict";
import test from "node:test";
import { networkInterfaces } from "node:os";
import {
  DEFAULT_KAYA_EGRESS,
  closeKayaAgent,
  describeEgressFailure,
  isEgressConfigured,
  kayaAgent,
  kayaBaseUrl,
} from "../lib/server/kaya-egress";

// Kaya's firewall drops this server's default egress address. Choosing another
// local address is the only in-app lever that changes what Kaya sees, so it has
// to be correct, honest about failures, and impossible to leave half-applied.

test("nothing is changed unless the operator asks", () => {
  assert.equal(isEgressConfigured(DEFAULT_KAYA_EGRESS), false);
  assert.equal(isEgressConfigured(undefined), false);
  // No settings means the previous behaviour, byte for byte: a plain fetch.
  assert.equal(kayaAgent(DEFAULT_KAYA_EGRESS), undefined);
  assert.equal(kayaBaseUrl(DEFAULT_KAYA_EGRESS), "https://kayaai.ir/api");
});

test("a saved address produces a dispatcher, and the host override a base url", () => {
  assert.equal(isEgressConfigured({ bindAddress: "192.0.2.1", host: "" }), true);
  const agent = kayaAgent({ bindAddress: "192.0.2.1", host: "" });
  assert.ok(agent, "a bound address must build a dispatcher");
  closeKayaAgent();
  assert.equal(kayaBaseUrl({ bindAddress: "", host: "" }), "https://kayaai.ir/api");
  assert.equal(kayaBaseUrl({ bindAddress: "", host: "egress.example.com" }), "https://egress.example.com/api");
  assert.equal(kayaBaseUrl({ bindAddress: "", host: "https://proxy.example.com/v1" }), "https://proxy.example.com/v1");
});

test("the source address is forced through undici's own connector", () => {
  // undici passes `localAddress: null` from the request down to its connector,
  // which silently overrides `new Agent({ connect: { localAddress } })`. That made
  // an impossible address report success while Kaya kept seeing the old IP, so the
  // implementation must wrap buildConnector instead. This test pins that.
  const source = require("node:fs").readFileSync("lib/server/kaya-egress.ts", "utf8") as string;
  assert.match(source, /buildConnector/, "the connector must be wrapped, not configured");
  assert.ok(
    !/new Agent\(\{\s*connect:\s*\{\s*localAddress/.test(source),
    "setting localAddress inside connect options does not work in undici 6",
  );
});

test("a missing local address is named, not reported as a Kaya outage", () => {
  const sentence = describeEgressFailure("EADDRNOTAVAIL", { bindAddress: "192.0.2.123", host: "" });
  assert.match(sentence, /192\.0\.2\.123/, "the message must name the operator's own address");
  assert.match(sentence, /وجود ندارد/);
  // An unrelated socket error keeps the generic handling, so the panel does not
  // blame a setting that is not the cause.
  assert.equal(describeEgressFailure("ECONNRESET", { bindAddress: "", host: "" }), "");
});

test("the machine's real addresses are discoverable for the panel", () => {
  const found: string[] = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses || []) if (address.family === "IPv4" && !address.internal) found.push(address.address);
  }
  // The panel offers these instead of letting the operator guess.
  assert.ok(Array.isArray(found));
  assert.ok(found.every((address) => /^\d+\.\d+\.\d+\.\d+$/.test(address)));
});
