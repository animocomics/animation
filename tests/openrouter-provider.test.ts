import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
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

test("a 403 is never reported as an invalid key — the key that listed 274 models proved itself", async () => {
  // This is the operator's exact report: the panel read 274 models from the account and
  // then said "the key is not valid" for the same key. OpenRouter uses 401 for a bad key
  // and 403 for a policy/scope refusal, so the two must not share a sentence.
  const { providerHttpRefusal } = await import("../lib/server/providers");
  const forbidden = providerHttpRefusal("openrouter", 403, "Provider returned error: content policy", "google/gemini-2.5-flash");
  assert.equal(forbidden.status, 400);
  assert.equal(forbidden.reason, "forbidden");
  assert.doesNotMatch(forbidden.message, /کلید معتبر نیست/, "a 403 must never claim the key is invalid");
  assert.match(forbidden.message, /کلید معتبر است|معتبر است/, "it must say the key itself is fine");
  assert.match(forbidden.message, /content policy/, "the service's own words must reach the operator");

  const unauthorized = providerHttpRefusal("openrouter", 401, "Invalid API key", "google/gemini-2.5-flash");
  assert.match(unauthorized.message, /401/);
  assert.match(unauthorized.message, /sk-or-/, "the fix must be concrete: what an OpenRouter key looks like");
});

test("a free model's limits are named as the model's, not the key's", async () => {
  const { providerHttpRefusal, isFreeModel } = await import("../lib/server/providers");
  assert.equal(isFreeModel("meta-llama/llama-3.3-70b-instruct:free"), true);
  assert.equal(isFreeModel("google/gemini-2.5-flash"), false);

  const limited = providerHttpRefusal("openrouter", 429, "Rate limit exceeded: free-models-per-day", "meta-llama/llama-3.3-70b-instruct:free");
  assert.equal(limited.status, 429);
  assert.match(limited.message, /رایگان/, "the free tier must be named");
  // A daily free-tier cap is not lifted by a small top-up, so the message must say what the
  // real reset is (midnight UTC) instead of advising a purchase as the fix.
  assert.match(limited.message, /۰۰:۰۰ UTC/, "the real reset time must be named");
  assert.doesNotMatch(limited.message, /کلید معتبر نیست/);

  const credit = providerHttpRefusal("openrouter", 402, "Insufficient credits", "meta-llama/llama-3.3-70b-instruct:free");
  assert.equal(credit.status, 402);
  assert.match(credit.message, /برداشته شده|رایگان/, "a free model that suddenly wants credit must be explained");
});

test("the connection test and the sheet read the same refusal table", async () => {
  const fs = await import("node:fs");
  const models = fs.readFileSync(path.join(root, "lib", "server", "provider-models.ts"), "utf8");
  const providers = fs.readFileSync(path.join(root, "lib", "server", "providers.ts"), "utf8");
  assert.match(models, /providerHttpRefusal\("openrouter", response\.status, rawMessage, model\)/, "the test button must use the shared table with the model");
  assert.match(providers, /providerHttpRefusal\("openrouter", status, openRouterDetail \|\| detail \|\| safe, model\)/, "the sheet path must use it with the model and the real cause");
  const testRoute = fs.readFileSync(path.join(root, "app", "api", "provider", "test", "route.ts"), "utf8");
  assert.match(testRoute, /providerResponseError\(response, input\.provider, apiKey, input\.model\)/, "the test route must pass the model so a free-tier cap is named");
});

test("the connection test sends a picture, so a blind model cannot pass it", async () => {
  const fs = await import("node:fs");
  const route = fs.readFileSync(path.join(root, "app", "api", "provider", "test", "route.ts"), "utf8");
  assert.match(route, /VISION_TEST_IMAGE/, "the test must include an image");
  assert.match(route, /image_url/, "it must use the multimodal content shape");
  assert.match(route, /!\s*\/7\|هفت\/\.test\(text\)/, "the answer must be checked, not just the status");
  // The embedded PNG must be a real PNG: an invented base64 string is a decoder crash
  // waiting to happen (it was one), so the signature is asserted on the decoded bytes.
  const match = route.match(/data:image\/png;base64,([A-Za-z0-9+/=]+)/);
  assert.ok(match, "a base64 PNG must be embedded");
  const bytes = Buffer.from(match[1], "base64");
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "the embedded image must be a real PNG");
  assert.ok(bytes.length > 200, "a real PNG, not a placeholder");
});

test("the operator's exact 429: 'Provider returned error' on a brand-new free model is NOT a daily cap", async () => {
  // Reported verbatim: "من تا حالا ازش استفاده نکردم" — a first request on a :free model,
  // answered with the surface text "Provider returned error". The real sentence was inside
  // error.metadata.raw: "<model>:free is temporarily rate-limited upstream". Our message
  // claimed the daily quota was finished, which is a different cause and the wrong advice.
  const { openRouterErrorDetail, openRouterLimitSource, providerHttpRefusal } = await import("../lib/server/providers");
  const body = {
    error: {
      message: "Provider returned error",
      code: 429,
      metadata: {
        raw: "google/gemma-4-31b-it:free is temporarily rate-limited upstream. Please retry shortly, or add your own key.",
        provider_name: "Google AI Studio",
        limit_source: "upstream_provider_shared_pool",
      },
    },
  };
  const detail = openRouterErrorDetail(body);
  assert.match(detail, /rate-limited upstream/, "the real cause must be extracted from metadata.raw");
  assert.match(detail, /Google AI Studio/, "the upstream host must be named");
  assert.equal(openRouterLimitSource(detail), "upstream");

  const error = providerHttpRefusal("openrouter", 429, detail, "google/gemma-4-31b-it:free");
  assert.equal(error.reason, "upstream-busy");
  assert.match(error.message, /سهمیهٔ حساب شما دست‌نخورده/, "it must say the operator's quota is fine");
  assert.match(error.message, /مدل دیگری انتخاب کنید/, "the action that helps: switch model");
  assert.doesNotMatch(error.message, /سهمیهٔ روزانهٔ مدل‌های رایگان حساب شما تمام شده/, "never claim a daily cap on an upstream refusal");
  assert.doesNotMatch(error.message, /تا فردا صبر/, "waiting is the wrong advice here");
});

test("each limit names itself, and an unlabelled one claims nothing", async () => {
  const { openRouterLimitSource, providerHttpRefusal } = await import("../lib/server/providers");
  const daily = providerHttpRefusal("openrouter", 429, "Rate limit exceeded: free-models-per-day", "x/y:free");
  assert.equal(daily.reason, "free-daily-cap");
  assert.match(daily.message, /۰۰:۰۰ UTC/, "the reset time must be concrete");
  const minute = providerHttpRefusal("openrouter", 429, "Rate limit exceeded: free-models-per-minute", "x/y:free");
  assert.equal(minute.reason, "free-minute-cap");
  assert.equal(openRouterLimitSource("something happened, nobody said what"), "unknown");
  const unknown = providerHttpRefusal("openrouter", 429, "something happened", "x/y:free");
  assert.doesNotMatch(unknown.message, /تمام شده/, "with no cause stated, no cause is claimed");
  assert.match(unknown.message, /لزوماً تمام نیست/);
});

test("free vision models are offered first, each from a different host", () => {
  // A 429 on a free model is usually one upstream host being full, so a single hard-coded
  // free model is the wrong default. The suggestions lead with free entries from distinct
  // vendors and end with the router's own free slot.
  const free = FALLBACK_MODEL_OPTIONS.openrouter.filter((id) => /:free$/.test(id));
  assert.ok(free.length >= 3, `expected several free suggestions, got ${free.length}`);
  const vendors = new Set(free.map((id) => id.split("/")[0]));
  assert.ok(vendors.size >= 3, "free suggestions must not all come from one upstream vendor");
  assert.equal(FALLBACK_MODEL_OPTIONS.openrouter.at(-1), "openrouter/free", "the router's free slot is the last resort");
});

test("the router's own free slot survives the vision filter", () => {
  // It is not one model and declares no modalities; dropping it would remove the only
  // suggestion that cannot be pinned to one saturated host.
  const kept = filterGradingCandidates("openrouter", [{ id: "openrouter/free" }, { id: "openai/whisper-1" }]);
  assert.deepEqual(kept, ["openrouter/free"]);
});

test("a free model's upstream 429 falls back to another free model, never a paid one", async () => {
  // Proven end to end against a stand-in earlier; this pins the rule. The substitution must
  // stay inside the free tier: choosing a paid model on the operator's behalf would spend
  // money nobody authorised, which is the one thing that must never happen silently.
  const { openRouterFallbacksFor, OPENROUTER_FREE_FALLBACKS } = await import("../lib/provider-catalog");
  for (const id of OPENROUTER_FREE_FALLBACKS) {
    assert.ok(/:free$/.test(id) || id === "openrouter/free", `${id} must be free`);
  }
  const next = openRouterFallbacksFor("google/gemma-3-27b-it:free");
  assert.ok(next.length >= 1 && next.length <= 3, "a bounded number of attempts");
  assert.ok(!next.includes("google/gemma-3-27b-it:free"), "never retry the model that just failed");
  assert.ok(next.every((id) => id === "openrouter/free" || /:free$/.test(id)), "fallbacks stay free");
});

test("a free model is asked not to think first, because its thinking eats the answer budget", async () => {
  // Every free OpenRouter model reasons before answering, and the reasoning is charged to
  // the same max_tokens. The reported symptom — HTTP 200 with nothing visible on Nemotron —
  // is that budget running out mid-thought, not a broken key. Reading a form is
  // transcription, so the free tier is asked to skip the thinking.
  const source = readFileSync(new URL("../lib/server/providers.ts", import.meta.url), "utf8");
  assert.match(source, /isFreeModel\(model\) \? \{ reasoning: \{ enabled: false \} \}/, "free models must be asked for no reasoning");
  assert.match(source, /reasoningAllowedBody/, "a model that refuses must be retried with thinking allowed");
  assert.match(source, /"empty-answer"/, "an empty answer needs its own reason, not a generic 502");
});

test("an empty free-model answer is retried on another free model, not blamed on the key", async () => {
  const { openRouterFallbacksFor } = await import("../lib/provider-catalog");
  // The retry list is the same one used for an upstream 429, and it stays free.
  assert.ok(openRouterFallbacksFor("nvidia/nemotron-3-ultra-550b-a55b:free").length > 0);
});

test("a Gemini quota 429 says the key is fine and which limit it was", async () => {
  const { geminiRefusal } = await import("../lib/server/providers");
  const day = geminiRefusal(429, "Quota exceeded for quota metric 'generate_content_free_tier_requests' and limit 'GenerateRequestsPerDayPerProjectPerModel-FreeTier'.");
  assert.equal(day.status, 429);
  assert.equal(day.reason, "gemini-quota");
  assert.match(day.message, /روزانه/, "a per-day quota must say so");
  assert.match(day.message, /کلید شما سالم است/, "and must not implicate the key");
  const minute = geminiRefusal(429, "generate_requests_per_minute");
  assert.match(minute.message, /دقیقه‌ای/, "a per-minute quota must say so");
});

test("Gemini's country block and a bad key are told apart", async () => {
  const { geminiRefusal } = await import("../lib/server/providers");
  assert.equal(geminiRefusal(400, "User location is not supported for the API use.").reason, "region-blocked");
  assert.equal(geminiRefusal(403, "API key not valid. Please pass a valid API key.").reason, "auth");
  assert.equal(geminiRefusal(404, "models/gemini-9 is not found").reason, "model-not-found");
});

test("the relay host is used for reading, for the model list and for the connection test", async () => {
  // A relay that only the grading call honours is worse than none: the model list and the
  // test button would still hit Google directly and disagree with the read.
  const providers = readFileSync(new URL("../lib/server/providers.ts", import.meta.url), "utf8");
  const models = readFileSync(new URL("../lib/server/provider-models.ts", import.meta.url), "utf8");
  const testRoute = readFileSync(new URL("../app/api/provider/test/route.ts", import.meta.url), "utf8");
  assert.match(providers, /export function geminiBaseUrl/, "one owner for the Gemini host");
  assert.match(models, /gemini: \(\) => `\$\{geminiBaseUrl\(\)\}/, "discovery must follow the relay");
  assert.match(testRoute, /geminiBaseUrl\(\)/, "the test button must follow the relay");
});

test("one sheet's real token cost is stated, so a free tier can be planned", async () => {
  const { geminiSheetTokenEstimate } = await import("../lib/provider-catalog");
  // Measured on the operator's own sheet: 15 line parts at ~1,120 tokens each.
  assert.equal(geminiSheetTokenEstimate(15), 15 * 1120 + 2500);
  assert.ok(geminiSheetTokenEstimate(15) > 15_000, "a sheet is tens of thousands of input tokens, not hundreds");
});

test("a blocked Google IP is not reported as a broken key", async () => {
  const { geminiRefusal, isGoogleHtmlRefusal } = await import("../lib/server/providers");
  const html = '<!DOCTYPE html><html><title>Error 403 (Forbidden)!!1</title><p>403. That&#39;s an error.</p><ins>Your client does not have permission to get URL /v1beta/models from this server.</ins></html>';
  assert.equal(isGoogleHtmlRefusal(403, html), true, "the HTML page is the signature");
  assert.equal(isGoogleHtmlRefusal(403, '{"error":{"message":"API key not valid"}}'), false, "JSON says nothing about an IP");
  const blocked = geminiRefusal(403, html);
  assert.equal(blocked.reason, "ip-blocked");
  assert.match(blocked.message, /محدودیت IP است، نه کلید/, "the key must be cleared, not blamed");
  // The same status with a JSON key error must still be an auth failure.
  assert.equal(geminiRefusal(403, '{"error":{"message":"API key not valid. Please pass a valid API key."}}').reason, "auth");
});
