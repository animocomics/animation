import type { Exam, Question, Submission } from "./types";

export function uid(prefix = "id"): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

export function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function faNumber(value: number | string, maximumFractionDigits = 1): string {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return "—";
  return new Intl.NumberFormat("fa-IR", { maximumFractionDigits }).format(numeric);
}

export function normalizeNumericInput(value: string): string {
  return value
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[٫،,]/g, ".")
    .replace(/\s/g, "");
}

export function formatNumericInput(value: number): string {
  return Number.isFinite(value)
    ? new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 2, useGrouping: false }).format(value)
    : "";
}

export function faDate(value: string | Date, options?: Intl.DateTimeFormatOptions): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("fa-IR-u-ca-persian-nu-arabext", {
    calendar: "persian",
    numberingSystem: "arabext",
    ...(options ?? {
      day: "numeric",
      month: "long",
      year: "numeric",
    }),
  }).format(date);
}

export function totalExamScore(exam: Pick<Exam, "questions">): number {
  return round(exam.questions.reduce((sum, question) => sum + Number(question.maxScore || 0), 0));
}

export function rubricScore(question: Question): number {
  if (!question.rubric.length) return question.maxScore;
  return round(question.rubric.reduce((sum, criterion) => sum + Number(criterion.points || 0), 0));
}

export function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function gradedSubmissions(exam: Exam): Submission[] {
  return exam.submissions.filter((submission) => submission.result);
}

export function examAverage(exam: Exam): number {
  return average(gradedSubmissions(exam).map((submission) => submission.result?.percentage ?? 0));
}

export function getSubmissionStatusLabel(status: Submission["status"]): string {
  return {
    uploaded: "آمادهٔ تصحیح",
    processing: "در حال تصحیح",
    graded: "تصحیح شده",
    needs_review: "نیازمند بازبینی",
    approved: "تأیید نهایی",
    error: "خطا در تصحیح",
  }[status];
}

export function getExamStatusLabel(status: Exam["status"]): string {
  return {
    draft: "پیش‌نویس",
    ready: "آمادهٔ تصحیح",
    grading: "در حال تصحیح",
    review: "در حال بازبینی",
    completed: "تکمیل شده",
  }[status];
}

export function normalizeAnswer(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase("fa-IR")
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/[\u0640\u064B-\u065F\u0670\u06D6-\u06ED]/g, "")
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[\u200c\u200f\u200e]/g, " ")
    .replace(/[.,،؛;:!?()[\]{}"'`_\\/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${faNumber(bytes)} بایت`;
  if (bytes < 1024 * 1024) return `${faNumber(bytes / 1024, 0)} کیلوبایت`;
  return `${faNumber(bytes / (1024 * 1024), 1)} مگابایت`;
}

export function getInitials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join(" ");
}

export function scoreTone(percentage: number): "success" | "warning" | "danger" {
  if (percentage >= 75) return "success";
  if (percentage >= 50) return "warning";
  return "danger";
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.includes(",") ? result.split(",")[1] : result);
    };
    reader.onerror = () => reject(new Error("خواندن فایل ممکن نشد."));
    reader.readAsDataURL(file);
  });
}

export function safeJsonParse<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
