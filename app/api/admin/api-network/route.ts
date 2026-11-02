import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, requireAdmin } from "@/lib/server/auth";
import { ApiNetworkError, clearApiNetworkJob, getApiNetworkJobStatus, getApiNetworkStatus, saveAndTestApiNetwork, startApiNetworkJob } from "@/lib/server/api-network";
import { ProviderNetworkError } from "@/lib/server/provider-network";

export const runtime = "nodejs";
export const maxDuration = 180;

const schema = z.object({
  enabled: z.boolean(),
  plan: z.enum(["free", "pro"]),
  servers: z.tuple([z.string().trim().min(7).max(15), z.string().trim().min(7).max(15)]),
  updateUrl: z.string().trim().max(2000).optional(),
});

export async function GET() {
  try {
    await requireAdmin();
    const [status, job] = await Promise.all([getApiNetworkStatus(), Promise.resolve(getApiNetworkJobStatus())]);
    return NextResponse.json({ status, pending: job.pending, jobError: job.error, jobStartedAt: job.startedAt, jobFinishedAt: job.finishedAt }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "وضعیت اتصال خوانده نشد." }, { status: 500 });
  }
}

async function saveApiNetwork(request: Request) {
  try {
    const user = await requireAdmin();
    const input = schema.parse(await request.json());
    const running = getApiNetworkJobStatus();
    if (input.enabled || running.pending) {
      const job = running.pending ? running : startApiNetworkJob(input, user.id);
      const status = await getApiNetworkStatus();
      // Passenger's HTTP proxy can time out before the documented one-minute
      // settling period. Return immediately and let the admin poll this same
      // persistent Node process while the bounded activation continues.
      return NextResponse.json({ status, pending: job.pending, jobError: job.error, jobStartedAt: job.startedAt, jobFinishedAt: job.finishedAt }, { status: 202, headers: { "Cache-Control": "no-store" } });
    }
    const status = await saveAndTestApiNetwork(input, user.id);
    clearApiNetworkJob();
    return NextResponse.json({ status, pending: false }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "نوع اشتراک و هر دو آدرس DNS معتبر را وارد کنید." }, { status: 400 });
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof ApiNetworkError || error instanceof ProviderNetworkError) {
      const status = await getApiNetworkStatus().catch(() => undefined);
      // This is an admin connection-test result, not an authorization failure.
      // Keep gateway/upstream failures JSON-shaped so Passenger cannot replace
      // the actionable Shecan message with its HTML 403 error document.
      const statusCode = error instanceof ApiNetworkError ? error.status : 502;
      const upstreamFailure = statusCode >= 500 || statusCode === 401 || statusCode === 403;
      return NextResponse.json({ error: error.message, status }, { status: upstreamFailure ? 400 : statusCode });
    }
    return NextResponse.json({ error: "ذخیره یا آزمایش اتصال انجام نشد؛ دوباره تلاش کنید." }, { status: 500 });
  }
}

export { saveApiNetwork as POST, saveApiNetwork as PUT };
