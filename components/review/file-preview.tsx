"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ExternalLink,
  FileImage,
  FileText,
  Minus,
  Plus,
  RotateCw,
  ScanLine,
} from "lucide-react";
import { getStoredFile } from "../../lib/file-store";
import type { FileMeta } from "../../lib/types";
import { faNumber } from "../../lib/utils";

export function FilePreview({ files, studentName, requestedPage = 1 }: {
  files: FileMeta[];
  studentName: string;
  requestedPage?: number;
}) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [objectUrl, setObjectUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [missing, setMissing] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const currentFile = files[currentIndex];

  useEffect(() => {
    if (requestedPage > 0 && files.length) setCurrentIndex(Math.min(files.length - 1, requestedPage - 1));
  }, [requestedPage, files.length]);

  useEffect(() => {
    let url = "";
    let cancelled = false;
    setObjectUrl("");
    setMissing(false);
    if (!currentFile) return;
    setLoading(true);
    const loadPreview = async (): Promise<Blob | null> => {
      if (currentFile.type === "application/pdf") {
        const response = await fetch(`/api/files/${encodeURIComponent(currentFile.storedId)}/preview?page=${requestedPage}`, { cache: "no-store" });
        if (!response.ok) throw new Error("PDF preview failed");
        return response.blob();
      }
      const stored = await getStoredFile(currentFile.storedId);
      return stored?.blob || null;
    };
    loadPreview().then((blob) => {
      if (cancelled) return;
      if (!blob) setMissing(true);
      else {
        url = URL.createObjectURL(blob);
        setObjectUrl(url);
      }
    }).catch(() => { if (!cancelled) setMissing(true); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [currentFile, requestedPage]);

  useEffect(() => { setZoom(1); setRotation(0); }, [currentIndex, requestedPage]);

  return (
    <section className="card paper-preview-card">
      <div className="paper-preview-toolbar">
        <div><ScanLine size={17} /><span><strong>برگهٔ اصلی</strong><small>{currentFile ? currentFile.name : `نمای نمونه · ${studentName}`}</small></span></div>
        <div className="preview-tools">
          <button className="icon-button btn-icon-small" onClick={() => setZoom((value) => Math.max(0.6, value - 0.15))} aria-label="کوچک‌نمایی"><Minus size={15} /></button>
          <span>{faNumber(zoom * 100, 0)}٪</span>
          <button className="icon-button btn-icon-small" onClick={() => setZoom((value) => Math.min(2, value + 0.15))} aria-label="بزرگ‌نمایی"><Plus size={15} /></button>
          <button className="icon-button btn-icon-small" onClick={() => setRotation((value) => (value + 90) % 360)} aria-label="چرخاندن"><RotateCw size={15} /></button>
          {currentFile?.type === "application/pdf" && <a className="icon-button btn-icon-small" href={`/api/files/${encodeURIComponent(currentFile.storedId)}`} target="_blank" rel="noreferrer" aria-label="بازکردن PDF اصلی" title="بازکردن PDF اصلی"><ExternalLink size={15} /></a>}
        </div>
      </div>
      {files.length > 1 && <div className="preview-file-tabs">{files.map((file, index) => <button className={index === currentIndex ? "active" : ""} onClick={() => setCurrentIndex(index)} key={file.id}>{file.type === "application/pdf" ? <FileText size={14} /> : <FileImage size={14} />}فایل {faNumber(index + 1)}<span>{file.name}</span></button>)}</div>}
      <div className="paper-viewport">
        {!files.length ? <DemoPaper studentName={studentName} /> : loading ? <div className="preview-loading"><span className="spinner" /><p>در حال بازکردن برگه…</p></div> : missing || !objectUrl ? <div className="preview-missing"><AlertTriangle size={27} /><strong>فایل اصلی روی سرور موجود نیست</strong><p>از بخش «افزودن و تصحیح برگه» فایل را دوباره اضافه کنید. نتیجهٔ قبلی حذف نمی‌شود.</p></div> : currentFile.type === "application/pdf" ? (
          <div className="image-preview-scroll pdf-image-preview"><img className="pdf-preview" data-page={requestedPage} src={objectUrl} alt={`صفحهٔ ${faNumber(requestedPage)} PDF برگهٔ ${studentName}`} style={{ transform: `scale(${zoom}) rotate(${rotation}deg)` }} /></div>
        ) : (
          <div className="image-preview-scroll"><img src={objectUrl} alt={`برگهٔ امتحانی ${studentName}`} style={{ transform: `scale(${zoom}) rotate(${rotation}deg)` }} /></div>
        )}
      </div>
      <div className="paper-preview-footer"><span>{files.length ? currentFile?.type === "application/pdf" ? `صفحهٔ ${faNumber(requestedPage)} · رندر امن PDF` : `فایل ${faNumber(currentIndex + 1)} از ${faNumber(files.length)}` : "این برگه فقط برای نمایش رابط، دادهٔ نمایشی است"}</span><span>برای رفع ابهام، فایل اصلی مبناست</span></div>
    </section>
  );
}

function DemoPaper({ studentName }: { studentName: string }) {
  return (
    <div className="demo-paper-wrap">
      <div className="demo-paper">
        <span className="demo-watermark">نمونهٔ نمایشی</span>
        <div className="paper-school-row"><span>دبیرستان نمونه</span><span>آزمون میان‌ترم زیست‌شناسی</span></div>
        <div className="paper-student-row"><span>نام دانش‌آموز: <b>{studentName}</b></span><span>کلاس: یازدهم تجربی</span></div>
        <div className="paper-rule" />
        <div className="handwritten-answer"><span>۱)</span><p>گزینهٔ ۲، میتوکندری</p></div>
        <div className="handwritten-answer"><span>۲)</span><p>سلول</p></div>
        <div className="handwritten-answer long"><span>۳)</span><p>سلول گیاهی دیوارهٔ سلولی دارد ولی سلول جانوری ندارد. هم‌چنین در سلول گیاهی کلروپلاست وجود دارد و فتوسنتز انجام می‌شود.</p></div>
        <div className="handwritten-answer long math-answer"><span>۴)</span><p>ATP خالص = ۳۸ − ۲ = ۳۶</p><p>پس در این فرایند ۳۶ مولکول ATP باقی می‌ماند.</p><i>بخشی از نوشته در تصویر واضح نیست…</i></div>
        <div className="paper-teacher-mark">؟</div>
        <div className="paper-page-number">صفحهٔ ۱ از ۲</div>
      </div>
    </div>
  );
}
