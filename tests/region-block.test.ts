import assert from "node:assert/strict";
import test from "node:test";
import { isRegionBlocked } from "../lib/server/providers";
import { markRegionBlocked, resetRegionBlocks, regionBlockWarning, clearRegionBlocked } from "../lib/server/region-block";
import { teacherSafeError } from "../lib/server/teacher-safe-error";

/**
 * "User location is not supported for the API use."
 *
 * Google returns this as a 400 to a server in a country it does not serve. It has
 * nothing to do with the key, model, file or credit, and no retry changes it — yet the
 * generic handlers turned it into "the request was rejected, check the key" or
 * "temporarily unavailable, try again", which sent the operator back to pay for the
 * same refusal. These tests pin the exact wording to the exact answer.
 */
test("Google's country refusal is recognised in the shapes it arrives in", () => {
  assert.equal(isRegionBlocked(400, "User location is not supported for the API use."), true);
  assert.equal(isRegionBlocked(400, "user location is not supported for the API use"), true);
  assert.equal(isRegionBlocked(403, "Unsupported country: IR"), true);
  assert.equal(isRegionBlocked(400, "API key not valid. Please pass a valid API key."), false, "a key problem must not be read as a region block");
  assert.equal(isRegionBlocked(429, "Quota exceeded"), false);
  assert.equal(isRegionBlocked(500, "User location is not supported"), false, "a 5xx is not this case");
});

test("a teacher is told to stop, not to wait", () => {
  const safe = teacherSafeError(Object.assign(new Error("Google Gemini درخواست این سرور را از نظر کشور مبدأ نپذیرفت (User location is not supported)."), { status: 400 }));
  assert.equal(safe.retryable, false, "retrying is billed and useless");
  assert.match(safe.error, /کشور مبدأ/);
  assert.doesNotMatch(safe.error, /موقتاً|چند دقیقهٔ دیگر/, "must not invite another attempt");
});

test("the panel remembers which provider already refused this host", () => {
  resetRegionBlocks();
  assert.equal(regionBlockWarning("gemini"), null, "nothing to warn about before it happens");
  markRegionBlocked("gemini", "User location is not supported for the API use.");
  assert.match(regionBlockWarning("gemini") || "", /کشور مبدأ/);
  assert.equal(regionBlockWarning("gapgpt"), null, "another provider is unaffected");
  clearRegionBlocked("gemini");
  assert.equal(regionBlockWarning("gemini"), null, "a working call clears the warning");
});
