import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { AppProvider } from "@/lib/app-context";
import { getCurrentUser } from "@/lib/server/auth";
import { getProviderStatus } from "@/lib/server/provider-config";

export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return (
    <AppProvider initialUser={user} initialProvider={getProviderStatus(user.role === "admin")}>
      <AppShell>{children}</AppShell>
    </AppProvider>
  );
}
