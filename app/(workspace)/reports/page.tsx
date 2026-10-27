import type { Metadata } from "next";
import { Suspense } from "react";
import { ReportsDashboard } from "@/components/reports-dashboard";

export const metadata: Metadata = { title: "گزارش و تحلیل" };

export default function ReportsPage() {
  return <Suspense fallback={<div className="card empty-state"><span className="spinner" /><p>در حال محاسبهٔ گزارش…</p></div>}><ReportsDashboard /></Suspense>;
}
