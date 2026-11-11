import test from "node:test";
import assert from "node:assert/strict";
import { normalizeImportedQuestions, questionImportResultSchema } from "../lib/server/question-import-schema";

/**
 * "دو سؤال داشت ولی یکی‌شو تشخیص داده."
 *
 * A sheet with two questions produced a one-question draft. The second question was
 * read correctly — wording, options and key — and then discarded because its printed
 * number repeated the first one (`1, 1`), which is what a slate numbered by hand
 * produces. Numbering is a label, not evidence, and the draft is renumbered anyway.
 */

function question(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    number: 1,
    type: "short_answer",
    prompt: "۲+۲ چند است؟",
    maxScore: 1,
    answer: "۴",
    options: [],
    acceptedAnswers: [],
    rubric: [],
    complete: true,
    issues: [],
    ...overrides,
  };
}

function normalize(questions: unknown[]) {
  return normalizeImportedQuestions(questionImportResultSchema.parse({ questions, warnings: [] }));
}

test("two questions numbered the same stay two questions", () => {
  const draft = normalize([
    question({ number: 1, prompt: "سؤال اول", answer: "الف" }),
    question({ number: 1, prompt: "سؤال دوم", answer: "ب" }),
  ]);
  assert.equal(draft.questions.length, 2, "the second question must not be dropped");
  assert.deepEqual(draft.questions.map((item) => item.prompt), ["سؤال اول", "سؤال دوم"]);
  assert.equal(draft.dropped.length, 0);
  assert.match([...draft.warnings, ...draft.questions.map((item) => item.prompt)].join(" "), /تکراری|دوم/);
});

test("a question numbered 0 is kept and numbered by position", () => {
  const draft = normalize([question({ number: 0, prompt: "بدون شماره", answer: "ج" })]);
  assert.equal(draft.questions.length, 1);
  assert.equal(draft.questions[0].number, 1);
  assert.equal(draft.questions[0].answer, "ج");
});

test("the order on the sheet is preserved, not the order of the numbering", () => {
  const draft = normalize([
    question({ number: 2, prompt: "دوم", answer: "۲" }),
    question({ number: 1, prompt: "اول", answer: "۱" }),
  ]);
  assert.deepEqual(draft.questions.map((item) => item.prompt), ["اول", "دوم"]);
});

test("a question whose last line is marked unreadable is kept, with a note", () => {
  // This is the common real case: the model transcribes everything and writes
  // "ناخوانا" for one smudged word. Deleting the question loses a perfectly good key.
  const draft = normalize([
    question({ number: 1, prompt: "خوانا", answer: "۴" }),
    question({ number: 2, prompt: "سؤال دوم (ناخوانا)", answer: "تهران" }),
  ]);
  assert.equal(draft.questions.length, 2, "an honest note must not delete a question");
  assert.equal(draft.dropped.length, 0);
});

test("a question with no wording at all is still refused before normalisation", () => {
  assert.throws(() => normalize([question({ number: 1, prompt: "خوانا" }), question({ number: 2, prompt: "" })]));
});

test("a draft that is shorter than the page says so, with the real numbers", () => {
  const draft = normalizeImportedQuestions(questionImportResultSchema.parse({
    questions: [question({ number: 1, prompt: "سؤال اول" })],
    warnings: [],
    expectedQuestionCount: 7,
  }));
  assert.equal(draft.questions.length, 1);
  assert.ok(draft.warnings.some((warning) => warning.includes("۷ سؤال") || warning.includes("7 سؤال")), "the count must be named");
  assert.ok(draft.warnings.some((warning) => warning.includes("6 سؤال")), "the gap must be named");
});

test("a complete draft is not nagged", () => {
  const draft = normalizeImportedQuestions(questionImportResultSchema.parse({
    questions: [question({ number: 1, prompt: "الف" }), question({ number: 2, prompt: "ب" })],
    warnings: [],
    expectedQuestionCount: 2,
  }));
  assert.equal(draft.questions.length, 2);
  assert.ok(!draft.warnings.some((warning) => warning.includes("برنگرداند")));
});

test("an absent or nonsense count is ignored rather than treated as zero", () => {
  for (const expectedQuestionCount of [undefined, "", null, "x"]) {
    const draft = normalizeImportedQuestions(questionImportResultSchema.parse({
      questions: [question({ prompt: "الف" })],
      warnings: [],
      expectedQuestionCount,
    }));
    assert.equal(draft.questions.length, 1);
    assert.ok(!draft.warnings.some((warning) => warning.includes("برنگرداند")));
  }
});
