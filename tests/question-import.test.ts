import assert from "node:assert/strict";
import test from "node:test";
import { MAX_FILE_SIZE_BYTES, MAX_FILE_BASE64_LENGTH } from "../lib/file-constraints";
import { saveUserFile } from "../lib/server/file-storage";
import {
  buildQuestionImportPrompt,
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

test("incomplete, unreadable or contradictory question extraction is rejected instead of guessed", () => {
  const incomplete = completeImport();
  incomplete.questions[0].complete = false;
  incomplete.questions[0].answer = "";
  incomplete.questions[0].issues = ["کلید در تصویر بریده شده است."];
  assert.throws(() => normalizeImportedQuestions(incomplete), (error) => error instanceof QuestionImportValidationError && /حدس/.test(error.message));

  const mismatch = completeImport();
  mismatch.questions[0].rubric = [{ label: "گام اول", description: "شرح", points: 1 }];
  assert.throws(() => normalizeImportedQuestions(mismatch), /جمع بارم/);

  const unreadableOption = completeImport();
  unreadableOption.questions[0].type = "multiple_choice";
  unreadableOption.questions[0].options = ["الف", "[ناخوانا]"];
  assert.throws(() => normalizeImportedQuestions(unreadableOption), /ناخوانایی/);
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
