import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, requireAdmin } from "@/lib/server/auth";
import { getKayaEgress, saveKayaEgress } from "@/lib/server/kaya-egress-store";
import { networkInterfaces } from "node:os";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The Kaya egress setting: which local address Kaya sees.
 *
 * The server's default route is the address Kaya's firewall drops, while the same
 * host answers other sites. A socket can choose its source address, so this is the
 * one change that can make Kaya work directly without touching routing, root, or a
 * tunnel. It is also the setting most likely to break everything, so the GET always
 * reports the machine's real addresses and whether the saved one exists.
 */

function localAddresses(): string[] {
  const found: string[] = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === "IPv4" && !address.internal) found.push(address.address);
    }
  }
  return found;
}

export async function GET() {
  try {
    await requireAdmin();
    const status = await getKayaEgress();
    return NextResponse.json({ ...status, localAddresses: localAddresses() });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: "دسترسی مدیر لازم است." }, { status: 401 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "خواندن تنظیمات ناموفق بود." }, { status: 500 });
  }
}

const schema = z.object({
  bindAddress: z.string().trim().max(45).default(""),
  host: z.string().trim().max(200).default(""),
});

export async function POST(request: Request) {
  try {
    const user = await requireAdmin();
    const input = schema.parse(await request.json());
    const saved = await saveKayaEgress(input, user.id);
    return NextResponse.json(saved);
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: "دسترسی مدیر لازم است." }, { status: 401 });
    if (error instanceof z.ZodError) return NextResponse.json({ error: "مقادیر واردشده معتبر نیستند." }, { status: 400 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "ذخیره ناموفق بود." }, { status: 400 });
  }
}
