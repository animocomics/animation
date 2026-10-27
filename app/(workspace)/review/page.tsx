import type { Metadata } from "next";
import { Suspense } from "react";
import { ReviewWorkspace } from "@/components/review/review-workspace";

export const metadata: Metadata = { title: "بازبینی نمرات" };

export default function ReviewPage() {
  return <Suspense fallback={<div className="card empty-state"><span className="spinner" /><p>در حال آماده‌سازی برگه‌ها…</p></div>}><ReviewWorkspace /></Suspense>;
}
