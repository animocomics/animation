import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, requireWorkspaceUser } from "@/lib/server/auth";
import { loadWorkspace, saveWorkspace, WorkspaceConflictError } from "@/lib/server/workspace-store";

export async function GET() {
  try {
    const user = await requireWorkspaceUser();
    return NextResponse.json(await loadWorkspace(user.id), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "خواندن فضای کاری ناموفق بود." }, { status });
  }
}

async function updateWorkspace(request: Request) {
  try {
    const user = await requireWorkspaceUser();
    const body = z.object({ data: z.unknown(), expectedRevision: z.number().int().nonnegative().optional() }).parse(await request.json());
    const result = await saveWorkspace(user.id, body.data, body.expectedRevision);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof WorkspaceConflictError) return NextResponse.json({ error: "نسخهٔ جدیدتری از فضای کاری روی سرور ذخیره شده است." }, { status: 409 });
    if (error instanceof z.ZodError) {
      // Name the field that failed. "the structure is invalid" cost a day: the
      // actual cause was one stale provider name inside settings, and nothing in
      // the response or the browser console said which part was rejected. Schema
      // field paths carry no secrets, so naming them is safe and decisive.
      const path = error.issues[0]?.path?.join(".") || "";
      // zod v4 reports a bad enum member as invalid_value and lists the accepted ones.
      const issue = error.issues[0] as { code?: string; options?: unknown[] } | undefined;
      const expected = issue?.code === "invalid_value" && Array.isArray(issue.options) ? issue.options.map(String).join("/") : "";
      return NextResponse.json(
        {
          error: `ساختار فضای کاری معتبر نیست${path ? ` (فیلد ${path})` : ""}${expected ? `؛ مقدار مجاز: ${expected}` : ""}.`,
          field: path || undefined,
        },
        { status: 400 },
      );
    }
    const status = error instanceof AuthError ? error.status : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "ذخیرهٔ فضای کاری ناموفق بود." }, { status });
  }
}

export { updateWorkspace as POST, updateWorkspace as PUT };
