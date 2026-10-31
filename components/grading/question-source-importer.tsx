"use client";

import { type ChangeEvent, type DragEvent, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Eye, FileImage, FileText, LoaderCircle, ScanText, Trash2, UploadCloud } from "lucide-react";
import { ACCEPTED_FILE_TYPES, MAX_FILE_SIZE_BYTES, MAX_FILE_SIZE_LABEL } from "../../lib/file-constraints";
import { deleteStoredFile, getStoredFile, storeFile } from "../../lib/file-store";
import { useApp } from "../../lib/app-context";
import type { Exam, QuestionSourceFile, QuestionSourceKind } from "../../lib/types";
import { faNumber, formatBytes, uid } from "../../lib/utils";

type ImportPatch = Partial<Pick<Exam, "questions" | "questionSources" | "questionsNeedReview" | "questionsImported" | "questionImportWarnings">>;

function fileType(file: File): string {
  if ((ACCEPTED_FILE_TYPES as readonly string[]).includes(file.type)) return file.type;
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "png") return "image/png";
  if (extension === "webp") return "image/webp";
  if (extension === "pdf") return "application/pdf";
  return file.type;
}

export function QuestionSourceImporter({ examId, sources, needsReview, imported, warnings, onChange, onBusyChange, beforeRead }: {
  examId: string;
  sources: QuestionSourceFile[];
  needsReview?: boolean;
  imported?: boolean;
  warnings?: string[];
  onChange: (patch: ImportPatch) => void;
  onBusyChange?: (busy: boolean) => void;
  beforeRead?: () => Promise<void>;
}) {
  const { notify } = useApp();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [errorDetails, setErrorDetails] = useState<string[]>([]);

  const setWorking = (value: boolean) => {
    setBusy(value);
    onBusyChange?.(value);
  };

  const updateSources = (next: QuestionSourceFile[]) => {
    onChange({
      questionSources: next,
      // Changing evidence invalidates a previous confirmation. Removing attachments never clears an unconfirmed imported draft.
      questionsNeedReview: next.length ? true : Boolean(imported && needsReview),
      ...(next.length ? {} : { questionImportWarnings: [] }),
    });
  };

  const processFiles = async (files: File[]) => {
    if (!files.length || busy) return;
    setErrorDetails([]);
    setWorking(true);
    const added: QuestionSourceFile[] = [];
    try {
      for (const file of files) {
        const type = fileType(file);
        if (!(ACCEPTED_FILE_TYPES as readonly string[]).includes(type)) {
          notify({ title: `فرمت ${file.name} پشتیبانی نمی‌شود`, description: "فقط JPG، PNG، WebP و PDF وارد کنید.", variant: "error" });
          continue;
        }
        if (file.size < 10 || file.size > MAX_FILE_SIZE_BYTES) {
          notify({ title: `حجم ${file.name} مجاز نیست`, description: `حجم هر فایل باید حداکثر ${MAX_FILE_SIZE_LABEL} باشد.`, variant: "error" });
          continue;
        }
        const id = uid("question_source");
        await storeFile(id, file, type);
        added.push({ id, storedId: id, name: file.name, type, size: file.size, kind: "combined" });
      }
      if (added.length) {
        updateSources([...sources, ...added]);
        notify({ title: "برگه‌های سؤال و کلید ذخیره شد", description: `${faNumber(added.length)} فایل آمادهٔ خواندن است؛ نقش هر فایل را بررسی کنید.`, variant: "success" });
      }
    } catch (error) {
      if (added.length) updateSources([...sources, ...added]);
      notify({ title: "ذخیرهٔ برگه کامل نشد", description: error instanceof Error ? error.message : "دوباره تلاش کنید.", variant: "error" });
    } finally {
      setWorking(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const onInput = (event: ChangeEvent<HTMLInputElement>) => processFiles(Array.from(event.target.files ?? []));
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    processFiles(Array.from(event.dataTransfer.files));
  };

  const removeSource = async (source: QuestionSourceFile) => {
    updateSources(sources.filter((item) => item.id !== source.id));
    try { await deleteStoredFile(source.storedId); } catch (error) {
      notify({ title: "حذف فایل از سرور ناموفق بود", description: error instanceof Error ? error.message : "دوباره تلاش کنید.", variant: "error" });
    }
  };

  const previewSource = async (source: QuestionSourceFile) => {
    try {
      const stored = await getStoredFile(source.storedId);
      if (!stored) throw new Error("فایل روی سرور پیدا نشد؛ دوباره بارگذاری کنید.");
      const url = URL.createObjectURL(stored.blob);
      window.open(url, "_blank", "noopener,noreferrer");
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      notify({ title: "نمایش فایل ممکن نشد", description: error instanceof Error ? error.message : "دوباره تلاش کنید.", variant: "error" });
    }
  };

  const readSources = async () => {
    if (!sources.length || busy) return;
    setErrorDetails([]);
    setWorking(true);
    try {
      await beforeRead?.();
      const response = await fetch("/api/grading/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ examId, sources: sources.map((source) => ({ storedId: source.storedId, kind: source.kind })) }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string; issues?: string[]; questions?: Exam["questions"]; warnings?: string[] };
      if (!response.ok) {
        setErrorDetails(payload.issues ?? []);
        throw new Error(payload.error || "خواندن سؤال و کلید کامل نشد.");
      }
      if (!payload.questions?.length) throw new Error("مدل هیچ سؤال کاملی برنگرداند؛ هیچ پیش‌نویسی ذخیره نشد.");
      onChange({ questions: payload.questions, questionsImported: true, questionImportWarnings: payload.warnings ?? [], questionsNeedReview: true });
      notify({ title: "پیش‌نویس سؤال‌ها ساخته شد", description: "همهٔ صورت‌ها، کلیدها و نمره‌ها را با برگهٔ اصلی مقایسه و سپس تأیید کنید.", variant: "success" });
    } catch (error) {
      notify({ title: "پیش‌نویس ساخته نشد", description: error instanceof Error ? error.message : "دوباره تلاش کنید.", variant: "error" });
    } finally {
      setWorking(false);
    }
  };

  return (
    <section className="question-source-importer">
      <div className="question-source-heading">
        <div>
          <h3><ScanText size={19} />خواندن سؤال و کلید از برگه <span className="optional-label">اختیاری</span></h3>
          <p>چند عکس یا PDF صفحات سؤال و پاسخ‌نامهٔ معلم را اضافه کنید؛ برای یک آزمون چندصفحه‌ای همهٔ صفحات را با هم بفرستید.</p>
        </div>
        <span className="badge badge-neutral">هر فایل تا {MAX_FILE_SIZE_LABEL}</span>
      </div>
      <div
        className={`question-source-dropzone ${dragActive ? "drag-active" : ""}`}
        onDragOver={(event) => { event.preventDefault(); setDragActive(true); }}
        onDragLeave={() => setDragActive(false)}
        onDrop={onDrop}
      >
        <input ref={inputRef} type="file" hidden multiple accept=".jpg,.jpeg,.png,.webp,.pdf" onChange={onInput} />
        <UploadCloud size={24} />
        <div><strong>برگه‌های سؤال و کلید را اینجا رها کنید</strong><span>JPG، PNG، WebP یا PDF · حداکثر {MAX_FILE_SIZE_LABEL} برای هر فایل</span></div>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => inputRef.current?.click()}>{busy ? <LoaderCircle className="spin-icon" size={16} /> : <UploadCloud size={16} />}انتخاب برگه‌ها</button>
      </div>
      <p className="question-source-limit">حداکثر ۳۰ فایل و ۲۰ صفحه برای هر PDF. محدودیت ذخیره با محدودیت حجم و قالب ورودی سرویس‌دهندهٔ هوش مصنوعی متفاوت است؛ در صورت نیاز PDF به تصویر صفحه تبدیل می‌شود.</p>

      {sources.length ? <div className="question-source-list">
        {sources.map((source, index) => <article className="question-source-file" key={source.id}>
          <span className="question-source-icon">{source.type === "application/pdf" ? <FileText size={18} /> : <FileImage size={18} />}</span>
          <div className="question-source-file-name"><strong>{faNumber(index + 1)}. {source.name}</strong><small>{formatBytes(source.size)}</small></div>
          <label className="question-source-role"><span>نقش فایل</span><select className="select" value={source.kind} disabled={busy} onChange={(event) => updateSources(sources.map((item) => item.id === source.id ? { ...item, kind: event.target.value as QuestionSourceKind } : item))}><option value="combined">سؤال و کلید با هم</option><option value="questions">فقط سؤال</option><option value="answers">فقط کلید / پاسخ معلم</option></select></label>
          <div className="question-source-actions"><button type="button" className="icon-button" onClick={() => previewSource(source)} title="مشاهدهٔ برگه" aria-label={`مشاهدهٔ ${source.name}`}><Eye size={16} /></button><button type="button" className="icon-button danger-hover" disabled={busy} onClick={() => removeSource(source)} title="حذف برگه" aria-label={`حذف ${source.name}`}><Trash2 size={16} /></button></div>
        </article>)}
      </div> : <p className="question-source-empty">هنوز برگه‌ای برای خواندن خودکار اضافه نشده است؛ می‌توانید سؤال‌ها را همانند قبل دستی وارد کنید.</p>}

      {errorDetails.length ? <div className="notice notice-warning question-source-errors"><AlertTriangle size={18} /><div><strong>موارد نیازمند اصلاح در خواندن</strong><ul>{errorDetails.map((detail, index) => <li key={`${index}-${detail}`}>{detail}</li>)}</ul></div></div> : null}
      {warnings?.length ? <div className="notice notice-warning question-source-warnings"><AlertTriangle size={18} /><div><strong>هشدارهای پیش‌نویس</strong><ul>{warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}</ul></div></div> : null}
      {needsReview && sources.length ? <div className="question-source-review-state"><AlertTriangle size={16} /><span>پیش‌نویس هنوز تأیید نشده است؛ تصحیح تا تأیید صریح معلم انجام نمی‌شود.</span></div> : null}

      <div className="question-source-footer">
        <p><CheckCircle2 size={15} />خروجی مدل فقط پیش‌نویس است. هیچ سؤال، کلید یا نمرهٔ مبهمی به‌صورت خودکار قطعی نمی‌شود؛ آن را با تصویر اصلی مقایسه کنید.</p>
        <button type="button" className="btn btn-primary" disabled={!sources.length || busy || sources.length > 30} onClick={readSources}>{busy ? <LoaderCircle className="spin-icon" size={17} /> : <ScanText size={17} />}{busy ? "در حال خواندن برگه‌ها…" : "ساخت پیش‌نویس سؤال و کلید"}</button>
      </div>
    </section>
  );
}
