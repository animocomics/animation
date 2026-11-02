import type {
  Exam,
  GradingResult,
  Question,
  QuestionResult,
  ReviewFlag,
  Submission,
  WorkspaceData,
  WorkspaceSettings,
} from "./types";

const biologyQuestions: Question[] = [
  {
    id: "q-cell-1",
    number: 1,
    type: "multiple_choice",
    prompt: "کدام اندامک مسئول تولید بیشتر انرژی سلول است؟",
    maxScore: 2,
    answer: "میتوکندری",
    options: ["هسته", "میتوکندری", "ریبوزوم", "دستگاه گلژی"],
    acceptedAnswers: ["گزینه ۲", "2", "ب"],
    partialCredit: false,
    errorCarriedForward: false,
    rubric: [{ id: "r1-1", label: "انتخاب پاسخ صحیح", description: "انتخاب میتوکندری", points: 2 }],
  },
  {
    id: "q-cell-2",
    number: 2,
    type: "fill_blank",
    prompt: "واحد ساختمان و عملکرد سلول‌های زنده .......... نامیده می‌شود.",
    maxScore: 2,
    answer: "سلول",
    options: [],
    acceptedAnswers: ["یاخته"],
    partialCredit: false,
    errorCarriedForward: false,
    rubric: [{ id: "r2-1", label: "اصطلاح علمی", description: "ذکر سلول یا یاخته", points: 2 }],
  },
  {
    id: "q-cell-3",
    number: 3,
    type: "short_answer",
    prompt: "دو تفاوت سلول جانوری و گیاهی را بنویسید.",
    maxScore: 3,
    answer: "دیوارهٔ سلولی و کلروپلاست در سلول گیاهی وجود دارد؛ سلول جانوری معمولاً فاقد این دو است.",
    options: [],
    acceptedAnswers: ["ذکر واکوئل بزرگ مرکزی به‌جای یکی از تفاوت‌ها نیز قابل قبول است."],
    partialCredit: true,
    errorCarriedForward: false,
    rubric: [
      { id: "r3-1", label: "تفاوت نخست", description: "یک تفاوت صحیح با توضیح", points: 1.5 },
      { id: "r3-2", label: "تفاوت دوم", description: "تفاوت دوم صحیح و مستقل", points: 1.5 },
    ],
  },
  {
    id: "q-cell-4",
    number: 4,
    type: "math",
    prompt: "اگر در یک سلول ۳۸ مولکول ATP تولید شود و ۲ ATP صرف شود، بازدهٔ خالص را محاسبه و توضیح دهید.",
    maxScore: 5,
    answer: "۳۶ ATP خالص؛ باید رابطه و جایگذاری عددی نیز نوشته شود.",
    options: [],
    acceptedAnswers: ["پاسخ با روش معادل و واحد صحیح پذیرفته شود."],
    partialCredit: true,
    errorCarriedForward: true,
    rubric: [
      { id: "r4-1", label: "رابطه", description: "انتخاب تفریق درست", points: 1.5 },
      { id: "r4-2", label: "محاسبه", description: "جایگذاری و محاسبهٔ صحیح", points: 2 },
      { id: "r4-3", label: "واحد و توضیح", description: "ذکر ATP و نتیجه‌گیری", points: 1.5 },
    ],
  },
  {
    id: "q-cell-5",
    number: 5,
    type: "diagram",
    prompt: "شکل سلول گیاهی را بررسی و سه بخش نام‌گذاری‌شده را توضیح دهید.",
    maxScore: 4,
    answer: "عملکرد دیواره، کلروپلاست و واکوئل مطابق نقش هر بخش توضیح داده شود.",
    options: [],
    acceptedAnswers: [],
    partialCredit: true,
    errorCarriedForward: false,
    rubric: [
      { id: "r5-1", label: "تشخیص بخش‌ها", description: "نام‌گذاری درست سه بخش", points: 1.5 },
      { id: "r5-2", label: "عملکرد", description: "توضیح عملکرد متناسب با هر بخش", points: 2.5 },
    ],
  },
  {
    id: "q-cell-6",
    number: 6,
    type: "essay",
    prompt: "نقش غشای سلول در حفظ تعادل داخلی را با یک مثال توضیح دهید.",
    maxScore: 4,
    answer: "نفوذپذیری انتخابی، انتقال مواد و مثال مرتبط مانند تنظیم آب یا یون‌ها.",
    options: [],
    acceptedAnswers: ["مثال علمی صحیح دیگر نیز پذیرفته شود."],
    partialCredit: true,
    errorCarriedForward: false,
    rubric: [
      { id: "r6-1", label: "مفهوم اصلی", description: "شرح نفوذپذیری انتخابی", points: 2 },
      { id: "r6-2", label: "مثال و پیوند", description: "مثال صحیح و اتصال آن به تعادل داخلی", points: 2 },
    ],
  },
];

function makeQuestionResult(question: Question, score: number, index: number, flagged: boolean): QuestionResult {
  const transcripts = [
    "گزینهٔ ۲ — میتوکندری",
    "سلول",
    "سلول گیاهی دیواره دارد و کلروپلاست هم دارد، ولی جانوری این‌ها را ندارد.",
    "۳۸ − ۲ = ۳۶ ATP خالص تولید می‌شود.",
    "دیواره برای محافظت، کلروپلاست برای فتوسنتز و واکوئل برای نگهداری آب است.",
    "غشا اجازهٔ عبور همهٔ مواد را نمی‌دهد و با انتخاب مواد، تعادل را حفظ می‌کند.",
  ];
  const ratio = question.maxScore ? score / question.maxScore : 0;
  return {
    questionId: question.id,
    transcript: flagged ? `${transcripts[index]} [بخشی ناخوانا]` : transcripts[index],
    extractedAnswer: transcripts[index],
    score,
    maxScore: question.maxScore,
    confidence: flagged ? 0.58 : Math.min(0.98, 0.84 + index * 0.02),
    needsReview: flagged,
    rationale: score === question.maxScore
      ? "پاسخ با کلید و همهٔ معیارهای بارم همخوانی دارد."
      : "بخشی از پاسخ صحیح است؛ امتیاز بر اساس معیارهای مشاهده‌شده محاسبه شد.",
    evidence: { page: index < 3 ? 1 : 2, excerpt: transcripts[index].slice(0, 70) },
    criteria: question.rubric.map((criterion) => ({
      criterionId: criterion.id,
      score: Math.round(criterion.points * ratio * 4) / 4,
      maxScore: criterion.points,
      note: ratio >= 0.99 ? "معیار کامل مشاهده شد." : "بخشی از معیار در پاسخ دیده شد.",
    })),
    flags: flagged ? ["illegible"] : [],
  };
}

function makeResult(
  questions: Question[],
  scores: number[],
  percentage: number,
  flags: ReviewFlag[],
  provider: "openai" | "gemini" = "openai",
): GradingResult {
  const flaggedQuestionIds = new Set(flags.map((flag) => flag.questionId));
  const questionResults = questions.map((question, index) =>
    makeQuestionResult(question, scores[index], index, flaggedQuestionIds.has(question.id)),
  );
  const totalScore = scores.reduce((sum, score) => sum + score, 0);
  return {
    totalScore,
    maxScore: 20,
    percentage,
    overallConfidence: flags.length ? 0.72 : 0.94,
    detectedStudentName: "",
    detectedStudentCode: "",
    detectedClassName: "",
    identityConfidence: 0.96,
    summary: flags.length
      ? "تصحیح اولیه انجام شد؛ موارد مشخص‌شده پیش از نهایی‌کردن به بازبینی معلم نیاز دارند."
      : "پاسخ‌ها با بارم ارزیابی شدند و مورد ابهام مهمی مشاهده نشد.",
    strengths: ["تسلط بر مفاهیم پایه", "ارائهٔ پاسخ مرتبط با سؤال"],
    improvements: ["توضیح کامل‌تر گام‌های محاسبه", "رعایت اصطلاحات دقیق علمی"],
    questions: questionResults,
    flags,
    provider,
    model: provider === "openai" ? "gpt-4.1" : "gemini-2.5-pro",
    gradedAt: "2026-10-26T09:30:00.000Z",
    verification: flags.length ? "verified" : "not_requested",
    usage: { inputTokens: 12840, outputTokens: 1640 },
  };
}

function makeSubmission(
  id: string,
  studentName: string,
  studentCode: string,
  scores: number[],
  status: Submission["status"],
  flags: ReviewFlag[] = [],
): Submission {
  const total = scores.reduce((sum, score) => sum + score, 0);
  const result = makeResult(biologyQuestions, scores, (total / 20) * 100, flags);
  result.detectedStudentName = studentName;
  result.detectedStudentCode = studentCode;
  result.detectedClassName = "یازدهم تجربی · گروه الف";
  if (status === "approved") {
    result.approvedAt = "2026-10-26T11:20:00.000Z";
    result.teacherFeedback = "پاسخ‌ها بازبینی و نمره تأیید شد.";
  }
  return {
    id,
    studentName,
    studentCode,
    files: [],
    status,
    result,
    audit: [
      { id: `${id}-a1`, at: "2026-10-26T09:30:00.000Z", actor: "ai", action: "تصحیح اولیه", details: "ارزیابی شش سؤال بر اساس بارم آزمون" },
      ...(status === "approved" ? [{ id: `${id}-a2`, at: "2026-10-26T11:20:00.000Z", actor: "teacher" as const, action: "تأیید نهایی", details: "نمره توسط معلم تأیید شد" }] : []),
    ],
  };
}

export function createDemoExams(): Exam[] {
  const mainExam: Exam = {
    id: "exam-biology-midterm",
    title: "میان‌ترم زیست‌شناسی",
    subject: "زیست‌شناسی",
    className: "یازدهم تجربی · گروه الف",
    date: "2026-10-25T08:00:00.000Z",
    passScore: 10,
    duration: 90,
    status: "review",
    questions: biologyQuestions,
    settings: {
      gradingMode: "precise",
      reviewThreshold: 0.8,
      anonymize: true,
      requireApproval: true,
      instructions: "به روش‌های جایگزین صحیح نمره دهید و یک خطا را دو بار جریمه نکنید.",
    },
    createdAt: "2026-10-22T08:00:00.000Z",
    updatedAt: "2026-10-26T11:20:00.000Z",
    isDemo: true,
    submissions: [
      makeSubmission("st-sara", "سارا محمدی", "۹۸۱۲۴", [2, 2, 3, 5, 4, 3.5], "approved"),
      makeSubmission("st-ali", "علی رضایی", "۹۸۱۲۵", [2, 2, 2.5, 4, 3.5, 3], "approved"),
      makeSubmission("st-negar", "نگار احمدی", "۹۸۱۲۶", [2, 2, 3, 3.5, 4, 3], "needs_review", [
        { id: "flag-negar-1", type: "illegible", severity: "warning", message: "بخشی از محاسبهٔ سؤال ۴ به‌وضوح خوانده نشد.", questionId: "q-cell-4", page: 2 },
      ]),
      makeSubmission("st-amir", "امیرحسین کریمی", "۹۸۱۲۷", [2, 0, 2, 4, 0, 2.5], "needs_review", [
        { id: "flag-amir-1", type: "missing_answer", severity: "critical", message: "پاسخ سؤال ۵ در فایل دریافتی دیده نشد؛ احتمال صفحهٔ مفقود وجود دارد.", questionId: "q-cell-5", page: 2 },
      ]),
      makeSubmission("st-taraneh", "ترانه موسوی", "۹۸۱۲۸", [2, 2, 2.5, 4.5, 3.5, 3.5], "approved"),
      makeSubmission("st-mohammad", "محمد طاهری", "۹۸۱۲۹", [0, 2, 1.5, 3, 2, 2], "graded"),
      makeSubmission("st-raha", "رها نادری", "۹۸۱۳۰", [2, 2, 1.5, 2.5, 1.5, 1], "needs_review", [
        { id: "flag-raha-1", type: "grade_boundary", severity: "warning", message: "نمرهٔ کل در فاصلهٔ نیم نمره از حد قبولی است.", page: 2 },
      ]),
      makeSubmission("st-arash", "آرش صادقی", "۹۸۱۳۱", [2, 2, 3, 4.5, 3, 3], "graded"),
    ],
  };

  const physicsQuestions = biologyQuestions.slice(0, 4).map((question, index) => ({
    ...question,
    id: `q-physics-${index + 1}`,
    prompt: ["کدام کمیت برداری است؟", "یکای نیرو در SI چیست؟", "تفاوت سرعت و تندی را توضیح دهید.", "شتاب متحرکی با تغییر سرعت ۲۰ متر بر ثانیه در ۵ ثانیه را محاسبه کنید."][index],
    answer: ["سرعت", "نیوتن", "سرعت برداری و تندی نرده‌ای است.", "a=Δv/Δt=20/5=4m/s²"][index],
    rubric: question.rubric.map((criterion) => ({ ...criterion, id: `r-physics-${index}-${criterion.id}` })),
  }));

  return [
    mainExam,
    {
      id: "exam-physics-3",
      title: "فصل سوم · حرکت",
      subject: "فیزیک",
      className: "دهم ریاضی · گروه ب",
      date: "2026-10-29T08:00:00.000Z",
      passScore: 7,
      duration: 60,
      status: "ready",
      questions: physicsQuestions,
      settings: { ...mainExam.settings, gradingMode: "balanced" },
      submissions: [],
      createdAt: "2026-10-24T08:00:00.000Z",
      updatedAt: "2026-10-26T07:00:00.000Z",
      isDemo: true,
    },
    {
      id: "exam-literature-draft",
      title: "ادبیات · آرایه‌های تشبیه",
      subject: "ادبیات فارسی",
      className: "یازدهم انسانی",
      date: "2026-11-02T08:00:00.000Z",
      passScore: 10,
      duration: 75,
      status: "draft",
      questions: biologyQuestions.slice(0, 3).map((question, index) => ({
        ...question,
        id: `q-literature-${index + 1}`,
        prompt: ["تشبیه را تعریف کنید.", "یک مثال از تشبیه بیاورید.", "در بیت داده‌شده آرایه را تحلیل کنید."][index],
        answer: ["تشبیه یعنی شباهت دادن دو چیز با ذکر وجه اشتراک.", "پاسخ آزاد با اجزای کامل", "تشخیص مشبه، مشبه‌به و وجه اشتراک"][index],
        type: index === 0 ? "short_answer" : "essay",
      })),
      settings: mainExam.settings,
      submissions: [],
      createdAt: "2026-10-26T06:00:00.000Z",
      updatedAt: "2026-10-26T06:00:00.000Z",
      isDemo: true,
    },
  ];
}

export function createDemoWorkspace(): WorkspaceData {
  const exams = createDemoExams();
  const classes: WorkspaceData["classes"] = [];
  const now = new Date().toISOString();
  exams.forEach((exam, examIndex) => {
    let schoolClass = classes.find((item) => item.name === exam.className);
    if (!schoolClass) {
      schoolClass = {
        id: `class-demo-${classes.length + 1}`,
        name: exam.className,
        grade: exam.className.split(" ")[0] || "",
        subject: exam.subject,
        academicYear: "۱۴۰۵–۱۴۰۶",
        students: [],
        createdAt: now,
        updatedAt: now,
      };
      classes.push(schoolClass);
    }
    exam.classId = schoolClass.id;
    exam.code = `DEMO-${String(examIndex + 1).padStart(3, "0")}`;
    exam.submissions = exam.submissions.map((submission, studentIndex) => {
      const studentId = submission.studentId || `student-demo-${examIndex + 1}-${studentIndex + 1}`;
      if (!schoolClass.students.some((student) => student.id === studentId)) {
        schoolClass.students.push({ id: studentId, name: submission.studentName, code: submission.studentCode, active: true });
      }
      return { ...submission, studentId, identityStatus: "matched" as const, identitySource: "demo" as const };
    });
  });
  return { exams, classes, settings: { ...DEFAULT_WORKSPACE_SETTINGS } };
}

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  provider: "openai",
  model: "gpt-4.1",
  gradingMode: "precise",
  reviewThreshold: 0.8,
  anonymize: true,
  requireApproval: true,
};
