import { redirect } from "next/navigation";
import { LoginForm } from "@/components/login-form";
import { getCurrentUser } from "@/lib/server/auth";

export const metadata = { title: "ورود به فضای کاری" };

/** A short, non-technical sentence per failure cause. */
const ERRORS: Record<string, string> = {
  bad: "نام کاربری یا رمز عبور درست نیست.",
  empty: "نام کاربری و رمز عبور را وارد کنید.",
  rate: "تلاش‌های ورود زیاد بوده است؛ چند دقیقه بعد دوباره تلاش کنید.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ e?: string; next?: string }>;
}) {
  if (await getCurrentUser()) redirect("/");
  const { e, next } = await searchParams;
  // The demo hint is for a fresh install only. It used to depend on the account
  // environment variables being absent, which is true on a configured host too, so
  // it appeared on a real deployment while the passwords it filled in were stale.
  const showDemoAccounts = !process.env.NOMREH_HIDE_DEMO_ACCOUNTS;
  return <LoginForm showDemoAccounts={showDemoAccounts} initialError={e ? ERRORS[e] || ERRORS.bad : ""} next={next || "/"} />;
}
