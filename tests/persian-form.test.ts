import assert from "node:assert/strict";
import test from "node:test";
import { formatPersianDate, isoFromPersianDate, persianDateFromIso, persianMonthLength, persianWeekdayIndex } from "../lib/persian-date";
import { faDate, formatNumericInput, normalizeNumericInput } from "../lib/utils";

test("Persian calendar conversion preserves Nowruz, ordinary dates and leap-day round trips", () => {
  const samples = ["2026-03-21", "2026-11-02", "2024-02-29", "2025-03-20"];
  for (const iso of samples) {
    const parts = persianDateFromIso(iso);
    assert.ok(parts);
    assert.equal(isoFromPersianDate(parts), iso);
  }
  assert.deepEqual(persianDateFromIso("2026-03-21"), { jy: 1405, jm: 1, jd: 1 });
  assert.deepEqual(persianDateFromIso("2026-11-02"), { jy: 1405, jm: 8, jd: 11 });
  assert.equal(persianMonthLength(1403, 12), 30);
  assert.equal(persianMonthLength(1404, 12), 29);
  assert.equal(isoFromPersianDate({ jy: 1404, jm: 12, jd: 30 }), null);
});

test("Persian calendar formatting and week alignment use Persian digits and Saturday-first weeks", () => {
  const parts = persianDateFromIso("2026-11-02")!;
  assert.equal(formatPersianDate(parts), "۱۱ آبان ۱۴۰۵");
  assert.equal(persianWeekdayIndex({ jy: 1405, jm: 8, jd: 1 }), 6);
  assert.match(faDate("2026-03-21T08:00:00.000Z"), /فروردین/);
});

test("numeric entry accepts Persian and Arabic digits without converting blank to zero", () => {
  assert.equal(normalizeNumericInput("۰٫۵"), "0.5");
  assert.equal(normalizeNumericInput("٠٫٧٥"), "0.75");
  assert.equal(normalizeNumericInput("12,5"), "12.5");
  assert.equal(normalizeNumericInput(""), "");
  assert.equal(formatNumericInput(0.5), "۰٫۵");
  assert.equal(formatNumericInput(12), "۱۲");
});
