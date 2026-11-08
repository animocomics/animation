import assert from "node:assert/strict";
import test from "node:test";
import { taskNeedsVision, textOnlyMessage, textOnlyReason } from "../lib/server/vision-capability";

/**
 * The operator's own report: provider gapgpt, model deepseek-v4.1-flash, a single
 * page, "the draft was not built". DeepSeek chat models take no image input, so the
 * page could never be read — no key, model-name spelling or file change was going to
 * fix it, and each attempt was billed. The app must refuse locally and say why.
 */
test("a model that cannot see is named before anything is sent", () => {
  assert.match(textOnlyReason("deepseek-v4.1-flash") || "", /تصویر/);
  assert.match(textOnlyReason("deepseek/deepseek-v4.1-flash") || "", /تصویر/);
  assert.ok(textOnlyReason("gpt-oss-120b"));
  assert.equal(textOnlyReason("gemini-2.5-flash"), null, "a vision model must never be blocked");
  assert.equal(textOnlyReason("gpt-4o"), null);
  assert.equal(textOnlyReason("claude-sonnet-5.5"), null);
});

test("the refusal explains the fix and that it cost nothing", () => {
  const message = textOnlyMessage("deepseek-v4.1-flash", "مدل‌های DeepSeek ورودی تصویر را قبول نمی‌کنند");
  assert.match(message, /تصویر/);
  assert.match(message, /هزینه‌ای پرداخت نشود/);
  assert.match(message, /پنل ادمین/);
});

test("only work that carries files needs vision", () => {
  assert.equal(taskNeedsVision("question-import", true), true);
  assert.equal(taskNeedsVision("grading", true), true);
  assert.equal(taskNeedsVision("question-import", false), false, "a text-only task is still allowed");
  assert.equal(taskNeedsVision(undefined, true), false);
});

test("the panel verdict uses the same list the request path enforces", async () => {
  const { visionVerdict } = await import("../lib/server/vision-capability");
  assert.equal(visionVerdict("deepseek-v4.1-flash"), "no", "blocked here must be blocked in the panel");
  assert.equal(visionVerdict("gemini-2.5-flash"), "yes");
  assert.equal(visionVerdict("gpt-4o"), "yes");
  // An id nobody recognises is a look-twice, not a block.
  assert.equal(visionVerdict("some-new-model"), "unknown");
});
