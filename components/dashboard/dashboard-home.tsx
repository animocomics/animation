"use client";

import Link from "next/link";
import {
  ArrowLeft,
  ArrowUpLeft,
  BookOpenCheck,
  CheckCheck,
  ChevronLeft,
  CircleAlert,
  ClipboardCheck,
  Clock3,
  FileCheck2,
  FilePlus2,
  Files,
  GraduationCap,
  Plus,
  Sparkles,
  TrendingUp,
  UsersRound,
} from "lucide-react";
import { useApp } from "../../lib/app-context";
import { average, examAverage, faDate, faNumber, getInitials, totalExamScore } from "../../lib/utils";
import { ExamStatusBadge, ScoreRing, SubmissionStatusBadge } from "../ui/primitives";

const statIcons = [Files, CheckCheck, CircleAlert, TrendingUp];

export function DashboardHome() {
  const { exams, classes, user } = useApp();
  const activeExam = exams.find((exam) => exam.submissions.some((submission) => submission.result)) ?? exams.find((exam) => exam.submissions.some((submission) => submission.files.length)) ?? exams[0];
  const allSubmissions = exams.flatMap((exam) => exam.submissions);
  const paperSubmissions = allSubmissions.filter((submission) => submission.files.length > 0 || submission.result);
  const approved = paperSubmissions.filter((submission) => submission.status === "approved").length;
  const pending = paperSubmissions.filter((submission) => submission.status === "needs_review").length;
  const graded = paperSubmissions.filter((submission) => submission.result);
  const overallAverage = average(graded.map((submission) => submission.result?.percentage ?? 0));
  const stats = [
    { label: "کل برگه‌های بارگذاری‌شده", value: faNumber(paperSubmissions.length), helper: `${faNumber(exams.length)} آزمون · ${faNumber(classes.length)} کلاس`, tone: "mint" },
    { label: "تأییدشده توسط معلم", value: faNumber(approved), helper: `${faNumber(paperSubmissions.length ? (approved / paperSubmissions.length) * 100 : 0, 0)}٪ از کل برگه‌ها`, tone: "blue" },
    { label: "در انتظار بازبینی", value: faNumber(pending), helper: pending ? "نیازمند توجه شما" : "همه‌چیز بررسی شده", tone: "amber" },
    { label: "میانگین نمرهٔ کلاس", value: `${faNumber(overallAverage, 0)}٪`, helper: "بر اساس برگه‌های تصحیح‌شده", tone: "violet" },
  ];

  const activePaperSubmissions = activeExam?.submissions.filter((submission) => submission.files.length > 0 || submission.result) ?? [];
  const reviewQueue = activePaperSubmissions.filter((submission) => submission.status === "needs_review");
  const maxScore = activeExam ? totalExamScore(activeExam) : 0;
  const questionPerformance = activeExam?.questions.map((question) => {
    const results = activeExam.submissions.map((submission) => submission.result?.questions.find((result) => result.questionId === question.id)).filter(Boolean);
    return {
      ...question,
      average: results.length ? average(results.map((result) => ((result?.score ?? 0) / question.maxScore) * 100)) : 0,
    };
  }) ?? [];
  const approvedActive = activePaperSubmissions.filter((submission) => submission.status === "approved").length;
  const reviewActive = activePaperSubmissions.filter((submission) => submission.status === "needs_review").length;
  const draftActive = Math.max(0, activePaperSubmissions.length - approvedActive - reviewActive);

  return (
    <div className="dashboard-page">
      <section className="welcome-row">
        <div>
          <div className="eyebrow"><span /> فضای کاری شما</div>
          <h2>خوش آمدید، {user.displayName} <span className="wave">👋</span></h2>
          <p>{pending ? `${faNumber(pending)} برگه منتظر بازبینی شماست؛ باقی موارد با آرامش پیش بروید.` : "همهٔ برگه‌ها بررسی شده‌اند؛ می‌توانید آزمون بعدی را بسازید."}</p>
        </div>
        <div className="welcome-actions">
          <Link href="/classes" className="btn btn-secondary"><UsersRound size={17} /> کلاس‌های من</Link>
          <Link href="/exams" className="btn btn-secondary"><BookOpenCheck size={17} /> آزمون‌های من</Link>
          <Link href="/grading" className="btn btn-primary"><Plus size={18} /> تصحیح جدید</Link>
        </div>
      </section>

      <section className="stats-grid" aria-label="آمار کلی">
        {stats.map((stat, index) => {
          const Icon = statIcons[index];
          return (
            <article className="stat-card card" key={stat.label}>
              <div className={`stat-icon stat-icon-${stat.tone}`}><Icon size={20} strokeWidth={1.8} /></div>
              <div className="stat-copy"><span>{stat.label}</span><strong>{stat.value}</strong><small>{stat.helper}</small></div>
              <svg className="stat-decoration" width="56" height="40" viewBox="0 0 56 40" fill="none" aria-hidden="true"><path d="M2 33C11 33 11 26 18 26C25 26 24 15 32 15C40 15 39 22 45 22C51 22 51 7 55 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
            </article>
          );
        })}
      </section>

      {activeExam && activePaperSubmissions.length > 0 ? (
        <>
          <section className="dashboard-main-grid">
            <article className="card recent-exam-card">
              <div className="card-header">
                <div className="exam-heading">
                  <span className="exam-subject-icon"><GraduationCap size={21} /></span>
                  <div><div className="exam-title-line"><h3>{activeExam.title}</h3><ExamStatusBadge status={activeExam.status} />{activeExam.isDemo && <span className="badge demo-badge">نمونه</span>}</div><p>{activeExam.className} · {faDate(activeExam.date)}</p></div>
                </div>
                <Link className="card-link" href={`/exams/${activeExam.id}`}>جزئیات آزمون <ChevronLeft size={14} /></Link>
              </div>
              <div className="exam-overview-strip">
                <div className="exam-overview-item"><UsersRound size={17} /><span>دانش‌آموز</span><strong>{faNumber(activeExam.submissions.length)}</strong></div>
                <div className="exam-overview-item"><FileCheck2 size={17} /><span>تصحیح‌شده</span><strong>{faNumber(activeExam.submissions.filter((submission) => submission.result).length)}</strong></div>
                <div className="exam-overview-item"><Clock3 size={17} /><span>بازبینی</span><strong className={reviewActive ? "text-warning" : ""}>{faNumber(reviewActive)}</strong></div>
                <div className="exam-average-block"><span>میانگین کلاس</span><strong>{faNumber(examAverage(activeExam), 0)}<small>٪</small></strong><div className="progress-track"><div className="progress-fill" style={{ width: `${examAverage(activeExam)}%` }} /></div></div>
              </div>
              <div className="table-wrap">
                <table className="data-table dashboard-table">
                  <thead><tr><th>دانش‌آموز</th><th>نمره</th><th>اعتماد مدل</th><th>وضعیت</th><th aria-label="اقدام" /></tr></thead>
                  <tbody>
                    {activePaperSubmissions.slice(0, 5).map((submission) => (
                      <tr key={submission.id}>
                        <td><div className="student-cell"><span className="student-avatar">{getInitials(submission.studentName)}</span><span><strong>{submission.studentName}</strong><small>{submission.studentCode}</small></span></div></td>
                        <td><span className="score-number">{faNumber(submission.result?.totalScore ?? 0)} <span className="score-total">از {faNumber(maxScore)}</span></span></td>
                        <td><div className="model-confidence"><span>{faNumber((submission.result?.overallConfidence ?? 0) * 100, 0)}٪</span><div className="mini-confidence-track"><i style={{ width: `${(submission.result?.overallConfidence ?? 0) * 100}%` }} /></div></div></td>
                        <td><SubmissionStatusBadge status={submission.status} /></td>
                        <td><Link className="row-action" href={`/review?exam=${activeExam.id}&submission=${submission.id}`} aria-label={`بازبینی ${submission.studentName}`}><ArrowUpLeft size={17} /></Link></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Link href={`/exams/${activeExam.id}`} className="table-footer-link">مشاهدهٔ همهٔ {faNumber(activePaperSubmissions.length)} برگه <ArrowLeft size={15} /></Link>
            </article>

            <aside className="card review-queue-card">
              <div className="card-header"><div><h3 className="card-title">منتظر نظر شما</h3><p className="card-subtitle">اولویت با موارد مبهم و حساس</p></div><span className="queue-count">{faNumber(reviewQueue.length)}</span></div>
              <div className="review-queue-list">
                {reviewQueue.slice(0, 4).map((submission, index) => (
                  <Link href={`/review?exam=${activeExam.id}&submission=${submission.id}`} className="review-queue-item" key={submission.id}>
                    <div className="queue-item-top"><span className={`queue-index ${index === 0 ? "urgent" : ""}`}>{faNumber(index + 1)}</span><div><strong>{submission.studentName}</strong><small>{submission.identityMessage && ["ambiguous", "unmatched", "missing"].includes(submission.identityStatus || "") ? submission.identityMessage : submission.result?.flags[0]?.message ?? "نمره نیازمند بررسی است"}</small></div></div>
                    <div className="queue-item-bottom"><span><CircleAlert size={13} /> {submission.result?.flags[0]?.type === "illegible" ? "دست‌خط ناخوانا" : submission.result?.flags[0]?.type === "grade_boundary" ? "نزدیک مرز قبولی" : "بررسی پاسخ"}</span><strong>{faNumber(submission.result?.totalScore ?? 0)} <small>/ {faNumber(maxScore)}</small></strong></div>
                  </Link>
                ))}
                {!reviewQueue.length && <div className="queue-empty"><CheckCheck size={27} /><strong>همهٔ برگه‌ها بررسی شدند</strong><span>موردی در صف بازبینی نیست.</span></div>}
              </div>
              {reviewQueue.length > 0 && <Link href={`/review?exam=${activeExam.id}`} className="btn btn-soft queue-button">شروع بازبینی <ArrowLeft size={15} /></Link>}
              <div className="queue-footnote"><Sparkles size={13} /><span>نمره‌ها تا تأیید شما موقت هستند</span></div>
            </aside>
          </section>

          <section className="dashboard-secondary-grid">
            <article className="card performance-card">
              <div className="card-header"><div><h3 className="card-title">عملکرد کلاس در هر سؤال</h3><p className="card-subtitle">میانگین درصد کسب نمره؛ برای پیدا کردن مفاهیم نیازمند مرور</p></div><Link href={`/reports?exam=${activeExam.id}`} className="card-link">گزارش کامل <ChevronLeft size={14} /></Link></div>
              <div className="question-bars">
                {questionPerformance.map((question) => (
                  <div className="question-bar-row" key={question.id}>
                    <span className="question-number">سؤال {faNumber(question.number)}</span>
                    <div className="question-bar-track"><div className={`question-bar-fill ${question.average < 60 ? "low" : question.average < 80 ? "medium" : ""}`} style={{ width: `${question.average}%` }} /></div>
                    <strong>{faNumber(question.average, 0)}٪</strong>
                  </div>
                ))}
              </div>
            </article>
            <article className="card grading-status-card">
              <div className="card-header"><div><h3 className="card-title">وضعیت این آزمون</h3><p className="card-subtitle">پیشرفت تا انتشار نمره‌ها</p></div></div>
              <div className="status-ring-content">
                <ScoreRing value={activePaperSubmissions.length ? (approvedActive / activePaperSubmissions.length) * 100 : 0} size={118} stroke={10} label="تأیید نهایی" />
                <div className="status-legend">
                  <div><span><i className="legend-dot approved" />تأییدشده</span><strong>{faNumber(approvedActive)}</strong></div>
                  <div><span><i className="legend-dot review" />نیازمند بازبینی</span><strong>{faNumber(reviewActive)}</strong></div>
                  <div><span><i className="legend-dot draft" />پیش‌نویس AI</span><strong>{faNumber(draftActive)}</strong></div>
                </div>
              </div>
              <div className="status-tip"><ClipboardCheck size={17} /><p>با تأیید همهٔ برگه‌ها، کارنامهٔ کلاس آمادهٔ انتشار می‌شود.</p></div>
            </article>
          </section>
        </>
      ) : (
        <section className="card empty-state dashboard-empty">
          <span className="empty-icon"><FilePlus2 size={28} /></span>
          <h3>اولین تصحیح واقعی را شروع کنید</h3>
          <p>کلاس و فهرست دانش‌آموزان را بسازید، سؤال‌ها و بارم را وارد کنید و برگه‌ها را برای تصحیح امن بارگذاری کنید.</p>
          <Link href="/grading" className="btn btn-primary">ساخت آزمون و بارگذاری برگه <ArrowLeft size={16} /></Link>
        </section>
      )}
    </div>
  );
}
