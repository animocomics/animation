import test from "node:test";
import assert from "node:assert/strict";
import { teacherSafeError } from "../lib/server/teacher-safe-error";
import { scrubSecret } from "../lib/server/provider-failure-log";

const FORBIDDEN = /kaya|gemini|deepseek|openai|z\.ai|minimax|inkling|mistral|UND_ERR|ECONN|ETIMEDOUT|sk-|Bearer|HTTP \d{3}|\d+\.\d+\.\d+\.\d+/i;

test("a teacher never sees the vendor, the model or a socket code", () => {
  const cases: unknown[] = [
    Object.assign(new Error("ارتباط با Kaya AI برای مدل deepseek/deepseek-v4.1-flash برقرار نشد."), { status: 502 }),
    Object.assign(new Error("UND_ERR_CONNECT_TIMEOUT"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }),
    Object.assign(new Error("کلید Kaya AI پذیرفته نشد؛ کلید را بررسی کنید."), { status: 400 }),
    Object.assign(new Error("اعتبار حساب Kaya AI کافی نیست."), { status: 402 }),
    Object.assign(new Error("Gemini rejected the request"), { code: "HTTP_500" }),
    new Error("fetch failed"),
  ];
  for (const error of cases) {
    const safe = teacherSafeError(error);
    assert.ok(!FORBIDDEN.test(safe.error), `leaked detail: ${safe.error}`);
    assert.ok(safe.error.length > 10, "the teacher needs an actionable sentence");
    assert.equal(typeof safe.retryable, "boolean");
  }
});

test("upload limits stay visible because they concern the teacher's own file", () => {
  const tooBig = new Error("فایل «a.pdf» بزرگ‌تر از ۱۰۰ مگابایت است.");
  assert.match(teacherSafeError(tooBig).error, /۱۰۰ مگابایت/);
});

test("network failures are marked retryable and credit problems are not", () => {
  assert.equal(teacherSafeError(Object.assign(new Error("x"), { code: "ECONNRESET" })).retryable, true);
  assert.equal(teacherSafeError(Object.assign(new Error("اعتبار"), { status: 402 })).retryable, false);
});

test("the admin failure log scrubs every secret shape", () => {
  const dirty = "Authorization: Bearer sk-llm-abcdef123456 and AIzaSyABCDEFGHIJKLMNOP and Bearer eyJhbGciOi.abc.def";
  const clean = scrubSecret(dirty);
  assert.ok(!/sk-llm-|AIzaSy[A-Za-z0-9]{10}/.test(clean), `secret leaked: ${clean}`);
});
