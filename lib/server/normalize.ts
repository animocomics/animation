import { randomUUID } from "crypto";
import type {
  GradeApiRequest,
  GradingResult,
  ProviderId,
  Question,
  QuestionResult,
  ReviewFlag,
} from "../types";
import { clamp, normalizeAnswer, round } from "../utils";
import type { ModelResult } from "./grading-schema";

function newFlag(flag: Omit<ReviewFlag, "id">): ReviewFlag {
  return { ...flag, id: `flag_${randomUUID()}` };
}

function splitAnswers(value: string): string[] {
  return value.split(/[,،;؛|\n]+/).map((part) => normalizeAnswer(part)).filter(Boolean);
}

function optionIndexFromLabel(value: string): number | undefined {
  const normalized = normalizeAnswer(value);
  const match = normalized.match(/^(?:(?:گزینه|پاسخ|جواب)(?:\s+شماره)?\s*)?(\d+|الف|ب|ج|د|ه|و|[a-f])$/);
  if (!match) return undefined;
  if (/^\d+$/.test(match[1])) return Number(match[1]);
  const persianIndex = ["الف", "ب", "ج", "د", "ه", "و"].indexOf(match[1]);
  return persianIndex >= 0 ? persianIndex + 1 : "abcdef".indexOf(match[1]) + 1;
}

interface DeterministicScore {
  score?: number;
  ambiguous?: boolean;
  note?: string;
}

export function deterministicObjectiveScore(question: Question, extractedAnswer: string): DeterministicScore {
  const extracted = normalizeAnswer(extractedAnswer);
  if (!extracted || /ناخوانا|unreadable|illegible/.test(extracted)) return {};

  if (["multiple_choice", "true_false", "fill_blank"].includes(question.type)) {
    const accepted = [question.answer, ...question.acceptedAnswers].map(normalizeAnswer).filter(Boolean);
    if (accepted.some((answer) => extracted === answer)) {
      return { score: question.maxScore, note: "تطبیق قطعی پاسخ با کلید انجام شد." };
    }

    if (question.type === "fill_blank") return {};

    const matchedOptions = question.options.filter((option) => {
      const normalized = normalizeAnswer(option);
      return normalized && (extracted === normalized || extracted.includes(normalized));
    });
    if (matchedOptions.length > 1) return { ambiguous: true };
    if (matchedOptions.length === 1) {
      const selected = normalizeAnswer(matchedOptions[0]);
      const correctOption = question.options.find((option) => normalizeAnswer(question.answer) === normalizeAnswer(option));
      if (correctOption) {
        const correct = selected === normalizeAnswer(correctOption);
        return {
          score: correct ? question.maxScore : 0,
          note: correct ? "گزینهٔ خوانده‌شده با کلید مطابقت دارد." : "گزینهٔ خوانده‌شده با کلید متفاوت است.",
        };
      }
      if (accepted.includes(selected)) return { score: question.maxScore, note: "پاسخ با گزینهٔ صحیح مطابقت دارد." };
      return { score: 0, note: "گزینهٔ استخراج‌شده جزو پاسخ‌های صحیح نیست." };
    }

    if (question.type === "multiple_choice") {
      const labelParts = extractedAnswer.split(/[,،;؛|\n]+|\s+و\s+/).map((part) => normalizeAnswer(part)).filter(Boolean);
      if (labelParts.length > 1 && labelParts.every((part) => optionIndexFromLabel(part) !== undefined)) return { ambiguous: true };
      const optionIndex = optionIndexFromLabel(extracted);
      if (optionIndex !== undefined) {
        if (optionIndex < 1 || optionIndex > question.options.length || !question.options[optionIndex - 1]?.trim()) return { ambiguous: true };
        const selected = normalizeAnswer(question.options[optionIndex - 1]);
        const correctOption = question.options.find((option) => normalizeAnswer(question.answer) === normalizeAnswer(option));
        if (correctOption) {
          const correct = selected === normalizeAnswer(correctOption);
          return { score: correct ? question.maxScore : 0, note: correct ? "گزینهٔ علامت‌خورده با کلید مطابقت دارد." : "گزینهٔ علامت‌خورده با کلید متفاوت است." };
        }
        if (accepted.includes(selected)) return { score: question.maxScore, note: "گزینهٔ علامت‌خورده با پاسخ صحیح مطابقت دارد." };
        return { score: 0, note: "گزینهٔ علامت‌خورده جزو پاسخ‌های صحیح نیست." };
      }
    }

    if (question.type === "true_false" && ["درست", "غلط", "صحیح", "نادرست", "true", "false"].includes(extracted)) {
      const isTrue = ["درست", "صحیح", "true"].includes(extracted);
      const answerIsTrue = ["درست", "صحیح", "true"].includes(normalizeAnswer(question.answer));
      return { score: isTrue === answerIsTrue ? question.maxScore : 0 };
    }
  }

  if (question.type === "multiple_response") {
    const correct = new Set(splitAnswers(question.answer));
    const selectedOptions = question.options.filter((option) => extracted.includes(normalizeAnswer(option)));
    const fallbackAnswers = extractedAnswer.split(/[,،;؛|\n]+|\s+و\s+/).map((part) => normalizeAnswer(part)).filter(Boolean);
    const fallbackOptionIndexes = fallbackAnswers.map(optionIndexFromLabel);
    if (!selectedOptions.length && fallbackOptionIndexes.some((index) => index !== undefined && (index < 1 || index > question.options.length))) return { ambiguous: true };
    const fallbackSelections = fallbackAnswers.map((answer, index) => {
      const optionIndex = fallbackOptionIndexes[index];
      return optionIndex !== undefined ? normalizeAnswer(question.options[optionIndex - 1] ?? "") : answer;
    }).filter(Boolean);
    const selected = new Set(selectedOptions.length ? selectedOptions.map(normalizeAnswer) : fallbackSelections);
    if (!selected.size || !correct.size) return {};
    const correctSelections = [...selected].filter((answer) => correct.has(answer)).length;
    const wrongSelections = selected.size - correctSelections;
    const isComplete = correctSelections === correct.size && wrongSelections === 0;
    if (isComplete) return { score: question.maxScore, note: "همهٔ پاسخ‌های صحیح و فقط آن‌ها انتخاب شده‌اند." };
    if (question.partialCredit) {
      const ratio = clamp((correctSelections - wrongSelections) / correct.size, 0, 1);
      return { score: round(question.maxScore * ratio, 2), note: "نمرهٔ جزئی بر اساس پاسخ‌های درست و انتخاب‌های اشتباه محاسبه شد." };
    }
    return { score: 0, note: "مجموعهٔ پاسخ‌ها کامل با کلید مطابقت ندارد." };
  }

  return {};
}

function flagKey(flag: Omit<ReviewFlag, "id"> | ReviewFlag): string {
  return `${flag.type}:${flag.questionId ?? "general"}:${flag.page ?? "any"}`;
}

export function normalizeGradingResult(
  modelResult: ModelResult,
  request: GradeApiRequest,
  provider: ProviderId,
  model: string,
  usage: { inputTokens: number; outputTokens: number },
  verification: GradingResult["verification"] = "not_requested",
): GradingResult {
  const flags: ReviewFlag[] = [];
  const flagKeys = new Set<string>();
  const addFlag = (flag: Omit<ReviewFlag, "id">) => {
    const key = flagKey(flag);
    if (flagKeys.has(key)) return;
    flagKeys.add(key);
    flags.push(newFlag(flag));
  };

  for (const flag of modelResult.flags) {
    const questionExists = !flag.questionId || request.exam.questions.some((question) => question.id === flag.questionId);
    if (!questionExists) continue;
    addFlag({
      type: flag.type,
      severity: flag.severity,
      message: flag.message || "این مورد نیازمند بازبینی معلم است.",
      questionId: flag.questionId || undefined,
      page: flag.page ?? undefined,
    });
  }

  const modelQuestions = new Map(modelResult.questions.map((question) => [question.questionId, question]));
  const questionResults: QuestionResult[] = request.exam.questions.map((question) => {
    const raw = modelQuestions.get(question.id);
    if (!raw) {
      addFlag({
        type: "rubric_mismatch",
        severity: "critical",
        message: `مدل برای سؤال ${question.number} نتیجهٔ معتبر برنگرداند؛ نمره موقت است و باید دستی بررسی شود.`,
        questionId: question.id,
      });
      return {
        questionId: question.id,
        transcript: "",
        extractedAnswer: "",
        score: 0,
        maxScore: question.maxScore,
        confidence: 0,
        needsReview: true,
        rationale: "نتیجهٔ این سؤال در خروجی مدل موجود نبود.",
        evidence: { page: null, excerpt: "" },
        criteria: question.rubric.map((criterion) => ({ criterionId: criterion.id, score: 0, maxScore: criterion.points, note: "ارزیابی مدل در دسترس نیست." })),
        flags: ["rubric_mismatch"],
      };
    }

    const localFlags = new Set(raw.flags);
    let rationale = raw.rationale;
    const deterministic = deterministicObjectiveScore(question, raw.extractedAnswer || raw.transcript);
    const hasIllegibleContent = /ناخوانا|unreadable|illegible/i.test(`${raw.transcript} ${raw.extractedAnswer}`);
    const explicitUncertainty = raw.needsReview || deterministic.ambiguous || hasIllegibleContent || !raw.transcript.trim();
    const suppressModelScore = explicitUncertainty;
    // An uncertain model score is not evidence. Keep it at zero until the teacher reviews the sheet.
    let score = suppressModelScore ? 0 : deterministic.score ?? raw.score;
    if (suppressModelScore) rationale = `${rationale} به‌دلیل ابهام یا نقص در خواندن، نمرهٔ خودکار صفر و نیازمند بررسی معلم است.`.trim();
    if (deterministic.note) rationale = `${rationale} ${deterministic.note}`.trim();
    if (deterministic.ambiguous) {
      localFlags.add("multiple_answers");
      addFlag({
        type: "multiple_answers",
        severity: "warning",
        message: `در پاسخ سؤال ${question.number} بیش از یک گزینه دیده می‌شود؛ انتخاب نهایی باید بررسی شود.`,
        questionId: question.id,
        page: raw.evidence.page ?? undefined,
      });
    }
    score = round(clamp(Number(score), 0, question.maxScore), 2);
    const confidence = round(clamp(Number(raw.confidence), 0, 1), 2);

    if (hasIllegibleContent) {
      localFlags.add("illegible");
      addFlag({
        type: "illegible",
        severity: "warning",
        message: `بخشی از پاسخ سؤال ${question.number} ناخوانا است؛ لطفاً تصویر اصلی را ببینید.`,
        questionId: question.id,
        page: raw.evidence.page ?? undefined,
      });
    }
    if (!raw.transcript.trim()) {
      localFlags.add("missing_answer");
      addFlag({
        type: "missing_answer",
        severity: "warning",
        message: `برای سؤال ${question.number} رونوشتی ثبت نشد؛ پاسخ خالی و صفحهٔ مفقود را بررسی کنید.`,
        questionId: question.id,
        page: raw.evidence.page ?? undefined,
      });
    }
    if (confidence < request.exam.settings.reviewThreshold) {
      localFlags.add("low_confidence");
      addFlag({
        type: "low_confidence",
        severity: "warning",
        message: `اعتماد مدل در سؤال ${question.number} از آستانهٔ تعیین‌شده کمتر است.`,
        questionId: question.id,
        page: raw.evidence.page ?? undefined,
      });
    }
    if (raw.needsReview && !localFlags.size) {
      localFlags.add("other");
      addFlag({
        type: "other",
        severity: "warning",
        message: `مدل سؤال ${question.number} را نیازمند بررسی دانسته است؛ نمرهٔ مبهم قطعی نیست.`,
        questionId: question.id,
        page: raw.evidence.page ?? undefined,
      });
    }

    const rawCriteria = new Map(raw.criteria.map((criterion) => [criterion.criterionId, criterion]));
    const criteria = question.rubric.map((criterion) => {
      const result = rawCriteria.get(criterion.id);
      if (!result) {
        localFlags.add("rubric_mismatch");
        return { criterionId: criterion.id, score: 0, maxScore: criterion.points, note: "مدل این معیار را گزارش نکرد؛ بررسی دستی لازم است." };
      }
      return {
        criterionId: criterion.id,
        score: suppressModelScore ? 0 : round(clamp(result.score, 0, criterion.points), 2),
        maxScore: criterion.points,
        note: result.note,
      };
    });
    if (question.rubric.length && raw.criteria.length < question.rubric.length) {
      addFlag({
        type: "rubric_mismatch",
        severity: "warning",
        message: `گزارش معیارهای سؤال ${question.number} ناقص است.`,
        questionId: question.id,
        page: raw.evidence.page ?? undefined,
      });
    }

    if (deterministic.score !== undefined && criteria.length === 1) {
      criteria[0].score = score;
    }

    const attachedFlag = flags.some((flag) => flag.questionId === question.id && flag.severity !== "info");
    return {
      questionId: question.id,
      transcript: raw.transcript,
      extractedAnswer: raw.extractedAnswer,
      score,
      maxScore: question.maxScore,
      confidence,
      needsReview: raw.needsReview || localFlags.size > 0 || attachedFlag || confidence < request.exam.settings.reviewThreshold,
      rationale,
      evidence: {
        page: raw.evidence.page ?? null,
        excerpt: raw.evidence.excerpt,
      },
      criteria,
      flags: [...localFlags],
    };
  });

  const totalScore = round(questionResults.reduce((sum, question) => sum + question.score, 0), 2);
  const maxScore = round(request.exam.questions.reduce((sum, question) => sum + question.maxScore, 0), 2);
  if (request.exam.passScore > 0 && Math.abs(totalScore - request.exam.passScore) <= 0.5) {
    addFlag({
      type: "grade_boundary",
      severity: "warning",
      message: "نمرهٔ کل نزدیک مرز قبولی است؛ پیش از نهایی‌کردن برگه را بازبینی کنید.",
    });
  }

  return {
    totalScore,
    maxScore,
    percentage: maxScore ? round((totalScore / maxScore) * 100, 1) : 0,
    overallConfidence: round(clamp(modelResult.overallConfidence, 0, 1), 2),
    detectedStudentName: modelResult.detectedStudentName,
    detectedClassName: modelResult.detectedClassName,
    identityConfidence: round(clamp(modelResult.identityConfidence, 0, 1), 2),
    summary: modelResult.summary,
    strengths: modelResult.strengths.filter(Boolean).slice(0, 8),
    improvements: modelResult.improvements.filter(Boolean).slice(0, 8),
    questions: questionResults,
    flags,
    provider,
    model,
    gradedAt: new Date().toISOString(),
    verification,
    usage: {
      inputTokens: Math.max(0, Math.round(usage.inputTokens)),
      outputTokens: Math.max(0, Math.round(usage.outputTokens)),
    },
  };
}

export function mergeVerifiedResult(initial: ModelResult, verified: ModelResult): ModelResult {
  const verifiedQuestions = new Map(verified.questions.map((question) => [question.questionId, question]));
  const questionIds = new Set([...initial.questions.map((question) => question.questionId), ...verifiedQuestions.keys()]);
  const flags = [...initial.flags, ...verified.flags].filter((flag, index, all) =>
    all.findIndex((candidate) => candidate.type === flag.type && candidate.questionId === flag.questionId && candidate.page === flag.page) === index,
  );
  return {
    ...verified,
    questions: [...questionIds].map((id) => verifiedQuestions.get(id) ?? initial.questions.find((question) => question.questionId === id)!).filter(Boolean),
    flags,
  };
}
