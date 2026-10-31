import assert from "node:assert/strict";
import test from "node:test";
import { deterministicObjectiveScore, normalizeGradingResult } from "../lib/server/normalize";
import { gradeRequestSchema, modelResultSchema } from "../lib/server/grading-schema";
import type { GradeApiRequest, Question } from "../lib/types";
import { normalizeAnswer } from "../lib/utils";

const mcq: Question = {
  id: "q1",
  number: 1,
  type: "multiple_choice",
  prompt: "کدام اندامک؟",
  maxScore: 2,
  answer: "میتوکندری",
  options: ["هسته", "میتوکندری", "ریبوزوم", "گلژی"],
  acceptedAnswers: [],
  partialCredit: false,
  errorCarriedForward: false,
  rubric: [{ id: "r1", label: "پاسخ صحیح", description: "انتخاب میتوکندری", points: 2 }],
};

const essay: Question = {
  id: "q2",
  number: 2,
  type: "essay",
  prompt: "توضیح دهید.",
  maxScore: 3,
  answer: "پاسخ مرجع",
  options: [],
  acceptedAnswers: [],
  partialCredit: true,
  errorCarriedForward: false,
  rubric: [{ id: "r2", label: "مفهوم", description: "شرح مفهوم", points: 3 }],
};

const request: GradeApiRequest = {
  examId: "exam_test",
  submissionId: "submission_test",
  exam: {
    title: "آزمون",
    subject: "زیست",
    passScore: 2.5,
    settings: { gradingMode: "fast", reviewThreshold: 0.8, anonymize: true, requireApproval: true, instructions: "" },
    questions: [mcq, essay],
  },
  student: { name: "دانش‌آموز", code: "1" },
  files: [{ name: "sheet.png", type: "image/png", data: "aGVsbG8=" }],
};

function rawModelResult() {
  return modelResultSchema.parse({
    detectedStudentName: "سارا محمدی",
    detectedClassName: "یازدهم الف",
    identityConfidence: 0.91,
    summary: "خلاصه",
    strengths: ["نکته قوت"],
    improvements: ["بهبود"],
    overallConfidence: 0.72,
    questions: [
      {
        questionId: "q1",
        transcript: "گزینهٔ ۲ — میتوکندری",
        extractedAnswer: "گزینهٔ ۲ — میتوکندری",
        score: 0,
        maxScore: 2,
        confidence: 0.95,
        needsReview: false,
        rationale: "انتخاب گزینه",
        evidence: { page: 1, excerpt: "میتوکندری" },
        criteria: [{ criterionId: "r1", score: 0, maxScore: 2, note: "بررسی شد" }],
        flags: [],
      },
      {
        questionId: "q2",
        transcript: "پاسخ تشریحی",
        extractedAnswer: "پاسخ تشریحی",
        score: 99,
        maxScore: 3,
        confidence: 0.5,
        needsReview: false,
        rationale: "ارزیابی تشریحی",
        evidence: { page: null, excerpt: "پاسخ" },
        criteria: [{ criterionId: "r2", score: 99, maxScore: 3, note: "بیش از سقف" }],
        flags: [],
      },
    ],
    flags: [{ type: "other", severity: "info", message: "یادداشت", questionId: "", page: null }],
  });
}

test("Persian and Arabic answer normalization is stable", () => {
  assert.equal(normalizeAnswer("  ياختهٔ ۱۲۳\u200c "), "یاخته 123");
  assert.equal(normalizeAnswer("كَلفُظ"), "کلفظ");
  assert.equal(normalizeAnswer("درست،"), "درست");
});

test("objective scoring uses the answer key and detects ambiguity", () => {
  assert.deepEqual(deterministicObjectiveScore(mcq, "گزینه ۲ — میتوکندری").score, 2);
  assert.equal(deterministicObjectiveScore(mcq, "هسته").score, 0);
  assert.equal(deterministicObjectiveScore(mcq, "هسته و میتوکندری").ambiguous, true);
  const fill = { ...mcq, id: "fill", type: "fill_blank" as const, answer: "سلول", acceptedAnswers: ["یاخته"] };
  assert.equal(deterministicObjectiveScore(fill, "ياخته").score, 2);
});

test("multiple response partial credit penalizes wrong selections without going below zero", () => {
  const multiple: Question = { ...mcq, type: "multiple_response", answer: "هسته، میتوکندری", partialCredit: true };
  assert.equal(deterministicObjectiveScore(multiple, "هسته، میتوکندری").score, 2);
  assert.equal(deterministicObjectiveScore(multiple, "هسته").score, 1);
  assert.equal(deterministicObjectiveScore(multiple, "هسته، ریبوزوم، گلژی").score, 0);
});

test("server normalizes scores, recomputes totals, keeps identity separate and flags low confidence", () => {
  const result = normalizeGradingResult(rawModelResult(), request, "openai", "gpt-4.1", { inputTokens: 10, outputTokens: 5 });
  assert.equal(result.questions[0].score, 2, "objective key must override the model score");
  assert.equal(result.questions[1].score, 3, "score must be clamped to the question maximum");
  assert.equal(result.questions[1].criteria[0].score, 3, "criterion score must be clamped");
  assert.equal(result.totalScore, 5);
  assert.equal(result.maxScore, 5);
  assert.equal(result.percentage, 100);
  assert.equal(result.detectedStudentName, "سارا محمدی");
  assert.equal(result.detectedClassName, "یازدهم الف");
  assert.equal(result.identityConfidence, 0.91);
  assert.ok(result.questions[1].needsReview);
  assert.ok(result.flags.some((flag) => flag.type === "low_confidence" && flag.questionId === "q2"));
  assert.equal(result.usage.inputTokens, 10);
});

test("a missing model question never disappears silently", () => {
  const raw = rawModelResult();
  raw.questions = raw.questions.slice(0, 1);
  const result = normalizeGradingResult(raw, request, "openai", "gpt-4.1", { inputTokens: 0, outputTokens: 0 });
  assert.equal(result.questions.length, 2);
  assert.equal(result.questions[1].score, 0);
  assert.equal(result.questions[1].needsReview, true);
  assert.ok(result.flags.some((flag) => flag.type === "rubric_mismatch" && flag.severity === "critical"));
});

test("grade requests accept owned stored-file references without browser Base64", () => {
  const parsed = gradeRequestSchema.parse({ ...request, files: [{ storedId: "file_1", name: "sheet.png", type: "image/png" }] });
  assert.equal(parsed.files[0].storedId, "file_1");
  assert.equal(parsed.files[0].data, undefined);
  assert.throws(() => gradeRequestSchema.parse({ ...request, files: [{ name: "missing.png", type: "image/png" }] }));
});

test("uncertain or illegible model content cannot keep an authoritative score", () => {
  const raw = rawModelResult();
  raw.questions[0].needsReview = true;
  raw.questions[1].needsReview = true;
  raw.questions[1].transcript = "[ناخوانا]";
  raw.questions[1].extractedAnswer = "[ناخوانا]";
  raw.questions[1].score = 3;
  raw.questions[1].criteria[0].score = 3;
  const result = normalizeGradingResult(raw, request, "openai", "gpt-4.1", { inputTokens: 0, outputTokens: 0 });
  assert.equal(result.questions[0].score, 0, "even an exact-looking extraction must not win over an explicit review flag");
  assert.equal(result.questions[1].score, 0);
  assert.equal(result.questions[1].criteria[0].score, 0);
  assert.equal(result.questions[1].needsReview, true);
  assert.ok(result.flags.some((flag) => flag.type === "illegible" && flag.questionId === "q2"));
  assert.match(result.questions[1].rationale, /نمرهٔ خودکار صفر/);
});

test("scores close to the pass boundary are routed to the teacher", () => {
  const raw = rawModelResult();
  raw.questions = raw.questions.slice(0, 1);
  raw.questions[0].extractedAnswer = "هسته";
  raw.questions[0].transcript = "هسته";
  const singleQuestionRequest = { ...request, exam: { ...request.exam, questions: [mcq], passScore: 0.5 } };
  const result = normalizeGradingResult(raw, singleQuestionRequest, "openai", "gpt-4.1", { inputTokens: 0, outputTokens: 0 });
  assert.equal(result.totalScore, 0);
  assert.ok(result.flags.some((flag) => flag.type === "grade_boundary"));
});
