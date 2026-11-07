import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { AuthError, requireWorkspaceUser } from "@/lib/server/auth";
import { createId } from "@/lib/server/ids";
import { readUserFile } from "@/lib/server/file-storage";
import { gradeRequestSchema } from "@/lib/server/grading-schema";
import { MAX_FILE_SIZE_BYTES } from "@/lib/file-constraints";
import { mergeVerifiedResult, normalizeGradingResult } from "@/lib/server/normalize";
import { prepareProviderFiles } from "@/lib/server/pdf-vision";
import { getProviderConfig } from "@/lib/server/provider-config";
import { buildGradingPrompt, callProvider, ProviderError } from "@/lib/server/providers";
import { loadWorkspace } from "@/lib/server/workspace-store";
import type { AuthUser, GradeApiRequest, GradingResult, ProviderId } from "@/lib/types";
import type { ProviderNetworkConfig } from "@/lib/api-network";
import { providerErrorHttpStatus } from "@/lib/error-message";
import { isAdminRole, teacherSafeError } from "@/lib/server/teacher-safe-error";

export const runtime = "nodejs";
export const maxDuration = 300;

// One grading job per submission at a time. A double-click used to start a second
// full run: another PDF conversion plus another provider call for every page.
// Combined with retries that is how one operator generated thousands of outbound
// requests, and the hosting provider then blocked the whole subscription's egress.
const gradingGlobal = globalThis as typeof globalThis & { __nomrehGradingInFlight?: Set<string> };
const gradingInFlight = gradingGlobal.__nomrehGradingInFlight || new Set<string>();
gradingGlobal.__nomrehGradingInFlight = gradingInFlight;

type GradeFileInput = {
  name?: string;
  type?: "image/jpeg" | "image/png" | "image/webp" | "application/pdf";
  data?: string;
  storedId?: string;
};

async function resolveGradeFiles(userId: string, files: GradeFileInput[]): Promise<GradeApiRequest["files"]> {
  const resolved: GradeApiRequest["files"] = [];
  for (const file of files) {
    if (file.data && file.name && file.type) {
      if (Buffer.byteLength(file.data, "base64") > MAX_FILE_SIZE_BYTES) throw new ProviderError(`فایل «${file.name}» بزرگ‌تر از ۱۰۰ مگابایت است.`, 413);
      resolved.push({ name: file.name, type: file.type, data: file.data });
      continue;
    }
    if (!file.storedId) throw new Error("شناسهٔ یکی از فایل‌ها مشخص نیست.");
    const stored = await readUserFile(userId, file.storedId);
    if (!stored) throw new Error("یکی از فایل‌های برگه روی سرور پیدا نشد؛ دوباره بارگذاری کنید.");
    if (stored.data.length > MAX_FILE_SIZE_BYTES) throw new ProviderError(`فایل «${stored.name}» بزرگ‌تر از ۱۰۰ مگابایت است.`, 413);
    resolved.push({ name: stored.name, type: stored.type, data: stored.data.toString("base64") });
  }
  return resolved;
}

export async function POST(request: Request) {
  let user: AuthUser | undefined;
  let input: GradeApiRequest | undefined;
  let config: { provider: ProviderId; model: string; apiKey: string; network: ProviderNetworkConfig } | undefined;
  let jobId: string | undefined;
  const startedAt = Date.now();

  const recordJob = async (status: "succeeded" | "failed", usage = { inputTokens: 0, outputTokens: 0 }, error?: string) => {
    if (!user || !config) return;
    const now = new Date().toISOString();
    const db = (await import("@/lib/server/db")).getDb();
    if (!jobId) {
      jobId = createId("job");
      const values = [jobId, user.id, input?.submissionId || null, config.provider, config.model, status, usage.inputTokens, usage.outputTokens, Date.now() - startedAt, error?.slice(0, 500) || null, now];
      const sql = `INSERT INTO ai_jobs (id, user_id, submission_id, provider, model, status, input_tokens, output_tokens, latency_ms, error, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
      db.prepare(sql).run(...values);
    } else {
      const values = [status, usage.inputTokens, usage.outputTokens, Date.now() - startedAt, error?.slice(0, 500) || null, jobId];
      const sql = "UPDATE ai_jobs SET status=?, input_tokens=?, output_tokens=?, latency_ms=?, error=? WHERE id=?";
      db.prepare(sql).run(...values);
    }
  };

  try {
    user = await requireWorkspaceUser();
    const parsed = gradeRequestSchema.parse(await request.json());
    const workspace = (await loadWorkspace(user.id)).data;
    const ownedExam = workspace?.exams.find((exam) => exam.id === parsed.examId);
    if (!ownedExam) {
      return NextResponse.json({ error: "این آزمون در فضای کاری شما پیدا نشد." }, { status: 403 });
    }
    if (ownedExam.questionsNeedReview) {
      return NextResponse.json({ error: "سؤال‌ها و کلید هنوز تأیید نشده‌اند. ابتدا پیش‌نویس را با برگهٔ اصلی مقایسه و در گام ۲ تأیید کنید." }, { status: 409 });
    }
    config = await getProviderConfig();
    const jobKey = `${user.id}:${parsed.submissionId || parsed.examId}`;
    if (gradingInFlight.has(jobKey)) {
      return NextResponse.json(
        { error: "این برگه همین حالا در حال تصحیح است. تا پایان همان اجرا صبر کنید و دوباره نفرستید." },
        { status: 429 },
      );
    }
    gradingInFlight.add(jobKey);
    input = { ...parsed, files: await resolveGradeFiles(user.id, parsed.files) } as GradeApiRequest;
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof ProviderError) return NextResponse.json({ error: error.message }, { status: providerErrorHttpStatus(error.status) });
    const message = error instanceof Error && !("issues" in error) ? error.message : "اطلاعات آزمون یا فایل‌ها کامل و معتبر نیست. نوع فایل، حجم و بارم سؤال‌ها را بررسی کنید.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const approximateFileBytes = input.files.reduce((sum, file) => sum + Math.floor(file.data.length * 0.75), 0);
  const providerByteLimit = config.provider === "gemini" ? 14 * 1024 * 1024 : ["deepseek", "zai", "minimax", "inkling", "mistral", "kaya"].includes(config.provider) ? 24 * 1024 * 1024 : 40 * 1024 * 1024;
  const hasPdf = input.files.some((file) => file.type === "application/pdf");
  if (approximateFileBytes > providerByteLimit && !hasPdf) {
    return NextResponse.json({ error: "حجم کل فایل‌های این دانش‌آموز برای یک درخواست زیاد است؛ فایل را فشرده یا برگه را به دسته‌های کوچک‌تر تقسیم کنید." }, { status: 413 });
  }
  let usage = { inputTokens: 0, outputTokens: 0 };
  try {
    const providerFiles = await prepareProviderFiles(input.files, config.provider, { convertAllPdfs: approximateFileBytes > providerByteLimit });
    const preparedBytes = providerFiles.reduce((sum, file) => sum + Math.floor(file.data.length * 0.75), 0);
    if (preparedBytes > providerByteLimit) {
      throw new ProviderError("حجم تصاویر صفحات پس از آماده‌سازی برای مدل زیاد است؛ تعداد صفحات را کمتر یا PDF را به دسته‌های کوچک‌تر تقسیم کنید.", 413);
    }
    const firstCall = await callProvider({ ...config, prompt: buildGradingPrompt(input), files: providerFiles });
    usage = { ...firstCall.usage };
    let normalized = normalizeGradingResult(firstCall.result, input, config.provider, config.model, usage);

    const shouldVerify = input.exam.settings.gradingMode === "precise"
      ? normalized.flags.length > 0 || normalized.questions.some((question) => question.needsReview)
      : input.exam.settings.gradingMode === "balanced"
        ? normalized.flags.some((flag) => flag.severity === "critical")
        : false;

    if (shouldVerify) {
      try {
        const secondCall = await callProvider({ ...config, prompt: buildGradingPrompt(input, firstCall.result), files: providerFiles });
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

    await recordJob("succeeded", usage);
    if (user && input) gradingInFlight.delete(`${user.id}:${(input as GradeApiRequest).submissionId || (input as GradeApiRequest).examId}`);
    return NextResponse.json({ result: normalized satisfies GradingResult });
  } catch (error) {
    const message = error instanceof Error ? error.message : "تصحیح برگه کامل نشد.";
    if (user) gradingInFlight.delete(`${user.id}:${input?.submissionId || input?.examId || ""}`);
    await recordJob("failed", usage, message);
    if (error instanceof ProviderError) {
      // The raw message names the vendor, the model and socket codes. It is stored
      // on the job row for the administrator and never sent to a teacher.
      const safe = teacherSafeError(error);
      const body = isAdminRole(user?.role)
        ? { error: error.message, teacherMessage: safe.error, code: safe.code, retryable: safe.retryable }
        : { error: safe.error, code: safe.code, retryable: safe.retryable };
      return NextResponse.json(body, { status: providerErrorHttpStatus(error.status) });
    }
    const safe = teacherSafeError(error);
    return NextResponse.json(
      isAdminRole(user?.role)
        ? { error: error instanceof Error ? error.message : safe.error, teacherMessage: safe.error, code: safe.code, retryable: safe.retryable }
        : { error: safe.error, code: safe.code, retryable: safe.retryable },
      { status: 500 },
    );
  }
}
