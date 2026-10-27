import type { Metadata } from "next";
import { SettingsPage } from "../../components/settings-page";

export const metadata: Metadata = { title: "تنظیمات و اتصال" };

export default function Settings() {
  return <SettingsPage />;
}
