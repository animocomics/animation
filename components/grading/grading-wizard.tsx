"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpenCheck,
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronLeft,
  CircleAlert,
  ClipboardCheck,
  FileCheck2,
  FileStack,
  FileUp,
  Info,
  KeyRound,
  ListChecks,
  LoaderCircle,
  LockKeyhole,
  Play,
  Save,
  ShieldCheck,
  Sparkles,
  Square,
  TriangleAlert,
  UsersRound,
  WandSparkles,
  XCircle,
} from "lucide-react";
import { useApp } from "../../lib/app-context";
import { readStoredFileAsBase64 } from "../../lib/file-store";
import type { Exam, ExamSettings, GradingResult, Submission } from "../../lib/types";
import { faNumber, rubricScore, totalExamScore, uid } from "../../lib/utils";
import { ApiConnection } from "../api-connection";
import { makeQuestion, QuestionEditor } from "./question-editor";
import { SubmissionUploader } from "./submission-uploader";

const steps = [
  { number: 1, title: "مشخصات آزمون", subtitle: "درس و سیاست تصحیح", icon: BookOpenCheck },
  { number: 2, title: "سؤال‌ها و بارم", subtitle: "کلید و معیارهای نمره", icon: ListChecks },
  { number: 3, title: "برگهٔ دانش‌آموزان", subtitle: "عکس یا PDF", icon: FileUp },
  { number: 4, title: "بررسی و اجرا", subtitle: "اتصال و شروع تصحیح", icon: Sparkles },
];

function createEmptyExam(settings: ExamSettings): Exam {
  const now = new Date();
  return {
    id: uid("exam"),
    title: "",
    subject: "",
    className: "",
    date: `${now.toISOString().slice(0, 10)}T08:00:00.000Z`,
    passScore: 10,
    duration: 60,
    status: "draft",
    questions: [makeQuestion("short_answer")],
    settings,
    submissions: [],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    isDemo: false,
  };
}

function resultNeedsReview(result: GradingResult): boolean {
  return result.flags.some((flag) => flag.severity !== "info") || result.questions.some((question) => question.needsReview);
}

export function GradingWizard() {
  const { exams, settings: workspaceSettings, apiKey, saveExam, updateSubmission, notify, storageReady } = useApp();
  const searchParams = useSearchParams();
  const router = useRouter();
  const existingExamId = searchParams.get("exam");
  const [draft, setDraft] = useState<Exam>(() => createEmptyExam({
    gradingMode: workspaceSettings.gradingMode,
    reviewThreshold: workspaceSettings.reviewThreshold,
    anonymize: workspaceSettings.anonymize,
    requireApproval: workspaceSettings.requireApproval,
    instructions: "پاسخ‌های جایگزین صحیح را بپذیر و یک خطا را دو بار جریمه نکن.",
  }));
  const [step, setStep] = useState(1);
  const [maxStep, setMaxStep] = useState(1);
  const [dirty, setDirty] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [hasRun, setHasRun] = useState(false);
  const [activeIds, setActiveIds] = useState<string[]>([]);
  const [completedCount, setCompletedCount] = useState(0);
  const [runTotal, setRunTotal] = useState(0);
  const loadedExisting = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const failedIds = useRef<Set<string>>(new Set());
  const finishedIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!existingExamId || !storageReady || loadedExisting.current === existingExamId) return;
    const existing = exams.find((exam) => exam.id === existingExamId);
    if (!existing) return;
    setDraft(JSON.parse(JSON.stringify(existing)) as Exam);
    const requestedStep = Number(searchParams.get("step"));
    const initialStep = requestedStep >= 1 && requestedStep <= 4 ? requestedStep : 3;
    setStep(initialStep);
    setMaxStep(Math.max(initialStep, existing.submissions.length ? 4 : 3));
    setSelectedIds(existing.submissions.filter((submission) => submission.files.length && ["uploaded", "error"].includes(submission.status)).map((submission) => submission.id));
    loadedExisting.current = existingExamId;
    setDirty(false);
  }, [existingExamId, exams, storageReady, searchParams]);

  useEffect(() => {
    if (!dirty || running) return;
    const timer = window.setTimeout(() => {
      saveExam(draft);
      setDirty(false);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [dirty, draft, running, saveExam]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const updateDraft = (patch: Partial<Exam>) => {
    setDraft((current) => ({ ...current, ...patch, isDemo: false }));
    setDirty(true);
  };

  const goToStep = (nextStep: number) => {
    if (running || nextStep > maxStep) return;
    setStep(nextStep);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const validateStep = (currentStep: number): boolean => {
    if (currentStep === 1) {
      if (!draft.title.trim() || !draft.subject.trim() || !draft.className.trim()) {
        notify({ title: "مشخصات آزمون کامل نیست", description: "عنوان، درس و کلاس الزامی هستند.", variant: "error" });
        return false;
      }
    }
    if (currentStep === 2) {
      const invalid = draft.questions.find((question) =>
        !question.prompt.trim() || !question.answer.trim() || question.maxScore <= 0 || Math.abs(rubricScore(question) - question.maxScore) > 0.001 ||
        (["multiple_choice", "multiple_response"].includes(question.type) && (question.options.filter((option) => option.trim()).length < 2)),
      );
      if (invalid) {
        notify({ title: `سؤال ${faNumber(invalid.number)} نیازمند اصلاح است`, description: "صورت سؤال، کلید، نمره و جمع معیارهای بارم را بررسی کنید.", variant: "error" });
        return false;
      }
      if (draft.passScore > totalExamScore(draft)) {
        notify({ title: "حد قبولی از نمرهٔ کل بیشتر است", description: "نمرهٔ قبولی یا بارم سؤال‌ها را اصلاح کنید.", variant: "error" });
        return false;
      }
    }
    if (currentStep === 3) {
      const runnable = draft.submissions.filter((submission) => submission.studentName.trim() && submission.files.length);
      if (!runnable.length) {
        notify({ title: "حداقل یک برگهٔ کامل لازم است", description: "نام دانش‌آموز و حداقل یک عکس یا PDF را اضافه کنید.", variant: "error" });
        return false;
      }
      const incomplete = draft.submissions.find((submission) => !submission.result && (!submission.studentName.trim() || !submission.files.length));
      if (incomplete) {
        notify({ title: "یک ردیف ناقص در فهرست است", description: "برای همهٔ دانش‌آموزان نام و فایل وارد کنید یا ردیف اضافی را حذف کنید.", variant: "error" });
        return false;
      }
      if (!selectedIds.length) setSelectedIds(runnable.filter((submission) => submission.status !== "approved").map((submission) => submission.id));
    }
    return true;
  };

  const nextStep = () => {
    if (!validateStep(step)) return;
    saveExam(draft);
    const next = Math.min(4, step + 1);
    setStep(next);
    setMaxStep((current) => Math.max(current, next));
    setDirty(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const saveDraftNow = () => {
    saveExam(draft);
    setDirty(false);
    notify({ title: "پیش‌نویس ذخیره شد", description: "می‌توانید بعداً از بخش آزمون‌ها ادامه دهید.", variant: "success" });
  };

  const eligibleSubmissions = useMemo(() => draft.submissions.filter((submission) => submission.files.length > 0 && submission.status !== "approved"), [draft.submissions]);
  const selectedSubmissions = eligibleSubmissions.filter((submission) => selectedIds.includes(submission.id));

  const startGrading = async () => {
    if (running) return;
    if (!apiKey) {
      notify({ title: "API Key لازم است", description: "کلید را در بخش اتصال همین صفحه وارد کنید.", variant: "error" });
      return;
    }
    if (!selectedSubmissions.length) {
      notify({ title: "برگه‌ای برای تصحیح انتخاب نشده", variant: "error" });
      return;
    }
    if (!validateStep(2)) {
      setStep(2);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    failedIds.current = new Set();
    finishedIds.current = new Set();
    setRunning(true);
    setHasRun(false);
    setCompletedCount(0);
    setActiveIds([]);
    const processingSubmissions = draft.submissions.map((submission) => selectedIds.includes(submission.id) ? { ...submission, status: "processing" as const, error: undefined } : submission);
    const processingDraft = { ...draft, submissions: processingSubmissions, status: "grading" as const };
    setDraft(processingDraft);
    saveExam(processingDraft);

    let cursor = 0;
    const queue = processingSubmissions.filter((submission) => selectedIds.includes(submission.id));
    setRunTotal(queue.length);

    const applyUpdate = (submissionId: string, patch: Partial<Submission>) => {
      setDraft((current) => ({ ...current, submissions: current.submissions.map((submission) => submission.id === submissionId ? { ...submission, ...patch } : submission) }));
      updateSubmission(draft.id, submissionId, patch);
    };

    const worker = async () => {
      while (cursor < queue.length && !controller.signal.aborted) {
        const index = cursor;
        cursor += 1;
        const submission = queue[index];
        setActiveIds((current) => [...current, submission.id]);
        try {
          const files = await Promise.all(submission.files.map((file) => readStoredFileAsBase64(file.storedId)));
          if (controller.signal.aborted) return;
          const response = await fetch("/api/grade", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
              provider: workspaceSettings.provider,
              model: workspaceSettings.model,
              apiKey,
              exam: {
                title: draft.title,
                subject: draft.subject,
                passScore: draft.passScore,
                settings: draft.settings,
                questions: draft.questions,
              },
              student: { name: submission.studentName, code: submission.studentCode },
              files,
            }),
          });
          const payload = await response.json() as { result?: GradingResult; error?: string };
          if (!response.ok || !payload.result) throw new Error(payload.error || "نتیجهٔ معتبر از سرور دریافت نشد.");
          const result = payload.result;
          const needsReview = resultNeedsReview(result);
          applyUpdate(submission.id, {
            status: needsReview ? "needs_review" : "graded",
            result,
            error: undefined,
            audit: [...submission.audit, {
              id: uid("audit"),
              at: new Date().toISOString(),
              actor: "ai",
              action: result.verification === "corrected" ? "تصحیح و اصلاح در ممیزی دوم" : result.verification === "verified" ? "تصحیح و ممیزی دوم" : "تصحیح اولیه",
              details: `${result.model} · ${faNumber(result.questions.length)} سؤال · ${faNumber(result.flags.length)} هشدار`,
            }],
          });
          failedIds.current.delete(submission.id);
        } catch (error) {
          const aborted = controller.signal.aborted;
          const message = aborted ? "تصحیح توسط کاربر لغو شد." : error instanceof Error ? error.message : "خطای ناشناخته در تصحیح";
          failedIds.current.add(submission.id);
          applyUpdate(submission.id, {
            status: aborted ? "uploaded" : "error",
            error: message,
            audit: [...submission.audit, { id: uid("audit"), at: new Date().toISOString(), actor: "system", action: aborted ? "لغو تصحیح" : "خطای تصحیح", details: message }],
          });
        } finally {
          finishedIds.current.add(submission.id);
          setActiveIds((current) => current.filter((id) => id !== submission.id));
          setCompletedCount((count) => count + 1);
        }
      }
    };

    await Promise.all([worker(), worker()]);
    if (controller.signal.aborted) {
      const remaining = queue.filter((submission) => !finishedIds.current.has(submission.id));
      remaining.forEach((submission) => {
        failedIds.current.add(submission.id);
        applyUpdate(submission.id, { status: "uploaded", error: undefined });
      });
    }
    setRunning(false);
    setHasRun(true);
    setSelectedIds([...failedIds.current]);
    const failedCount = failedIds.current.size;
    notify({
      title: failedCount ? "اجرای تصحیح با خطا تمام شد" : "تصحیح برگه‌ها تمام شد",
      description: failedCount ? `${faNumber(failedCount)} برگه ناموفق است؛ می‌توانید فقط همان‌ها را دوباره اجرا کنید.` : "نتایج آمادهٔ بازبینی و تأیید معلم است.",
      variant: failedCount ? "error" : "success",
    });
  };

  const cancelGrading = () => {
    abortRef.current?.abort();
    notify({ title: "در حال توقف اجرا…", description: "برگه‌های کامل‌شده حفظ می‌شوند.", variant: "info" });
  };

  const currentProgress = running || hasRun ? runTotal : selectedSubmissions.length;

  return (
    <div className="grading-wizard-page">
      <section className="wizard-heading">
        <div><div className="eyebrow"><span />{existingExamId ? "ادامهٔ آزمون" : "آزمون جدید"}</div><h2>{draft.title || "یک تصحیح دقیق شروع کنیم"}</h2><p>کلید و بارم شما، مبنای همهٔ نمره‌هاست؛ موارد مبهم به خودتان ارجاع می‌شود.</p></div>
        <button className="btn btn-secondary" onClick={saveDraftNow} disabled={running}><Save size={16} />{dirty ? "ذخیرهٔ تغییرات" : "پیش‌نویس ذخیره است"}</button>
      </section>

      <nav className="wizard-steps card" aria-label="مراحل تصحیح">
        {steps.map((item, index) => {
          const Icon = item.icon;
          const active = step === item.number;
          const complete = step > item.number || (maxStep > item.number && !active);
          return <div className="wizard-step-wrap" key={item.number}>
            <button className={`wizard-step ${active ? "active" : ""} ${complete ? "complete" : ""}`} onClick={() => goToStep(item.number)} disabled={item.number > maxStep || running} aria-current={active ? "step" : undefined}>
              <span className="wizard-step-icon">{complete ? <Check size={18} /> : <Icon size={19} />}</span>
              <span><small>گام {faNumber(item.number)}</small><strong>{item.title}</strong><em>{item.subtitle}</em></span>
            </button>
            {index < steps.length - 1 && <span className={`wizard-step-line ${complete ? "complete" : ""}`} />}
          </div>;
        })}
      </nav>

      <div className="wizard-content">
        {step === 1 && <div className="exam-setup-grid">
          <section className="card wizard-form-card">
            <div className="wizard-section-heading"><span className="section-heading-icon"><BookOpenCheck size={21} /></span><div><h3>دربارهٔ این آزمون</h3><p>این اطلاعات در گزارش و کارنامه استفاده می‌شود.</p></div></div>
            <div className="wizard-form-body">
              <div className="form-field"><label htmlFor="exam-title">عنوان آزمون <span>*</span></label><input id="exam-title" className="input" value={draft.title} onChange={(event) => updateDraft({ title: event.target.value })} placeholder="مثلاً میان‌ترم زیست‌شناسی" /></div>
              <div className="form-grid">
                <div className="form-field"><label htmlFor="exam-subject">درس <span>*</span></label><input id="exam-subject" className="input" value={draft.subject} onChange={(event) => updateDraft({ subject: event.target.value })} placeholder="مثلاً زیست‌شناسی" /></div>
                <div className="form-field"><label htmlFor="exam-class">کلاس / گروه <span>*</span></label><input id="exam-class" className="input" value={draft.className} onChange={(event) => updateDraft({ className: event.target.value })} placeholder="مثلاً یازدهم تجربی · الف" /></div>
              </div>
              <div className="form-grid-3">
                <div className="form-field"><label htmlFor="exam-date">تاریخ آزمون</label><input id="exam-date" className="input" type="date" value={draft.date.slice(0, 10)} onChange={(event) => updateDraft({ date: `${event.target.value}T08:00:00.000Z` })} /></div>
                <div className="form-field"><label htmlFor="exam-duration">مدت (دقیقه)</label><input id="exam-duration" className="input" type="number" min="1" value={draft.duration} onChange={(event) => updateDraft({ duration: Math.max(1, Number(event.target.value)) })} /></div>
                <div className="form-field"><label htmlFor="exam-pass-score">حد قبولی</label><input id="exam-pass-score" className="input" type="number" min="0" step="0.25" value={draft.passScore} onChange={(event) => updateDraft({ passScore: Math.max(0, Number(event.target.value)) })} /><span className="form-hint">از {faNumber(totalExamScore(draft))} نمره فعلی</span></div>
              </div>
              <div className="form-field"><label htmlFor="exam-instructions">دستور تکمیلی به مصحح <span className="optional-label">اختیاری</span></label><textarea id="exam-instructions" className="textarea" value={draft.settings.instructions} onChange={(event) => updateDraft({ settings: { ...draft.settings, instructions: event.target.value } })} placeholder="مثلاً پاسخ با هر راه‌حل علمی صحیح پذیرفته شود؛ خطای محاسباتی فقط یک بار جریمه شود…" /><span className="form-hint">قواعد خاص درس، نمرهٔ منفی، واحد، املا یا خطای انتقالی را اینجا روشن کنید.</span></div>
              <div className="notice notice-info"><Info size={18} /><div><strong>پاسخ مرجع، تنها راه صحیح نیست</strong><p>در گام بعد می‌توانید پاسخ‌های جایگزین و برای هر گام، نمرهٔ مستقل تعریف کنید.</p></div></div>
            </div>
          </section>

          <aside className="card wizard-form-card policy-card">
            <div className="wizard-section-heading"><span className="section-heading-icon amber"><ShieldCheck size={21} /></span><div><h3>سیاست دقت و بازبینی</h3><p>تعادل هزینه، سرعت و کنترل انسانی</p></div></div>
            <div className="wizard-form-body">
              <div className="grading-mode-options">
                {([
                  ["fast", "سریع", "یک ارزیابی؛ مناسب تمرین کم‌اهمیت"],
                  ["balanced", "متعادل", "ممیزی دوم فقط هشدارهای بحرانی"],
                  ["precise", "دقیق", "ممیزی دوم همهٔ موارد پرچم‌دار"],
                ] as const).map(([value, label, description]) => <label className={`grading-mode-option ${draft.settings.gradingMode === value ? "selected" : ""}`} key={value}><input type="radio" name="grading-mode" value={value} checked={draft.settings.gradingMode === value} onChange={() => updateDraft({ settings: { ...draft.settings, gradingMode: value } })} /><span className="radio-check">{draft.settings.gradingMode === value && <Check size={12} />}</span><span><strong>{label}</strong><small>{description}</small></span>{value === "precise" && <span className="badge badge-success">پیشنهادی</span>}</label>)}
              </div>
              <div className="threshold-field"><div><label htmlFor="review-threshold">آستانهٔ ارجاع به معلم</label><strong>{faNumber(draft.settings.reviewThreshold * 100, 0)}٪</strong></div><input id="review-threshold" type="range" min="0.5" max="0.95" step="0.05" value={draft.settings.reviewThreshold} onChange={(event) => updateDraft({ settings: { ...draft.settings, reviewThreshold: Number(event.target.value) } })} /><div><span>آزادتر</span><span>محتاط‌تر</span></div><p>اگر اعتماد گزارش‌شدهٔ مدل کمتر از این مقدار باشد، نمره برای بازبینی پرچم می‌شود.</p></div>
              <div className="policy-switches">
                <label className="switch-field"><span><strong>تصحیح ناشناس</strong><small>نام دانش‌آموز به مدل داده نشود</small></span><span className="switch"><input type="checkbox" checked={draft.settings.anonymize} onChange={(event) => updateDraft({ settings: { ...draft.settings, anonymize: event.target.checked } })} /><span className="switch-slider" /></span></label>
                <label className="switch-field"><span><strong>تأیید الزامی معلم</strong><small>نمره تا تأیید شما موقت بماند</small></span><span className="switch"><input type="checkbox" checked={draft.settings.requireApproval} onChange={(event) => updateDraft({ settings: { ...draft.settings, requireApproval: event.target.checked } })} /><span className="switch-slider" /></span></label>
              </div>
              <div className="privacy-mini"><LockKeyhole size={15} /><span>فایل هر دانش‌آموز جدا ارسال می‌شود و برگه‌های سایرین در Prompt نیست.</span></div>
            </div>
          </aside>
        </div>}

        {step === 2 && <section className="card questions-wizard-card">
          <div className="wizard-section-heading questions-heading"><span className="section-heading-icon"><ListChecks size={21} /></span><div><h3>سؤال‌ها، کلید و بارم تفصیلی</h3><p>معیارهای کوتاه و مستقل بنویسید؛ این مهم‌ترین عامل تصحیح منسجم است.</p></div><div className="questions-total-chip"><span>جمع نمرات</span><strong>{faNumber(totalExamScore(draft))}</strong></div></div>
          <QuestionEditor questions={draft.questions} onChange={(questions) => updateDraft({ questions })} />
        </section>}

        {step === 3 && <section className="card upload-wizard-card">
          <div className="wizard-section-heading"><span className="section-heading-icon"><FileStack size={21} /></span><div><h3>برگه‌های دانش‌آموزان</h3><p>فایل‌ها در IndexedDB مرورگر نگه‌داری می‌شوند و فقط هنگام اجرا برای دانش‌آموز مربوط ارسال خواهند شد.</p></div><span className="badge badge-info">بدون OCR جداگانه</span></div>
          <div className="upload-wizard-body"><SubmissionUploader submissions={draft.submissions} onChange={(submissions) => { updateDraft({ submissions }); setSelectedIds([]); setHasRun(false); }} /></div>
        </section>}

        {step === 4 && <div className="run-step-layout">
          <div className="run-main-column">
            <section className="card run-summary-card">
              <div className="wizard-section-heading"><span className="section-heading-icon"><ClipboardCheck size={21} /></span><div><h3>پیش از شروع، همه‌چیز را بررسی کنید</h3><p>پس از اجرا، نتیجهٔ هر دانش‌آموز مستقل ذخیره می‌شود.</p></div>{!running && !hasRun && <span className="badge badge-success"><CheckCircle2 size={13} />آمادهٔ اجرا</span>}</div>
              <div className="run-summary-grid">
                <button onClick={() => goToStep(1)} disabled={running}><BookOpenCheck size={18} /><span><small>آزمون</small><strong>{draft.title}</strong><em>{draft.subject} · {draft.className}</em></span><ChevronLeft size={15} /></button>
                <button onClick={() => goToStep(2)} disabled={running}><ListChecks size={18} /><span><small>سؤال‌ها و بارم</small><strong>{faNumber(draft.questions.length)} سؤال · {faNumber(totalExamScore(draft))} نمره</strong><em>{faNumber(draft.questions.reduce((sum, question) => sum + question.rubric.length, 0))} معیار ارزیابی</em></span><ChevronLeft size={15} /></button>
                <button onClick={() => goToStep(3)} disabled={running}><UsersRound size={18} /><span><small>برگه‌ها</small><strong>{faNumber(eligibleSubmissions.length)} دانش‌آموز</strong><em>{faNumber(eligibleSubmissions.reduce((sum, submission) => sum + submission.files.length, 0))} فایل آماده</em></span><ChevronLeft size={15} /></button>
                <button onClick={() => goToStep(1)} disabled={running}><ShieldCheck size={18} /><span><small>سیاست تصحیح</small><strong>{{ fast: "سریع", balanced: "متعادل", precise: "دقیق" }[draft.settings.gradingMode]} · آستانهٔ {faNumber(draft.settings.reviewThreshold * 100, 0)}٪</strong><em>{draft.settings.anonymize ? "تصحیح ناشناس" : "تطبیق هویت"}</em></span><ChevronLeft size={15} /></button>
              </div>
            </section>

            <section className="card run-submissions-card">
              <div className="card-header"><div><h3 className="card-title">صف تصحیح</h3><p className="card-subtitle">دو برگه به‌صورت هم‌زمان پردازش می‌شود؛ خطای یک برگه بقیه را متوقف نمی‌کند.</p></div>{!running && <button className="btn btn-ghost btn-sm" disabled={!eligibleSubmissions.length} onClick={() => setSelectedIds(selectedIds.length === eligibleSubmissions.length ? [] : eligibleSubmissions.map((submission) => submission.id))}>{selectedIds.length === eligibleSubmissions.length ? "لغو انتخاب همه" : "انتخاب همه"}</button>}</div>
              {(running || hasRun) && <div className="run-progress-panel"><div><span>{running ? "در حال خواندن و ارزیابی برگه‌ها…" : failedIds.current.size ? "اجرا تمام شد؛ برخی برگه‌ها نیازمند تلاش مجدد هستند." : "همهٔ برگه‌های انتخاب‌شده پردازش شدند."}</span><strong>{faNumber(Math.min(completedCount, currentProgress))} / {faNumber(currentProgress)}</strong></div><div className="progress-track"><div className="progress-fill" style={{ width: `${currentProgress ? Math.min(100, (completedCount / currentProgress) * 100) : 0}%` }} /></div><small>این صفحه را باز نگه دارید. نتیجهٔ هر برگه بلافاصله پس از پایان ذخیره می‌شود.</small></div>}
              <div className="run-queue-list">{eligibleSubmissions.map((submission) => {
                const active = activeIds.includes(submission.id);
                const selected = selectedIds.includes(submission.id);
                return <div className={`run-queue-item ${active ? "active" : ""}`} key={submission.id}>
                  {!running && <label className="queue-checkbox"><input type="checkbox" checked={selected} onChange={() => setSelectedIds((current) => current.includes(submission.id) ? current.filter((id) => id !== submission.id) : [...current, submission.id])} /><span>{selected && <Check size={12} />}</span></label>}
                  <span className={`run-status-icon status-${submission.status}`}>{active || submission.status === "processing" ? <LoaderCircle className="spin-icon" size={18} /> : submission.status === "error" ? <XCircle size={18} /> : submission.result ? <CheckCircle2 size={18} /> : <FileCheck2 size={18} />}</span>
                  <div className="run-student-info"><strong>{submission.studentName}</strong><small>{faNumber(submission.files.length)} فایل · {submission.studentCode || "بدون کد"}</small>{submission.error && <em>{submission.error}</em>}</div>
                  <div className="run-item-result">{active ? <span className="badge badge-info">در حال تصحیح</span> : submission.result ? <><strong>{faNumber(submission.result.totalScore)} <small>/ {faNumber(submission.result.maxScore)}</small></strong><span className={`badge ${resultNeedsReview(submission.result) ? "badge-warning" : "badge-success"}`}>{resultNeedsReview(submission.result) ? `${faNumber(submission.result.flags.length)} هشدار` : "بدون هشدار"}</span></> : submission.status === "error" ? <span className="badge badge-danger">ناموفق</span> : <span className="badge badge-neutral">در صف</span>}</div>
                </div>;
              })}</div>
              {hasRun && <div className={`run-completion ${failedIds.current.size ? "has-errors" : ""}`}><span>{failedIds.current.size ? <TriangleAlert size={22} /> : <CheckCheck size={22} />}</span><div><strong>{failedIds.current.size ? `${faNumber(failedIds.current.size)} برگه ناموفق ماند` : "تصحیح این دسته کامل شد"}</strong><p>{failedIds.current.size ? "موارد ناموفق انتخاب شده‌اند؛ بدون تکرار موارد موفق دوباره اجرا کنید." : "هیچ نمره‌ای خودکار نهایی نشده؛ لطفاً شواهد و هشدارها را بازبینی کنید."}</p></div>{!failedIds.current.size && <button className="btn btn-primary" onClick={() => router.push(`/review?exam=${draft.id}`)}>رفتن به بازبینی <ArrowLeft size={16} /></button>}</div>}
            </section>
          </div>

          <aside className="run-side-column">
            <section className="card api-run-card"><div className="card-header"><div><h3 className="card-title">اتصال مدل</h3><p className="card-subtitle">تصحیح با اعتبار API خودتان</p></div><KeyRound size={18} className="text-brand" /></div><div className="api-run-body"><ApiConnection compact /></div></section>
            <section className="card accuracy-reminder"><WandSparkles size={21} /><h3>چه چیزی برگردانده می‌شود؟</h3><ul><li>رونوشت و پاسخ هر سؤال</li><li>نمرهٔ هر معیار با دلیل و شاهد</li><li>هشدار دست‌خط ناخوانا و تصویر مبهم</li><li>ممیزی دوم در موارد تعیین‌شده</li></ul><p>اعتماد مدل تضمین درستی نیست؛ نمرهٔ نهایی با تأیید شما مشخص می‌شود.</p></section>
          </aside>
        </div>}
      </div>

      <footer className="wizard-footer">
        <div>{step > 1 ? <button className="btn btn-secondary" onClick={() => goToStep(step - 1)} disabled={running}><ArrowRight size={16} />مرحلهٔ قبل</button> : <Link href="/exams" className="btn btn-ghost">انصراف</Link>}</div>
        <div className="wizard-footer-status">{dirty ? <><LoaderCircle size={14} className="spin-icon" />در حال ذخیرهٔ خودکار…</> : <><Check size={14} />تغییرات ذخیره شده است</>}</div>
        <div>{step < 4 ? <button className="btn btn-primary btn-lg" onClick={nextStep} disabled={running}>ذخیره و ادامه <ArrowLeft size={17} /></button> : running ? <button className="btn btn-danger-soft btn-lg" onClick={cancelGrading}><Square size={15} />توقف اجرا</button> : (!hasRun || selectedIds.length > 0) && <button className="btn btn-primary btn-lg" onClick={startGrading} disabled={!selectedSubmissions.length || !apiKey}><Play size={17} />{hasRun ? `تلاش مجدد (${faNumber(selectedSubmissions.length)} برگه)` : `شروع تصحیح ${faNumber(selectedSubmissions.length)} برگه`}</button>}</div>
      </footer>
      {step === 4 && !apiKey && <div className="wizard-fixed-hint"><KeyRound size={15} />برای فعال‌شدن دکمهٔ تصحیح، API Key را در کارت «اتصال مدل» وارد کنید.</div>}
    </div>
  );
}
