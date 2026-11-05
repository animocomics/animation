import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { AppProvider } from "@/lib/app-context";
import { getCurrentUser } from "@/lib/server/auth";
import { getProviderStatus } from "@/lib/server/provider-config";

export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role === "admin") redirect("/admin");
  return (
    <AppProvider initialUser={user} initialProvider={await getProviderStatus(false)}>
      <AppShell>{children}</AppShell>
    </AppProvider>
  );
}
