import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { FALLBACK_MODEL_OPTIONS, RECOMMENDED_MODELS, SUPPORTS_ACCOUNT_MODEL_DISCOVERY, mergeModelOptions } from "../lib/provider-catalog";
import { gapgptBaseUrl } from "../lib/server/providers";
import { sessionCookieOptions } from "../lib/server/session-cookie";

const root = path.resolve(__dirname, "..");

test("GapGPT is a first-class provider with a default model in its own catalogue", () => {
  assert.equal(SUPPORTS_ACCOUNT_MODEL_DISCOVERY.gapgpt, true, "the account model list must be readable");
  assert.ok(RECOMMENDED_MODELS.gapgpt);
  assert.ok(
    FALLBACK_MODEL_OPTIONS.gapgpt.includes(RECOMMENDED_MODELS.gapgpt),
    "the default model must appear in the offline suggestion list",
  );
  // One gateway serves several vendors, so the list must not be single-vendor.
  const joined = FALLBACK_MODEL_OPTIONS.gapgpt.join(" ");
  assert.match(joined, /gpt-/);
  assert.match(joined, /gemini-/);
});

test("the model picker keeps the operator's choice and never silently swaps it", () => {
  // mergeModelOptions drives the dropdown the admin picks from. A manually typed
  // model must survive even when it is not in the offline list, or the panel would
  // quietly fall back to a different model than the one that was chosen.
  const options = mergeModelOptions("gapgpt", FALLBACK_MODEL_OPTIONS.gapgpt, ["some-brand-new-model-2099"]);
  assert.ok(options.includes("some-brand-new-model-2099"), "a manually entered model must be offered, not dropped");
  assert.ok(options.includes(RECOMMENDED_MODELS.gapgpt), "the recommended model stays in the list");
  assert.equal(new Set(options).size, options.length, "the list must not contain duplicates");
});

test("the GapGPT endpoint defaults to the vendor's API host and honours a configured one", () => {
  assert.equal(gapgptBaseUrl(undefined), "https://api.gapgpt.app/v1");
  assert.equal(gapgptBaseUrl({ host: "", bindAddress: "" }), "https://api.gapgpt.app/v1");
  // A bare hostname is completed with the /v1 prefix the OpenAI contract needs.
  assert.equal(gapgptBaseUrl({ host: "api.gapapi.com", bindAddress: "" }), "https://api.gapapi.com/v1");
  // A full URL is used verbatim, minus any trailing slash.
  assert.equal(gapgptBaseUrl({ host: "https://api.gapapi.com/v1/", bindAddress: "" }), "https://api.gapapi.com/v1");
});

test("every surface that must know about GapGPT actually does", () => {
  const checks: Array<[string, RegExp]> = [
    // The call path: grading must route to the Chat Completions implementation.
    ["lib/server/providers.ts", /input\.provider === "gapgpt"\) return callGapGpt\(input\)/],
    // Model discovery: the admin panel's "read account models" button.
    ["lib/server/provider-models.ts", /gapgpt: \(egress\) => `\$\{gapgptBaseUrl\(egress\)\}\/models`/],
    // The connection test button.
    ["app/api/provider/test/route.ts", /PROVIDER_IDS/],
    // PDF rasterisation and payload ceiling come from the shared table.
    ["lib/server/provider-traits.ts", /gapgpt: \{ chatOnly: true, convertsPdf: true/],
    // The admin UI card.
    ["components/api-connection.tsx", /gapgpt: \{ label:/],
  ];
  for (const [file, pattern] of checks) {
    const body = fs.readFileSync(path.join(root, file), "utf8");
    assert.match(body, pattern, `${file} must wire up gapgpt`);
  }

  // The host guard must apply to GapGPT exactly as it does to Kaya: the configured
  // host decides where the request goes, so a remote plain-HTTP host must be refused.
  const testRoute = fs.readFileSync(path.join(root, "app", "api", "provider", "test", "route.ts"), "utf8");
  assert.match(testRoute, /input\.provider === "kaya" \|\| input\.provider === "gapgpt"\) assertKayaHostAllowed/);
});

test("GapGPT shares the Kaya call implementation rather than copying it", () => {
  // One Chat Completions path, two providers. A second copy would drift, and the
  // error messages are the part that drifts first.
  const providers = fs.readFileSync(path.join(root, "lib", "server", "providers.ts"), "utf8");
  const gapgptFn = providers.slice(providers.indexOf("async function callGapGpt"));
  const body = gapgptFn.slice(0, gapgptFn.indexOf("\n}\n"));
  assert.match(body, /return callKayaModel\(input, input\.model, false\)/);
  assert.doesNotMatch(body, /fetch\(/, "callGapGpt must not issue its own request");
  // The shared path names whichever service actually failed.
  assert.match(providers, /const serviceName = PROVIDER_LABELS\[input\.provider\]/);
});

test("the session cookie policy is unchanged by the provider work", () => {
  // A regression guard: this file was fixed for the cross-site preview, and adding a
  // provider must not quietly reintroduce a cookie the browser would drop.
  const env = process.env as Record<string, string | undefined>;
  const before = { ...process.env };
  delete env.NODE_ENV;
  delete process.env.NOMREH_COOKIE_SAMESITE;
  delete process.env.NOMREH_COOKIE_SECURE;
  try {
    assert.equal(sessionCookieOptions(new Date(0)).sameSite, "lax");
  } finally {
    Object.assign(process.env, before);
  }
});
