"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { type FormEvent, useMemo, useRef, useState } from "react";
import { AlertCircle, ArrowLeft, BarChart3, BookOpenCheck, CheckCircle2, ChevronLeft, CircleAlert, Download, Edit3, FileSpreadsheet, FileUp, Flag, FolderPlus, GraduationCap, ListChecks, Plus, Search, Trash2, UserPlus, UsersRound, X } from "lucide-react";
import { useApp } from "@/lib/app-context";
import { createCsv } from "@/lib/csv";
import { parseRosterCsv, populateRosterSubmissions } from "@/lib/roster";
import type { Exam, SchoolClass, Student, Submission } from "@/lib/types";
import { average, downloadBlob, faNumber, normalizeAnswer, totalExamScore, uid } from "@/lib/utils";

const emptyClass = (): SchoolClass => ({ id: uid("class"), name: "", grade: "", subject: "", academicYear: "۱۴۰۵–۱۴۰۶", students: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

function examForStudent(exam: Exam, student: Student): Submission | undefined {
  const assigned = exam.submissions.find((submission) => submission.studentId === student.id);
  if (assigned) return assigned;
  return exam.submissions.find((submission) => {
    if (submission.studentId || ["ambiguous", "unmatched"].includes(submission.identityStatus || "")) return false;
    const sameCode = Boolean(student.code) && normalizeAnswer(submission.studentCode) === normalizeAnswer(student.code);
    const sameName = normalizeAnswer(submission.studentName) === normalizeAnswer(student.name);
    return sameCode || sameName;
  });
}

export function ClassManager() {
  const { classes, exams, saveClass, deleteClass, saveExam, notify } = useApp();
  const searchParams = useSearchParams();
  const [selectedId, setSelectedId] = useState(searchParams.get("class") ?? "");
  const requestedTab = searchParams.get("tab");
  const [tab, setTab] = useState<"roster" | "gradebook" | "report">(requestedTab === "report" || requestedTab === "gradebook" ? requestedTab : "roster");
  const [query, setQuery] = useState("");
  const [editingClass, setEditingClass] = useState<SchoolClass | null>(null);
  const [studentForm, setStudentForm] = useState({ name: "", code: "" });
  const [importBusy, setImportBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const selectedClass = classes.find((item) => item.id === selectedId) ?? classes[0];
  const classExams = useMemo(() => selectedClass ? exams.filter((exam) => exam.classId === selectedClass.id || (!exam.classId && exam.className === selectedClass.name)).sort((a, b) => a.date.localeCompare(b.date)) : [], [exams, selectedClass]);
  const filteredStudents = selectedClass?.students.filter((student) => `${student.name} ${student.code}`.includes(query.trim())) ?? [];

  const report = useMemo(() => {
    if (!selectedClass) return null;
    const rows = selectedClass.students.filter((student) => student.active).map((student) => {
      const cells = classExams.map((exam) => ({ exam, submission: examForStudent(exam, student) }));
      const results = cells.map((cell) => cell.submission?.result).filter(Boolean);
      return { student, cells, average: average(results.map((result) => result!.percentage)), graded: results.length, missing: cells.filter((cell) => !cell.submission?.result).length, review: cells.filter((cell) => cell.submission?.status === "needs_review" || cell.submission?.identityStatus === "ambiguous" || cell.submission?.identityStatus === "unmatched").length };
    });
    const examStats = classExams.map((exam) => {
      const linked = new Map<string, Submission>();
      selectedClass.students.filter((student) => student.active).forEach((student) => {
        const submission = examForStudent(exam, student);
        if (submission) linked.set(submission.id, submission);
      });
      const results = [...linked.values()].map((submission) => submission.result).filter(Boolean);
      return { exam, average: average(results.map((result) => result!.percentage)), graded: results.length, review: exam.submissions.filter((submission) => submission.status === "needs_review" || ["ambiguous", "unmatched", "missing"].includes(submission.identityStatus || "")).length };
    });
    return { rows, examStats, average: average(examStats.map((item) => item.average).filter((_, index) => examStats[index].graded > 0)), missing: rows.reduce((sum, row) => sum + row.missing, 0), review: rows.reduce((sum, row) => sum + row.review, 0) };
  }, [classExams, selectedClass]);

  function saveClassForm(event: FormEvent) {
    event.preventDefault();
    if (!editingClass?.name.trim()) return;
    if (classes.some((item) => item.id !== editingClass.id && normalizeAnswer(item.name) === normalizeAnswer(editingClass.name))) {
      notify({ title: "نام کلاس تکراری است", description: "برای جلوگیری از خطای تطبیق، نام یکتایی انتخاب کنید.", variant: "error" }); return;
    }
    saveClass({ ...editingClass, name: editingClass.name.trim() });
    setSelectedId(editingClass.id); setEditingClass(null);
    notify({ title: "کلاس ذخیره شد", description: "فهرست دانش‌آموزان را اضافه یا از CSV وارد کنید.", variant: "success" });
  }

  function addStudent(event: FormEvent) {
    event.preventDefault();
    if (!selectedClass || !studentForm.name.trim()) return;
    if (studentForm.code && selectedClass.students.some((student) => normalizeAnswer(student.code) === normalizeAnswer(studentForm.code))) {
      notify({ title: "کد دانش‌آموزی تکراری است", description: "هر دانش‌آموز باید کد یکتا داشته باشد.", variant: "error" }); return;
    }
    const student: Student = { id: uid("student"), name: studentForm.name.trim(), code: studentForm.code.trim(), active: true };
    saveClass({ ...selectedClass, students: [...selectedClass.students, student] });
    setStudentForm({ name: "", code: "" });
  }

  async function importRoster(file: File) {
    if (!selectedClass) return;
    setImportBusy(true);
    try {
      const entries = parseRosterCsv(await file.text());
      if (!entries.length) throw new Error("ردیف معتبری پیدا نشد؛ ستون‌های نام و کد دانش‌آموزی را بررسی کنید.");
      const existing = new Set(selectedClass.students.map((student) => normalizeAnswer(student.code || student.name)));
      const seen = new Set<string>();
      const additions: Student[] = [];
      for (const entry of entries) {
        const key = normalizeAnswer(entry.code || entry.name);
        if (existing.has(key) || seen.has(key)) continue;
        seen.add(key); additions.push({ id: uid("student"), name: entry.name, code: entry.code, active: true });
      }
      saveClass({ ...selectedClass, students: [...selectedClass.students, ...additions] });
      notify({ title: "فهرست کلاس وارد شد", description: `${faNumber(additions.length)} دانش‌آموز اضافه و ${faNumber(entries.length - additions.length)} ردیف تکراری نادیده گرفته شد.`, variant: "success" });
    } catch (error) { notify({ title: "ورود فهرست ناموفق بود", description: error instanceof Error ? error.message : "فایل را بررسی کنید.", variant: "error" }); }
    finally { setImportBusy(false); if (fileInput.current) fileInput.current.value = ""; }
  }

  function updateStudent(studentId: string, patch: Partial<Student>) {
    if (!selectedClass) return;
    saveClass({ ...selectedClass, students: selectedClass.students.map((student) => student.id === studentId ? { ...student, ...patch } : student) });
  }

  function removeClass() {
    if (!selectedClass) return;
    if (classExams.length) { notify({ title: "کلاس دارای آزمون است", description: "ابتدا آزمون‌های مرتبط را به کلاس دیگری منتقل کنید تا کارنامه‌ها از دست نروند.", variant: "error" }); return; }
    if (!window.confirm(`کلاس «${selectedClass.name}» و فهرست دانش‌آموزانش حذف شود؟`)) return;
    deleteClass(selectedClass.id); setSelectedId("");
  }

  function populateGradebooks() {
    if (!selectedClass) return;
    if (!classExams.length) { notify({ title: "هنوز آزمونی برای این کلاس نیست", description: "از مسیر تصحیح جدید، آزمون را به این کلاس متصل کنید.", variant: "info" }); return; }
    classExams.forEach((exam) => saveExam({ ...exam, submissions: populateRosterSubmissions(exam, selectedClass) }));
    notify({ title: "کارنامه‌ها به‌روز شد", description: "نمره‌های موجود وارد شد و ردیف برگه‌های مفقود با هشدار ساخته شد.", variant: "success" });
  }

  function exportClass() {
    if (!selectedClass || !report) return;
    const header = ["نام دانش‌آموز", "کد", ...classExams.map((exam) => `${exam.title} (${exam.code || "بدون کد"}) - درصد`), "میانگین", "موارد مفقود", "نیازمند بازبینی"];
    const lines = report.rows.map((row) => [row.student.name, row.student.code, ...row.cells.map((cell) => cell.submission?.result?.percentage ?? ""), row.graded ? row.average.toFixed(1) : "", row.missing, row.review]);
    const csv = createCsv([header, ...lines]);
    downloadBlob(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }), `کارنامه-${selectedClass.name}.csv`);
    notify({ title: "کارنامهٔ تجمیعی دانلود شد", description: "نمره‌ها و وضعیت موارد مفقود در CSV قرار گرفت.", variant: "success" });
  }

  if (!classes.length && !editingClass) return <>
    <section className="card empty-state classes-empty"><span className="empty-icon"><UsersRound size={30} /></span><h3>نخستین کلاس خود را بسازید</h3><p>فهرست دانش‌آموزان پایهٔ تطبیق هویت، ثبت خودکار نمره و گزارش‌های تجمیعی است.</p><button className="btn btn-primary" onClick={() => setEditingClass(emptyClass())}><FolderPlus size={17} /> ساخت کلاس</button></section>
    {editingClass && null}
  </>;

  return <div className="classes-page">
    <section className="page-heading-row"><div><div className="eyebrow"><span />ساختار آموزشی</div><h2>کلاس‌ها و دانش‌آموزان شما</h2><p>کلاس بسازید، نام دانش‌آموزان را خودتان وارد کنید و کارنامه‌ها را در فضای مستقل خود نگه دارید.</p></div><button className="btn btn-primary" onClick={() => setEditingClass(emptyClass())}><Plus size={17} /> کلاس جدید</button></section>
    <div className="classes-layout">
      <aside className="card class-list-panel"><div className="class-list-heading"><strong>کلاس‌های من</strong><span>{faNumber(classes.length)}</span></div><div className="class-list">{classes.map((schoolClass) => <button key={schoolClass.id} className={selectedClass?.id === schoolClass.id ? "active" : ""} onClick={() => { setSelectedId(schoolClass.id); setQuery(""); }}><span className="class-list-icon"><GraduationCap size={19} /></span><span><strong>{schoolClass.name}</strong><small>{faNumber(schoolClass.students.filter((student) => student.active).length)} دانش‌آموز · {schoolClass.academicYear}</small></span><ChevronLeft size={15} /></button>)}</div><div className="class-list-note"><ListChecks size={16} /><p>فهرست کلاس فقط در فضای کاری شما ذخیره و برای تطبیق برگه‌ها استفاده می‌شود.</p></div></aside>

      {selectedClass && report && <main className="class-main">
        <section className="card class-header-card"><div><span className="class-hero-icon"><BookOpenCheck size={25} /></span><div><div className="class-title-line"><h2>{selectedClass.name}</h2><span className="badge badge-success">{faNumber(selectedClass.students.filter((student) => student.active).length)} دانش‌آموز</span></div><p>{[selectedClass.grade, selectedClass.subject, selectedClass.academicYear].filter(Boolean).join(" · ")}</p></div></div><div className="class-header-actions"><button className="btn btn-secondary btn-sm" onClick={() => setEditingClass({ ...selectedClass })}><Edit3 size={15} /> ویرایش</button><button className="icon-button danger-icon" onClick={removeClass} title="حذف کلاس" aria-label="حذف کلاس"><Trash2 size={17} /></button></div></section>
        <div className="class-tabs" role="tablist"><button role="tab" aria-selected={tab === "roster"} className={tab === "roster" ? "active" : ""} onClick={() => setTab("roster")}><UsersRound size={16} /> فهرست دانش‌آموزان</button><button role="tab" aria-selected={tab === "gradebook"} className={tab === "gradebook" ? "active" : ""} onClick={() => setTab("gradebook")}><FileSpreadsheet size={16} /> کارنامهٔ آزمون‌ها</button><button role="tab" aria-selected={tab === "report"} className={tab === "report" ? "active" : ""} onClick={() => setTab("report")}><BarChart3 size={16} /> گزارش تجمیعی</button></div>

        {tab === "roster" && <section className="card roster-card">
          <div className="roster-toolbar"><form className="add-student-form" onSubmit={addStudent}><input className="input" aria-label="نام دانش‌آموز" required placeholder="نام و نام‌خانوادگی" value={studentForm.name} onChange={(event) => setStudentForm({ ...studentForm, name: event.target.value })} /><input className="input" aria-label="کد دانش‌آموزی" dir="ltr" placeholder="کد دانش‌آموزی" value={studentForm.code} onChange={(event) => setStudentForm({ ...studentForm, code: event.target.value })} /><button className="btn btn-primary"><UserPlus size={16} /> افزودن</button></form><input ref={fileInput} type="file" hidden accept=".csv,.txt,.tsv" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importRoster(file); }} /><button className="btn btn-secondary" disabled={importBusy} onClick={() => fileInput.current?.click()}><FileUp size={16} /> ورود CSV / Excel</button></div>
          <div className="roster-subtoolbar"><div className="input-with-icon"><Search size={15} /><input className="input" placeholder="جست‌وجوی نام یا کد…" value={query} onChange={(event) => setQuery(event.target.value)} /></div><button className="btn btn-ghost btn-sm" onClick={() => downloadBlob(new Blob(["\uFEFFنام و نام خانوادگی,کد دانش‌آموزی\r\nنمونه دانش‌آموز,140501"], { type: "text/csv;charset=utf-8" }), "الگوی-فهرست-کلاس.csv")}><Download size={14} /> دانلود الگو</button><span>در CSV فارسی، ستون اول نام و ستون دوم کد است؛ سطر هدر نیز پشتیبانی می‌شود.</span></div>
          <div className="table-wrap"><table className="data-table roster-table"><thead><tr><th>#</th><th>دانش‌آموز</th><th>کد دانش‌آموزی</th><th>وضعیت</th><th>حذف</th></tr></thead><tbody>{filteredStudents.map((student, index) => <tr key={student.id}><td>{faNumber(index + 1)}</td><td><input className="table-inline-input" aria-label={`نام ${student.name}`} value={student.name} onChange={(event) => updateStudent(student.id, { name: event.target.value })} /></td><td><input className="table-inline-input student-code-input" aria-label={`کد ${student.name}`} dir="ltr" value={student.code} onChange={(event) => updateStudent(student.id, { code: event.target.value })} /></td><td><button className={`badge ${student.active ? "badge-success" : "badge-neutral"}`} onClick={() => updateStudent(student.id, { active: !student.active })}>{student.active ? "فعال" : "غیرفعال"}</button></td><td><button className="icon-button btn-icon-small danger-icon" aria-label={`حذف ${student.name}`} onClick={() => updateStudent(student.id, { active: false })}><Trash2 size={15} /></button></td></tr>)}</tbody></table>{!filteredStudents.length && <div className="roster-empty"><UsersRound size={26} /><p>{selectedClass.students.length ? "دانش‌آموزی با این جست‌وجو پیدا نشد." : "فهرست خالی است؛ دانش‌آموز را دستی یا با CSV اضافه کنید."}</p></div>}</div>
        </section>}

        {tab === "gradebook" && <section className="card gradebook-card"><div className="admin-section-heading"><div><h3>کارنامهٔ خودکار آزمون‌ها</h3><p>ردیف‌های مفقود و نتایج نیازمند توجه از فهرست کلاس ساخته می‌شوند.</p></div><div className="gradebook-actions"><button className="btn btn-secondary" onClick={populateGradebooks}><RefreshCwIcon /> به‌روزرسانی ردیف‌ها</button><button className="btn btn-primary" onClick={exportClass}><Download size={16} /> خروجی CSV</button></div></div>
          {!classExams.length ? <div className="admin-empty"><FileSpreadsheet size={34} /><h3>آزمونی به این کلاس متصل نیست</h3><p>هنگام ساخت آزمون، همین کلاس را انتخاب کنید تا کارنامهٔ آن اینجا ساخته شود.</p><Link href="/grading" className="btn btn-primary">ساخت آزمون <ArrowLeft size={15} /></Link></div> : <div className="table-scroll"><table className="admin-table gradebook-table"><thead><tr><th>دانش‌آموز</th>{classExams.map((exam) => <th key={exam.id}><Link href={`/reports?exam=${exam.id}`}>{exam.title}<small dir="ltr">{exam.code || "بدون کد"}</small></Link></th>)}<th>میانگین</th><th>توجه</th></tr></thead><tbody>{report.rows.map((row) => <tr key={row.student.id}><td><strong>{row.student.name}</strong><small className="table-subline" dir="ltr">{row.student.code}</small></td>{row.cells.map(({ exam, submission }) => <td key={exam.id}>{submission?.result ? <Link className={`grade-cell ${submission.status === "needs_review" ? "review" : ""}`} href={`/review?exam=${exam.id}&submission=${submission.id}`}><strong>{faNumber(submission.result.totalScore)}<small> / {faNumber(totalExamScore(exam))}</small></strong><span>{faNumber(submission.result.percentage)}٪</span>{submission.status === "needs_review" && <Flag size={12} />}</Link> : <span className="grade-cell missing" title={submission?.identityMessage || "برگه یا نتیجه‌ای ثبت نشده"}><AlertCircle size={15} /><span>{submission?.status === "processing" ? "در حال تصحیح" : "مفقود"}</span></span>}</td>)}<td><strong className="class-average">{row.graded ? `${faNumber(row.average)}٪` : "—"}</strong><small className="table-subline">{faNumber(row.graded)} از {faNumber(classExams.length)} آزمون</small></td><td>{row.review ? <span className="badge badge-warning"><Flag size={12} /> {faNumber(row.review)} بازبینی</span> : row.missing ? <span className="badge badge-danger">{faNumber(row.missing)} مفقود</span> : <span className="badge badge-success"><CheckCircle2 size={12} /> کامل</span>}</td></tr>)}</tbody></table></div>}
          {classExams.some((exam) => exam.submissions.some((submission) => ["ambiguous", "unmatched"].includes(submission.identityStatus || ""))) && <div className="identity-alert"><CircleAlert size={18} /><div><strong>برگه‌های بدون انتساب قطعی وجود دارد</strong><p>این برگه‌ها عمداً وارد ردیف دانش‌آموز نشده‌اند. از صفحهٔ بازبینی، نام درست را تأیید کنید.</p></div></div>}
        </section>}

        {tab === "report" && <div className="class-report-view">
          <div className="report-stats-grid"><article className="card report-stat"><span className="report-stat-icon mint"><BarChart3 size={20} /></span><div><span>میانگین تجمیعی کلاس</span><strong>{faNumber(report.average)}<small>٪</small></strong><small>در آزمون‌های دارای نتیجه</small></div></article><article className="card report-stat"><span className="report-stat-icon blue"><BookOpenCheck size={20} /></span><div><span>آزمون‌های کلاس</span><strong>{faNumber(classExams.length)}</strong><small>{faNumber(report.examStats.reduce((sum, item) => sum + item.graded, 0))} نتیجهٔ ثبت‌شده</small></div></article><article className="card report-stat"><span className="report-stat-icon amber"><Flag size={20} /></span><div><span>نیازمند بازبینی</span><strong>{faNumber(report.review)}</strong><small>در کارنامهٔ تجمیعی</small></div></article><article className="card report-stat"><span className="report-stat-icon violet"><AlertCircle size={20} /></span><div><span>نتیجهٔ مفقود</span><strong>{faNumber(report.missing)}</strong><small>برگه، انتساب یا تصحیح ناقص</small></div></article></div>
          <section className="card class-exam-performance"><div className="card-header"><div><h3 className="card-title">روند عملکرد بین آزمون‌ها</h3><p className="card-subtitle">میانگین درصد و پوشش تصحیح هر آزمون</p></div><button className="btn btn-secondary btn-sm" onClick={exportClass}><Download size={14} /> دریافت گزارش</button></div>{report.examStats.length ? <div className="exam-performance-list">{report.examStats.map((item) => <div key={item.exam.id}><div className="exam-performance-label"><span><strong>{item.exam.title}</strong><small dir="ltr">{item.exam.code || "بدون کد"}</small></span><b>{item.graded ? `${faNumber(item.average)}٪` : "بدون نتیجه"}</b></div><div className="question-bar-track"><div className={`question-bar-fill ${item.average < 60 ? "low" : item.average < 80 ? "medium" : ""}`} style={{ width: `${item.average}%` }} /></div><div className="exam-performance-meta"><span>{faNumber(item.graded)} نتیجه از {faNumber(selectedClass.students.filter((student) => student.active).length)} دانش‌آموز</span>{item.review > 0 && <span className="warning-text"><Flag size={12} /> {faNumber(item.review)} مورد توجه</span>}<Link href={`/reports?exam=${item.exam.id}`}>گزارش آزمون <ArrowLeft size={12} /></Link></div></div>)}</div> : <div className="admin-empty"><BarChart3 size={32} /><p>پس از اتصال آزمون‌ها، روند کلاس اینجا نمایش داده می‌شود.</p></div>}</section>
          <section className="card class-attention-list"><div className="card-header"><div><h3 className="card-title">دانش‌آموزان نیازمند پیگیری</h3><p className="card-subtitle">بر اساس نمره، غیبت در نتایج و وضعیت بازبینی</p></div></div>{report.rows.filter((row) => row.review > 0 || row.missing > 0 || (row.graded > 0 && row.average < 60)).length ? <div className="attention-student-grid">{report.rows.filter((row) => row.review > 0 || row.missing > 0 || (row.graded > 0 && row.average < 60)).map((row) => <div key={row.student.id}><span className="student-avatar">{row.student.name.charAt(0)}</span><p><strong>{row.student.name}</strong><small>{row.graded ? `میانگین ${faNumber(row.average)}٪` : "هنوز نمره‌ای ثبت نشده"}</small></p><span>{row.review > 0 && <i className="badge badge-warning">{faNumber(row.review)} بازبینی</i>}{row.missing > 0 && <i className="badge badge-danger">{faNumber(row.missing)} مفقود</i>}{row.graded > 0 && row.average < 60 && <i className="badge badge-neutral">نیازمند جبران</i>}</span></div>)}</div> : <div className="admin-empty compact"><CheckCircle2 size={28} /><p>مورد فوری برای پیگیری وجود ندارد.</p></div>}</section>
        </div>}
      </main>}
    </div>

    {editingClass && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditingClass(null); }}><div className="modal" role="dialog" aria-modal="true" aria-labelledby="class-form-title"><div className="modal-header"><div><h2 id="class-form-title">{classes.some((item) => item.id === editingClass.id) ? "ویرایش کلاس" : "ساخت کلاس جدید"}</h2><p>این اطلاعات برای تطبیق کلاس روی برگه و گزارش‌گیری استفاده می‌شود.</p></div><button className="icon-button" onClick={() => setEditingClass(null)} aria-label="بستن"><X size={19} /></button></div><form onSubmit={saveClassForm}><div className="modal-body form-grid"><div className="form-field full"><label htmlFor="class-name">نام کلاس</label><input id="class-name" className="input" required autoFocus value={editingClass.name} onChange={(event) => setEditingClass({ ...editingClass, name: event.target.value })} placeholder="مثلاً یازدهم تجربی · گروه الف" /></div><div className="form-field"><label htmlFor="class-grade">پایه</label><input id="class-grade" className="input" value={editingClass.grade} onChange={(event) => setEditingClass({ ...editingClass, grade: event.target.value })} placeholder="یازدهم" /></div><div className="form-field"><label htmlFor="class-subject">رشته / درس</label><input id="class-subject" className="input" value={editingClass.subject} onChange={(event) => setEditingClass({ ...editingClass, subject: event.target.value })} placeholder="تجربی" /></div><div className="form-field full"><label htmlFor="class-year">سال تحصیلی</label><input id="class-year" className="input" value={editingClass.academicYear} onChange={(event) => setEditingClass({ ...editingClass, academicYear: event.target.value })} /></div></div><div className="modal-footer"><button type="button" className="btn btn-secondary" onClick={() => setEditingClass(null)}>انصراف</button><button className="btn btn-primary"><CheckCircle2 size={16} /> ذخیرهٔ کلاس</button></div></form></div></div>}
  </div>;
}

function RefreshCwIcon() { return <ListChecks size={16} />; }
