import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, requireAdmin, requireUser } from "@/lib/server/auth";
import { getProviderStatus, saveProviderConfig } from "@/lib/server/provider-config";
import { PROVIDER_IDS } from "@/lib/provider-catalog";
import { regionBlockWarning } from "@/lib/server/region-block";

const schema = z.object({
  provider: z.enum(PROVIDER_IDS),
  model: z.string().trim().min(2).max(120),
  apiKey: z.string().trim().max(500).optional(),
});

export async function GET() {
  try {
    const user = await requireUser();
    const status = await getProviderStatus(user.role === "admin");
    // The same provider that already refused this server is flagged in the panel, so
    // choosing it again is a deliberate act rather than another billed surprise.
    const warning = user.role === "admin" ? regionBlockWarning(status.provider) : null;
    return NextResponse.json({ status, warning }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "خواندن وضعیت اتصال ناموفق بود." }, { status });
  }
}

async function saveProvider(request: Request) {
  try {
    const admin = await requireAdmin();
    const input = schema.parse(await request.json());
    return NextResponse.json({ status: await saveProviderConfig(input, admin.id) });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "ارائه‌دهنده و مدل را کامل وارد کنید." }, { status: 400 });
    const status = error instanceof AuthError ? error.status : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "ذخیرهٔ اتصال ناموفق بود." }, { status });
  }
}

// POST avoids the host's HTML 403 response for PUT; PUT remains for backward compatibility.
export { saveProvider as POST, saveProvider as PUT };
