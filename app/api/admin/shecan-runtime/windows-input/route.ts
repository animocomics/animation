import { NextResponse } from "next/server";
import { AuthError, requireAdmin } from "@/lib/server/auth";
import { getOfficialRuntimeStatus } from "@/lib/server/shecan-runtime";

export const runtime = "nodejs";
export const maxDuration = 15;

function sameOriginAdminRequest(request: Request): boolean {
  try {
    const origin = new URL(request.headers.get("origin") || "");
    return ["http:", "https:"].includes(origin.protocol)
      && origin.host === request.headers.get("host")
      && request.headers.get("x-nomreh-windows-client") === "1";
  } catch { return false; }
}

export async function POST(request: Request) {
  try {
    await requireAdmin();
    if (!sameOriginAdminRequest(request) || !request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      return NextResponse.json({ error: "درخواست ورودی برنامه معتبر نیست." }, { status: 403 });
    }
    const runtimeStatus = getOfficialRuntimeStatus();
    const port = Number(process.env.NOMREH_SHECAN_WINDOWS_PREVIEW_PORT || 6099);
    if (runtimeStatus.applicationKind !== "windows" || !runtimeStatus.appReady || !Number.isInteger(port) || port < 1024 || port > 65535) {
      return NextResponse.json({ error: "نمایش برنامهٔ ویندوز آماده نیست." }, { status: 503 });
    }
    const body = await request.text();
    if (Buffer.byteLength(body, "utf8") > 4096) return NextResponse.json({ error: "ورودی برنامه بزرگ‌تر از حد مجاز است." }, { status: 413 });
    const message = JSON.parse(body) as unknown;
    if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("Invalid Windows viewer input");
    const upstream = await fetch(`http://127.0.0.1:${port}/input`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!upstream.ok) throw new Error("Windows viewer input failed");
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof SyntaxError) return NextResponse.json({ error: "ورودی برنامه معتبر نیست." }, { status: 400 });
    return NextResponse.json({ error: "ارسال ورودی به برنامهٔ ویندوز انجام نشد." }, { status: 503 });
  }
}
