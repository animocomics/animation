/**
 * The vocabulary of the subject, given to the reader.
 *
 * On the operator's sheet a readable word came back as «بیان» instead of «ضمان», and a
 * jurist's name as «لندروکا» instead of «لنگرودی». Those are not random slips. Handwriting
 * gives a reader a shape; «ضمان» and «بیان» differ in two dots, and a reader that expects
 * ordinary Persian prose completes the shape with the common word instead of the word this
 * course is about. Naming the words this course actually uses removes most of that bias,
 * costs a few hundred tokens per import, and needs no new step in the pipeline.
 *
 * What this module does NOT do is rewrite the transcription. The app's promise is that a
 * value it shows was read off the page. A gloss that quietly replaces «بیان» with «ضمان»
 * would break that promise the first time the sheet really did say «بیان». So the vocabulary
 * only ever reaches the model as a hint, and the model is still told that a guess is worse
 * than an admitted unreadable word.
 *
 * Terms live in `data/glossary/`, one text file per subject, so a teacher can add the
 * vocabulary of their own course without touching code. `NOMREH_GLOSSARY` points at another
 * folder when a deployment keeps its data elsewhere.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * Words that a general-purpose reader misreads on a handwritten sheet of this subject: the
 * jurists whose opinions these questions cite, the Shia sources they cite, and the technical
 * nouns whose letters differ from an everyday word by a dot or two.
 */
const DEFAULT_TERMS: string[] = [
  "لنگرودی", "کاتوزیان", "امام خمینی", "شهید اول", "شهید ثانی", "صاحب جواهر", "محقق حلی", "علامه حلی", "شیخ انصاری", "ابن ادریس", "ابن براج", "محقق اردبیلی", "میرزای قمی", "سلار",
  "الوسیله", "شرایع الاسلام", "جواهر الکلام", "وسائل الشیعه", "کفایه الاصول", "مکاسب", "قواعد فقه",
  "ید", "علی الید", "الید", "ضمان", "اجاره", "مستأجر", "موجر", "اجل", "حبس", "قضاوت", "قاضی", "گواهی", "اقرار", "بیع", "خیار", "قصاص", "دیه", "حدود", "تعزیر", "ارث", "وصیت", "وکالت", "رهن", "کفالت", "حواله", "مضاربه", "مزارعه", "مساقات", "شفعه", "وقف", "نکاح", "طلاق", "عدّه", "نفقه", "حضانت",
];

export function loadGlossaryTerms(): string[] {
  const terms = new Set(DEFAULT_TERMS);
  const directory = process.env.NOMREH_GLOSSARY || path.join(process.cwd(), "data", "glossary");
  try {
    for (const name of fs.readdirSync(directory)) {
      if (!name.endsWith(".txt")) continue;
      const text = fs.readFileSync(path.join(directory, name), "utf8");
      for (const line of text.split(/\r?\n/)) {
        const term = line.replace(/#.*$/, "").trim();
        if (term.length >= 2) terms.add(term);
      }
    }
  } catch {
    // No glossary folder is normal: the built-in list covers a first run.
  }
  return [...terms];
}

/**
 * The hint the reader receives.
 *
 * It is written as a tie-breaker, not an instruction to invent: when a shape could be read
 * as either a word of this subject or a word of ordinary Persian, prefer the one in the list.
 * The last sentence repeats the rule it must not break — an unreadable word is still reported
 * as unreadable.
 */
export function glossaryPromptHint(terms: string[] = loadGlossaryTerms()): string {
  if (!terms.length) return "";
  // Only the words long enough to be a real hint; a list of two-letter terms teaches nothing.
  const shown = terms.filter((term) => term.replace(/\s/g, "").length >= 3).slice(0, 80);
  return `- این برگه‌ها از درس فقه و حقوق اسلامی است. وقتی یک شکل دست‌خطی را می‌شود هم به یک واژهٔ معمولی فارسی خواند و هم به یکی از واژه‌های زیر، واژهٔ همین فهرست را انتخاب کن: ${shown.join("، ")}. این فهرست فقط راهنمای ترجیح است؛ اگر شکل خوانا نیست، حدس نزن و طبق قاعدهٔ بالا ناخوانا اعلام کن.`;
}
