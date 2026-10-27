"use client";

import { type ReactNode, useEffect } from "react";
import { Check, Clock3, TriangleAlert, X } from "lucide-react";
import type { Exam, Submission } from "../../lib/types";
import { faNumber, getExamStatusLabel, getSubmissionStatusLabel } from "../../lib/utils";

export function SubmissionStatusBadge({ status }: { status: Submission["status"] }) {
  const variant = status === "approved" ? "success" : status === "needs_review" || status === "error" ? "warning" : status === "processing" ? "info" : status === "graded" ? "violet" : "neutral";
  return <span className={`badge badge-${variant}`}>
    {status === "approved" && <Check size={12} />}
    {status === "needs_review" && <TriangleAlert size={12} />}
    {status === "processing" && <Clock3 size={12} />}
    {getSubmissionStatusLabel(status)}
  </span>;
}

export function ExamStatusBadge({ status }: { status: Exam["status"] }) {
  const variant = status === "completed" ? "success" : status === "review" ? "warning" : status === "grading" ? "info" : status === "ready" ? "violet" : "neutral";
  return <span className={`badge badge-${variant}`}>{getExamStatusLabel(status)}</span>;
}

export function ScoreRing({ value, size = 72, stroke = 7, label, tone = "brand" }: {
  value: number;
  size?: number;
  stroke?: number;
  label?: string;
  tone?: "brand" | "amber" | "red";
}) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const percentage = Math.max(0, Math.min(100, value));
  return (
    <div className={`score-ring score-ring-${tone}`} style={{ width: size, height: size }} role="img" aria-label={`${faNumber(percentage)} درصد`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle className="score-ring-track" cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={stroke} />
        <circle className="score-ring-value" cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={stroke} strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - percentage / 100)} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </svg>
      <span><strong>{faNumber(percentage, 0)}<small>٪</small></strong>{label && <small>{label}</small>}</span>
    </div>
  );
}

export function Modal({ title, description, onClose, children, footer, large = false }: {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  large?: boolean;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className={`modal ${large ? "modal-lg" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header">
          <div><h2>{title}</h2>{description && <p>{description}</p>}</div>
          <button className="icon-button" onClick={onClose} aria-label="بستن"><X size={19} /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </section>
    </div>
  );
}

export function ConfidenceBar({ value }: { value: number }) {
  const percentage = Math.round(value * 100);
  return (
    <div className="confidence-bar" title="اعتماد گزارش‌شده توسط مدل، نه احتمال کالیبره‌شدهٔ درستی">
      <div className="progress-track"><div className={`progress-fill ${percentage < 60 ? "danger" : percentage < 80 ? "warning" : ""}`} style={{ width: `${percentage}%` }} /></div>
      <span>{faNumber(percentage, 0)}٪</span>
    </div>
  );
}
