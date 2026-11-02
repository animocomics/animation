"use client";

import { useEffect, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import {
  PERSIAN_MONTH_NAMES,
  PERSIAN_WEEKDAY_NAMES,
  formatPersianDate,
  isoFromPersianDate,
  persianDateFromIso,
  persianMonthLength,
  persianWeekdayIndex,
  shiftPersianMonth,
  todayIsoDate,
  type PersianDateParts,
} from "@/lib/persian-date";
import { faDate, faNumber } from "@/lib/utils";

interface PersianDateFieldProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

export function PersianDateField({ id, value, onChange, disabled = false }: PersianDateFieldProps) {
  const selected = persianDateFromIso(value) ?? persianDateFromIso(todayIsoDate())!;
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState<PersianDateParts>({ ...selected, jd: 1 });
  const rootRef = useRef<HTMLDivElement>(null);
  const today = persianDateFromIso(todayIsoDate())!;

  useEffect(() => {
    if (open) setCursor({ ...selected, jd: 1 });
  }, [open, value]); // Reset the viewed month whenever a newly selected date is opened.

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, [open]);

  const chooseDay = (day: number) => {
    const iso = isoFromPersianDate({ ...cursor, jd: day });
    if (!iso) return;
    onChange(iso);
    setOpen(false);
  };

  const blanks = Array.from({ length: persianWeekdayIndex(cursor) }, (_, index) => `blank-${index}`);
  const days = Array.from({ length: persianMonthLength(cursor.jy, cursor.jm) }, (_, index) => index + 1);

  return (
    <div className="persian-date-field" ref={rootRef}>
      <button
        id={id}
        type="button"
        className="input persian-date-trigger"
        dir="rtl"
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="انتخاب تاریخ آزمون از تقویم شمسی"
        onClick={() => setOpen((current) => !current)}
      >
        <CalendarDays size={16} aria-hidden="true" />
        <span>{formatPersianDate(selected)}</span>
        <span className="persian-date-weekday">{faDate(value, { weekday: "long" })}</span>
      </button>
      {open && !disabled && (
        <div className="persian-calendar" role="dialog" aria-label="تقویم شمسی">
          <div className="persian-calendar-head">
            <button type="button" className="icon-btn" aria-label="ماه قبل" onClick={() => setCursor((current) => shiftPersianMonth(current, -1))}><ChevronRight size={16} /></button>
            <strong>{PERSIAN_MONTH_NAMES[cursor.jm - 1]} {new Intl.NumberFormat("fa-IR", { useGrouping: false }).format(cursor.jy)}</strong>
            <button type="button" className="icon-btn" aria-label="ماه بعد" onClick={() => setCursor((current) => shiftPersianMonth(current, 1))}><ChevronLeft size={16} /></button>
          </div>
          <div className="persian-calendar-weekdays" aria-hidden="true">
            {PERSIAN_WEEKDAY_NAMES.map((day) => <span key={day}>{day.slice(0, 1)}</span>)}
          </div>
          <div className="persian-calendar-days">
            {blanks.map((blank) => <span key={blank} aria-hidden="true" />)}
            {days.map((day) => {
              const isSelected = selected.jy === cursor.jy && selected.jm === cursor.jm && selected.jd === day;
              const isToday = today.jy === cursor.jy && today.jm === cursor.jm && today.jd === day;
              return (
                <button
                  type="button"
                  key={day}
                  className={`${isSelected ? "selected" : ""} ${isToday ? "today" : ""}`}
                  aria-label={`${formatPersianDate({ ...cursor, jd: day })}`}
                  aria-pressed={isSelected}
                  onClick={() => chooseDay(day)}
                >
                  {faNumber(day, 0)}
                </button>
              );
            })}
          </div>
          <div className="persian-calendar-foot">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setCursor({ ...today, jd: 1 }); onChange(todayIsoDate()); setOpen(false); }}>امروز</button>
            <span>تقویم هجری شمسی</span>
          </div>
        </div>
      )}
    </div>
  );
}
