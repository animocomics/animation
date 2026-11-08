import { NextResponse } from "next/server";
import { ACCEPTED_FILE_LABEL } from "@/lib/file-constraints";
import { AuthError, requireWorkspaceUser } from "@/lib/server/auth";
import { getProviderConfig } from "@/lib/server/provider-config";
import { providerByteLimit } from "@/lib/server/provider-traits";
import { regionBlockWarning } from "@/lib/server/region-block";

export const runtime = "nodejs";

/**
 * "Is this thing actually wired up?" — answered without spending a token.
 *
 * The teacher kept receiving one sentence that could mean six different things, and
 * the only way to tell them apart was for someone to read the server log. This endpoint
 * reports what the server knows about itself: which provider and model are configured,
 * whether a key is present (never the key), what the size limits are, how long a call
 * may run, and whether the last refusal was a country block. It makes no provider
 * request, so opening it costs nothing.
 */
export async function GET() {
  try {
    const user = await requireWorkspaceUser();
    let provider: Awaited<ReturnType<typeof getProviderConfig>> | null = null;
    let providerError = "";
    try {
      provider = await getProviderConfig();
    } catch (error) {
      providerError = error instanceof Error ? error.message : "خواندن تنظیمات سرویس ناموفق بود.";
    }

    const configuredTimeout = Number(process.env.NOMREH_PROVIDER_TIMEOUT_MS || "");
    const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout >= 15_000 ? Math.min(configuredTimeout, 600_000) : 120_000;
    const singlePageBudget = 400 * 1024; // measured: ~256 KB per A4 page at the app's render scale

    return NextResponse.json({
      ok: !providerError && Boolean(provider?.provider && provider?.model && provider?.apiKey),
      provider: provider ? { id: provider.provider, model: provider.model, hasKey: Boolean(provider.apiKey) } : null,
      providerError: providerError || undefined,
      limits: {
        acceptedFiles: ACCEPTED_FILE_LABEL,
        requestBytes: providerByteLimit(provider?.provider ?? "gemini"),
        timeoutMs,
        // Above this, the page is likely to run past the proxy's patience.
        pagesPerRequestAdvice: Math.max(1, Math.floor(providerByteLimit(provider?.provider ?? "gemini") / singlePageBudget)),
      },
      warning: provider ? regionBlockWarning(provider.provider) : null,
      // The one check that catches the most common host problem: a process started
      // before the current build, where the code behaves nothing like the docs.
      buildId: process.env.NOMREH_BUILD_ID || null,
      role: user.role,
      note: "این گزارش هیچ درخواستی به سرویس هوش مصنوعی نمی‌فرستد و هیچ توکنی مصرف نمی‌کند.",
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "بررسی آمادگی ناموفق بود." }, { status });
  }
}
