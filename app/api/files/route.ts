import { NextResponse } from "next/server";
import { AuthError, requireWorkspaceUser } from "@/lib/server/auth";
import { clearUserFiles, saveUserFile } from "@/lib/server/file-storage";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const user = await requireWorkspaceUser();
    const form = await request.formData();
    const id = String(form.get("id") || "");
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "فایل انتخاب نشده است." }, { status: 400 });
    await saveUserFile(user.id, id, file);
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "بارگذاری فایل ناموفق بود." }, { status });
  }
}

export async function DELETE() {
  try {
    const user = await requireWorkspaceUser();
    await clearUserFiles(user.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "پاک‌کردن فایل‌ها ناموفق بود." }, { status });
  }
}
