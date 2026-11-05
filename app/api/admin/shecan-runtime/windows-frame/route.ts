import { NextResponse } from "next/server";
import { AuthError, requireAdmin } from "@/lib/server/auth";
import { getOfficialRuntimeStatus } from "@/lib/server/shecan-runtime";

export const runtime = "nodejs";
export const maxDuration = 15;

export async function GET() {
  try {
    await requireAdmin();
    const runtimeStatus = getOfficialRuntimeStatus();
    const port = Number(process.env.NOMREH_SHECAN_WINDOWS_PREVIEW_PORT || 6099);
    if (runtimeStatus.applicationKind !== "windows" || !runtimeStatus.appReady || !Number.isInteger(port) || port < 1024 || port > 65535) {
      return NextResponse.json({ error: "نمایش برنامهٔ ویندوز آماده نیست." }, { status: 503 });
    }
    const upstream = await fetch(`http://127.0.0.1:${port}/frame`, { cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (!upstream.ok || upstream.headers.get("content-type") !== "image/jpeg") throw new Error("Windows frame unavailable");
    const frame = await upstream.arrayBuffer();
    if (!frame.byteLength || frame.byteLength > 2_000_000) throw new Error("Windows frame size is invalid");
    return new NextResponse(frame, {
      status: 200,
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "فریم برنامهٔ ویندوز در دسترس نیست." }, { status: 503 });
  }
}
