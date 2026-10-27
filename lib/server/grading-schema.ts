import { z } from "zod";

const rubricCriterionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string(),
  points: z.number().nonnegative().max(1000),
});

const questionSchema = z.object({
  id: z.string().min(1),
  number: z.number().int().positive(),
  type: z.enum([
    "multiple_choice", "multiple_response", "true_false", "fill_blank", "short_answer",
    "essay", "math", "diagram", "matching", "ordering",
  ]),
  prompt: z.string().min(1),
  maxScore: z.number().positive().max(1000),
  answer: z.string(),
  options: z.array(z.string()).max(30),
  acceptedAnswers: z.array(z.string()).max(50),
  partialCredit: z.boolean(),
  errorCarriedForward: z.boolean(),
  rubric: z.array(rubricCriterionSchema).max(50),
});

export const gradeRequestSchema = z.object({
  provider: z.enum(["openai", "gemini"]),
  model: z.string().min(2).max(120),
  apiKey: z.string().min(8).max(500),
  exam: z.object({
    title: z.string().min(1).max(300),
    subject: z.string().max(200),
    passScore: z.number().nonnegative().max(10000),
    settings: z.object({
      gradingMode: z.enum(["fast", "balanced", "precise"]),
      reviewThreshold: z.number().min(0).max(1),
      anonymize: z.boolean(),
      requireApproval: z.boolean(),
      instructions: z.string().max(10000),
    }),
    questions: z.array(questionSchema).min(1).max(200),
  }),
  student: z.object({
    name: z.string().max(200),
    code: z.string().max(100),
  }),
  files: z.array(z.object({
    name: z.string().min(1).max(300),
    type: z.enum(["image/jpeg", "image/png", "image/webp", "application/pdf"]),
    data: z.string().min(10).max(75_000_000),
  })).min(1).max(30),
});

const criterionResultSchema = z.object({
  criterionId: z.string(),
  score: z.number(),
  maxScore: z.number().nonnegative(),
  note: z.string(),
});

const questionResultSchema = z.object({
  questionId: z.string(),
  transcript: z.string(),
  extractedAnswer: z.string(),
  score: z.number(),
  maxScore: z.number().nonnegative(),
  confidence: z.number().min(0).max(1),
  needsReview: z.boolean(),
  rationale: z.string(),
  evidence: z.object({
    page: z.number().int().positive().nullable(),
    excerpt: z.string(),
  }),
  criteria: z.array(criterionResultSchema),
  flags: z.array(z.string()),
});

const modelFlagSchema = z.object({
  type: z.enum([
    "illegible", "low_confidence", "low_quality", "missing_answer", "missing_page",
    "ambiguous", "multiple_answers", "rubric_mismatch", "grade_boundary", "other",
  ]),
  severity: z.enum(["info", "warning", "critical"]),
  message: z.string(),
  questionId: z.string().nullable().optional().transform((value) => value || undefined),
  page: z.number().int().positive().nullable().optional().transform((value) => value ?? undefined),
});

export const modelResultSchema = z.object({
  detectedStudentName: z.string(),
  summary: z.string(),
  strengths: z.array(z.string()),
  improvements: z.array(z.string()),
  overallConfidence: z.number().min(0).max(1),
  questions: z.array(questionResultSchema),
  flags: z.array(modelFlagSchema),
});

export type ModelResult = z.infer<typeof modelResultSchema>;

export const gradingJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["detectedStudentName", "summary", "strengths", "improvements", "overallConfidence", "questions", "flags"],
  properties: {
    detectedStudentName: { type: "string", description: "Only if visible and requested; otherwise an empty string." },
    summary: { type: "string" },
    strengths: { type: "array", items: { type: "string" } },
    improvements: { type: "array", items: { type: "string" } },
    overallConfidence: { type: "number", minimum: 0, maximum: 1 },
    questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["questionId", "transcript", "extractedAnswer", "score", "maxScore", "confidence", "needsReview", "rationale", "evidence", "criteria", "flags"],
        properties: {
          questionId: { type: "string" },
          transcript: { type: "string" },
          extractedAnswer: { type: "string" },
          score: { type: "number" },
          maxScore: { type: "number", minimum: 0 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          needsReview: { type: "boolean" },
          rationale: { type: "string" },
          evidence: {
            type: "object",
            additionalProperties: false,
            required: ["page", "excerpt"],
            properties: {
              page: { type: ["number", "null"] },
              excerpt: { type: "string" },
            },
          },
          criteria: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["criterionId", "score", "maxScore", "note"],
              properties: {
                criterionId: { type: "string" },
                score: { type: "number" },
                maxScore: { type: "number", minimum: 0 },
                note: { type: "string" },
              },
            },
          },
          flags: { type: "array", items: { type: "string" } },
        },
      },
    },
    flags: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "severity", "message", "questionId", "page"],
        properties: {
          type: { type: "string", enum: ["illegible", "low_confidence", "low_quality", "missing_answer", "missing_page", "ambiguous", "multiple_answers", "rubric_mismatch", "grade_boundary", "other"] },
          severity: { type: "string", enum: ["info", "warning", "critical"] },
          message: { type: "string" },
          questionId: { type: "string" },
          page: { type: ["number", "null"] },
        },
      },
    },
  },
} as const;
