import type { Metadata } from "next";
import { ExamDetail } from "../../../components/exam-detail";

export const metadata: Metadata = { title: "جزئیات آزمون" };

export default async function ExamDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ExamDetail examId={id} />;
}
