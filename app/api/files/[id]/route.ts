import { NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/server/auth";
import { deleteUserFile, readUserFile } from "@/lib/server/file-storage";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  try {
    const user = await requireUser();
    const { id } = await context.params;
    const file = await readUserFile(user.id, id);
    if (!file) return NextResponse.json({ error: "فایل پیدا نشد." }, { status: 404 });
    return new Response(new Uint8Array(file.data), {
      headers: {
        "Content-Type": file.type,
        "Content-Length": String(file.data.length),
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        "X-Nomreh-File-Name": encodeURIComponent(file.name),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "خواندن فایل ناموفق بود." }, { status });
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const user = await requireUser();
    const { id } = await context.params;
    await deleteUserFile(user.id, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "حذف فایل ناموفق بود." }, { status });
  }
}
