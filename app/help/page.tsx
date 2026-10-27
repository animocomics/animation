import type { Metadata } from "next";
import { HelpPage } from "../../components/help-page";

export const metadata: Metadata = { title: "راهنما و بهترین روش" };

export default function Help() {
  return <HelpPage />;
}
