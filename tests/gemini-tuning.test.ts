import test from "node:test";
import assert from "node:assert/strict";
import { geminiMediaResolution, geminiThinkingConfig } from "../lib/server/providers";

/**
 * The two settings that decide whether Gemini actually sees the page, and how fast it
 * answers. Both were previously absent, so the API used its own defaults: an image
 * budget small enough to lose a fraction bar, and dynamic thinking that spends seconds
 * on transcription.
 */
function withEnv<T>(env: Record<string, string | undefined>, run: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key] as string;
  }
  try {
    return run();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key] as string;
    }
  }
}

test("page images reach Gemini 3+ at high detail by default", () => {
  const level = withEnv({ NOMREH_GEMINI_MEDIA_RESOLUTION: undefined }, () => geminiMediaResolution("gemini-3.7-flash"));
  assert.equal(level, "MEDIA_RESOLUTION_HIGH");
});

test("the operator can ask for more detail when handwriting is dense", () => {
  const level = withEnv({ NOMREH_GEMINI_MEDIA_RESOLUTION: "ultra_high" }, () => geminiMediaResolution("gemini-3.7-flash"));
  assert.equal(level, "MEDIA_RESOLUTION_ULTRA_HIGH");
});

test("an unknown value falls back to high instead of sending nonsense", () => {
  const level = withEnv({ NOMREH_GEMINI_MEDIA_RESOLUTION: "maximum" }, () => geminiMediaResolution("gemini-3.7-flash"));
  assert.equal(level, "MEDIA_RESOLUTION_HIGH");
});

test("older models do not receive a field they reject", () => {
  assert.equal(geminiMediaResolution("gemini-2.0-flash"), null);
});

test("thinking is minimal by default, because reading a form is not reasoning", () => {
  assert.deepEqual(withEnv({ NOMREH_GEMINI_THINKING: undefined }, () => geminiThinkingConfig("gemini-3.7-flash")), { thinkingLevel: "low" });
  assert.deepEqual(withEnv({ NOMREH_GEMINI_THINKING: undefined }, () => geminiThinkingConfig("gemini-2.5-flash")), { thinkingBudget: 0 });
});

test("a slower, more careful mode is available on request", () => {
  assert.deepEqual(withEnv({ NOMREH_GEMINI_THINKING: "high" }, () => geminiThinkingConfig("gemini-2.5-flash")), { thinkingBudget: 2048 });
  assert.deepEqual(withEnv({ NOMREH_GEMINI_THINKING: "high" }, () => geminiThinkingConfig("gemini-3.7-flash")), { thinkingLevel: "high" });
  assert.equal(withEnv({ NOMREH_GEMINI_THINKING: "off" }, () => geminiThinkingConfig("gemini-3.7-flash")), null);
});
