import test from "node:test";
import assert from "node:assert/strict";
import { dedupeQuestions, textSimilarity } from "../lib/server/question-dedupe";
import { normalizeImportedQuestions, questionImportResultSchema } from "../lib/server/question-import-schema";

/**
 * Overlapping bands are what make handwriting readable, and returning the same
 * question twice is their one real cost. These tests pin both directions: a repeat must
 * collapse, and two different questions must never be merged — losing a real question
 * is far worse than showing a duplicate.
 */

const Q1 = "در حرم مطهر، مواد مادهای را که در جوامع بلوک شرقی در سالهای بلافاصله بعد، به گاگبریایی است؟";
const Q2 = "با اقدامات راندمان کدام شامل هدف میشود؟ نظر بلوک کاتوزیان؟";
const Q3 = "قواعد کلاسیک قضاوت چیست؟";

test("the same question read from two bands is one question", () => {
  const { kept, groups } = dedupeQuestions([
    { prompt: Q1, answer: "الف" },
    { prompt: Q1.replace("،", " ،").replace("است؟", "است ؟"), answer: "" },
  ]);
  assert.equal(kept.length, 1);
  assert.equal(groups.length, 1);
});

test("the surviving copy is the one that has the key", () => {
  // The band that cut the key off must not be the one that wins.
  const { kept } = dedupeQuestions([
    { prompt: Q1, answer: "" },
    { prompt: Q1, answer: "به گاگبریایی" },
  ]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].answer, "به گاگبریایی");
});

test("two genuinely different questions are both kept", () => {
  const { kept } = dedupeQuestions([
    { prompt: Q1, answer: "الف" },
    { prompt: Q2, answer: "ب" },
    { prompt: Q3, answer: "ج" },
  ]);
  assert.equal(kept.length, 3, "never merge distinct questions");
});

test("questions that differ only in their numbering are the same question", () => {
  const { kept } = dedupeQuestions([
    { prompt: "۱- " + Q3, answer: "ج" },
    { prompt: "۲- " + Q3, answer: "ج" },
  ]);
  assert.equal(kept.length, 1);
});

test("similarity is about words, and short overlaps are not enough", () => {
  assert.ok(textSimilarity(Q1, Q1) > 0.99);
  assert.ok(textSimilarity(Q1, Q2) < 0.5);
  assert.equal(textSimilarity("", Q1), 0);
});

test("a real import collapses the duplicate and says so, without losing others", () => {
  const draft = questionImportResultSchema.parse({
    questions: [
      { number: 1, type: "short_answer", prompt: Q1, maxScore: 1, answer: "الف", options: [], acceptedAnswers: [], rubric: [], complete: true, issues: [] },
      { number: 2, type: "short_answer", prompt: Q1, maxScore: 1, answer: "", options: [], acceptedAnswers: [], rubric: [], complete: true, issues: [] },
      { number: 3, type: "short_answer", prompt: Q3, maxScore: 1, answer: "ج", options: [], acceptedAnswers: [], rubric: [], complete: true, issues: [] },
    ],
    warnings: [],
  });
  const result = normalizeImportedQuestions(draft);
  assert.equal(result.questions.length, 2);
  assert.deepEqual(result.questions.map((question) => question.prompt), [Q1, Q3]);
  assert.equal(result.questions[0].answer, "الف", "the copy with the key survives");
  assert.ok(result.warnings.some((warning) => warning.includes("هم‌پوشان")));
});
