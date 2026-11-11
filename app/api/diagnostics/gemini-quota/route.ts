import { NextResponse } from "next/server";
import { requireWorkspaceUser } from "@/lib/server/auth";
import { isAdminRole } from "@/lib/server/teacher-safe-error";
import { getProviderConfig } from "@/lib/server/provider-config";
import { probeGeminiKey } from "@/lib/server/gemini-quota";

/**
 * "Is the free tier alive?" — a GET with no page image, so it costs nothing and spends no
 * request of the generation quota. Admin only: the answer describes the account's key.
 */
export async function GET() {
  const user = await requireWorkspaceUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "برای این بررسی باید وارد شوید." }, { status: 401 });
  if (!isAdminRole(user.role)) return NextResponse.json({ error: "این بررسی فقط برای مدیر است." }, { status: 403 });
  const config = await getProviderConfig();
  if (config.provider !== "gemini") {
    return NextResponse.json(
      { error: "سرویس‌دهندهٔ فعلی Google Gemini نیست؛ این بررسی مخصوص سهمیهٔ رایگان Gemini است." },
      { status: 400 },
    );
  }
  const probe = await probeGeminiKey({ apiKey: config.apiKey });
  return NextResponse.json({ provider: config.provider, model: config.model, ...probe });
}
