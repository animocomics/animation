"use client";

import { createCsv } from "./csv";
import type { Exam, Submission } from "./types";
import { downloadBlob, faNumber, getSubmissionStatusLabel, round } from "./utils";

export function exportExamCsv(exam: Exam): void {
  const headers = [
    "کد آزمون", "نام آزمون", "کلاس", "نام دانش‌آموز", "کد دانش‌آموزی", "وضعیت تطبیق هویت", "نمره", "نمره کل", "درصد", "وضعیت",
    "اعتماد مدل", "تعداد هشدار", "بازبینی دوم", ...exam.questions.map((question) => `سؤال ${question.number}`),
    "خلاصه", "هشدارها",
  ];
  const rows = exam.submissions.map((submission) => {
    const result = submission.result;
    return [
      exam.code || "",
      exam.title,
      exam.className,
      submission.studentName,
      submission.studentCode,
      submission.identityStatus ?? "manual",
      result?.totalScore ?? "",
      result?.maxScore ?? "",
      result?.percentage ?? "",
      getSubmissionStatusLabel(submission.status),
      result ? round(result.overallConfidence * 100, 1) : "",
      result?.flags.length ?? "",
      result?.verification ?? "",
      ...exam.questions.map((question) => result?.questions.find((item) => item.questionId === question.id)?.score ?? ""),
      result?.summary ?? submission.error ?? "",
      result?.flags.map((flag) => flag.message).join(" | ") ?? "",
    ];
  });
  const content = `\uFEFF${createCsv([headers, ...rows])}`;
  downloadBlob(new Blob([content], { type: "text/csv;charset=utf-8" }), `${exam.title.replace(/\s+/g, "-")}-results.csv`);
}

export function exportStudentJson(exam: Exam, submission: Submission): void {
  const content = JSON.stringify({
    exam: {
      title: exam.title,
      code: exam.code,
      subject: exam.subject,
      classId: exam.classId,
      className: exam.className,
      date: exam.date,
      questions: exam.questions,
    },
    student: { id: submission.studentId, name: submission.studentName, code: submission.studentCode, identityStatus: submission.identityStatus, identityMessage: submission.identityMessage, detectedClassName: submission.detectedClassName },
    status: getSubmissionStatusLabel(submission.status),
    result: submission.result,
    audit: submission.audit,
  }, null, 2);
  downloadBlob(new Blob([content], { type: "application/json;charset=utf-8" }), `${submission.studentName.replace(/\s+/g, "-")}-report.json`);
}

export function printStudentReport(exam: Exam, submission: Submission): void {
  const result = submission.result;
  if (!result) return;
  const printWindow = window.open("", "_blank", "width=900,height=700");
  if (!printWindow) return;
  const rows = exam.questions.map((question) => {
    const answer = result.questions.find((item) => item.questionId === question.id);
    return `<tr><td>${question.number}</td><td>${escapeHtml(question.prompt)}</td><td>${faNumber(answer?.score ?? 0)} از ${faNumber(question.maxScore)}</td><td>${escapeHtml(answer?.rationale ?? "—")}</td></tr>`;
  }).join("");
  printWindow.document.write(`<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><title>کارنامهٔ ${escapeHtml(submission.studentName)}</title><style>body{font-family:Tahoma,Arial,sans-serif;color:#18332f;padding:35px;line-height:1.8}h1{font-size:24px}h2{font-size:16px;margin-top:28px}p,td{font-size:12px}table{width:100%;border-collapse:collapse;margin-top:15px}th,td{border:1px solid #dfe6e1;padding:9px;text-align:right;vertical-align:top}th{background:#f2f7f3}.score{display:inline-block;padding:12px 20px;background:#e4f4ed;border-radius:10px;font-size:22px;font-weight:bold}.meta{color:#667b72}.notice{padding:12px;background:#fff4df;border-radius:8px;margin-top:18px}@media print{body{padding:0}}</style></head><body><h1>کارنامهٔ آزمون ${escapeHtml(exam.title)}</h1><p class="meta">${escapeHtml(exam.subject)} · ${escapeHtml(exam.className)} · ${escapeHtml(exam.code || "بدون کد")} · ${escapeHtml(submission.studentName)} (${escapeHtml(submission.studentCode)})</p><h2>نمرهٔ ${submission.status === "approved" ? "نهایی" : "موقت"}</h2><div class="score">${faNumber(result.totalScore)} از ${faNumber(result.maxScore)} · ${faNumber(result.percentage)}٪</div><p>${escapeHtml(result.summary)}</p>${result.teacherFeedback ? `<h2>بازخورد معلم</h2><p>${escapeHtml(result.teacherFeedback)}</p>` : ""}${result.flags.length ? `<div class="notice">این برگه ${faNumber(result.flags.length)} هشدار بازبینی دارد. نمره پیش از تأیید معلم نهایی نیست.</div>` : ""}<h2>جزئیات سؤال‌ها</h2><table><thead><tr><th>سؤال</th><th>صورت سؤال</th><th>نمره</th><th>توضیح</th></tr></thead><tbody>${rows}</tbody></table><h2>نقاط قوت</h2><p>${result.strengths.map(escapeHtml).join(" · ") || "—"}</p><h2>پیشنهاد برای بهبود</h2><p>${result.improvements.map(escapeHtml).join(" · ") || "—"}</p><p class="meta">تهیه‌شده با دستیار تصحیح نمره · وضعیت: ${getSubmissionStatusLabel(submission.status)}</p><script>window.onload=()=>window.print()<\/script></body></html>`);
  printWindow.document.close();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character);
}
