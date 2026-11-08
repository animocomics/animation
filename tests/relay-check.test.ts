import test from "node:test";
import assert from "node:assert/strict";
import { checkGeminiRelay, relayBaseUrl } from "../lib/server/relay-check";

function respond(body: string, status: number): typeof fetch {
  return (async () =>
    new Response(body, { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

const GOOGLE_INVALID_KEY = JSON.stringify({
  error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" },
});

test("an unset relay is reported as unset, not as a failure", async () => {
  const result = await checkGeminiRelay({ baseUrl: null });
  assert.equal(result.configured, false);
  assert.equal(result.layer, "unset");
  assert.match(result.detail, /مستقیم/);
});

test("trailing slashes are stripped once, so the path is never doubled", async () => {
  assert.equal(relayBaseUrl({ NOMREH_GEMINI_BASE_URL: "https://relay.example.workers.dev///" } as unknown as NodeJS.ProcessEnv), "https://relay.example.workers.dev");
  assert.equal(relayBaseUrl({ NOMREH_GEMINI_BASE_URL: "  " } as unknown as NodeJS.ProcessEnv), null);
});

test("Google answering through the relay is success, even though the key was refused", async () => {
  let seen = "";
  const fake = (async (url: string) => {
    seen = String(url);
    return new Response(GOOGLE_INVALID_KEY, { status: 400 });
  }) as unknown as typeof fetch;
  const result = await checkGeminiRelay({ baseUrl: "https://relay.example.workers.dev", fetchImpl: fake });
  assert.equal(result.reachable, true);
  assert.equal(result.layer, "google");
  assert.equal(seen, "https://relay.example.workers.dev/v1beta/models");
});

test("a relay that still trips the country block is called out by name", async () => {
  const fake = respond(JSON.stringify({ error: { message: "User location is not supported for the API use." } }), 400);
  const result = await checkGeminiRelay({ baseUrl: "https://relay.example.workers.dev", fetchImpl: fake });
  assert.equal(result.reachable, false);
  assert.match(result.detail, /Deploy/);
});

test("a wrong worker name is attributed to Cloudflare, not to Google", async () => {
  const fake = respond("<!doctype html><html><body>There is nothing here yet</body></html>", 404);
  const result = await checkGeminiRelay({ baseUrl: "https://nope.workers.dev", fetchImpl: fake });
  assert.equal(result.reachable, false);
  assert.equal(result.layer, "cloudflare");
});

test("a dead address is a network failure with the address named", async () => {
  const fake = (async () => {
    throw new Error("getaddrinfo ENOTFOUND nope.workers.dev");
  }) as unknown as typeof fetch;
  const result = await checkGeminiRelay({ baseUrl: "https://nope.workers.dev", fetchImpl: fake });
  assert.equal(result.layer, "network");
  assert.match(result.detail, /ENOTFOUND/);
});
