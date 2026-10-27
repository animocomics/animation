import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, requireUser } from "@/lib/server/auth";
import { loadWorkspace, saveWorkspace, WorkspaceConflictError } from "@/lib/server/workspace-store";

export async function GET() {
  try {
    const user = await requireUser();
    return NextResponse.json(loadWorkspace(user.id), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "خواندن فضای کاری ناموفق بود." }, { status });
  }
}

export async function PUT(request: Request) {
  try {
    const user = await requireUser();
    const body = z.object({ data: z.unknown(), expectedRevision: z.number().int().nonnegative().optional() }).parse(await request.json());
    const result = saveWorkspace(user.id, body.data, body.expectedRevision);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof WorkspaceConflictError) return NextResponse.json({ error: "نسخهٔ جدیدتری از فضای کاری روی سرور ذخیره شده است." }, { status: 409 });
    if (error instanceof z.ZodError) return NextResponse.json({ error: "ساختار فضای کاری معتبر نیست." }, { status: 400 });
    const status = error instanceof AuthError ? error.status : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "ذخیرهٔ فضای کاری ناموفق بود." }, { status });
  }
}
