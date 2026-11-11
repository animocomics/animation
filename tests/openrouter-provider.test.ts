import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { FALLBACK_MODEL_OPTIONS, RECOMMENDED_MODELS, SUPPORTS_ACCOUNT_MODEL_DISCOVERY, mergeModelOptions } from "../lib/provider-catalog";
import { openrouterBaseUrl, OPENROUTER_HEADERS, PROVIDER_LABELS } from "../lib/server/providers";
import { isChatCompletionsProvider, providerNeedsPdfRaster } from "../lib/server/provider-traits";
import { filterGradingCandidates } from "../lib/server/provider-models";

const root = path.resolve(__dirname, "..");

test("OpenRouter is a first-class provider with a default model in its own catalogue", () => {
  assert.equal(SUPPORTS_ACCOUNT_MODEL_DISCOVERY.openrouter, true, "the account model list must be readable");
  assert.equal(PROVIDER_LABELS.openrouter, "OpenRouter");
  assert.ok(RECOMMENDED_MODELS.openrouter);
  assert.ok(
    FALLBACK_MODEL_OPTIONS.openrouter.includes(RECOMMENDED_MODELS.openrouter),
    "the default model must appear in the offline suggestion list",
  );
  // OpenRouter fronts every vendor, so the suggestions must not be single-vendor.
  const joined = FALLBACK_MODEL_OPTIONS.openrouter.join(" ");
  assert.match(joined, /google\//);
  assert.match(joined, /anthropic\//);
  // Ids carry the owner prefix OpenRouter requires; a bare name would 404.
  for (const id of FALLBACK_MODEL_OPTIONS.openrouter) assert.match(id, /^[a-z0-9-]+\/.+/, `${id} must be owner/model`);
});

test("OpenRouter is reached over Chat Completions, with pages rasterised first", () => {
  assert.equal(isChatCompletionsProvider("openrouter"), true);
  assert.equal(providerNeedsPdfRaster("openrouter"), true, "a raw PDF is not the contract we send");
});

test("the OpenRouter endpoint defaults to the vendor host and honours a configured one", () => {
  assert.equal(openrouterBaseUrl(undefined), "https://openrouter.ai/api/v1");
  assert.equal(openrouterBaseUrl({ host: "", bindAddress: "" }), "https://openrouter.ai/api/v1");
  assert.equal(openrouterBaseUrl({ host: "openrouter.ai", bindAddress: "" }), "https://openrouter.ai/v1");
  assert.equal(openrouterBaseUrl({ host: "https://mirror.example/v1/", bindAddress: "" }), "https://mirror.example/v1");
});

test("the attribution headers carry no sheet and no secret", () => {
  assert.ok(OPENROUTER_HEADERS["X-Title"]);
  const joined = Object.values(OPENROUTER_HEADERS).join(" ");
  assert.doesNotMatch(joined, /key|token|Bearer/i);
  // The sheet itself is never in a header; the title is a product name.
  assert.match(joined, /Nomreh/);
});

test("the OpenRouter catalogue is filtered to models that can actually see a page", () => {
  const catalogue = [
    // A vision model: has both modalities. Must survive.
    { id: "google/gemini-2.5-flash", input_modalities: ["text", "image"], output_modalities: ["text"] },
    { id: "anthropic/claude-sonnet-4.5", input_modalities: ["text", "image"], output_modalities: ["text"] },
    // A text-only model: the exact mistake that costs money, because it "reads" a sheet
    // by inventing one. Must be dropped.
    { id: "meta-llama/llama-3.3-70b-instruct", input_modalities: ["text"], output_modalities: ["text"] },
    // An image *generator*: output is not text, so it cannot return a grade.
    { id: "openai/dall-e-3", input_modalities: ["text"], output_modalities: ["image"] },
    // Naming that cannot be a grader even without a modality list.
    { id: "openai/text-embedding-3-large" },
    { id: "openai/whisper-1" },
  ];
  const kept = filterGradingCandidates("openrouter", catalogue);
  assert.deepEqual(kept.sort(), ["anthropic/claude-sonnet-4.5", "google/gemini-2.5-flash"]);
});

test("a model with no declared modalities is kept, because refusing is worse than trying", () => {
  // OpenRouter does not always publish modalities for a new model. Dropping it would
  // block a working setup; the request path still refuses a known text-only family.
  const kept = filterGradingCandidates("openrouter", [{ id: "newco/vision-experimental-1" }]);
  assert.deepEqual(kept, ["newco/vision-experimental-1"]);
});

test("the model picker keeps a manually typed OpenRouter id", () => {
  const options = mergeModelOptions("openrouter", FALLBACK_MODEL_OPTIONS.openrouter, ["newco/brand-new-2099"]);
  assert.ok(options.includes("newco/brand-new-2099"));
  assert.ok(options.includes(RECOMMENDED_MODELS.openrouter));
  assert.equal(new Set(options).size, options.length);
});

test("every surface that must know about OpenRouter actually does", async () => {
  const fs = await import("node:fs");
  const checks: Array<[string, RegExp]> = [
    ["lib/server/providers.ts", /input\.provider === "openrouter"\) return callOpenRouter\(input\)/],
    ["lib/server/providers.ts", /openrouterBaseUrl\("|export function openrouterBaseUrl/],
    ["lib/server/provider-models.ts", /openrouter: \(egress\) => `\$\{openrouterBaseUrl\(egress\)\}\/models`/],
    ["app/api/provider/test/route.ts", /openrouterBaseUrl\(stored\.egress\)/],
    ["app/api/provider/models/route.ts", /provider === "openrouter"/],
    ["app/api/admin/network-diagnostics/route.ts", /openrouter\.ai\/api\/v1\/models/],
  ];
  for (const [file, pattern] of checks) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    assert.match(text, pattern, `${file} must handle OpenRouter`);
  }
});

test("an egress host meant for Kaya is never applied to OpenRouter silently", async () => {
  // The stored host override is how the operator points the app at a Kaya mirror. Left
  // set while switching to OpenRouter, it would send the sheet to that mirror instead:
  // a different company and a different bill. The app honours the setting — it is an
  // explicit choice, and a legitimate OpenRouter mirror exists — but it must say so.
  const { openRouterHostWarning } = await import("../lib/server/provider-config");
  assert.equal(openRouterHostWarning("kaya", { host: "mirror.example", bindAddress: "" }), null, "only OpenRouter is warned about");
  assert.equal(openRouterHostWarning("openrouter", { host: "", bindAddress: "" }), null, "no override, nothing to say");
  assert.equal(openRouterHostWarning("openrouter", { host: "https://openrouter.ai/api/v1", bindAddress: "" }), null, "the vendor host is correct");
  assert.equal(openRouterHostWarning("openrouter", { host: "http://127.0.0.1:4010/api/v1", bindAddress: "" }), null, "a local stand-in is a deliberate test");
  const warning = openRouterHostWarning("openrouter", { host: "https://kaya-mirror.example/api", bindAddress: "" });
  assert.ok(warning, "a foreign host must produce a warning");
  assert.match(warning as string, /openrouter\.ai/, "the warning must name the host it should have used");
  assert.match(warning as string, /kaya-mirror\.example/, "the warning must name the host it is actually using");
});

test("the warning is shown in the panel, not only raised in code", async () => {
  const fs = await import("node:fs");
  const route = fs.readFileSync(path.join(root, "app", "api", "provider", "route.ts"), "utf8");
  assert.match(route, /openRouterHostWarning\(/, "the status route must surface the warning");
});

test("reach checks OpenRouter as its own destination, and needs no key to do it", async () => {
  // The catalogue endpoint is public: one GET proves reachability and spends nothing.
  // This matters more for OpenRouter than for the Iranian gateways, because it sits on a
  // different domain that a filtered host may not open at all.
  const fs = await import("node:fs");
  const script = fs.readFileSync(path.join(root, "scripts", "nomreh-reachability.cjs"), "utf8");
  assert.match(script, /label: "OpenRouter API", host: "openrouter\.ai", path: "\/api\/v1\/models"/);
  assert.match(script, /--openrouter/);
});
