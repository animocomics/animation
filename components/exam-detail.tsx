"use client";

import Link from "next/link";
import { useState } from "react";
import {
  ArrowLeft,
  ArrowUpLeft,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Download,
  FileQuestion,
  FileUp,
  KeyRound,
  ListChecks,
  LockKeyhole,
  Settings2,
  ShieldCheck,
  Sparkles,
  UsersRound,
} from "lucide-react";
import { useApp } from "../lib/app-context";
import { exportExamCsv } from "../lib/export";
import { QUESTION_TYPE_LABELS } from "../lib/types";
import { faDate, faNumber, getInitials, rubricScore, totalExamScore } from "../lib/utils";
import { ConfidenceBar, ExamStatusBadge, SubmissionStatusBadge } from "./ui/primitives";

export function ExamDetail({ examId }: { examId: string }) {
  const { exams, notify, user } = useApp();
  const [tab, setTab] = useState<"submissions" | "questions" | "settings">("submissions");
  const [openQuestion, setOpenQuestion] = useState<string | null>(null);
  const exam = exams.find((item) => item.id === examId);

  if (!exam) {
    return <section className="card empty-state"><span className="empty-icon"><FileQuestion size={27} /></span><h3>این آزمون پیدا نشد</h3><p>ممکن است حذف شده باشد یا در فضای کاری این حساب موجود نباشد.</p><Link href="/exams" className="btn btn-primary">بازگشت به آزمون‌ها</Link></section>;
  }

  const approved = exam.submissions.filter((submission) => submission.status === "approved").length;

  return (
    <div className="exam-detail-page">
      <Link href="/exams" className="back-link"><ArrowLeft size={15} className="flip-rtl" /> بازگشت به آزمون‌ها</Link>
      <section className="card exam-detail-hero">
        <div className="exam-detail-main">
          <div className="exam-detail-icon"><FileQuestion size={26} /></div>
          <div><div className="exam-detail-title"><h2>{exam.title}</h2><ExamStatusBadge status={exam.status} />{exam.isDemo && <span className="badge demo-badge">نمونه</span>}</div><p>{exam.subject} · {exam.className}{exam.code && <span dir="ltr"> · {exam.code}</span>}</p><div className="exam-detail-meta"><span><CalendarDays size={14} />{faDate(exam.date)}</span><span><Clock3 size={14} />{faNumber(exam.duration)} دقیقه</span><span><ListChecks size={14} />{faNumber(exam.questions.length)} سؤال</span></div></div>
        </div>
        <div className="exam-detail-actions">
          {exam.submissions.length > 0 && <button className="btn btn-secondary" onClick={() => { exportExamCsv(exam); notify({ title: "فایل CSV ساخته شد", variant: "success" }); }}><Download size={17} /> خروجی CSV</button>}
          <Link href={`/grading?exam=${exam.id}`} className="btn btn-primary"><FileUp size={17} /> {exam.submissions.length ? "افزودن و تصحیح برگه" : "بارگذاری برگه‌ها"}</Link>
        </div>
        <div className="exam-detail-stats">
          <div><span>نمرهٔ کل</span><strong>{faNumber(totalExamScore(exam))}</strong></div>
          <div><span>حد قبولی</span><strong>{faNumber(exam.passScore)}</strong></div>
          <div><span>ردیف کارنامه</span><strong>{faNumber(exam.submissions.length)}</strong></div>
          <div><span>تأیید نهایی</span><strong>{faNumber(approved)} <small>از {faNumber(exam.submissions.length)}</small></strong></div>
        </div>
      </section>

      <div className="detail-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "submissions"} className={tab === "submissions" ? "active" : ""} onClick={() => setTab("submissions")}><UsersRound size={17} />برگه‌های دانش‌آموزان<span>{faNumber(exam.submissions.length)}</span></button>
        <button role="tab" aria-selected={tab === "questions"} className={tab === "questions" ? "active" : ""} onClick={() => setTab("questions")}><ListChecks size={17} />سؤال‌ها و بارم<span>{faNumber(exam.questions.length)}</span></button>
        <button role="tab" aria-selected={tab === "settings"} className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}><Settings2 size={17} />سیاست تصحیح</button>
      </div>

      {tab === "submissions" && (
        <section className="card detail-content-card">
          <div className="card-header"><div><h3 className="card-title">نتایج دانش‌آموزان</h3><p className="card-subtitle">برای دیدن رونوشت و شواهد، برگه را باز کنید.</p></div>{exam.submissions.some((submission) => submission.status === "needs_review") && <Link href={`/review?exam=${exam.id}`} className="card-link">رفتن به صف بازبینی <ArrowLeft size={14} /></Link>}</div>
          {exam.submissions.length ? (
            <div className="table-wrap"><table className="data-table"><thead><tr><th>دانش‌آموز</th><th>فایل</th><th>نمره</th><th>درصد</th><th>اعتماد مدل</th><th>هشدار</th><th>وضعیت</th><th /></tr></thead><tbody>
              {exam.submissions.map((submission) => (
                <tr key={submission.id}>
                  <td><div className="student-cell"><span className="student-avatar">{getInitials(submission.studentName)}</span><span><strong>{submission.studentName}</strong><small>{submission.studentCode || "بدون کد"}</small></span></div></td>
                  <td><span className="text-muted">{submission.files.length ? `${faNumber(submission.files.length)} فایل` : exam.isDemo ? "نمونه" : "مفقود"}</span></td>
                  <td><span className="score-number">{submission.result ? faNumber(submission.result.totalScore) : "—"} <span className="score-total">/ {faNumber(totalExamScore(exam))}</span></span></td>
                  <td>{submission.result ? `${faNumber(submission.result.percentage)}٪` : "—"}</td>
                  <td>{submission.result ? <ConfidenceBar value={submission.result.overallConfidence} /> : "—"}</td>
                  <td>{!submission.result && !submission.files.length ? <span className="badge badge-danger">برگه مفقود</span> : ["ambiguous", "unmatched", "missing"].includes(submission.identityStatus || "") ? <span className="badge badge-warning">هویت نیازمند بررسی</span> : submission.result?.flags.length ? <span className="badge badge-warning">{faNumber(submission.result.flags.length)} مورد</span> : <span className="badge badge-success"><CheckCircle2 size={12} />بدون هشدار</span>}</td>
                  <td>{!submission.result && !submission.files.length ? <span className="badge badge-warning">منتظر برگه</span> : <SubmissionStatusBadge status={submission.status} />}</td>
                  <td>{submission.result ? <Link className="row-action" href={`/review?exam=${exam.id}&submission=${submission.id}`} aria-label="باز کردن برگه"><ArrowUpLeft size={17} /></Link> : <Link className="btn btn-soft btn-sm" href={`/grading?exam=${exam.id}`}>{submission.files.length ? "تصحیح" : "بارگذاری"}</Link>}</td>
                </tr>
              ))}
            </tbody></table></div>
          ) : <div className="empty-state"><span className="empty-icon"><FileUp size={26} /></span><h3>هنوز برگه‌ای برای این آزمون نیست</h3><p>عکس یا PDF برگه‌های دانش‌آموزان را اضافه کنید و تصحیح را شروع کنید.</p><Link href={`/grading?exam=${exam.id}`} className="btn btn-primary">افزودن برگه‌ها</Link></div>}
        </section>
      )}

      {tab === "questions" && (
        <section className="questions-detail-list">
          <div className="questions-detail-intro"><div><h3>سؤال‌ها و معیارهای نمره‌دهی</h3><p>مدل ملزم است برای هر معیار، شاهد و نمرهٔ جداگانه برگرداند.</p></div><Link href={`/grading?exam=${exam.id}&step=2`} className="btn btn-secondary btn-sm">ویرایش در چیدمان آزمون</Link></div>
          {exam.questions.map((question) => {
            const open = openQuestion === question.id;
            return <article className={`card question-detail-item ${open ? "open" : ""}`} key={question.id}>
              <button className="question-detail-summary" onClick={() => setOpenQuestion(open ? null : question.id)} aria-expanded={open}>
                <span className="question-detail-number">{faNumber(question.number)}</span>
                <span><strong>{question.prompt}</strong><small>{QUESTION_TYPE_LABELS[question.type]} · {faNumber(question.rubric.length)} معیار</small></span>
                <span className="question-max-score">{faNumber(question.maxScore)} <small>نمره</small></span>
                <ChevronDown size={18} className={open ? "rotate-180" : ""} />
              </button>
              {open && <div className="question-detail-body">
                <div className="answer-key-box"><span>پاسخ مرجع</span><p>{question.answer || "پاسخ مرجع ثبت نشده است."}</p>{question.acceptedAnswers.length > 0 && <small>پاسخ‌های مجاز دیگر: {question.acceptedAnswers.join(" · ")}</small>}</div>
                <div className="rubric-detail"><div className="rubric-detail-head"><strong>بارم تفصیلی</strong><span className={rubricScore(question) !== question.maxScore ? "text-warning" : "text-brand"}>جمع معیارها: {faNumber(rubricScore(question))} از {faNumber(question.maxScore)}</span></div>{question.rubric.map((criterion) => <div className="rubric-detail-row" key={criterion.id}><span><strong>{criterion.label}</strong><small>{criterion.description}</small></span><b>{faNumber(criterion.points)} نمره</b></div>)}</div>
                <div className="question-rule-tags">{question.partialCredit && <span className="badge badge-info">نمرهٔ جزئی فعال</span>}{question.errorCarriedForward && <span className="badge badge-violet">لحاظ خطای انتقالی</span>}</div>
              </div>}
            </article>;
          })}
        </section>
      )}

      {tab === "settings" && (
        <section className="exam-settings-grid">
          <article className="card settings-summary-card"><div className="settings-summary-icon"><Sparkles size={22} /></div><h3>حالت تصحیح</h3><strong>{{ fast: "سریع · یک مرحله", balanced: "متعادل · ممیزی موارد بحرانی", precise: "دقیق · ممیزی همهٔ موارد پرچم‌دار" }[exam.settings.gradingMode]}</strong><p>در ممیزی دوم، مدل نتیجهٔ اول را با مراجعهٔ دوباره به تصویر بررسی و در صورت نیاز اصلاح می‌کند.</p></article>
          <article className="card settings-summary-card"><div className="settings-summary-icon blue"><ShieldCheck size={22} /></div><h3>آستانهٔ بازبینی</h3><strong>{faNumber(exam.settings.reviewThreshold * 100, 0)}٪ اعتماد مدل</strong><p>اعتماد کمتر از این مقدار و نمرهٔ نزدیک مرز قبولی به‌صورت خودکار برای معلم پرچم می‌شود.</p></article>
          <article className="card settings-summary-card"><div className="settings-summary-icon violet"><LockKeyhole size={22} /></div><h3>حریم خصوصی و انتشار</h3><strong>{exam.settings.anonymize ? "تصحیح ناشناس فعال" : "تطبیق هویت فعال"} · {exam.settings.requireApproval ? "تأیید معلم الزامی" : "تأیید اختیاری"}</strong><p>{exam.settings.instructions || "دستور تکمیلی برای این آزمون ثبت نشده است."}</p></article>
          <div className="notice notice-info exam-settings-notice"><KeyRound size={19} /><div><strong>اتصال متمرکز و محفوظ نزد مدیر</strong><p>کلید فقط روی سرور و هنگام اجرا خوانده می‌شود؛ در آزمون، نتایج یا دسترس معلم ذخیره نمی‌شود.</p></div>{user.role === "admin" && <Link href="/admin" className="card-link">مدیریت اتصال</Link>}</div>
        </section>
      )}
    </div>
  );
}
