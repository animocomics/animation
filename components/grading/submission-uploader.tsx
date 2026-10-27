"use client";

import { type ChangeEvent, type DragEvent, useRef, useState } from "react";
import {
  FileImage,
  FilePlus2,
  FileText,
  LoaderCircle,
  Paperclip,
  Plus,
  Trash2,
  UploadCloud,
  UserPlus,
  UsersRound,
  X,
} from "lucide-react";
import { useApp } from "../../lib/app-context";
import { deleteStoredFile, getStoredFile, storeFile } from "../../lib/file-store";
import type { FileMeta, Submission } from "../../lib/types";
import { faNumber, formatBytes, uid } from "../../lib/utils";

const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
const MAX_FILE_SIZE = 15 * 1024 * 1024;

function fileType(file: File): string {
  if (ACCEPTED_TYPES.includes(file.type)) return file.type;
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "png") return "image/png";
  if (extension === "webp") return "image/webp";
  if (extension === "pdf") return "application/pdf";
  return file.type;
}

function nameFromFile(filename: string, index: number): string {
  const cleaned = filename
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\b(scan|page|answer|sheet|img|image)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || `دانش‌آموز ${index + 1}`;
}

export function SubmissionUploader({ submissions, onChange }: {
  submissions: Submission[];
  onChange: (submissions: Submission[]) => void;
}) {
  const { notify } = useApp();
  const [studentName, setStudentName] = useState("");
  const [studentCode, setStudentCode] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const bulkInput = useRef<HTMLInputElement>(null);

  const addStudent = () => {
    if (!studentName.trim()) {
      notify({ title: "نام دانش‌آموز را وارد کنید", variant: "error" });
      return;
    }
    const submission: Submission = {
      id: uid("submission"),
      studentName: studentName.trim(),
      studentCode: studentCode.trim(),
      files: [],
      status: "uploaded",
      identitySource: "manual",
      identityStatus: "manual",
      audit: [{ id: uid("audit"), at: new Date().toISOString(), actor: "teacher", action: "افزودن دانش‌آموز", details: "دانش‌آموز به فهرست تصحیح اضافه شد." }],
    };
    onChange([...submissions, submission]);
    setStudentName("");
    setStudentCode("");
  };

  const processFiles = async (files: File[], submissionId?: string) => {
    if (!files.length) return;
    setBusy(true);
    const validFiles: Array<{ file: File; type: string }> = [];
    for (const file of files) {
      const type = fileType(file);
      if (!ACCEPTED_TYPES.includes(type)) {
        notify({ title: `فرمت ${file.name} پشتیبانی نمی‌شود`, description: "فقط JPG، PNG، WebP و PDF وارد کنید.", variant: "error" });
        continue;
      }
      if (file.size > MAX_FILE_SIZE) {
        notify({ title: `فایل ${file.name} بزرگ‌تر از ۱۵ مگابایت است`, description: "آن را فشرده کنید یا صفحات را جدا کنید.", variant: "error" });
        continue;
      }
      validFiles.push({ file, type });
    }

    try {
      if (submissionId) {
        const target = submissions.find((submission) => submission.id === submissionId);
        if (!target) return;
        const metas: FileMeta[] = [];
        for (const { file, type } of validFiles) {
          const id = uid("file");
          await storeFile(id, file);
          metas.push({ id, storedId: id, name: file.name, type, size: file.size });
        }
        onChange(submissions.map((submission) => submission.id === submissionId ? {
          ...submission,
          files: [...submission.files, ...metas],
          status: "uploaded",
          result: undefined,
          error: undefined,
        } : submission));
      } else {
        const newSubmissions: Submission[] = [];
        for (const [index, { file, type }] of validFiles.entries()) {
          const id = uid("file");
          await storeFile(id, file);
          newSubmissions.push({
            id: uid("submission"),
            studentName: nameFromFile(file.name, submissions.length + index),
            studentCode: "",
            files: [{ id, storedId: id, name: file.name, type, size: file.size }],
            status: "uploaded",
            identitySource: "filename",
            audit: [{ id: uid("audit"), at: new Date().toISOString(), actor: "teacher", action: "بارگذاری برگه", details: `فایل ${file.name} بارگذاری شد.` }],
          });
        }
        onChange([...submissions, ...newSubmissions]);
      }
      if (validFiles.length) notify({ title: "برگه‌ها آماده شد", description: `${faNumber(validFiles.length)} فایل در فضای امن حساب شما روی سرور ذخیره شد.`, variant: "success" });
    } catch (error) {
      notify({ title: "ذخیرهٔ فایل ناموفق بود", description: error instanceof Error ? error.message : "لطفاً دوباره تلاش کنید.", variant: "error" });
    } finally {
      setBusy(false);
      if (bulkInput.current) bulkInput.current.value = "";
    }
  };

  const onBulkInput = (event: ChangeEvent<HTMLInputElement>) => processFiles(Array.from(event.target.files ?? []));
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    processFiles(Array.from(event.dataTransfer.files));
  };

  const updateStudent = (id: string, patch: Partial<Submission>) => {
    const identityEdited = "studentName" in patch || "studentCode" in patch;
    onChange(submissions.map((submission) => submission.id === id ? { ...submission, ...patch, ...(identityEdited ? { studentId: undefined, identitySource: "manual" as const, identityStatus: "manual" as const, identityMessage: "انتساب دستی؛ پس از تصحیح با نام روی برگه کنترل می‌شود." } : {}) } : submission));
  };

  const removeSubmission = async (submission: Submission) => {
    onChange(submissions.filter((item) => item.id !== submission.id));
    await Promise.allSettled(submission.files.map((file) => deleteStoredFile(file.storedId)));
  };

  const removeFile = async (submissionId: string, file: FileMeta) => {
    const target = submissions.find((submission) => submission.id === submissionId);
    if (!target) return;
    updateStudent(submissionId, { files: target.files.filter((item) => item.id !== file.id), status: "uploaded", result: undefined });
    await deleteStoredFile(file.storedId);
  };

  const previewFile = async (file: FileMeta) => {
    const stored = await getStoredFile(file.storedId);
    if (!stored) {
      notify({ title: "فایل روی سرور پیدا نشد", description: "دوباره آن را بارگذاری کنید.", variant: "error" });
      return;
    }
    const url = URL.createObjectURL(stored.blob);
    window.open(url, "_blank", "noopener,noreferrer");
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  return (
    <div className="submission-uploader">
      <div className="upload-layout">
        <div
          className={`bulk-dropzone ${dragActive ? "drag-active" : ""}`}
          onDragOver={(event) => { event.preventDefault(); setDragActive(true); }}
          onDragLeave={() => setDragActive(false)}
          onDrop={onDrop}
        >
          <input ref={bulkInput} type="file" accept=".jpg,.jpeg,.png,.webp,.pdf" multiple hidden onChange={onBulkInput} />
          <span className="upload-illustration"><UploadCloud size={29} /></span>
          <h3>برگه‌ها را اینجا رها کنید</h3>
          <p>عکس JPG، PNG، WebP یا PDF · حداکثر ۱۵ مگابایت برای هر فایل</p>
          <button className="btn btn-primary" disabled={busy} onClick={() => bulkInput.current?.click()}>{busy ? <LoaderCircle className="spin-icon" size={17} /> : <FilePlus2 size={17} />}{busy ? "در حال ذخیره…" : "انتخاب فایل‌ها"}</button>
          <span className="bulk-upload-note">در بارگذاری گروهی هر فایل یک برگه می‌شود؛ نام و کلاس هنگام تصحیح از روی برگه خوانده و با فهرست تطبیق داده خواهد شد.</span>
        </div>
        <aside className="add-student-panel">
          <span className="add-student-icon"><UserPlus size={22} /></span>
          <h3>یا دانش‌آموز را جدا اضافه کنید</h3>
          <p>برای چند عکس یا چند فایل متعلق به یک نفر، ابتدا دانش‌آموز را بسازید.</p>
          <div className="form-field"><label htmlFor="new-student-name">نام و نام خانوادگی</label><input id="new-student-name" className="input" value={studentName} onChange={(event) => setStudentName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") addStudent(); }} placeholder="مثلاً سارا محمدی" /></div>
          <div className="form-field"><label htmlFor="new-student-code">کد دانش‌آموزی <span className="optional-label">اختیاری</span></label><input id="new-student-code" className="input" value={studentCode} onChange={(event) => setStudentCode(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") addStudent(); }} placeholder="مثلاً ۹۸۱۲۴" /></div>
          <button className="btn btn-secondary" onClick={addStudent}><Plus size={16} />افزودن به فهرست</button>
        </aside>
      </div>

      <div className="submission-list-section">
        <div className="submission-list-heading"><div><h3>فهرست برگه‌ها</h3><p>نام فایل‌ها را بررسی کنید؛ برگهٔ هر دانش‌آموز نباید با دیگری مخلوط شود.</p></div><span className="badge badge-neutral"><UsersRound size={13} />{faNumber(submissions.length)} دانش‌آموز · {faNumber(submissions.reduce((sum, submission) => sum + submission.files.length, 0))} فایل</span></div>
        {submissions.length ? <div className="submission-upload-list">{submissions.map((submission, index) => (
          <article className={`submission-upload-card ${!submission.files.length ? "missing-files" : ""}`} key={submission.id}>
            <div className="submission-order">{faNumber(index + 1)}</div>
            <div className="submission-identity-fields">
              <input className="input" value={submission.studentName} onChange={(event) => updateStudent(submission.id, { studentName: event.target.value })} aria-label={`نام دانش‌آموز ${index + 1}`} />
              <input className="input" value={submission.studentCode} onChange={(event) => updateStudent(submission.id, { studentCode: event.target.value })} placeholder="کد دانش‌آموزی" aria-label={`کد دانش‌آموز ${index + 1}`} />
            </div>
            <div className="submission-file-area">
              {submission.files.map((file) => <div className="uploaded-file-chip" key={file.id}>
                <button type="button" className="file-chip-main" onClick={() => previewFile(file)} title="مشاهدهٔ فایل">
                  {file.type === "application/pdf" ? <FileText size={17} /> : <FileImage size={17} />}
                  <span><strong>{file.name}</strong><small>{formatBytes(file.size)}</small></span>
                </button>
                <button className="file-chip-remove" onClick={() => removeFile(submission.id, file)} aria-label={`حذف ${file.name}`}><X size={14} /></button>
              </div>)}
              <label className="add-page-button"><Paperclip size={15} /><span>{submission.files.length ? "افزودن صفحه / فایل" : "انتخاب برگه"}</span><input type="file" hidden multiple accept=".jpg,.jpeg,.png,.webp,.pdf" onChange={(event) => { processFiles(Array.from(event.target.files ?? []), submission.id); event.target.value = ""; }} /></label>
            </div>
            <div className="submission-card-status">{submission.result ? <span className="badge badge-success">تصحیح‌شده</span> : submission.files.length ? <span className="badge badge-info">آمادهٔ تصحیح</span> : <span className="badge badge-warning">{submission.identitySource === "roster" ? "برگه مفقود" : "فایل لازم است"}</span>}<button className="icon-button btn-icon-small danger-hover" onClick={() => removeSubmission(submission)} aria-label={`حذف ${submission.studentName}`}><Trash2 size={15} /></button></div>
          </article>
        ))}</div> : <div className="submission-list-empty"><UsersRound size={25} /><span>هنوز برگه‌ای اضافه نشده است.</span></div>}
      </div>
    </div>
  );
}
