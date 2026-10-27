import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticate, createSession } from "@/lib/server/auth";
import { rateLimit, requestIp } from "@/lib/server/rate-limit";

const schema = z.object({ username: z.string().trim().min(1).max(80), password: z.string().min(1).max(300) });

export async function POST(request: Request) {
  try {
    const input = schema.parse(await request.json());
    if (!rateLimit(`login:${requestIp(request)}:${input.username.toLowerCase()}`, 10, 15 * 60 * 1000)) {
      return NextResponse.json({ error: "تلاش‌های ورود زیاد بوده است؛ ۱۵ دقیقه بعد دوباره تلاش کنید." }, { status: 429 });
    }
    const user = authenticate(input.username, input.password);
    if (!user) return NextResponse.json({ error: "نام کاربری یا رمز عبور درست نیست." }, { status: 401 });
    await createSession(user.id);
    return NextResponse.json({ user });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "نام کاربری و رمز عبور را وارد کنید." }, { status: 400 });
    return NextResponse.json({ error: "ورود انجام نشد؛ لطفاً دوباره تلاش کنید." }, { status: 500 });
  }
}
