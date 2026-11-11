import { NextResponse } from "next/server";
import { AuthError, requireWorkspaceUser } from "@/lib/server/auth";
import { describeImportJob, findRunningImportJob, getImportJob } from "@/lib/server/import-jobs";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * "How is the reading going?"
 *
 * This is the request the browser makes while the model works. It answers from memory
 * in microseconds, so the proxy in front of the app cannot time it out however long
 * the model takes. If the teacher's connection drops mid-poll, the next poll asks the
 * same question — the job kept running, because it was never tied to a connection.
 *
 * A missing job is not an error to hide: it means the process that owned it restarted
 * (or the id is wrong), and only a fresh read can produce a draft.
 */
export async function GET(_request: Request, context: { params: Promise<{ jobId: string }> }) {
  try {
    await requireWorkspaceUser();
    const { jobId } = await context.params;
    const job = getImportJob(jobId);
    if (!job) {
      return NextResponse.json(
        { error: "این خواندن روی سرور پیدا نشد؛ معمولاً یعنی سرور در این فاصله راه‌اندازی مجدد شده است. یک بار دیگر برگه را بفرستید.", code: "import-job-missing" },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json(describeImportJob(job), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "وضعیت خواندن برگه معلوم نشد." }, { status });
  }
}
