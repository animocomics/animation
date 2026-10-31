import { NextResponse } from "next/server";
import { z } from "zod";
import { ACCEPTED_FILE_TYPES, MAX_FILE_SIZE_BYTES } from "@/lib/file-constraints";
import type { AuthUser, GradeApiRequest, ProviderId } from "@/lib/types";
import { AuthError, requireUser } from "@/lib/server/auth";
import { readUserFile } from "@/lib/server/file-storage";
import { prepareProviderFiles } from "@/lib/server/pdf-vision";
import { getProviderConfig } from "@/lib/server/provider-config";
import { callProvider, ProviderError } from "@/lib/server/providers";
import {
  buildQuestionImportPrompt,
  normalizeImportedQuestions,
  QuestionImportValidationError,
} from "@/lib/server/question-import-schema";
import { loadWorkspace } from "@/lib/server/workspace-store";

export const runtime = "nodejs";
export const maxDuration = 300;

const requestSchema = z.object({
  examId: z.string().min(1).max(200),
  sources: z.array(z.object({
    storedId: z.string().min(1).max(180),
    kind: z.enum(["questions", "answers", "combined"]),
  })).min(1).max(30),
});

function providerByteLimit(provider: ProviderId): number {
  if (provider === "gemini") return 14 * 1024 * 1024;
  if (["deepseek", "zai", "minimax", "inkling", "mistral"].includes(provider)) return 24 * 1024 * 1024;
  return 40 * 1024 * 1024;
}

export async function POST(request: Request) {
  let user: AuthUser | undefined;
  try {
    user = await requireUser();
    const input = requestSchema.parse(await request.json());
    const workspace = (await loadWorkspace(user.id)).data;
    if (!workspace?.exams.some((exam) => exam.id === input.examId)) {
      return NextResponse.json({ error: "این آزمون در فضای کاری شما پیدا نشد." }, { status: 403 });
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

    const prompt = buildQuestionImportPrompt(JSON.stringify(manifest));
    const response = await callProvider({ ...config, task: "question-import", prompt, files: providerFiles });
    const draft = normalizeImportedQuestions(response.result);
    return NextResponse.json({ questions: draft.questions, warnings: draft.warnings, usage: response.usage });
  } catch (error) {
    if (error instanceof AuthError || error instanceof ProviderError || error instanceof QuestionImportValidationError) {
      return NextResponse.json({ error: error.message, ...(error instanceof QuestionImportValidationError ? { issues: error.issues } : {}) }, { status: error.status });
    }
    if (error instanceof z.ZodError) return NextResponse.json({ error: "شناسهٔ آزمون یا فایل‌های سؤال و کلید معتبر نیست." }, { status: 400 });
    const message = error instanceof Error ? error.message : "خواندن سؤال و کلید کامل نشد.";
    const status = error instanceof Error && error.message.includes("پیکربندی نشده") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
