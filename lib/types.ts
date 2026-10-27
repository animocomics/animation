export type ProviderId = "openai" | "gemini";

export type QuestionType =
  | "multiple_choice"
  | "multiple_response"
  | "true_false"
  | "fill_blank"
  | "short_answer"
  | "essay"
  | "math"
  | "diagram"
  | "matching"
  | "ordering";

export type SubmissionStatus =
  | "uploaded"
  | "processing"
  | "graded"
  | "needs_review"
  | "approved"
  | "error";

export type FlagSeverity = "info" | "warning" | "critical";

export interface RubricCriterion {
  id: string;
  label: string;
  description: string;
  points: number;
}

export interface Question {
  id: string;
  number: number;
  type: QuestionType;
  prompt: string;
  maxScore: number;
  answer: string;
  options: string[];
  acceptedAnswers: string[];
  partialCredit: boolean;
  errorCarriedForward: boolean;
  rubric: RubricCriterion[];
}

export interface ExamSettings {
  gradingMode: "fast" | "balanced" | "precise";
  reviewThreshold: number;
  anonymize: boolean;
  requireApproval: boolean;
  instructions: string;
}

export interface FileMeta {
  id: string;
  name: string;
  type: string;
  size: number;
  storedId: string;
}

export interface CriterionResult {
  criterionId: string;
  score: number;
  maxScore: number;
  note: string;
}

export interface QuestionResult {
  questionId: string;
  transcript: string;
  extractedAnswer: string;
  score: number;
  maxScore: number;
  confidence: number;
  needsReview: boolean;
  rationale: string;
  evidence: {
    page: number | null;
    excerpt: string;
  };
  criteria: CriterionResult[];
  flags: string[];
  teacherEdited?: boolean;
  originalAiScore?: number;
  teacherNote?: string;
}

export interface ReviewFlag {
  id: string;
  type:
    | "illegible"
    | "low_confidence"
    | "low_quality"
    | "missing_answer"
    | "missing_page"
    | "ambiguous"
    | "multiple_answers"
    | "rubric_mismatch"
    | "grade_boundary"
    | "provider_error"
    | "other";
  severity: FlagSeverity;
  message: string;
  questionId?: string;
  page?: number;
}

export interface GradingResult {
  totalScore: number;
  maxScore: number;
  percentage: number;
  overallConfidence: number;
  detectedStudentName: string;
  summary: string;
  strengths: string[];
  improvements: string[];
  questions: QuestionResult[];
  flags: ReviewFlag[];
  provider: ProviderId;
  model: string;
  gradedAt: string;
  verification: "not_requested" | "verified" | "corrected" | "failed";
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  teacherFeedback?: string;
  approvedAt?: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: "ai" | "teacher" | "system";
  action: string;
  details: string;
}

export interface Submission {
  id: string;
  studentName: string;
  studentCode: string;
  files: FileMeta[];
  status: SubmissionStatus;
  result?: GradingResult;
  error?: string;
  audit: AuditEntry[];
}

export interface Exam {
  id: string;
  title: string;
  subject: string;
  className: string;
  date: string;
  passScore: number;
  duration: number;
  status: "draft" | "ready" | "grading" | "review" | "completed";
  questions: Question[];
  settings: ExamSettings;
  submissions: Submission[];
  createdAt: string;
  updatedAt: string;
  isDemo?: boolean;
}

export interface WorkspaceSettings {
  provider: ProviderId;
  model: string;
  gradingMode: "fast" | "balanced" | "precise";
  reviewThreshold: number;
  anonymize: boolean;
  requireApproval: boolean;
}

export interface ToastMessage {
  id: string;
  title: string;
  description?: string;
  variant: "success" | "error" | "info";
}

export interface GradeApiRequest {
  provider: ProviderId;
  model: string;
  apiKey: string;
  exam: {
    title: string;
    subject: string;
    passScore: number;
    settings: ExamSettings;
    questions: Question[];
  };
  student: {
    name: string;
    code: string;
  };
  files: Array<{
    name: string;
    type: string;
    data: string;
  }>;
}

export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  multiple_choice: "تستی تک‌پاسخی",
  multiple_response: "چندپاسخی",
  true_false: "درست / غلط",
  fill_blank: "جای‌خالی",
  short_answer: "پاسخ کوتاه",
  essay: "تشریحی",
  math: "محاسباتی",
  diagram: "شکل و نمودار",
  matching: "جورکردن",
  ordering: "ترتیب‌دهی",
};

export const FLAG_LABELS: Record<ReviewFlag["type"], string> = {
  illegible: "دست‌خط ناخوانا",
  low_confidence: "اعتماد پایین",
  low_quality: "کیفیت پایین تصویر",
  missing_answer: "پاسخ دیده نشد",
  missing_page: "احتمال صفحهٔ مفقود",
  ambiguous: "پاسخ مبهم",
  multiple_answers: "چند پاسخ / خط‌خورده",
  rubric_mismatch: "خارج از بارم",
  grade_boundary: "نزدیک مرز قبولی",
  provider_error: "خطای سرویس",
  other: "نیازمند بررسی",
};
