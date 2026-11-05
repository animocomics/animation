export interface PersianDateParts {
  jy: number;
  jm: number;
  jd: number;
}

export const PERSIAN_MONTH_NAMES = [
  "فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور",
  "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند",
];
export const PERSIAN_WEEKDAY_NAMES = ["شنبه", "یکشنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه", "پنجشنبه", "جمعه"];

const DAY_MS = 86_400_000;
const persianFormatter = new Intl.DateTimeFormat("en-US-u-ca-persian-nu-latn", {
  timeZone: "UTC",
  year: "numeric",
  month: "numeric",
  day: "numeric",
});
const numberFormatter = new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 0, useGrouping: false });

function partsFromGregorianDate(date: Date): PersianDateParts | null {
  if (Number.isNaN(date.getTime())) return null;
  const parts = persianFormatter.formatToParts(date);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const jy = read("year");
  const jm = read("month");
  const jd = read("day");
  return jy > 0 && jm >= 1 && jm <= 12 && jd >= 1 ? { jy, jm, jd } : null;
}

function gregorianDateFromIso(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const [, year, month, day] = match;
  const gy = Number(year);
  const gm = Number(month);
  const gd = Number(day);
  const date = new Date(Date.UTC(gy, gm - 1, gd));
  if (date.getUTCFullYear() !== gy || date.getUTCMonth() !== gm - 1 || date.getUTCDate() !== gd) return null;
  return date;
}

export function persianDateFromIso(value: string | Date): PersianDateParts | null {
  const date = value instanceof Date ? value : gregorianDateFromIso(value);
  return date ? partsFromGregorianDate(date) : null;
}

export function isoFromPersianDate(parts: PersianDateParts): string | null {
  const { jy, jm, jd } = parts;
  if (!Number.isInteger(jy) || !Number.isInteger(jm) || !Number.isInteger(jd) || jy < 1 || jm < 1 || jm > 12 || jd < 1 || jd > 31) return null;
  // Farvardin is close to March. Searching this small window also handles
  // leap years and the different month boundaries without a lookup table.
  const approximate = Date.UTC(jy + 621, jm + 1, jd);
  for (let distance = 0; distance <= 40; distance += 1) {
    const offsets = distance === 0 ? [0] : [distance, -distance];
    for (const offset of offsets) {
      const candidate = new Date(approximate + offset * DAY_MS);
      const actual = partsFromGregorianDate(candidate);
      if (actual?.jy === jy && actual.jm === jm && actual.jd === jd) {
        return `${String(candidate.getUTCFullYear()).padStart(4, "0")}-${String(candidate.getUTCMonth() + 1).padStart(2, "0")}-${String(candidate.getUTCDate()).padStart(2, "0")}`;
      }
    }
  }
  return null;
}

export function persianMonthLength(jy: number, jm: number): number {
  if (jm <= 6) return 31;
  if (jm <= 11) return 30;
  return isoFromPersianDate({ jy, jm, jd: 30 }) ? 30 : 29;
}

export function shiftPersianMonth(parts: PersianDateParts, amount: number): PersianDateParts {
  const index = parts.jy * 12 + (parts.jm - 1) + amount;
  const jy = Math.floor(index / 12);
  const jm = ((index % 12) + 12) % 12 + 1;
  return { jy, jm, jd: 1 };
}

export function persianWeekdayIndex(parts: PersianDateParts): number {
  const iso = isoFromPersianDate({ ...parts, jd: 1 });
  if (!iso) return 0;
  const [gy, gm, gd] = iso.split("-").map(Number);
  // JavaScript: Sunday=0. The Persian calendar week starts on Saturday.
  return (new Date(Date.UTC(gy, gm - 1, gd)).getUTCDay() + 1) % 7;
}

export function formatPersianDate(parts: PersianDateParts, withYear = true): string {
  return `${numberFormatter.format(parts.jd)} ${PERSIAN_MONTH_NAMES[parts.jm - 1]}${withYear ? ` ${numberFormatter.format(parts.jy)}` : ""}`;
}

export function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}
