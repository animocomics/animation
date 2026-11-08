"use client";

import { type ChangeEvent, type DragEvent, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Eye, FileImage, FileText, Info, KeyRound, LoaderCircle, ScanText, Trash2, UploadCloud, XCircle } from "lucide-react";
import { ACCEPTED_FILE_EXTENSIONS, ACCEPTED_FILE_LABEL, ACCEPTED_FILE_TYPES, MAX_FILE_SIZE_BYTES, MAX_FILE_SIZE_LABEL } from "../../lib/file-constraints";
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
  const pendingKind = useRef<QuestionSourceKind>("combined");
  const [busy, setBusy] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [errorDetails, setErrorDetails] = useState<string[]>([]);
  // Set once a paid read has been sent for the current file selection. It is what
  // makes the cost visible *before* a second click, and it is cleared whenever the
  // sources change (new evidence means a new request is genuinely needed).
  const [lastSentAt, setLastSentAt] = useState<number | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const answerKeyOnly = sources.length > 0 && sources.every((source) => source.kind === "answers");

  const setWorking = (value: boolean) => {
    setBusy(value);
    onBusyChange?.(value);
  };

  const updateSources = (next: QuestionSourceFile[]) => {
    setLastSentAt(null);
    onChange({
      questionSources: next,
      // Changing evidence invalidates a previous confirmation. Removing attachments never clears an unconfirmed imported draft.
      questionsNeedReview: next.length ? true : Boolean(imported && needsReview),
      ...(next.length ? {} : { questionImportWarnings: [] }),
    });
  };

  const chooseFiles = (kind: QuestionSourceKind) => {
    pendingKind.current = kind;
    inputRef.current?.click();
  };

  const processFiles = async (files: File[], kind: QuestionSourceKind) => {
    if (!files.length || busy) return;
    setErrorDetails([]);
    setWorking(true);
    const added: QuestionSourceFile[] = [];
    try {
      for (const file of files) {
        const type = fileType(file);
        if (!(ACCEPTED_FILE_TYPES as readonly string[]).includes(type)) {
          notify({ title: `فرمت ${file.name} پشتیبانی نمی‌شود`, description: `فقط ${ACCEPTED_FILE_LABEL} پذیرفته می‌شود.`, variant: "error" });
          continue;
        }
        if (file.size < 10 || file.size > MAX_FILE_SIZE_BYTES) {
          notify({ title: `حجم ${file.name} مجاز نیست`, description: `حجم هر فایل باید حداکثر ${MAX_FILE_SIZE_LABEL} باشد.`, variant: "error" });
          continue;
        }
        const id = uid("question_source");
        await storeFile(id, file, type);
        added.push({ id, storedId: id, name: file.name, type, size: file.size, kind });
      }
      if (added.length) {
        updateSources([...sources, ...added]);
        const label = kind === "answers" ? "کلید و پاسخ‌نامه" : kind === "questions" ? "برگه‌های سؤال" : "برگه‌های سؤال و کلید";
        notify({ title: `${label} ذخیره شد`, description: `${faNumber(added.length)} فایل آمادهٔ خواندن است؛ نیازی به تنظیم دوبارهٔ نقش نیست.`, variant: "success" });
      }
    } catch (error) {
      if (added.length) updateSources([...sources, ...added]);
      notify({ title: "ذخیرهٔ برگه کامل نشد", description: error instanceof Error ? error.message : "دوباره تلاش کنید.", variant: "error" });
    } finally {
      setWorking(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const onInput = (event: ChangeEvent<HTMLInputElement>) => {
    const kind = pendingKind.current;
    pendingKind.current = "combined";
    void processFiles(Array.from(event.target.files ?? []), kind);
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    void processFiles(Array.from(event.dataTransfer.files), "combined");
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

  const readSources = async (forceKeyOnly = false) => {
    if (!sources.length || busy) return;
    const keyOnly = forceKeyOnly || sources.every((source) => source.kind === "answers");
    const selectedSources = keyOnly ? sources.filter((source) => source.kind === "answers") : sources;
    if (!selectedSources.length) return;
    // A second send of the same files is a second bill for identical work. This is
    // a confirmation, not a block: a teacher whose first attempt failed for a reason
    // the panel cannot see still gets to retry, but by choosing to.
    if (lastSentAt && Date.now() - lastSentAt < 120_000) {
      const confirmed = typeof window === "undefined" ? false : window.confirm("همین برگه‌ها کمتر از دو دقیقه پیش خوانده شدند. اگر پاسخ قبلی خطا داد، اول آن خطا را بخوانید؛ بعضی خطاها با تکرار درست نمی‌شوند. دوباره بفرستم؟");
      if (!confirmed) return;
    }
    setErrorDetails([]);
    setWorking(true);
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      await beforeRead?.();
      const response = await fetch("/api/grading/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ examId, mode: keyOnly ? "answer-key-only" : "questions-and-key", sources: selectedSources.map((source) => ({ storedId: source.storedId, kind: source.kind })) }),
      });
      setLastSentAt(Date.now());
      // The reply is not always JSON: a proxy in front of the app answers a request
      // that ran too long with its own HTML 504 page. Reading that as an empty object
      // produced the useless "reading the questions did not complete" sentence, which
      // says nothing about what to do. Name the two cases that actually happen.
      const rawText = await response.text().catch(() => "");
      let payload: { error?: string; issues?: string[]; questions?: Exam["questions"]; warnings?: string[] } = {};
      try {
        payload = JSON.parse(rawText) as typeof payload;
      } catch {
        payload = {};
      }
      if (!response.ok) {
        setErrorDetails(payload.issues ?? []);
        if (!payload.error) {
          const gatewayTimeout = response.status === 502 || response.status === 503 || response.status === 504;
          throw new Error(gatewayTimeout
            ? `سرور تا پاسخ مدل صبر نکرد (HTTP ${response.status} از پروکسی هاست، نه از خود برنامه). برگه‌های کمتر یا یک صفحه را بفرستید و اگر تکرار شد، زمان انتظار پروکسی را در Plesk بالا ببرید.`
            : `پاسخ سرور خوانا نبود (HTTP ${response.status}). این معمولاً از پروکسی یا تنظیمات هاست می‌آید، نه از فایل شما؛ جزئیات را برای مدیر بفرستید.`);
        }
        throw new Error(payload.error);
      }
      if (!rawText.trim()) throw new Error("سرور پاسخی برنگرداند (پاسخ خالی). این نشانهٔ قطع‌شدن درخواست توسط پروکسی هاست است؛ با برگه‌های کمتر دوباره امتحان کنید.");
      if (!payload.questions?.length) throw new Error("مدل هیچ سؤال کاملی برنگرداند؛ هیچ پیش‌نویسی ذخیره نشد.");
      onChange({ questions: payload.questions, questionsImported: true, questionImportWarnings: payload.warnings ?? [], questionsNeedReview: true });
      notify({
        title: keyOnly ? "کلید جدا روی سؤال‌ها نشست" : "پیش‌نویس سؤال‌ها ساخته شد",
        description: keyOnly ? "صورت، نمره و بارم تغییر نکرد؛ کلیدها را با پاسخ‌نامه مقایسه و تأیید کنید." : "همهٔ صورت‌ها، کلیدها و نمره‌ها را با برگهٔ اصلی مقایسه و سپس تأیید کنید.",
        variant: "success",
      });
    } catch (error) {
      const aborted = error instanceof DOMException && error.name === "AbortError";
      notify({
        title: aborted ? "درخواست لغو شد" : keyOnly ? "کلید جدا خوانده نشد" : "پیش‌نویس ساخته نشد",
        description: aborted ? "درخواست لغو شد. پیش از فرستادن دوباره، نتیجه را بررسی کنید." : error instanceof Error ? error.message : "دوباره تلاش کنید.",
        variant: aborted ? "info" : "error",
      });
    } finally {
      controllerRef.current = null;
      setWorking(false);
    }
  };

  return (
    <section className="question-source-importer">
      <div className="question-source-heading">
        <div>
          <h3><ScanText size={19} />خواندن سؤال و کلید از برگه <span className="optional-label">اختیاری</span></h3>
          <p>سؤال‌ها و کلید را جدا یا با هم اضافه کنید. عکس پاسخ‌نامهٔ تستی با گزینه‌های سیاه‌شده یا علامت‌گذاری‌شده هم پذیرفته می‌شود.</p>
        </div>
        <span className="badge badge-neutral">هر فایل تا {MAX_FILE_SIZE_LABEL}</span>
      </div>
      <div
        className={`question-source-dropzone ${dragActive ? "drag-active" : ""}`}
        onDragOver={(event) => { event.preventDefault(); setDragActive(true); }}
        onDragLeave={() => setDragActive(false)}
        onDrop={onDrop}
      >
        <input ref={inputRef} type="file" hidden multiple accept={ACCEPTED_FILE_EXTENSIONS} onChange={onInput} />
        <UploadCloud size={24} />
        <div className="question-source-dropzone-copy"><strong>عکس بگیرید یا برگه‌ها را انتخاب کنید</strong><span>نقش هر فایل با دکمهٔ انتخاب خودکار مشخص می‌شود.</span></div>
        <div className="question-source-upload-actions">
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => chooseFiles("questions")}><FileText size={16} />افزودن سؤال‌ها</button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => chooseFiles("answers")}><KeyRound size={16} />افزودن عکس/PDF کلید</button>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => chooseFiles("combined")}><UploadCloud size={16} />سؤال و کلید در یک فایل</button>
        </div>
      </div>
      <p className="question-source-limit">پسوندهای مجاز: {ACCEPTED_FILE_LABEL}؛ حداکثر ۳۰ فایل و ۲۰ صفحه برای هر PDF. فایل رها شده در کادر، نقش «سؤال و کلید با هم» می‌گیرد و بعداً قابل تغییر است.</p>

      {sources.length ? <div className="question-source-list">
        {sources.map((source, index) => <article className="question-source-file" key={source.id}>
          <span className="question-source-icon">{source.type === "application/pdf" ? <FileText size={18} /> : <FileImage size={18} />}</span>
          <div className="question-source-file-name"><strong>{faNumber(index + 1)}. {source.name}</strong><small>{formatBytes(source.size)}</small></div>
          <label className="question-source-role"><span>نقش فایل</span><select className="select" value={source.kind} disabled={busy} onChange={(event) => updateSources(sources.map((item) => item.id === source.id ? { ...item, kind: event.target.value as QuestionSourceKind } : item))}><option value="combined">سؤال و کلید با هم</option><option value="questions">فقط سؤال</option><option value="answers">فقط کلید / پاسخ معلم</option></select></label>
          <div className="question-source-actions"><button type="button" className="icon-button" onClick={() => previewSource(source)} title="مشاهدهٔ برگه" aria-label={`مشاهدهٔ ${source.name}`}><Eye size={16} /></button><button type="button" className="icon-button danger-hover" disabled={busy} onClick={() => removeSource(source)} title="حذف برگه" aria-label={`حذف ${source.name}`}><Trash2 size={16} /></button></div>
        </article>)}
      </div> : <p className="question-source-empty">می‌توانید سؤال‌ها را دستی وارد کنید و بعد فقط عکس کلید را اضافه کنید؛ لازم نیست همه‌چیز را از نو بسازید.</p>}

      {answerKeyOnly ? <div className="notice notice-info question-key-only-state"><KeyRound size={18} /><div><strong>حالت کلید جدا، خودکار</strong><p>فقط پاسخ‌های سؤال‌های موجود خوانده می‌شود؛ صورت سؤال، گزینه‌ها، نمره و بارم دست نمی‌خورد. در تستی‌ها گزینهٔ سیاه/علامت‌خورده خوانده می‌شود و علامت مبهم یا چندگانه پذیرفته نمی‌شود.</p></div></div> : null}
      {lastSentAt && !busy ? <div className="notice notice-info question-source-cost"><Info size={16} /><div><strong>این برگه‌ها همین حالا خوانده شدند</strong><p>اگر نتیجه نیامد، پیام خطای بالا را بخوانید؛ بعضی خطاها (مدل بدون پشتیبانی تصویر، کشور مبدأ، کلید) با فرستادن دوباره درست نمی‌شوند.</p></div></div> : null}
      {errorDetails.length ? <div className="notice notice-warning question-source-errors"><AlertTriangle size={18} /><div><strong>موارد نیازمند اصلاح در خواندن</strong><ul>{errorDetails.map((detail, index) => <li key={`${index}-${detail}`}>{detail}</li>)}</ul></div></div> : null}
      {warnings?.length ? <div className="notice notice-warning question-source-warnings"><AlertTriangle size={18} /><div><strong>هشدارهای پیش‌نویس</strong><ul>{warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}</ul></div></div> : null}
      {needsReview && sources.length ? <div className="question-source-review-state"><AlertTriangle size={16} /><span>پیش‌نویس هنوز تأیید نشده است؛ تصحیح تا تأیید صریح معلم انجام نمی‌شود.</span></div> : null}

      <div className="question-source-footer">
        <p><CheckCircle2 size={15} />پیش‌نویس است، نه نمرهٔ نهایی؛ آن را با برگهٔ اصلی مقایسه کنید.</p>
        <div className="question-source-read-actions">
          {!answerKeyOnly && sources.some((source) => source.kind === "answers") ? <button type="button" className="btn btn-secondary" disabled={busy || sources.length > 30} onClick={() => void readSources(true)}><KeyRound size={17} />فقط خواندن کلید</button> : null}
          {busy ? <button type="button" className="btn btn-secondary" onClick={() => controllerRef.current?.abort()}><XCircle size={17} />لغو درخواست</button> : null}
          <button type="button" className="btn btn-primary" disabled={!sources.length || busy || sources.length > 30} onClick={() => void readSources()}>{busy ? <LoaderCircle className="spin-icon" size={17} /> : <ScanText size={17} />}{busy ? "در حال خواندن برگه‌ها…" : answerKeyOnly ? "خواندن کلید جدا" : "ساخت پیش‌نویس سؤال و کلید"}</button>
        </div>
      </div>
    </section>
  );
}
