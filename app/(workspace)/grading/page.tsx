import type { Metadata } from "next";
import { Suspense } from "react";
import { GradingWizard } from "@/components/grading/grading-wizard";

export const metadata: Metadata = { title: "آزمون جدید" };

export default function GradingPage() {
  return (
    <Suspense fallback={<div className="card empty-state"><span className="spinner" /><p>در حال آماده‌سازی فضای تصحیح…</p></div>}>
      <GradingWizard />
    </Suspense>
  );
}
