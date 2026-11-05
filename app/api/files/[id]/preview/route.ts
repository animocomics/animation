import { NextResponse } from "next/server";
import { AuthError, requireWorkspaceUser } from "@/lib/server/auth";
import { readUserFile } from "@/lib/server/file-storage";
import { renderPdfToVisionFiles } from "@/lib/server/pdf-vision";
import { ProviderError } from "@/lib/server/providers";

export const runtime = "nodejs";
export const maxDuration = 60;

type RouteContext = { params: Promise<{ id: string }> };

/** Authenticated, same-owner page preview; the original PDF remains available at the parent route. */
export async function GET(request: Request, context: RouteContext) {
  try {
    const user = await requireWorkspaceUser();
    const { id } = await context.params;
    const file = await readUserFile(user.id, id);
    if (!file) return NextResponse.json({ error: "فایل پیدا نشد." }, { status: 404 });
    if (file.type !== "application/pdf") return NextResponse.json({ error: "پیش‌نمایش صفحه‌ای فقط برای PDF است." }, { status: 400 });
    const rawPage = new URL(request.url).searchParams.get("page") || "1";
    const page = Number(rawPage);
    if (!Number.isInteger(page) || page < 1) return NextResponse.json({ error: "شمارهٔ صفحه معتبر نیست." }, { status: 400 });
    const rendered = await renderPdfToVisionFiles({ name: file.name, type: file.type, data: file.data.toString("base64") }, 1, page);
    const jpeg = Buffer.from(rendered[0].data, "base64");
    return new Response(new Uint8Array(jpeg), {
      headers: {
        "Content-Type": "image/jpeg",
        "Content-Length": String(jpeg.length),
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(`${file.name}-page-${page}.jpg`)}`,
        "X-Nomreh-Preview-Page": String(page),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const status = error instanceof AuthError || error instanceof ProviderError ? error.status : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "ساخت پیش‌نمایش PDF ناموفق بود." }, { status });
  }
}
