import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/server/auth";
import { createId, getDb } from "@/lib/server/db";
import { gradeRequestSchema } from "@/lib/server/grading-schema";
import { mergeVerifiedResult, normalizeGradingResult } from "@/lib/server/normalize";
import { getProviderConfig } from "@/lib/server/provider-config";
import { buildGradingPrompt, callProvider, ProviderError } from "@/lib/server/providers";
import { loadWorkspace } from "@/lib/server/workspace-store";
import type { AuthUser, GradeApiRequest, GradingResult, ProviderId } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  let user: AuthUser | undefined;
  let input: GradeApiRequest | undefined;
  let config: { provider: ProviderId; model: string; apiKey: string } | undefined;
  let jobId: string | undefined;
  const startedAt = Date.now();

  const recordJob = (status: "succeeded" | "failed", usage = { inputTokens: 0, outputTokens: 0 }, error?: string) => {
    if (!user || !config) return;
    const now = new Date().toISOString();
    if (!jobId) {
      jobId = createId("job");
      getDb().prepare(`INSERT INTO ai_jobs (id, user_id, submission_id, provider, model, status, input_tokens, output_tokens, latency_ms, error, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(jobId, user.id, input?.submissionId || null, config.provider, config.model, status, usage.inputTokens, usage.outputTokens, Date.now() - startedAt, error?.slice(0, 500) || null, now);
    } else {
      getDb().prepare("UPDATE ai_jobs SET status=?, input_tokens=?, output_tokens=?, latency_ms=?, error=? WHERE id=?")
        .run(status, usage.inputTokens, usage.outputTokens, Date.now() - startedAt, error?.slice(0, 500) || null, jobId);
    }
  };

  try {
    user = await requireUser();
    input = gradeRequestSchema.parse(await request.json()) as GradeApiRequest;
    config = getProviderConfig();
    const workspace = loadWorkspace(user.id).data;
    if (!workspace?.exams.some((exam) => exam.id === input?.examId)) {
      return NextResponse.json({ error: "این آزمون در فضای کاری شما پیدا نشد." }, { status: 403 });
    }
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    const message = error instanceof Error && !("issues" in error) ? error.message : "اطلاعات آزمون یا فایل‌ها کامل و معتبر نیست. نوع فایل، حجم و بارم سؤال‌ها را بررسی کنید.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const approximateFileBytes = input.files.reduce((sum, file) => sum + Math.floor(file.data.length * 0.75), 0);
  const providerByteLimit = config.provider === "gemini" ? 14 * 1024 * 1024 : config.provider === "deepseek" ? 24 * 1024 * 1024 : 40 * 1024 * 1024;
  if (approximateFileBytes > providerByteLimit) {
    return NextResponse.json({ error: "حجم کل فایل‌های این دانش‌آموز برای یک درخواست زیاد است؛ فایل را فشرده یا برگه را به دسته‌های کوچک‌تر تقسیم کنید." }, { status: 413 });
  }
  if (config.provider === "deepseek" && input.files.some((file) => file.type === "application/pdf")) {
    return NextResponse.json({ error: "DeepSeek فعلاً PDF مستقیم نمی‌پذیرد؛ صفحات را به JPG/PNG تبدیل کنید یا مدیر سامانه OpenAI/Gemini را فعال کند." }, { status: 400 });
  }

  let usage = { inputTokens: 0, outputTokens: 0 };
  try {
    const firstCall = await callProvider({ ...config, prompt: buildGradingPrompt(input), files: input.files });
    usage = { ...firstCall.usage };
    let normalized = normalizeGradingResult(firstCall.result, input, config.provider, config.model, usage);

    const shouldVerify = input.exam.settings.gradingMode === "precise"
      ? normalized.flags.length > 0 || normalized.questions.some((question) => question.needsReview)
      : input.exam.settings.gradingMode === "balanced"
        ? normalized.flags.some((flag) => flag.severity === "critical")
        : false;

    if (shouldVerify) {
      try {
        const secondCall = await callProvider({ ...config, prompt: buildGradingPrompt(input, firstCall.result), files: input.files });
        usage.inputTokens += secondCall.usage.inputTokens;
        usage.outputTokens += secondCall.usage.outputTokens;
        const merged = mergeVerifiedResult(firstCall.result, secondCall.result);
        const verified = normalizeGradingResult(merged, input, config.provider, config.model, usage, "verified");
        const changed = verified.totalScore !== normalized.totalScore || verified.questions.some((question, index) => question.score !== normalized.questions[index]?.score);
        verified.verification = changed ? "corrected" : "verified";
        normalized = verified;
      } catch (error) {
        normalized = {
          ...normalized,
          verification: "failed",
          flags: [...normalized.flags, {
            id: `flag_${randomUUID()}`,
            type: "provider_error",
            severity: "warning",
            message: error instanceof Error ? `بازبینی دوم کامل نشد: ${error.message}` : "بازبینی دوم کامل نشد؛ نتیجهٔ اول نیازمند تأیید معلم است.",
          }],
        };
      }
    }

    recordJob("succeeded", usage);
    return NextResponse.json({ result: normalized satisfies GradingResult });
  } catch (error) {
    const message = error instanceof Error ? error.message : "تصحیح برگه کامل نشد.";
    recordJob("failed", usage, message);
    if (error instanceof ProviderError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "تصحیح این برگه کامل نشد. اطلاعات شما ذخیره شده است؛ لطفاً دوباره تلاش کنید." }, { status: 500 });
  }
}
