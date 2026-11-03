import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, requireAdmin } from "@/lib/server/auth";
import { getApiNetworkStatus } from "@/lib/server/api-network";
import {
  loginShecanAccount,
  logoutShecanAccount,
  probeShecanAccountService,
  refreshShecanOrders,
  selectShecanOrder,
  ShecanAccountError,
} from "@/lib/server/shecan-account";

export const runtime = "nodejs";
export const maxDuration = 90;

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("login"), identifier: z.string().min(1).max(160), password: z.string().min(1).max(512) }),
  z.object({ action: z.literal("refresh") }),
  z.object({ action: z.literal("probe") }),
  z.object({ action: z.literal("select"), orderId: z.number().int().positive() }),
]);

async function responseWithStatus(orders?: unknown) {
  return NextResponse.json({ status: await getApiNetworkStatus(), ...(orders ? { orders } : {}) }, { headers: { "Cache-Control": "no-store" } });
}

export async function GET() {
  try {
    await requireAdmin();
    return await responseWithStatus();
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "وضعیت حساب شکن خوانده نشد." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireAdmin();
    const input = schema.parse(await request.json());
    if (input.action === "login") {
      const result = await loginShecanAccount(input.identifier, input.password, user.id);
      return responseWithStatus(result.orders);
    }
    if (input.action === "probe") {
      const accountProbe = await probeShecanAccountService();
      return NextResponse.json({ status: await getApiNetworkStatus(), accountProbe }, { headers: { "Cache-Control": "no-store" } });
    }
    if (input.action === "refresh") {
      const result = await refreshShecanOrders(user.id);
      return responseWithStatus(result.orders);
    }
    const result = await selectShecanOrder(input.orderId, user.id);
    return responseWithStatus(result.orders);
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "نام کاربری، رمز عبور یا سرویس انتخاب‌شده معتبر نیست." }, { status: 400 });
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof ShecanAccountError) {
      const status = await getApiNetworkStatus().catch(() => undefined);
      const statusCode = error.status >= 500 || error.status === 401 || error.status === 403 ? 400 : error.status;
      return NextResponse.json({ error: error.message, status }, { status: statusCode, headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json({ error: "عملیات حساب شکن انجام نشد؛ رمز ذخیره نشد و دوباره تلاش کنید." }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const user = await requireAdmin();
    await logoutShecanAccount(user.id);
    return responseWithStatus();
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "خروج از حساب شکن انجام نشد." }, { status: 500 });
  }
}
