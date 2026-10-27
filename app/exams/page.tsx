import type { Metadata } from "next";
import { ExamsList } from "../../components/exams-list";

export const metadata: Metadata = { title: "آزمون‌های من" };

export default function ExamsPage() {
  return <ExamsList />;
}
