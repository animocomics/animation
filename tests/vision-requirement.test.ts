import assert from "node:assert/strict";
import test from "node:test";
import { isVisionRejection } from "../lib/server/providers";

/**
 * The model that cannot see.
 *
 * `gapgpt` + `deepseek-v4.1-flash` was a valid, reachable, paid configuration that
 * could never read a photographed sheet: the model takes text only, so every request
 * carrying an image was refused — and the panel showed one generic sentence. The
 * operator then changed keys and providers, spending each time. These are the exact
 * refusals the gateway can return, and the ones that must not be mistaken for them.
 */
test("a text-only model's refusal to take an image is recognised", () => {
  assert.equal(isVisionRejection(400, "Invalid type for 'messages[0].content[1]': expected 'text', but got 'image_url'."), true);
  assert.equal(isVisionRejection(400, "messages[0].content: image input is not supported for this model"), true);
  assert.equal(isVisionRejection(422, "This model does not support image input."), true);
  assert.equal(isVisionRejection(400, "only supports text prompts"), true);
});

test("unrelated 400s are not read as a vision problem", () => {
  assert.equal(isVisionRejection(400, "User location is not supported for the API use."), false);
  assert.equal(isVisionRejection(400, "API key not valid."), false);
  assert.equal(isVisionRejection(429, "image input is not supported"), false, "a quota error is not a capability error");
  assert.equal(isVisionRejection(500, "invalid image"), false);
});

test("the catalogue no longer offers models that declare themselves text-only", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../lib/server/provider-models.ts", import.meta.url), "utf8");
  assert.match(source, /record\.input_modalities\?\.length && !record\.input_modalities\.includes\("image"\)/,
    "a declared text-only model must not reach the picker");
});

test("a teacher is not told the service is unconfigured when the model is blind", async () => {
  const { teacherSafeError } = await import("../lib/server/teacher-safe-error");
  const error = Object.assign(new Error("مدل انتخاب‌شده تصویر نمی‌پذیرد (مدل متنی است) و برگه‌ها تصویر هستند. کلید و اعتبار درست است؛ فقط مدل باید عوض شود."), { status: 400, reason: "vision-required" });
  const safe = teacherSafeError(error);
  assert.equal(safe.retryable, false, "sending the same sheet again cannot help");
  assert.match(safe.error, /نمی‌تواند تصویر برگه را بخواند/);
  assert.doesNotMatch(safe.error, /تنظیم سرویس هوش مصنوعی سامانه کامل نیست/, "the service is configured; the model is the problem");
});

test("the mapping survives a zero-width non-joiner inside the sentence", async () => {
  const { teacherSafeError } = await import("../lib/server/teacher-safe-error");
  // The same sentence, written with a ZWNJ (U+200C) in a different place.
  const withZwnj = Object.assign(new Error("مدل انتخاب\u200cشده تصویر نمی\u200cپذیرد (مدل متنی است)"), { status: 400 });
  const safe = teacherSafeError(withZwnj);
  assert.equal(safe.code, "vision-required");
  // And the structured reason alone is enough, even if the wording changes entirely.
  const byReason = Object.assign(new Error("whatever words the provider used"), { status: 400, reason: "vision-required" });
  assert.equal(teacherSafeError(byReason).code, "vision-required");
});
