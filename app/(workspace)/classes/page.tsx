import { Suspense } from "react";
import { ClassManager } from "@/components/classes/class-manager";

export const metadata = { title: "کلاس‌ها و دانش‌آموزان" };

export default function ClassesPage() {
  return <Suspense fallback={<div className="card empty-state"><span className="spinner" /><p>در حال آماده‌سازی کلاس‌ها…</p></div>}><ClassManager /></Suspense>;
}
