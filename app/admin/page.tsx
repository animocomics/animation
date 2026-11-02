import { redirect } from "next/navigation";
import { AdminPanel } from "@/components/admin-panel";
import { getCurrentUser } from "@/lib/server/auth";

export const metadata = { title: "مدیریت سامانه" };

export default async function AdminPage() {
  const user = await getCurrentUser();
  if (user?.role !== "admin") redirect("/");
  return <AdminPanel />;
}
