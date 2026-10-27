import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { buildGradingPrompt, callProvider, ProviderError } from "../../../lib/server/providers";
import { gradeRequestSchema } from "../../../lib/server/grading-schema";
import { mergeVerifiedResult, normalizeGradingResult } from "../../../lib/server/normalize";
import type { GradeApiRequest, GradingResult } from "../../../lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  let input: GradeApiRequest;
  try {
    const body = await request.json();
    input = gradeRequestSchema.parse(body) as GradeApiRequest;
  } catch {
    return NextResponse.json({
      error: "اطلاعات آزمون یا فایل‌ها کامل و معتبر نیست. نوع فایل، حجم و بارم سؤال‌ها را بررسی کنید.",
    }, { status: 400 });
  }

  const approximateFileBytes = input.files.reduce((sum, file) => sum + Math.floor(file.data.length * 0.75), 0);
  const providerByteLimit = input.provider === "gemini" ? 14 * 1024 * 1024 : 40 * 1024 * 1024;
  if (approximateFileBytes > providerByteLimit) {
    return NextResponse.json({
      error: input.provider === "gemini"
        ? "حجم کل فایل‌های این دانش‌آموز برای ارسال مستقیم به Gemini زیاد است؛ مجموع را به حدود ۱۴ مگابایت برسانید یا برگه را به دسته‌های کوچک‌تر تقسیم کنید."
        : "حجم کل فایل‌های این دانش‌آموز برای یک درخواست زیاد است؛ مجموع را به کمتر از ۴۰ مگابایت برسانید.",
    }, { status: 413 });
  }

  try {
    const firstCall = await callProvider({
      provider: input.provider,
      model: input.model,
      apiKey: input.apiKey,
      prompt: buildGradingPrompt(input),
      files: input.files,
    });
    const usage = { ...firstCall.usage };
    let normalized = normalizeGradingResult(firstCall.result, input, input.provider, input.model, usage);

    const shouldVerify = input.exam.settings.gradingMode === "precise"
      ? normalized.flags.length > 0 || normalized.questions.some((question) => question.needsReview)
      : input.exam.settings.gradingMode === "balanced"
        ? normalized.flags.some((flag) => flag.severity === "critical")
        : false;

    if (shouldVerify) {
      try {
        const secondCall = await callProvider({
          provider: input.provider,
          model: input.model,
          apiKey: input.apiKey,
          prompt: buildGradingPrompt(input, firstCall.result),
          files: input.files,
        });
        usage.inputTokens += secondCall.usage.inputTokens;
        usage.outputTokens += secondCall.usage.outputTokens;
        const merged = mergeVerifiedResult(firstCall.result, secondCall.result);
        const verified = normalizeGradingResult(merged, input, input.provider, input.model, usage, "verified");
        const changed = verified.totalScore !== normalized.totalScore || verified.questions.some((question, index) =>
          question.score !== normalized.questions[index]?.score,
        );
        verified.verification = changed ? "corrected" : "verified";
        normalized = verified;
      } catch (error) {
        // A successful first pass remains useful, but the failed audit must be visible.
        normalized = {
          ...normalized,
          verification: "failed",
          flags: [...normalized.flags, {
            id: `flag_${randomUUID()}`,
            type: "provider_error",
            severity: "warning",
            message: error instanceof Error
              ? `بازبینی دوم کامل نشد: ${error.message}`
              : "بازبینی دوم کامل نشد؛ نتیجهٔ اول نیازمند تأیید معلم است.",
          }],
        };
      }
    }

    return NextResponse.json({ result: normalized satisfies GradingResult });
  } catch (error) {
    if (error instanceof ProviderError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({
      error: "تصحیح این برگه کامل نشد. اطلاعات شما ذخیره شده است؛ لطفاً دوباره تلاش کنید.",
    }, { status: 500 });
  }
}
