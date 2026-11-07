import assert from "node:assert/strict";
import test from "node:test";
import { MAX_FILE_SIZE_BYTES, MAX_FILE_BASE64_LENGTH } from "../lib/file-constraints";
import { saveUserFile } from "../lib/server/file-storage";
import {
  buildQuestionImportPrompt,
  importNotesOf,
  normalizeImportedQuestions,
  QuestionImportValidationError,
  questionImportResultSchema,
} from "../lib/server/question-import-schema";

function completeImport() {
  return questionImportResultSchema.parse({
    questions: [{
      number: 1,
      type: "short_answer",
      prompt: "تعریف سلول را بنویسید.",
      maxScore: 2,
      answer: "سلول واحد ساختاری و عملکردی جانداران است.",
      options: [],
      acceptedAnswers: [],
      rubric: [],
      complete: true,
      issues: [],
    }],
    warnings: [],
  });
}

test("question import keeps a readable draft editable and marks a system fallback rubric", () => {
  const draft = normalizeImportedQuestions(completeImport());
  assert.equal(draft.questions.length, 1);
  assert.equal(draft.questions[0].number, 1);
  assert.equal(draft.questions[0].maxScore, 2);
  assert.equal(draft.questions[0].rubric[0].points, 2);
  assert.match(draft.questions[0].rubric[0].description, /پیش‌فرض سیستم/);
  assert.ok(draft.warnings.some((warning) => warning.includes("بارم تفصیلی")));
  assert.ok(draft.questions[0].id.startsWith("question_"));
});

test("a question the model flagged incomplete is kept with its note when nothing crucial is missing", () => {
  const draft = completeImport();
  draft.questions[0].complete = false;
  draft.questions[0].answer = "";
  draft.questions[0].issues = ["کلید در تصویر بریده شده است."];
  const result = normalizeImportedQuestions(draft);
  assert.equal(result.questions.length, 1, "the readable question must not be thrown away");
  assert.equal(result.questions[0].answer, "");
  assert.deepEqual(result.dropped, []);
  assert.ok(result.warnings.some((warning) => warning.includes("کلید سؤال‌های 1")), "a missing key is named as a warning");
  assert.deepEqual(importNotesOf(result.questions[0]), ["پاسخ مرجع خالی است و باید دستی نوشته شود", "کلید در تصویر بریده شده است."]);
});

test("contradictory extraction is dropped by number and the sound questions survive", () => {
  const mixed = questionImportResultSchema.parse({
    questions: [
      { number: 1, type: "short_answer", prompt: "تعریف سلول", maxScore: 2, answer: "واحد ساختاری", options: [], acceptedAnswers: [], rubric: [], complete: true, issues: [] },
      { number: 2, type: "short_answer", prompt: "بارم اشتباه", maxScore: 2, answer: "پاسخ", options: [], acceptedAnswers: [], rubric: [{ label: "گام", description: "شرح", points: 1 }], complete: true, issues: [] },
      { number: 3, type: "multiple_choice", prompt: "گزینهٔ ناخوانا", maxScore: 1, answer: "الف", options: ["الف", "[ناخوانا]"], acceptedAnswers: [], rubric: [], complete: true, issues: [] },
    ],
    warnings: [],
  });
  const result = normalizeImportedQuestions(mixed);
  assert.deepEqual(result.questions.map((question) => question.prompt), ["تعریف سلول"]);
  assert.deepEqual(result.dropped.map((item) => item.number), [2, 3]);
  assert.match(result.dropped[0].reasons[0], /جمع بارم/);
  assert.match(result.dropped[1].reasons[0], /ناخوانایی/);
  assert.ok(result.warnings.some((warning) => warning.includes("سؤال‌های 2، 3")));
});

test("when nothing is usable the error names each rejected question instead of a generic sentence", () => {
  const nothing = questionImportResultSchema.parse({
    questions: [{ number: 4, type: "unknown", prompt: "متن مبهم", maxScore: 0, answer: "", options: [], acceptedAnswers: [], rubric: [], complete: true, issues: [] }],
    warnings: [],
  });
  assert.throws(
    () => normalizeImportedQuestions(nothing),
    (error) => error instanceof QuestionImportValidationError
      && /هیچ سؤالی کامل خوانده نشد/.test(error.message)
      && /سؤال 4/.test(error.message),
  );
});

test("a blank prompt never reaches a draft, even though every other field is tolerant", () => {
  assert.throws(
    () => questionImportResultSchema.parse({ questions: [{ number: 1, type: "short_answer", prompt: "   ", maxScore: 1, answer: "", options: [], acceptedAnswers: [], rubric: [], complete: true, issues: [] }], warnings: [] }),
    /صورت سؤال خالی است/,
  );
});

test("question import prompt carries explicit file roles and the storage limit is 100 MiB", () => {
  const prompt = buildQuestionImportPrompt(JSON.stringify([{ file: 1, role: "فقط سؤال" }, { file: 2, role: "فقط کلید/پاسخ معلم" }]));
  assert.match(prompt, /فقط سؤال/);
  assert.match(prompt, /فقط کلید/);
  assert.match(prompt, /حدس/);
  assert.equal(MAX_FILE_SIZE_BYTES, 100 * 1024 * 1024);
  assert.ok(MAX_FILE_BASE64_LENGTH >= Math.ceil(MAX_FILE_SIZE_BYTES * 4 / 3));
});

test("server upload validation rejects a file above 100 MiB before storage", async () => {
  const file = new File([new Uint8Array(10)], "oversize.png", { type: "image/png" });
  Object.defineProperty(file, "size", { value: MAX_FILE_SIZE_BYTES + 1 });
  await assert.rejects(saveUserFile("user_smoke", "file_oversize", file), /۱۰۰ مگابایت/);
});
