import { redirect } from "next/navigation";
import { LoginForm } from "@/components/login-form";
import { getCurrentUser } from "@/lib/server/auth";

export const metadata = { title: "ورود به فضای کاری" };

export default async function LoginPage() {
  if (await getCurrentUser()) redirect("/");
  const showDemoAccounts = !process.env.NOMREH_ADMIN_PASSWORD && !process.env.NOMREH_TEACHER_PASSWORD && !process.env.NOMREH_ADMIN_USERNAME && !process.env.NOMREH_TEACHER_USERNAME;
  return <LoginForm showDemoAccounts={showDemoAccounts} />;
}
