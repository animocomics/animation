"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ArrowUpLeft,
  Award,
  BarChart3,
  CheckCircle2,
  CircleAlert,
  Download,
  FileBarChart,
  Flag,
  Lightbulb,
  Printer,
  Search,
  Target,
  TrendingUp,
  Trophy,
  UsersRound,
} from "lucide-react";
import { useApp } from "../lib/app-context";
import { exportExamCsv, printStudentReport } from "../lib/export";
import { average, faNumber, getInitials, totalExamScore } from "../lib/utils";
import { ScoreRing, SubmissionStatusBadge } from "./ui/primitives";

export function ReportsDashboard() {
  const { exams, notify } = useApp();
  const searchParams = useSearchParams();
  const eligibleExams = exams.filter((exam) => exam.submissions.some((submission) => submission.result));
  const [examId, setExamId] = useState(searchParams.get("exam") ?? "");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"score_desc" | "score_asc" | "name">("score_desc");
  const exam = eligibleExams.find((item) => item.id === examId) ?? eligibleExams[0];

  const analytics = useMemo(() => {
    if (!exam) return null;
    const submissions = exam.submissions.filter((submission) => submission.result);
    const percentages = submissions.map((submission) => submission.result?.percentage ?? 0);
    const maxScore = totalExamScore(exam);
    const passPercentage = maxScore ? (exam.passScore / maxScore) * 100 : 0;
    const sorted = [...percentages].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    const median = sorted.length ? sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 : 0;
    const questionPerformance = exam.questions.map((question) => {
      const results = submissions.map((submission) => submission.result?.questions.find((item) => item.questionId === question.id)).filter(Boolean);
      return {
        id: question.id,
        number: question.number,
        prompt: question.prompt,
        average: results.length ? average(results.map((item) => ((item?.score ?? 0) / question.maxScore) * 100)) : 0,
        flagged: results.filter((item) => item?.needsReview).length,
        edited: results.filter((item) => item?.teacherEdited).length,
      };
    });
    const bins = [
      { label: "۰–۴۹", min: 0, max: 49.99, count: 0 },
      { label: "۵۰–۵۹", min: 50, max: 59.99, count: 0 },
      { label: "۶۰–۶۹", min: 60, max: 69.99, count: 0 },
      { label: "۷۰–۷۹", min: 70, max: 79.99, count: 0 },
      { label: "۸۰–۸۹", min: 80, max: 89.99, count: 0 },
      { label: "۹۰–۱۰۰", min: 90, max: 100, count: 0 },
    ];
    percentages.forEach((percentage) => { const bin = bins.find((item) => percentage >= item.min && percentage <= item.max); if (bin) bin.count += 1; });
    const flags = submissions.flatMap((submission) => submission.result?.flags ?? []);
    const edits = submissions.flatMap((submission) => submission.result?.questions ?? []).filter((question) => question.teacherEdited && question.originalAiScore !== undefined);
    const averageEdit = edits.length ? average(edits.map((question) => Math.abs(question.score - (question.originalAiScore ?? question.score)))) : 0;
    return {
      submissions,
      percentages,
      maxScore,
      passPercentage,
      average: average(percentages),
      median,
      passed: percentages.filter((percentage) => percentage >= passPercentage).length,
      approved: submissions.filter((submission) => submission.status === "approved").length,
      highest: submissions.reduce((best, submission) => (submission.result?.percentage ?? 0) > (best.result?.percentage ?? -1) ? submission : best, submissions[0]),
      questionPerformance,
      bins,
      flags,
      averageEdit,
      edits: edits.length,
    };
  }, [exam]);

  if (!exam || !analytics) {
    return <section className="card empty-state"><span className="empty-icon"><FileBarChart size={28} /></span><h3>برای ساخت گزارش به نتیجه نیاز داریم</h3><p>پس از تصحیح حداقل یک برگه، تحلیل کلاس و عملکرد سؤال‌ها اینجا ساخته می‌شود.</p><Link href="/grading" className="btn btn-primary">شروع تصحیح <ArrowLeft size={16} /></Link></section>;
  }

  const currentExam = exam;
  const data = analytics;
  const weakest = [...data.questionPerformance].sort((a, b) => a.average - b.average)[0];
  const strongest = [...data.questionPerformance].sort((a, b) => b.average - a.average)[0];
  const filteredSubmissions = data.submissions.filter((submission) => submission.studentName.includes(query.trim())).sort((a, b) => {
    if (sort === "name") return a.studentName.localeCompare(b.studentName, "fa");
    const difference = (a.result?.percentage ?? 0) - (b.result?.percentage ?? 0);
    return sort === "score_asc" ? difference : -difference;
  });
  const maxBin = Math.max(1, ...data.bins.map((bin) => bin.count));

  return (
    <div className="reports-page">
      <section className="page-heading-row reports-heading">
        <div><div className="eyebrow"><span />تحلیل عملکرد</div><h2>گزارش آزمون و عملکرد کلاس</h2><p>از نمرهٔ کلی تا معیارهایی که به بازبینی یا آموزش مجدد نیاز دارند.</p></div>
        <div className="reports-actions"><select className="select report-exam-select" value={currentExam.id} onChange={(event) => setExamId(event.target.value)} aria-label="انتخاب آزمون">{eligibleExams.map((item) => <option value={item.id} key={item.id}>{item.title} · {item.className}</option>)}</select><button className="btn btn-secondary" onClick={() => window.print()}><Printer size={16} />چاپ</button><button className="btn btn-primary" onClick={() => { exportExamCsv(currentExam); notify({ title: "گزارش CSV دانلود شد", description: "شامل نمرهٔ هر سؤال، وضعیت و هشدارها", variant: "success" }); }}><Download size={16} />خروجی CSV</button></div>
      </section>

      <div className="report-context-row"><span><strong>{currentExam.subject}</strong> · {currentExam.className}</span>{currentExam.isDemo && <span className="badge demo-badge">تحلیل دادهٔ نمایشی</span>}<span className="report-context-note">آمار فقط از برگه‌های دارای نتیجه محاسبه شده است.</span></div>

      <section className="report-stats-grid">
        <article className="card report-stat"><span className="report-stat-icon mint"><TrendingUp size={20} /></span><div><span>میانگین کلاس</span><strong>{faNumber(data.average, 1)}<small>٪</small></strong><small>میانه: {faNumber(data.median, 1)}٪</small></div></article>
        <article className="card report-stat"><span className="report-stat-icon blue"><Target size={20} /></span><div><span>نرخ قبولی</span><strong>{faNumber(data.submissions.length ? (data.passed / data.submissions.length) * 100 : 0, 0)}<small>٪</small></strong><small>{faNumber(data.passed)} از {faNumber(data.submissions.length)} دانش‌آموز</small></div></article>
        <article className="card report-stat"><span className="report-stat-icon amber"><CheckCircle2 size={20} /></span><div><span>تأیید نهایی</span><strong>{faNumber(data.approved)}<small> / {faNumber(data.submissions.length)}</small></strong><small>{faNumber(data.submissions.length - data.approved)} برگه هنوز نهایی نیست</small></div></article>
        <article className="card report-stat"><span className="report-stat-icon violet"><Flag size={20} /></span><div><span>هشدارهای ثبت‌شده</span><strong>{faNumber(data.flags.length)}</strong><small>{faNumber(data.edits)} اصلاح نمره توسط معلم</small></div></article>
      </section>

      <section className="report-charts-grid">
        <article className="card distribution-card">
          <div className="card-header"><div><h3 className="card-title">توزیع نمره‌های کلاس</h3><p className="card-subtitle">تعداد دانش‌آموز در هر بازهٔ درصدی</p></div><span className="badge badge-neutral"><UsersRound size={12} />{faNumber(data.submissions.length)} برگه</span></div>
          <div className="distribution-chart"><div className="chart-y-lines"><span>{faNumber(maxBin)}</span><span>{faNumber(Math.ceil(maxBin / 2))}</span><span>۰</span></div><div className="distribution-bars">{data.bins.map((bin, index) => <div className="distribution-bar-item" key={bin.label}><span className="bar-count">{bin.count ? faNumber(bin.count) : ""}</span><div className="distribution-bar-track"><div className={`distribution-bar bin-${index}`} style={{ height: `${Math.max(bin.count ? 12 : 2, (bin.count / maxBin) * 100)}%` }}><i /></div></div><span>{bin.label}</span></div>)}</div></div>
          <div className="distribution-footer"><span><i className="legend-dot approved" />میانگین: {faNumber(data.average, 0)}٪</span><span><i className="legend-dot review" />حد قبولی: {faNumber(data.passPercentage, 0)}٪</span><span>بازه‌ها بر اساس درصد، نه نمرهٔ خام</span></div>
        </article>

        <article className="card class-insight-card">
          <div className="card-header"><div><h3 className="card-title">جمع‌بندی قابل اقدام</h3><p className="card-subtitle">استخراج مستقیم از نتایج همین آزمون</p></div><Lightbulb size={19} className="text-warning" /></div>
          <div className="insight-hero"><span className="insight-trophy"><Trophy size={25} /></span><div><span>بالاترین نتیجه</span><strong>{data.highest.studentName}</strong><small>{faNumber(data.highest.result?.totalScore ?? 0)} از {faNumber(data.maxScore)} · {faNumber(data.highest.result?.percentage ?? 0)}٪</small></div></div>
          <div className="insight-list">
            <div><span className="insight-icon success"><ArrowUp size={17} /></span><p><strong>بهترین عملکرد: سؤال {faNumber(strongest.number)}</strong><span>میانگین کلاس {faNumber(strongest.average, 0)}٪ است؛ می‌توان از پاسخ‌های خوب به‌عنوان نمونهٔ آموزشی استفاده کرد.</span></p></div>
            <div><span className="insight-icon warning"><ArrowDown size={17} /></span><p><strong>نیازمند مرور: سؤال {faNumber(weakest.number)}</strong><span>کمترین میانگین ({faNumber(weakest.average, 0)}٪) در این سؤال است. صورت سؤال: {weakest.prompt}</span></p></div>
            <div><span className="insight-icon info"><CircleAlert size={17} /></span><p><strong>اختلاف تصحیح AI و معلم</strong><span>{data.edits ? `میانگین قدرمطلق اصلاح در ${faNumber(data.edits)} سؤال ویرایش‌شده، ${faNumber(data.averageEdit)} نمره است.` : "هنوز اصلاح نمره‌ای توسط معلم ثبت نشده است."}</span></p></div>
          </div>
        </article>
      </section>

      <section className="card question-performance-report">
        <div className="card-header"><div><h3 className="card-title">تحلیل سؤال‌به‌سؤال</h3><p className="card-subtitle">میانگین کسب نمره و تعداد پاسخ‌های پرچم‌دار در هر سؤال</p></div><BarChart3 size={19} className="text-brand" /></div>
        <div className="question-report-grid">{data.questionPerformance.map((question) => <div className="question-report-item" key={question.id}><div className="question-report-top"><span className="question-detail-number">{faNumber(question.number)}</span><div><strong>سؤال {faNumber(question.number)}</strong><small>{question.prompt}</small></div><b>{faNumber(question.average, 0)}٪</b></div><div className="question-bar-track"><div className={`question-bar-fill ${question.average < 60 ? "low" : question.average < 80 ? "medium" : ""}`} style={{ width: `${question.average}%` }} /></div><div className="question-report-meta"><span>{question.flagged ? `${faNumber(question.flagged)} پاسخ پرچم‌دار` : "بدون پاسخ پرچم‌دار"}</span>{question.edited > 0 && <span>{faNumber(question.edited)} اصلاح معلم</span>}</div></div>)}</div>
      </section>

      <section className="card report-students-card">
        <div className="card-header report-students-header"><div><h3 className="card-title">کارنامهٔ دانش‌آموزان</h3><p className="card-subtitle">مرتب‌سازی، چاپ فردی و رفتن مستقیم به شواهد</p></div><div className="report-table-controls"><div className="input-with-icon"><Search size={15} /><input className="input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="جست‌وجوی نام…" /></div><select className="select" value={sort} onChange={(event) => setSort(event.target.value as typeof sort)} aria-label="مرتب‌سازی"><option value="score_desc">بیشترین نمره</option><option value="score_asc">کمترین نمره</option><option value="name">نام دانش‌آموز</option></select></div></div>
        <div className="table-wrap"><table className="data-table"><thead><tr><th>رتبه</th><th>دانش‌آموز</th><th>نمره</th><th>درصد</th><th>وضعیت قبولی</th><th>هشدار</th><th>وضعیت تأیید</th><th>اقدام</th></tr></thead><tbody>{filteredSubmissions.map((submission, index) => <tr key={submission.id}><td><span className={`rank-number ${index < 3 && sort === "score_desc" ? "top" : ""}`}>{faNumber(index + 1)}</span></td><td><div className="student-cell"><span className="student-avatar">{getInitials(submission.studentName)}</span><span><strong>{submission.studentName}</strong><small>{submission.studentCode}</small></span></div></td><td><span className="score-number">{faNumber(submission.result?.totalScore ?? 0)} <span className="score-total">از {faNumber(data.maxScore)}</span></span></td><td><div className="report-percentage"><span>{faNumber(submission.result?.percentage ?? 0)}٪</span><div className="progress-track"><div className={`progress-fill ${(submission.result?.percentage ?? 0) < data.passPercentage ? "danger" : ""}`} style={{ width: `${submission.result?.percentage ?? 0}%` }} /></div></div></td><td>{(submission.result?.percentage ?? 0) >= data.passPercentage ? <span className="badge badge-success"><CheckCircle2 size={12} />قبول</span> : <span className="badge badge-danger">نیازمند جبران</span>}</td><td>{submission.result?.flags.length ? <span className="badge badge-warning">{faNumber(submission.result.flags.length)} مورد</span> : <span className="text-muted">—</span>}</td><td><SubmissionStatusBadge status={submission.status} /></td><td><div className="report-row-actions"><button className="icon-button btn-icon-small" onClick={() => printStudentReport(currentExam, submission)} title="چاپ کارنامه"><Printer size={14} /></button><Link className="row-action" href={`/review?exam=${currentExam.id}&submission=${submission.id}`} title="مشاهدهٔ برگه"><ArrowUpLeft size={15} /></Link></div></td></tr>)}</tbody></table></div>
      </section>
      <div className="report-method-note"><Award size={15} /><p>این گزارش برای تصمیم‌گیری آموزشی است؛ اعتماد مدل و نرخ قبولی به‌تنهایی معیار کیفیت تصحیح نیستند. نتایج مهم را با نمونه‌برداری انسانی و پاسخ اصلی ارزیابی کنید.</p></div>
    </div>
  );
}
