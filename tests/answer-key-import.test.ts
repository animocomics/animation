import assert from "node:assert/strict";
import test from "node:test";
import { applyImportedAnswerKey, answerKeyImportResultSchema, buildAnswerKeyImportPrompt } from "../lib/server/answer-key-import-schema";
import { QuestionImportValidationError } from "../lib/server/question-import-schema";
import type { Question, QuestionType } from "../lib/types";

function question(number: number, type: QuestionType, options: string[] = []): Question {
  return {
    id: `question_${number}`,
    number,
    type,
    prompt: `صورت سؤال ${number}`,
    maxScore: 2,
    answer: "پاسخ قبلی که نباید به مدل داده شود",
    options,
    acceptedAnswers: ["پاسخ جایگزین موجود"],
    partialCredit: type === "multiple_response",
    errorCarriedForward: false,
    rubric: [{ id: `rubric_${number}`, label: "پاسخ صحیح", description: "بارم موجود", points: 2 }],
  };
}

function questions() {
  return [
    question(1, "multiple_choice", ["الف", "ب", "ج", "د"]),
    question(2, "multiple_response", ["یک", "دو", "سه", "چهار"]),
    question(3, "short_answer"),
  ];
}

function readableKey() {
  return answerKeyImportResultSchema.parse({
    answers: [
      { questionNumber: 1, answer: "", selectedOptions: [3], complete: true, issues: [] },
      { questionNumber: 2, answer: "", selectedOptions: [1, 4], complete: true, issues: [] },
      { questionNumber: 3, answer: "پاسخ رونویسی‌شدهٔ معلم", selectedOptions: [], complete: true, issues: [] },
    ],
    warnings: [],
  });
}

test("separate filled-bubble key updates only answers and preserves every existing question field", () => {
  const existing = questions();
  const before = structuredClone(existing);
  const draft = applyImportedAnswerKey(readableKey(), existing);
  assert.equal(draft.questions[0].answer, "ج");
  assert.equal(draft.questions[1].answer, "یک، چهار");
  assert.equal(draft.questions[2].answer, "پاسخ رونویسی‌شدهٔ معلم");
  for (const [index, updated] of draft.questions.entries()) {
    const original = before[index];
    assert.equal(updated.id, original.id);
    assert.equal(updated.prompt, original.prompt);
    assert.equal(updated.maxScore, original.maxScore);
    assert.deepEqual(updated.options, original.options);
    assert.deepEqual(updated.acceptedAnswers, original.acceptedAnswers);
    assert.deepEqual(updated.rubric, original.rubric);
  }
});

test("ambiguous, missing or contradictory separate keys are rejected without partial application", () => {
  const multiple = readableKey();
  multiple.answers[0].selectedOptions = [1, 2];
  assert.throws(() => applyImportedAnswerKey(multiple, questions()), (error) => error instanceof QuestionImportValidationError && /بیش از یک گزینه/.test(error.message));

  const outOfRange = readableKey();
  outOfRange.answers[0].selectedOptions = [5];
  assert.throws(() => applyImportedAnswerKey(outOfRange, questions()), /خارج از گزینه‌های سؤال/);

  const missing = readableKey();
  missing.answers = missing.answers.slice(0, 2);
  assert.throws(() => applyImportedAnswerKey(missing, questions()), /سؤال 3: ردیف کلید/);

  const unclear = readableKey();
  unclear.answers[1].complete = false;
  unclear.answers[1].issues = ["دو علامت پاک‌شده همپوشانی دارند."];
  assert.throws(() => applyImportedAnswerKey(unclear, questions()), /کامل و روشن خوانده نشده/);
});

test("separate-key prompt contains no previous answer or question text and explicitly reads filled marks", () => {
  const existing = questions();
  const prompt = buildAnswerKeyImportPrompt(JSON.stringify([{ file: 1, role: "فقط کلید/پاسخ معلم" }]), existing);
  assert.match(prompt, /بدون صورت و پاسخ قبلی/);
  assert.match(prompt, /حل نکن/);
  assert.ok(!prompt.includes(existing[0].prompt));
  assert.ok(!prompt.includes(existing[0].answer));
  assert.ok(prompt.includes("optionCount"));
});
