"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  CircleAlert,
  ClipboardCheck,
  Download,
  ExternalLink,
  FileQuestion,
  FileSearch,
  Flag,
  History,
  Info,
  Lightbulb,
  MessageSquareText,
  Printer,
  Search,
  ShieldCheck,
  Sparkles,
  ThumbsUp,
  TriangleAlert,
  UserCheck,
  UserRound,
  X,
} from "lucide-react";
import { useApp } from "../../lib/app-context";
import { exportStudentJson, printStudentReport } from "../../lib/export";
import { FLAG_LABELS, QUESTION_TYPE_LABELS, type GradingResult, type QuestionResult, type ReviewFlag, type Submission } from "../../lib/types";
import { clamp, faDate, faNumber, getInitials, round, uid } from "../../lib/utils";
import { ConfidenceBar, Modal, ScoreRing, SubmissionStatusBadge } from "../ui/primitives";
import { FilePreview } from "./file-preview";

type ReviewFilter = "all" | "needs_review" | "approved";
type PanelTab = "scores" | "feedback" | "audit";

export function ReviewWorkspace() {
  const { exams, classes, updateSubmission, notify } = useApp();
  const searchParams = useSearchParams();
  const examParam = searchParams.get("exam");
  const submissionParam = searchParams.get("submission");
  const eligibleExams = exams.filter((exam) => exam.submissions.some((submission) => submission.result));
  const [examId, setExamId] = useState(examParam ?? "");
  const activeExam = eligibleExams.find((exam) => exam.id === examId) ?? eligibleExams[0];
  const [submissionId, setSubmissionId] = useState(submissionParam ?? "");
  const [filter, setFilter] = useState<ReviewFilter>("all");
  const [query, setQuery] = useState("");
  const [panelTab, setPanelTab] = useState<PanelTab>("scores");
  const [activeQuestionId, setActiveQuestionId] = useState("");
  const [scoreDrafts, setScoreDrafts] = useState<Record<string, number>>({});
  const [feedbackDraft, setFeedbackDraft] = useState("");
  const [previewPage, setPreviewPage] = useState(1);
  const [approvalOpen, setApprovalOpen] = useState(false);

  const selectedSubmission = activeExam?.submissions.find((submission) => submission.id === submissionId && submission.result)
    ?? activeExam?.submissions.find((submission) => submission.status === "needs_review" && submission.result)
    ?? activeExam?.submissions.find((submission) => submission.result);
  const result = selectedSubmission?.result;

  const filteredSubmissions = useMemo(() => activeExam?.submissions.filter((submission) => {
    if (!submission.result) return false;
    const matchesFilter = filter === "all" || (filter === "needs_review" ? submission.status === "needs_review" : submission.status === "approved");
    return matchesFilter && submission.studentName.includes(query.trim());
  }) ?? [], [activeExam, filter, query]);

  useEffect(() => {
    if (!selectedSubmission?.result) return;
    setScoreDrafts(Object.fromEntries(selectedSubmission.result.questions.map((question) => [question.questionId, question.score])));
    setFeedbackDraft(selectedSubmission.result.teacherFeedback ?? "");
    const firstFlagged = selectedSubmission.result.questions.find((question) => question.needsReview) ?? selectedSubmission.result.questions[0];
    setActiveQuestionId(firstFlagged?.questionId ?? "");
    setPanelTab("scores");
    setPreviewPage(1);
  }, [selectedSubmission?.id]);

  if (!activeExam || !selectedSubmission || !result) {
    return <section className="card empty-state review-empty"><span className="empty-icon"><FileSearch size={28} /></span><h3>هنوز نتیجه‌ای برای بازبینی وجود ندارد</h3><p>پس از تصحیح واقعی برگه‌ها، رونوشت، شواهد و هشدارها اینجا نمایش داده می‌شود.</p><Link href="/grading" className="btn btn-primary">شروع یک تصحیح <ArrowLeft size={16} /></Link></section>;
  }

  const currentExam = activeExam;
  const currentSubmission = selectedSubmission;
  const currentResult = result;
  const schoolClass = classes.find((item) => item.id === currentExam.classId) || classes.find((item) => item.name === currentExam.className);
  const identityNeedsReview = ["ambiguous", "unmatched", "missing"].includes(currentSubmission.identityStatus || "");
  const unresolvedCount = currentResult.questions.filter((question) => question.needsReview).length + currentResult.flags.filter((flag) => !flag.questionId && flag.severity !== "info").length + (identityNeedsReview ? 1 : 0);

  const updateResult = (nextResult: GradingResult, status: Submission["status"] = currentSubmission.status, audit?: { action: string; details: string }) => {
    updateSubmission(currentExam.id, currentSubmission.id, {
      result: nextResult,
      status,
      audit: audit ? [...currentSubmission.audit, { id: uid("audit"), at: new Date().toISOString(), actor: "teacher", ...audit }] : currentSubmission.audit,
    });
  };

  const commitScore = (questionResult: QuestionResult) => {
    const rawScore = scoreDrafts[questionResult.questionId] ?? questionResult.score;
    const nextScore = round(clamp(rawScore, 0, questionResult.maxScore), 2);
    setScoreDrafts((current) => ({ ...current, [questionResult.questionId]: nextScore }));
    if (nextScore === questionResult.score) return;
    const questions = currentResult.questions.map((question) => question.questionId === questionResult.questionId ? {
      ...question,
      score: nextScore,
      teacherEdited: true,
      originalAiScore: question.originalAiScore ?? question.score,
    } : question);
    const totalScore = round(questions.reduce((sum, question) => sum + question.score, 0), 2);
    const nextResult = {
      ...currentResult,
      questions,
      totalScore,
      percentage: currentResult.maxScore ? round((totalScore / currentResult.maxScore) * 100, 1) : 0,
      approvedAt: undefined,
    };
    updateResult(nextResult, currentSubmission.status === "approved" ? "needs_review" : currentSubmission.status, {
      action: "اصلاح نمره توسط معلم",
      details: `سؤال ${currentExam.questions.find((question) => question.id === questionResult.questionId)?.number}: از ${faNumber(questionResult.score)} به ${faNumber(nextScore)}`,
    });
    notify({ title: "نمره اصلاح شد", description: "مقدار اولیهٔ AI و تغییر معلم در تاریخچه حفظ شد.", variant: "success" });
  };

  const resolveQuestion = (questionId: string) => {
    const questions = currentResult.questions.map((question) => question.questionId === questionId ? { ...question, needsReview: false, flags: [] } : question);
    const flags = currentResult.flags.filter((flag) => flag.questionId !== questionId);
    updateResult({ ...currentResult, questions, flags }, currentSubmission.status, {
      action: "بازبینی هشدار",
      details: `سؤال ${currentExam.questions.find((question) => question.id === questionId)?.number} توسط معلم بررسی و هشدار آن رفع شد.`,
    });
  };

  const saveFeedback = () => {
    updateResult({ ...currentResult, teacherFeedback: feedbackDraft }, currentSubmission.status, { action: "ثبت بازخورد معلم", details: "بازخورد کلی برگه به‌روزرسانی شد." });
    notify({ title: "بازخورد ذخیره شد", variant: "success" });
  };

  const assignIdentity = (studentId?: string) => {
    const id = studentId || currentSubmission.studentId;
    const student = schoolClass?.students.find((item) => item.id === id);
    if (!student) {
      notify({ title: "دانش‌آموز را از فهرست کلاس انتخاب کنید", variant: "error" });
      return;
    }
    const duplicate = currentExam.submissions.find((submission) => submission.id !== currentSubmission.id && submission.studentId === student.id && submission.result);
    if (duplicate) {
      notify({ title: "این دانش‌آموز قبلاً برگه دارد", description: "برگهٔ تکراری را حذف یا با برگهٔ اصلی ادغام کنید؛ نمره دوم جایگزین خودکار نمی‌شود.", variant: "error" });
      return;
    }
    const otherReview = currentResult.questions.some((question) => question.needsReview) || currentResult.flags.some((flag) => flag.severity !== "info");
    updateSubmission(currentExam.id, currentSubmission.id, {
      studentId: student.id,
      studentName: student.name,
      studentCode: student.code,
      identityStatus: "matched",
      identitySource: "manual",
      identityMessage: "انتساب هویت توسط معلم تأیید شد.",
      status: currentSubmission.status === "approved" ? "approved" : otherReview ? "needs_review" : "graded",
      audit: [...currentSubmission.audit, { id: uid("audit"), at: new Date().toISOString(), actor: "teacher", action: "تأیید هویت و انتساب", details: `برگه به ${student.name} (${student.code || "بدون کد"}) در ${schoolClass!.name} متصل شد.` }],
    });
    notify({ title: "هویت برگه تأیید شد", description: `نمره در ردیف ${student.name} قرار گرفت.`, variant: "success" });
  };

  const approve = () => {
    if (identityNeedsReview && schoolClass) {
      notify({ title: "ابتدا هویت برگه را تأیید کنید", description: "دانش‌آموز درست را از کارت تطبیق هویت انتخاب کنید؛ تأیید نمره به‌تنهایی انتساب مبهم را نهایی نمی‌کند.", variant: "error" });
      setApprovalOpen(false);
      setPanelTab("scores");
      return;
    }
    const approvedAt = new Date().toISOString();
    updateResult({
      ...currentResult,
      approvedAt,
      teacherFeedback: feedbackDraft,
      questions: currentResult.questions.map((question) => ({ ...question, needsReview: false })),
    }, "approved", {
      action: "تأیید نهایی نمره",
      details: unresolvedCount ? `تأیید توسط معلم با ${faNumber(unresolvedCount)} یادداشت بازبینی باقی‌مانده در تاریخچه` : "همهٔ موارد بررسی و نمره نهایی تأیید شد.",
    });
    setApprovalOpen(false);
    notify({ title: `نمرهٔ ${currentSubmission.studentName} تأیید شد`, description: "کارنامهٔ نهایی آمادهٔ چاپ و خروجی است.", variant: "success" });
    const next = currentExam.submissions.find((submission) => submission.id !== currentSubmission.id && submission.status === "needs_review" && submission.result);
    if (next) setSubmissionId(next.id);
  };

  const reopen = () => {
    updateResult({ ...currentResult, approvedAt: undefined }, currentResult.flags.length ? "needs_review" : "graded", { action: "بازکردن مجدد برگه", details: "تأیید نهایی برداشته شد تا معلم دوباره بررسی کند." });
  };

  const goToEvidence = (flag: ReviewFlag) => {
    if (flag.questionId) setActiveQuestionId(flag.questionId);
    if (flag.page) setPreviewPage(flag.page);
    setPanelTab("scores");
    document.getElementById(`result-${flag.questionId ?? "general"}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const statusCounts = {
    all: currentExam.submissions.filter((submission) => submission.result).length,
    needs_review: currentExam.submissions.filter((submission) => submission.status === "needs_review").length,
    approved: currentExam.submissions.filter((submission) => submission.status === "approved").length,
  };

  return (
    <div className="review-page">
      <section className="review-topbar">
        <div className="review-exam-select"><span className="review-exam-icon"><ClipboardCheck size={20} /></span><div><label htmlFor="review-exam">آزمون در حال بازبینی</label><select id="review-exam" value={currentExam.id} onChange={(event) => { setExamId(event.target.value); setSubmissionId(""); setFilter("all"); }}>{eligibleExams.map((exam) => <option key={exam.id} value={exam.id}>{exam.title} · {exam.className}</option>)}</select></div></div>
        <div className="review-top-actions"><Link href={`/exams/${currentExam.id}`} className="btn btn-secondary btn-sm"><ExternalLink size={15} />جزئیات آزمون</Link><button className="btn btn-secondary btn-sm" onClick={() => printStudentReport(currentExam, currentSubmission)}><Printer size={15} />چاپ کارنامه</button><button className="btn btn-primary btn-sm" onClick={() => currentSubmission.status === "approved" ? reopen() : unresolvedCount ? setApprovalOpen(true) : approve()}>{currentSubmission.status === "approved" ? <><X size={15} />بازکردن مجدد</> : <><UserCheck size={15} />تأیید نمره</>}</button></div>
      </section>

      <div className="review-layout">
        <aside className="card review-queue-panel">
          <div className="review-queue-search input-with-icon"><Search size={15} /><input className="input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="جست‌وجوی دانش‌آموز…" /></div>
          <div className="review-filter-tabs">{(["all", "needs_review", "approved"] as ReviewFilter[]).map((value) => <button key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{{ all: "همه", needs_review: "بازبینی", approved: "تأییدشده" }[value]}<span>{faNumber(statusCounts[value])}</span></button>)}</div>
          <div className="review-student-list">{filteredSubmissions.map((submission) => <button key={submission.id} className={`review-student-item ${selectedSubmission.id === submission.id ? "active" : ""}`} onClick={() => setSubmissionId(submission.id)}>
            <span className="student-avatar">{getInitials(submission.studentName)}</span>
            <span className="review-student-copy"><strong>{submission.studentName}</strong><small>{submission.status === "needs_review" ? `${faNumber(submission.result?.flags.length ?? 0)} هشدار بازبینی` : submission.status === "approved" ? "تأیید نهایی" : "پیش‌نویس تصحیح"}</small></span>
            <span className={`review-student-score ${submission.status === "needs_review" ? "warning" : ""}`}>{faNumber(submission.result?.totalScore ?? 0)}<small>/{faNumber(submission.result?.maxScore ?? 0)}</small></span>
          </button>)}</div>
          {!filteredSubmissions.length && <div className="review-filter-empty"><Search size={20} /><p>در این فیلتر برگه‌ای نیست.</p><button onClick={() => { setFilter("all"); setQuery(""); }}>نمایش همه</button></div>}
          <div className="review-queue-footer"><ShieldCheck size={14} /><span>نمرهٔ نهایی فقط با تأیید معلم</span></div>
        </aside>

        <div className="review-paper-column"><FilePreview files={currentSubmission.files} studentName={currentSubmission.studentName} requestedPage={previewPage} /><div className="paper-help-note"><Info size={14} /><span>اگر رونوشت با برگه فرق دارد، نمره را اصلاح کنید؛ مقدار اولیهٔ AI در تاریخچه می‌ماند.</span></div></div>

        <aside className="card grading-review-panel">
          <div className="grading-student-header">
            <div className="grading-student-name"><span className="student-avatar">{getInitials(currentSubmission.studentName)}</span><div><h3>{currentSubmission.studentName}</h3><p>{currentSubmission.studentCode || "بدون کد"} · {faDate(currentResult.gradedAt, { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}</p></div></div>
            <SubmissionStatusBadge status={currentSubmission.status} />
            <div className="grading-score-summary"><ScoreRing value={currentResult.percentage} size={78} stroke={7} tone={currentResult.percentage < 50 ? "red" : currentResult.percentage < 75 ? "amber" : "brand"} /><div><span>نمرهٔ فعلی</span><strong>{faNumber(currentResult.totalScore)} <small>از {faNumber(currentResult.maxScore)}</small></strong><small>{currentSubmission.status === "approved" ? "تأیید نهایی معلم" : "پیش‌نویس قابل ویرایش"}</small></div><div className="grading-model-info"><Bot size={13} /><span>{currentResult.model}</span>{currentResult.verification === "verified" || currentResult.verification === "corrected" ? <span className="badge badge-success">ممیزی دوم</span> : null}</div></div>
          </div>

          <div className="grading-panel-tabs"><button className={panelTab === "scores" ? "active" : ""} onClick={() => setPanelTab("scores")}><ListChecksIcon />نمره‌ها</button><button className={panelTab === "feedback" ? "active" : ""} onClick={() => setPanelTab("feedback")}><MessageSquareText size={15} />بازخورد</button><button className={panelTab === "audit" ? "active" : ""} onClick={() => setPanelTab("audit")}><History size={15} />تاریخچه</button></div>

          {panelTab === "scores" && <div className="grading-scores-panel">
            <div className={`identity-match-card ${identityNeedsReview ? "needs-attention" : ""}`}>
              <div className="identity-match-heading"><span>{identityNeedsReview ? <AlertTriangle size={17} /> : <UserCheck size={17} />}</span><div><strong>{identityNeedsReview ? "انتساب هویت نیازمند تأیید است" : "هویت و ردیف کارنامه"}</strong><small>{currentSubmission.identityMessage || "هویت این برگه برای ثبت در کارنامه بررسی شده است."}</small></div><span className={`badge ${identityNeedsReview ? "badge-warning" : "badge-success"}`}>{identityNeedsReview ? "توقف انتساب" : "تطبیق‌شده"}</span></div>
              <div className="identity-detection-meta"><span>روی برگه: <strong>{currentResult.detectedStudentName || "نام خوانده نشد"}</strong></span><span>کلاس: <strong>{currentResult.detectedClassName || currentSubmission.detectedClassName || "خوانده نشد"}</strong></span><span>اطمینان هویت: <strong>{faNumber((currentResult.identityConfidence ?? 0) * 100, 0)}٪</strong></span></div>
              {schoolClass ? <div className="identity-assign-row"><select className="select" aria-label="انتساب به دانش‌آموز کلاس" value={currentSubmission.studentId || ""} onChange={(event) => assignIdentity(event.target.value)}><option value="">انتخاب دانش‌آموز از {schoolClass.name}…</option>{schoolClass.students.filter((student) => student.active).map((student) => <option key={student.id} value={student.id}>{student.name} · {student.code || "بدون کد"}</option>)}</select>{identityNeedsReview && currentSubmission.studentId && <button className="btn btn-secondary btn-sm" onClick={() => assignIdentity()}><Check size={14} /> تأیید انتساب فعلی</button>}</div> : <Link href="/classes" className="btn btn-secondary btn-sm">ساخت و اتصال فهرست کلاس <ChevronLeft size={14} /></Link>}
            </div>
            {currentResult.flags.length > 0 && <div className="review-flags-box"><div className="review-flags-title"><TriangleAlert size={16} /><strong>{faNumber(currentResult.flags.length)} نکته برای توجه شما</strong></div>{currentResult.flags.slice(0, 4).map((flag) => <button key={flag.id} onClick={() => goToEvidence(flag)}><span className={`flag-severity ${flag.severity}`} /><span><strong>{FLAG_LABELS[flag.type]}</strong><small>{flag.message}</small></span><ChevronLeft size={14} /></button>)}</div>}
            <div className="question-result-list">{currentExam.questions.map((question) => {
              const questionResult = currentResult.questions.find((item) => item.questionId === question.id);
              if (!questionResult) return null;
              const open = activeQuestionId === question.id;
              return <article id={`result-${question.id}`} className={`question-result-card ${open ? "open" : ""} ${questionResult.needsReview ? "flagged" : ""}`} key={question.id}>
                <div className="question-result-summary">
                  <button onClick={() => setActiveQuestionId(open ? "" : question.id)} aria-expanded={open}><span className="question-result-number">{faNumber(question.number)}</span><span><strong>{question.prompt}</strong><small>{QUESTION_TYPE_LABELS[question.type]} · اعتماد {faNumber(questionResult.confidence * 100, 0)}٪</small></span><ChevronDown size={15} className={open ? "rotate-180" : ""} /></button>
                  <div className={`question-score-input ${questionResult.teacherEdited ? "edited" : ""}`}><input aria-label={`نمرهٔ سؤال ${question.number}`} type="number" min="0" max={question.maxScore} step="0.25" value={scoreDrafts[question.id] ?? questionResult.score} onChange={(event) => setScoreDrafts((current) => ({ ...current, [question.id]: Number(event.target.value) }))} onBlur={() => commitScore(questionResult)} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /><span>/ {faNumber(question.maxScore)}</span></div>
                </div>
                {questionResult.needsReview && <div className="question-flag-line"><Flag size={12} />نیازمند بازبینی{questionResult.teacherEdited && <span>· نمره توسط معلم اصلاح شده</span>}</div>}
                {open && <div className="question-result-body">
                  <div className="transcript-box"><div><span>رونوشت پاسخ دانش‌آموز</span><ConfidenceBar value={questionResult.confidence} /></div><p>{questionResult.transcript || "رونوشتی ثبت نشده است."}</p></div>
                  {questionResult.evidence.excerpt && <button className="evidence-box" onClick={() => setPreviewPage(questionResult.evidence.page ?? 1)}><FileSearch size={16} /><span><strong>شاهد در برگه {questionResult.evidence.page ? `· صفحهٔ ${faNumber(questionResult.evidence.page)}` : ""}</strong><small>{questionResult.evidence.excerpt}</small></span><ExternalLink size={13} /></button>}
                  {questionResult.criteria.length > 0 && <div className="criterion-result-table"><div className="criterion-result-head"><span>معیار بارم</span><span>نمره</span></div>{questionResult.criteria.map((criterion) => { const definition = question.rubric.find((item) => item.id === criterion.criterionId); return <div className="criterion-result-row" key={criterion.criterionId}><span><strong>{definition?.label ?? "معیار"}</strong><small>{criterion.note}</small></span><b>{faNumber(criterion.score)} / {faNumber(criterion.maxScore)}</b></div>; })}</div>}
                  <div className="ai-rationale"><Sparkles size={15} /><div><strong>دلیل ارزیابی مدل</strong><p>{questionResult.rationale}</p></div></div>
                  {questionResult.teacherEdited && <div className="teacher-edit-note"><UserRound size={14} /><span>نمرهٔ اولیهٔ AI: {faNumber(questionResult.originalAiScore ?? questionResult.score)} · مقدار فعلی توسط معلم اصلاح شده است.</span></div>}
                  <div className="question-result-footer"><span>{questionResult.needsReview ? "پس از مقایسه با برگهٔ اصلی، وضعیت را مشخص کنید." : "این سؤال بررسی شده است."}</span>{questionResult.needsReview ? <button className="btn btn-soft btn-sm" onClick={() => resolveQuestion(question.id)}><Check size={14} />بررسی شد</button> : <span className="badge badge-success"><CheckCircle2 size={12} />بررسی‌شده</span>}</div>
                </div>}
              </article>;
            })}</div>
          </div>}

          {panelTab === "feedback" && <div className="feedback-panel">
            <div className="feedback-ai-summary"><Sparkles size={18} /><div><strong>جمع‌بندی دستیار</strong><p>{currentResult.summary}</p></div></div>
            <div className="feedback-list strengths"><h4><ThumbsUp size={16} />نقاط قوت</h4>{currentResult.strengths.length ? <ul>{currentResult.strengths.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p>نکته‌ای ثبت نشده است.</p>}</div>
            <div className="feedback-list improvements"><h4><Lightbulb size={16} />فرصت‌های بهبود</h4>{currentResult.improvements.length ? <ul>{currentResult.improvements.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p>پیشنهادی ثبت نشده است.</p>}</div>
            <div className="form-field teacher-feedback-field"><label>بازخورد نهایی معلم</label><textarea className="textarea" value={feedbackDraft} onChange={(event) => setFeedbackDraft(event.target.value)} placeholder="بازخورد کوتاه، مشخص و قابل اقدام برای دانش‌آموز…" /><span className="form-hint">این متن در کارنامهٔ چاپی و خروجی دانش‌آموز استفاده می‌شود.</span></div>
            <button className="btn btn-primary" onClick={saveFeedback}><Check size={15} />ذخیرهٔ بازخورد</button>
          </div>}

          {panelTab === "audit" && <div className="audit-panel"><div className="audit-model-card"><Bot size={19} /><div><strong>{currentResult.provider === "openai" ? "OpenAI" : currentResult.provider === "gemini" ? "Gemini" : currentResult.provider === "zai" ? "Z.AI GLM" : currentResult.provider === "minimax" ? "MiniMax" : currentResult.provider === "inkling" ? "Inkling / Tinker" : currentResult.provider === "mistral" ? "Mistral AI" : "DeepSeek"} · {currentResult.model}</strong><span>{faNumber(currentResult.usage.inputTokens + currentResult.usage.outputTokens)} توکن ثبت‌شده · {faDate(currentResult.gradedAt, { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}</span></div></div><div className="audit-timeline">{[...currentSubmission.audit].reverse().map((entry) => <div className="audit-entry" key={entry.id}><span className={`audit-actor ${entry.actor}`}>{entry.actor === "teacher" ? <UserRound size={14} /> : entry.actor === "ai" ? <Bot size={14} /> : <CircleAlert size={14} />}</span><div><strong>{entry.action}</strong><p>{entry.details}</p><small>{faDate(entry.at, { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}</small></div></div>)}</div></div>}

          <div className="grading-panel-footer"><button className="btn btn-secondary btn-sm" onClick={() => exportStudentJson(currentExam, currentSubmission)}><Download size={14} />JSON</button>{currentSubmission.status === "approved" ? <span className="approved-stamp"><CheckCheck size={15} />تأیید شده توسط معلم</span> : <button className="btn btn-primary btn-sm" onClick={() => unresolvedCount ? setApprovalOpen(true) : approve()}>تأیید و برگهٔ بعدی<ChevronLeft size={14} /></button>}</div>
        </aside>
      </div>

      {approvalOpen && <Modal title="تأیید نمره با هشدار باقی‌مانده" description={currentSubmission.studentName} onClose={() => setApprovalOpen(false)} footer={<><button className="btn btn-secondary" onClick={() => setApprovalOpen(false)}>بازگشت به بازبینی</button><button className="btn btn-primary" onClick={approve}><UserCheck size={16} />تأیید نهایی توسط من</button></>}><div className="notice notice-warning"><AlertTriangle size={20} /><div><strong>{faNumber(unresolvedCount)} مورد هنوز به‌صورت «بررسی‌شده» علامت نخورده است</strong><p>می‌توانید به برگه برگردید یا مسئولیت بررسی را بپذیرید و نمره را تأیید کنید. هشدارها در تاریخچه حذف نمی‌شوند.</p></div></div></Modal>}
    </div>
  );
}

function ListChecksIcon() {
  return <ClipboardCheck size={15} />;
}
