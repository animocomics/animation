"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  BookOpen,
  CalendarDays,
  ChevronLeft,
  Copy,
  FileQuestion,
  FileStack,
  MoreHorizontal,
  Plus,
  Search,
  Trash2,
  UsersRound,
} from "lucide-react";
import { useApp } from "../lib/app-context";
import { deleteStoredFile } from "../lib/file-store";
import type { Exam } from "../lib/types";
import { examAverage, faDate, faNumber, totalExamScore, uid } from "../lib/utils";
import { ExamStatusBadge, Modal } from "./ui/primitives";

export function ExamsList() {
  const { exams, deleteExam, saveExam, notify } = useApp();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | Exam["status"]>("all");
  const [deleteTarget, setDeleteTarget] = useState<Exam | null>(null);

  const filtered = useMemo(() => exams.filter((exam) => {
    const matchesQuery = `${exam.title} ${exam.subject} ${exam.className} ${exam.code || ""}`.includes(query.trim());
    const matchesFilter = filter === "all" || exam.status === filter;
    return matchesQuery && matchesFilter;
  }), [exams, query, filter]);

  const duplicateExam = (exam: Exam) => {
    const idMap = new Map<string, string>();
    const questions = exam.questions.map((question) => {
      const id = uid("question");
      idMap.set(question.id, id);
      return {
        ...question,
        id,
        rubric: question.rubric.map((criterion) => ({ ...criterion, id: uid("rubric") })),
      };
    });
    saveExam({
      ...exam,
      id: uid("exam"),
      title: `${exam.title} · نسخهٔ کپی`,
      code: `${exam.code || "EX"}-COPY-${Date.now().toString(36).slice(-4).toUpperCase()}`,
      status: "draft",
      submissions: [],
      questions,
      isDemo: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    notify({ title: "کپی آزمون ساخته شد", description: "سؤال‌ها و بارم کپی شدند؛ برگه‌ها کپی نمی‌شوند.", variant: "success" });
  };

  const removeExam = async () => {
    if (!deleteTarget) return;
    await Promise.allSettled(deleteTarget.submissions.flatMap((submission) => submission.files.map((file) => deleteStoredFile(file.storedId))));
    deleteExam(deleteTarget.id);
    setDeleteTarget(null);
    notify({ title: "آزمون و فایل‌هایش حذف شد", variant: "success" });
  };

  return (
    <div className="exams-page">
      <section className="page-heading-row">
        <div><h2>آزمون‌ها و برگه‌ها</h2><p>هر آزمون با سؤال‌ها، بارم و نتایجش در یک جا.</p></div>
        <Link href="/grading" className="btn btn-primary"><Plus size={18} /> ساخت آزمون جدید</Link>
      </section>
      <section className="exam-toolbar card">
        <div className="exam-tabs" role="tablist" aria-label="فیلتر وضعیت">
          {([
            ["all", "همه"], ["review", "در بازبینی"], ["ready", "آماده"], ["draft", "پیش‌نویس"], ["completed", "تکمیل‌شده"],
          ] as const).map(([value, label]) => (
            <button key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)} role="tab" aria-selected={filter === value}>{label}{value === "all" && <span>{faNumber(exams.length)}</span>}</button>
          ))}
        </div>
        <div className="input-with-icon exam-search"><Search size={17} /><input className="input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="جست‌وجوی درس، عنوان یا کلاس…" aria-label="جست‌وجوی آزمون" /></div>
      </section>

      {filtered.length ? (
        <section className="exam-cards-grid">
          {filtered.map((exam) => {
            const graded = exam.submissions.filter((submission) => submission.result).length;
            const approved = exam.submissions.filter((submission) => submission.status === "approved").length;
            const paperCount = exam.submissions.filter((submission) => submission.files.length > 0 || submission.result).length;
            const missingCount = exam.submissions.length - paperCount;
            const progress = exam.submissions.length ? (approved / exam.submissions.length) * 100 : 0;
            return (
              <article className="card exam-card" key={exam.id}>
                <div className="exam-card-accent" />
                <div className="exam-card-header">
                  <span className={`exam-card-icon subject-${exam.subject.length % 4}`}><BookOpen size={22} /></span>
                  <div className="exam-card-badges"><ExamStatusBadge status={exam.status} />{exam.isDemo && <span className="badge demo-badge">دادهٔ نمایشی</span>}</div>
                  <div className="exam-card-menu"><MoreHorizontal size={19} /></div>
                </div>
                <Link href={`/exams/${exam.id}`} className="exam-card-title"><h3>{exam.title}</h3><p>{exam.subject} · {exam.className}{exam.code && <span dir="ltr"> · {exam.code}</span>}</p></Link>
                <div className="exam-card-meta">
                  <span><CalendarDays size={15} />{faDate(exam.date, { day: "numeric", month: "long" })}</span>
                  <span><FileQuestion size={15} />{faNumber(exam.questions.length)} سؤال · {faNumber(totalExamScore(exam))} نمره</span>
                  <span><UsersRound size={15} />{faNumber(paperCount)} برگه{missingCount > 0 && <span className="text-warning"> · {faNumber(missingCount)} مفقود</span>}</span>
                </div>
                {exam.submissions.length > 0 ? (
                  <div className="exam-card-progress">
                    <div><span>پیشرفت تأیید نمره‌ها</span><strong>{faNumber(progress, 0)}٪</strong></div>
                    <div className="progress-track"><div className="progress-fill" style={{ width: `${progress}%` }} /></div>
                    <small>{faNumber(graded)} تصحیح‌شده · میانگین {faNumber(examAverage(exam), 0)}٪</small>
                  </div>
                ) : (
                  <div className="exam-card-no-submission"><FileStack size={17} /><span>هنوز برگه‌ای بارگذاری نشده است</span></div>
                )}
                <div className="exam-card-footer">
                  <Link href={exam.submissions.length ? `/exams/${exam.id}` : `/grading?exam=${exam.id}`} className="btn btn-soft btn-sm">{exam.submissions.length ? "مشاهدهٔ نتایج" : "افزودن برگه"}<ChevronLeft size={14} /></Link>
                  <div>
                    <button className="icon-button btn-icon-small" onClick={() => duplicateExam(exam)} title="کپی آزمون" aria-label={`کپی ${exam.title}`}><Copy size={15} /></button>
                    <button className="icon-button btn-icon-small danger-hover" onClick={() => setDeleteTarget(exam)} title="حذف آزمون" aria-label={`حذف ${exam.title}`}><Trash2 size={15} /></button>
                  </div>
                </div>
              </article>
            );
          })}
        </section>
      ) : (
        <section className="card empty-state">
          <span className="empty-icon"><Search size={26} /></span>
          <h3>آزمونی با این مشخصات پیدا نشد</h3>
          <p>عبارت جست‌وجو یا فیلتر وضعیت را تغییر دهید.</p>
          <button className="btn btn-secondary" onClick={() => { setQuery(""); setFilter("all"); }}>پاک‌کردن فیلترها</button>
        </section>
      )}

      {deleteTarget && (
        <Modal title="حذف آزمون" description="این کار قابل بازگشت نیست." onClose={() => setDeleteTarget(null)} footer={<><button className="btn btn-secondary" onClick={() => setDeleteTarget(null)}>انصراف</button><button className="btn btn-danger-soft" onClick={() => void removeExam()}><Trash2 size={16} /> حذف آزمون</button></>}>
          <div className="notice notice-danger"><Trash2 size={19} /><div><strong>{deleteTarget.title}</strong><p>سؤال‌ها، بارم و نتایج ثبت‌شدهٔ این آزمون از فضای کاری این حساب حذف می‌شوند. فایل‌های ارسال‌شده به Provider از طریق این بخش حذف نمی‌شوند.</p></div></div>
        </Modal>
      )}
    </div>
  );
}
