import assert from "node:assert/strict";
import test from "node:test";
import { Resolver } from "node:dns/promises";
import { FALLBACK_MODEL_OPTIONS, mergeModelOptions, RECOMMENDED_MODELS } from "../lib/provider-catalog";
import { discoverProviderModels, providerResponseError } from "../lib/server/provider-models";

async function mockFetch(handler: (url: string, init: RequestInit) => Promise<Response> | Response, run: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init || {})) as typeof fetch;
  try { await run(); } finally { globalThis.fetch = original; }
}

test("current offline catalog includes Gemini 3.7, 3.8 and 4 with free-tier 3.8 recommended", () => {
  assert.equal(RECOMMENDED_MODELS.gemini, "gemini-3.8-flash");
  for (const id of ["gemini-3.7-flash", "gemini-3.8-flash", "gemini-4-argon"]) assert.ok(FALLBACK_MODEL_OPTIONS.gemini.includes(id));
  assert.ok(FALLBACK_MODEL_OPTIONS.openai.includes("gpt-6.1-terra"));
  assert.ok(FALLBACK_MODEL_OPTIONS.inkling.includes("thinkingmachines/Inkling:peft:262144:sampling-nvfp4"));
});

test("live account discovery extends rather than replaces every legacy model option", () => {
  const legacy = ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-1.5-pro", "gpt-4.1", "gpt-4o"];
  const gemini = mergeModelOptions("gemini", FALLBACK_MODEL_OPTIONS.gemini, ["gemini-future-vision"], legacy);
  for (const id of [...legacy.filter((id) => id.startsWith("gemini-")), "gemini-3.8-flash", "gemini-future-vision"]) assert.ok(gemini.includes(id));
  const openai = mergeModelOptions("openai", FALLBACK_MODEL_OPTIONS.openai, ["gpt-future-vision"], legacy);
  for (const id of ["gpt-4.1", "gpt-4o", "gpt-6.1-terra", "gpt-future-vision"]) assert.ok(openai.includes(id));
});

test("Gemini account discovery follows pagination and keeps text-output GenerateContent models only", async () => {
  const urls: string[] = [];
  await mockFetch((url, init) => {
    urls.push(url);
    assert.equal((init.headers as Record<string, string>)["x-goog-api-key"], "free-gemini-key");
    if (!url.includes("pageToken=next")) return Response.json({
      models: [
        { name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-3.8-flash-tts", supportedGenerationMethods: ["generateContent"] },
        { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
      ],
      nextPageToken: "next",
    });
    return Response.json({
      models: [
        { name: "models/gemini-4-argon", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-3.1-flash-image", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-3.8-live", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-3.1-pro-preview", supportedGenerationMethods: ["generateContent"] },
      ],
    });
  }, async () => {
    const models = await discoverProviderModels({ provider: "gemini", apiKey: "free-gemini-key" });
    assert.deepEqual(models, ["gemini-3.8-flash", "gemini-4-argon", "gemini-3.1-pro-preview"]);
    assert.equal(urls.length, 2);
    assert.ok(urls[0].includes("pageSize=1000"));
    assert.ok(urls[1].includes("pageToken=next"));
  });
});

test("OpenAI, DeepSeek, MiniMax and Mistral discovery excludes incompatible output or modality models", async () => {
  await mockFetch((url) => {
    if (url.includes("openai")) return Response.json({ data: [
      { id: "gpt-6.1-terra" }, { id: "gpt-image-2.5-sunburst" }, { id: "gpt-realtime-2.1" }, { id: "text-embedding-3-large" },
    ] });
    if (url.includes("deepseek")) return Response.json({ data: [
      { id: "deepseek-flash", input_modalities: ["text", "image"], output_modalities: ["text"] },
      { id: "deepseek-v4-pro", input_modalities: ["text"], output_modalities: ["text"] },
    ] });
    if (url.includes("minimax")) return Response.json({ data: [{ id: "MiniMax-M3.1-Flash" }, { id: "speech-2.8-hd" }, { id: "image-01" }] });
    return Response.json({ data: [
      { id: "mistral-large-4", capabilities: { completion_chat: true, vision: true } },
      { id: "text-only-model", capabilities: { completion_chat: true, vision: false } },
    ] });
  }, async () => {
    assert.deepEqual(await discoverProviderModels({ provider: "openai", apiKey: "openai-test-key" }), ["gpt-6.1-terra"]);
    assert.deepEqual(await discoverProviderModels({ provider: "deepseek", apiKey: "deepseek-test-key" }), ["deepseek-flash"]);
    assert.deepEqual(await discoverProviderModels({ provider: "minimax", apiKey: "minimax-test-key" }), ["MiniMax-M3.1-Flash"]);
    assert.deepEqual(await discoverProviderModels({ provider: "mistral", apiKey: "mistral-test-key" }), ["mistral-large-4"]);
  });
});

test("Gemini errors explain unrestricted standard keys and free quota instead of hiding Google's response", async () => {
  const unrestricted = await providerResponseError(Response.json({ error: { message: "Unrestricted standard API keys are not supported." } }, { status: 400 }), "gemini", "secret-free-key");
  assert.match(unrestricted.message, /Auth Key/);
  assert.match(unrestricted.message, /رایگان/);
  const quota = await providerResponseError(Response.json({ error: { message: "Quota exceeded" } }, { status: 429 }), "gemini", "secret-free-key");
  assert.match(quota.message, /سهمیهٔ رایگان/);
  assert.equal(quota.status, 429);
});

test("model discovery uses the scoped Shecan dispatcher when enabled", async () => {
  const originalResolve = Resolver.prototype.resolve4;
  let dispatcher: unknown;
  Resolver.prototype.resolve4 = (async () => [{ address: "203.0.113.80", ttl: 60 }]) as unknown as typeof Resolver.prototype.resolve4;
  await mockFetch((_url, init) => {
    dispatcher = (init as RequestInit & { dispatcher?: unknown }).dispatcher;
    return Response.json({ models: [{ name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent"] }] });
  }, async () => {
    await discoverProviderModels({
      provider: "gemini",
      apiKey: "free-gemini-key",
      network: { enabled: true, plan: "free", servers: ["198.51.100.80", "198.51.100.81"] },
    });
    assert.ok(dispatcher, "provider model discovery must not bypass Shecan");
  });
  Resolver.prototype.resolve4 = originalResolve;
});
