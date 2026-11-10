import { NextResponse } from "next/server";
import { z } from "zod";
import { ACCEPTED_FILE_TYPES, MAX_FILE_SIZE_BYTES } from "@/lib/file-constraints";
import type { AuthUser, GradeApiRequest, ProviderId } from "@/lib/types";
import { applyImportedAnswerKey, buildAnswerKeyImportPrompt } from "@/lib/server/answer-key-import-schema";
import { AuthError, requireWorkspaceUser } from "@/lib/server/auth";
import { claimPaidRequest, duplicateKey, releasePaidRequest } from "@/lib/server/duplicate-guard";
import { failImportJob, finishImportJob, setImportStep, startImportJob } from "@/lib/server/import-jobs";
import { readUserFile } from "@/lib/server/file-storage";
import { prepareProviderFiles } from "@/lib/server/pdf-vision";
import { getProviderConfig } from "@/lib/server/provider-config";
import { providerByteLimit } from "@/lib/server/provider-traits";
import { callProvider, ProviderError } from "@/lib/server/providers";
import {
  buildQuestionImportPrompt,
  importNotesOf,
  normalizeImportedQuestions,
  QuestionImportValidationError,
} from "@/lib/server/question-import-schema";
import { loadWorkspace } from "@/lib/server/workspace-store";
import { providerErrorHttpStatus } from "@/lib/error-message";
import { isAdminRole, teacherSafeError } from "@/lib/server/teacher-safe-error";

export const runtime = "nodejs";
export const maxDuration = 300;

const requestSchema = z.object({
  examId: z.string().min(1).max(200),
  mode: z.enum(["questions-and-key", "answer-key-only"]).default("questions-and-key"),
  sources: z.array(z.object({
    storedId: z.string().min(1).max(180),
    kind: z.enum(["questions", "answers", "combined"]),
  })).min(1).max(30),
});

export async function POST(request: Request) {
  let user: AuthUser | undefined;
  try {
    user = await requireWorkspaceUser();
    const input = requestSchema.parse(await request.json());
    const workspace = (await loadWorkspace(user.id)).data;
    const exam = workspace?.exams.find((item) => item.id === input.examId);
    if (!exam) {
      return NextResponse.json({ error: "این آزمون در فضای کاری شما پیدا نشد." }, { status: 403 });
    }
    if (input.mode === "answer-key-only") {
      if (input.sources.some((source) => source.kind !== "answers")) {
        return NextResponse.json({ error: "در حالت کلید جدا فقط فایل‌هایی با نقش «فقط کلید» پذیرفته می‌شود." }, { status: 400 });
      }
      if (!exam.questions.length || exam.questions.some((question) => !question.prompt.trim() || (["multiple_choice", "multiple_response"].includes(question.type) && question.options.filter((option) => option.trim()).length < 2))) {
        return NextResponse.json({ error: "برای خواندن کلید جدا، ابتدا صورت سؤال‌ها و گزینه‌های تستی را وارد یا از برگه بخوانید. کلید به همان سؤال‌های موجود اضافه می‌شود." }, { status: 400 });
      }
    }
    const config = await getProviderConfig();
    const files: GradeApiRequest["files"] = [];
    const roleLabels = { questions: "فقط سؤال", answers: "فقط کلید/پاسخ معلم", combined: "سؤال و کلید با هم" };

    for (const source of input.sources) {
      const stored = await readUserFile(user.id, source.storedId);
      if (!stored) return NextResponse.json({ error: "یکی از برگه‌های سؤال یا کلید روی سرور پیدا نشد؛ دوباره بارگذاری کنید." }, { status: 404 });
      if (stored.data.length > MAX_FILE_SIZE_BYTES) return NextResponse.json({ error: `فایل «${stored.name}» بزرگ‌تر از ۱۰۰ مگابایت است.` }, { status: 413 });
      if (!(ACCEPTED_FILE_TYPES as readonly string[]).includes(stored.type)) return NextResponse.json({ error: `قالب فایل «${stored.name}» برای خواندن پشتیبانی نمی‌شود.` }, { status: 400 });
      files.push({ name: stored.name, type: stored.type as "image/jpeg" | "image/png" | "image/webp" | "application/pdf", data: stored.data.toString("base64") });
    }

    const byteLimit = providerByteLimit(config.provider);
    const sourceBytes = files.reduce((sum, file) => sum + Math.floor(file.data.length * 0.75), 0);
    if (sourceBytes > byteLimit && !files.some((file) => file.type === "application/pdf")) {
      return NextResponse.json({ error: "حجم تصاویر برای یک درخواست مدل زیاد است؛ تصاویر را فشرده یا به چند بخش تقسیم کنید. محدودیت ۱۰۰ مگابایت فقط مربوط به ذخیرهٔ فایل است." }, { status: 413 });
    }

    // Convert each source separately so a five-page PDF and a separate key never lose their roles.
    const providerFiles: GradeApiRequest["files"] = [];
    const manifest: Array<{ file: number; sourceFile: number; name: string; role: string }> = [];
    for (const [sourceIndex, file] of files.entries()) {
      const converted = await prepareProviderFiles([file], config.provider, { convertAllPdfs: true });
      for (const providerFile of converted) {
        providerFiles.push(providerFile);
        manifest.push({ file: providerFiles.length, sourceFile: sourceIndex + 1, name: providerFile.name, role: roleLabels[input.sources[sourceIndex].kind] });
      }
    }
    if (providerFiles.length > 30) return NextResponse.json({ error: "تعداد صفحات و فایل‌های سؤال و کلید برای یک درخواست بیش از ۳۰ است؛ آن را به دسته‌های کوچک‌تر تقسیم کنید." }, { status: 413 });
    const preparedBytes = providerFiles.reduce((sum, file) => sum + Math.floor(file.data.length * 0.75), 0);
    if (preparedBytes > byteLimit) {
      return NextResponse.json({ error: "حجم تصاویر صفحات پس از آماده‌سازی برای مدل زیاد است؛ تعداد صفحات را کمتر یا PDF را به دسته‌های کوچک‌تر تقسیم کنید." }, { status: 413 });
    }

    if (input.mode === "answer-key-only") {
      const prompt = buildAnswerKeyImportPrompt(JSON.stringify(manifest), exam.questions);
      const response = await callProvider({ ...config, task: "answer-key-import", prompt, files: providerFiles });
      const draft = applyImportedAnswerKey(response.result, exam.questions);
      return NextResponse.json({ questions: draft.questions, warnings: draft.warnings, usage: response.usage });
    }

    const prompt = buildQuestionImportPrompt(JSON.stringify(manifest));
    // A model that reads twenty pages takes minutes, and the proxy in front of the app
    // gives up after sixty seconds. So the POST no longer waits for the model at all:
    // it starts the work and answers immediately. The browser then polls a request that
    // takes microseconds, which no proxy will ever time out, and a cut poll costs
    // nothing because the job is not attached to the connection.
    const jobKey = duplicateKey(["question-import", user.id, input.examId, config.provider, config.model, ...input.sources.map((source) => source.storedId).sort()]);
    const started = startImportJob(jobKey);
    if (!started.created) {
      // Same exam, same pages, same model, still running: hand back the job in flight
      // instead of buying the same work a second time.
      return NextResponse.json({ jobId: started.job.id, status: started.job.status, step: started.job.step, reused: true }, { status: 202 });
    }
    const claimed = claimPaidRequest(jobKey);
    if (!claimed) {
      failImportJob(started.job.id, {
        status: 429,
        message: "همین برگه چند لحظه پیش خوانده شد و همان درخواست دوباره ارسال نشد تا دوبار هزینه نشود. نتیجهٔ همان خواندن را ببینید؛ اگر خطا داد، حدود یک دقیقه بعد دوباره بخوانید.",
      });
      return NextResponse.json({ jobId: started.job.id, status: "failed" }, { status: 429 });
    }

    // Deliberately not awaited: the answer to this POST is the job id, not the draft.
    void (async () => {
      try {
        setImportStep(started.job.id, "در حال خواندن برگه‌ها با مدل");
        const response = await callProvider({ ...config, task: "question-import", prompt, files: providerFiles });
        setImportStep(started.job.id, "در حال ساخت پیش‌نویس");
        const draft = normalizeImportedQuestions(response.result);
        // A question that was read but needs a human eye carries its own note. It is shown
        // as a warning beside that question, and stripped from the payload so the saved
        // exam keeps exactly the shape the rest of the app validates.
        const questionNotes = draft.questions.flatMap((question) =>
          importNotesOf(question).map((note) => `سؤال ${question.number}: ${note}`),
        );
        const questions = draft.questions.map((question) => {
          if (!importNotesOf(question).length) return question;
          const { importNotes: _notes, ...rest } = question as typeof question & { importNotes?: string[] };
          return rest;
        });
        finishImportJob(started.job.id, { questions, warnings: [...draft.warnings, ...questionNotes].slice(0, 40), usage: response.usage });
      } catch (error) {
        // A request that never reached the model cost nothing, so it must not lock the
        // teacher out. Only failures that may already be billed keep the claim.
        if (error instanceof ProviderError && [400, 402].includes(error.status)) releasePaidRequest(jobKey);
        const admin = await requireWorkspaceUser().then((current) => isAdminRole(current.role)).catch(() => false);
        if (error instanceof ProviderError) {
          const safe = teacherSafeError(error);
          failImportJob(started.job.id, { status: providerErrorHttpStatus(error.status), message: admin ? error.message : safe.error, code: safe.code });
        } else if (error instanceof QuestionImportValidationError) {
          failImportJob(started.job.id, { status: error.status, message: error.message, issues: error.issues });
        } else {
          failImportJob(started.job.id, { status: 500, message: error instanceof Error ? error.message : "خواندن سؤال و کلید کامل نشد." });
        }
      }
    })();

    return NextResponse.json({ jobId: started.job.id, status: "working", step: started.job.step }, { status: 202 });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof ProviderError) {
      // Same rule as grading: the vendor and model names stay with the administrator.
      const safe = teacherSafeError(error);
      const admin = await requireWorkspaceUser().then((current) => isAdminRole(current.role)).catch(() => false);
      return NextResponse.json(
        admin ? { error: error.message, teacherMessage: safe.error, code: safe.code } : { error: safe.error, code: safe.code },
        { status: providerErrorHttpStatus(error.status) },
      );
    }
    if (error instanceof QuestionImportValidationError) return NextResponse.json({ error: error.message, issues: error.issues }, { status: error.status });
    if (error instanceof z.ZodError) return NextResponse.json({ error: "شناسهٔ آزمون یا فایل‌های سؤال و کلید معتبر نیست." }, { status: 400 });
    const message = error instanceof Error ? error.message : "خواندن سؤال و کلید کامل نشد.";
    const status = error instanceof Error && error.message.includes("پیکربندی نشده") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
