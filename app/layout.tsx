import type { Metadata, Viewport } from "next";
import "@fontsource-variable/vazirmatn";
import "./globals.css";
import { AppProvider } from "../lib/app-context";
import { AppShell } from "../components/app-shell";

export const metadata: Metadata = {
  title: { default: "نمره | دستیار تصحیح آزمون", template: "%s | نمره" },
  description: "تصحیح هوشمند برگه‌های امتحانی با بارم دقیق، بازبینی انسانی و اتصال مستقیم به API مدل‌های چندوجهی.",
  icons: { icon: "/nomreh-mark.svg" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#123b35",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="fa" dir="rtl">
      <body>
        <AppProvider>
          <AppShell>{children}</AppShell>
        </AppProvider>
      </body>
    </html>
  );
}
