import type { Metadata, Viewport } from "next";
import "@fontsource-variable/vazirmatn";
import "./globals.css";
import "./features.css";

export const metadata: Metadata = {
  title: { default: "نمره | دستیار تصحیح آزمون", template: "%s | نمره" },
  description: "تصحیح هوشمند برگه‌های امتحانی با حساب معلم، کلاس‌بندی، بارم دقیق و بازبینی انسانی.",
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
      <body>{children}</body>
    </html>
  );
}
