import type { Exam, GradingResult, SchoolClass, Student, Submission } from "./types";
import { normalizeAnswer, uid } from "./utils";

export interface IdentityMatch {
  status: NonNullable<Submission["identityStatus"]>;
  student?: Student;
  candidates: Array<{ student: Student; score: number }>;
  message: string;
}

function classMatches(detected: string, expected: string): boolean {
  const a = normalizeAnswer(detected);
  const b = normalizeAnswer(expected);
  if (!a || !b) return true;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const expectedTokens = new Set(b.split(" ").filter((token) => token.length > 1 && !["کلاس", "گروه", "پایه"].includes(token)));
  const detectedTokens = a.split(" ").filter((token) => token.length > 1 && !["کلاس", "گروه", "پایه"].includes(token));
  return detectedTokens.length > 0 && detectedTokens.every((token) => expectedTokens.has(token));
}

export function matchStudentIdentity(
  result: Pick<GradingResult, "detectedStudentName" | "detectedStudentCode" | "detectedClassName" | "identityConfidence">,
  schoolClass: SchoolClass | undefined,
): IdentityMatch {
  const name = result.detectedStudentName.trim();
  const code = normalizeAnswer(result.detectedStudentCode ?? "");
  if (!schoolClass) return { status: "unmatched", candidates: [], message: "برای این آزمون کلاس و فهرست دانش‌آموزان تعیین نشده است." };
  if (result.detectedClassName && !classMatches(result.detectedClassName, schoolClass.name)) {
    return { status: "ambiguous", candidates: [], message: `کلاس روی برگه («${result.detectedClassName}») با کلاس آزمون («${schoolClass.name}») همخوانی ندارد.` };
  }
  if (!name && !code) return { status: "missing", candidates: [], message: "نام و کد دانش‌آموز روی برگه خوانده نشد؛ انتساب دستی لازم است." };

  const activeStudents = schoolClass.students.filter((student) => student.active);
  const nameMatches = name ? activeStudents.filter((student) => normalizeAnswer(student.name) === normalizeAnswer(name)) : [];
  const codeMatches = code ? activeStudents.filter((student) => normalizeAnswer(student.code) === code) : [];
  const candidatesFor = (students: Student[]) => students.map((student) => ({ student, score: 1 }));

  if (code) {
    if (codeMatches.length === 1) {
      const student = codeMatches[0];
      if (name && normalizeAnswer(student.name) !== normalizeAnswer(name)) {
        return { status: "ambiguous", candidates: candidatesFor([...codeMatches, ...nameMatches.filter((item) => item.id !== student.id)]), message: "نام و کد خوانده‌شده روی برگه به یک دانش‌آموز اشاره نمی‌کنند؛ انتساب خودکار انجام نشد." };
      }
      if (result.identityConfidence < 0.6) {
        return { status: "ambiguous", candidates: candidatesFor(codeMatches), message: "اطمینان به هویت خوانده‌شده پایین است؛ کد و نام باید توسط معلم تأیید شود." };
      }
      return { status: "matched", student, candidates: candidatesFor(codeMatches), message: "کد دانش‌آموزی روی برگه با فهرست کلاس تطبیق داده شد." };
    }
    if (codeMatches.length > 1) {
      return { status: "ambiguous", candidates: candidatesFor(codeMatches), message: "این کد در فهرست کلاس یکتا نیست؛ انتساب خودکار انجام نشد." };
    }
    return {
      status: nameMatches.length ? "ambiguous" : "unmatched",
      candidates: candidatesFor(nameMatches),
      message: "کد خوانده‌شده با فهرست کلاس مطابقت ندارد؛ هویت بدون تأیید معلم ثبت نمی‌شود.",
    };
  }

  if (nameMatches.length === 1 && result.identityConfidence >= 0.6) {
    return { status: "matched", student: nameMatches[0], candidates: candidatesFor(nameMatches), message: "نام برگه با فهرست کلاس تطبیق داده شد." };
  }
  if (nameMatches.length > 1) return { status: "ambiguous", candidates: candidatesFor(nameMatches), message: "بیش از یک دانش‌آموز با این نام در کلاس وجود دارد؛ با کد دانش‌آموزی انتساب را تأیید کنید." };
  return {
    status: result.identityConfidence < 0.6 ? "ambiguous" : "unmatched",
    candidates: [],
    message: result.identityConfidence < 0.6 ? "اطمینان به نام خوانده‌شده پایین است؛ هویت بدون تأیید معلم ثبت نمی‌شود." : "نام خوانده‌شده با هیچ دانش‌آموزی در فهرست کلاس مطابقت قطعی ندارد؛ انتساب تقریبی انجام نمی‌شود.",
  };
}

export function applyIdentityMatch(submission: Submission, result: GradingResult, schoolClass: SchoolClass | undefined): Submission {
  const assigned = schoolClass?.students.find((student) => student.id === submission.studentId);
  let match = matchStudentIdentity(result, schoolClass);
  if (assigned && match.student && match.student.id !== assigned.id) {
    match = { status: "ambiguous", candidates: match.candidates, message: `هویت روی برگه با انتساب قبلی («${assigned.name}») متفاوت است؛ تغییر خودکار انجام نشد.` };
  }
  const preserveAssignment = Boolean(assigned && match.status !== "matched" && submission.identityStatus !== "missing" && submission.identitySource !== "pending");
  const identityNeedsReview = match.status !== "matched";
  const identityFlagId = `identity-${submission.id}`;
  const flagsWithoutIdentity = result.flags.filter((flag) => flag.id !== identityFlagId);
  const nextResult = identityNeedsReview
    ? { ...result, flags: [...flagsWithoutIdentity, { id: identityFlagId, type: "ambiguous" as const, severity: "warning" as const, message: match.message }] }
    : (flagsWithoutIdentity.length === result.flags.length ? result : { ...result, flags: flagsWithoutIdentity });
  const hasCriticalFlags = nextResult.flags.some((flag) => flag.severity !== "info") || nextResult.questions.some((question) => question.needsReview);
  const manualFallback = submission.identitySource === "manual" ? submission : { studentName: "", studentCode: "" };
  return {
    ...submission,
    studentId: preserveAssignment ? assigned?.id : match.student?.id,
    studentName: preserveAssignment ? assigned!.name : match.student?.name || result.detectedStudentName || manualFallback.studentName,
    studentCode: preserveAssignment ? assigned!.code : match.student?.code || result.detectedStudentCode || manualFallback.studentCode,
    detectedClassName: result.detectedClassName || undefined,
    identitySource: "ai",
    identityStatus: match.status,
    identityMessage: preserveAssignment ? `${match.message} انتساب قبلی حفظ شد اما باید تأیید شود.` : match.message,
    result: nextResult,
    status: identityNeedsReview || hasCriticalFlags ? "needs_review" : "graded",
    error: undefined,
  };
}

export function populateRosterSubmissions(exam: Exam, schoolClass: SchoolClass): Submission[] {
  const next = exam.submissions.map((submission) => ({ ...submission }));
  for (const student of schoolClass.students.filter((item) => item.active)) {
    const matching = next.filter((submission) =>
      submission.studentId === student.id
      || (Boolean(student.code) && normalizeAnswer(submission.studentCode) === normalizeAnswer(student.code))
      || (submission.identityStatus !== "unmatched" && normalizeAnswer(submission.studentName) === normalizeAnswer(student.name)),
    );
    if (matching.length === 1) {
      const target = matching[0];
      Object.assign(target, { studentId: student.id, studentName: student.name, studentCode: student.code });
      if (!target.result && target.identitySource !== "ai") {
        target.identityStatus = "matched";
        target.identityMessage = "به فهرست کلاس متصل است؛ برگه هنوز تصحیح نشده است.";
      }
    } else if (matching.length > 1) {
      matching.forEach((submission) => {
        submission.identityStatus = "ambiguous";
        submission.identityMessage = "بیش از یک برگه برای این دانش‌آموز پیدا شد؛ برگهٔ درست را مشخص کنید.";
      });
    } else {
      next.push({
        id: uid("submission"),
        studentId: student.id,
        studentName: student.name,
        studentCode: student.code,
        files: [],
        status: "uploaded",
        identityStatus: "missing",
        identitySource: "roster",
        identityMessage: "برگه‌ای برای این دانش‌آموز بارگذاری یا به او متصل نشده است.",
        audit: [{ id: uid("audit"), at: new Date().toISOString(), actor: "teacher", action: "ایجاد ردیف کارنامه", details: "ردیف از فهرست کلاس ساخته شد؛ در انتظار برگه." }],
      });
    }
  }
  return next;
}

export interface RosterEntry { name: string; code: string }

function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = []; let field = ""; let quoted = false;
  const source = text.replace(/^\uFEFF/, "");
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"') {
      if (quoted && source[index + 1] === '"') { field += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === delimiter && !quoted) { row.push(field.trim()); field = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(field.trim()); field = "";
      if (row.some(Boolean)) rows.push(row); row = [];
    } else field += char;
  }
  row.push(field.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

export function parseRosterCsv(text: string): RosterEntry[] {
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  const delimiter = ["\t", ";", ","].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const rows = parseDelimited(text, delimiter);
  if (!rows.length) return [];
  const header = rows[0].map(normalizeAnswer);
  const hasHeader = header.some((cell) => ["نام", "نام و نام خانوادگی", "نام دانش آموز", "name", "student name", "کد", "کد دانش آموزی", "student code", "code"].includes(cell));
  const nameIndex = hasHeader ? header.findIndex((cell) => /^(نام|name|student)/.test(cell) && !/کد|code/.test(cell)) : 0;
  const codeIndex = hasHeader ? header.findIndex((cell) => /کد|شماره|code|id/.test(cell)) : 1;
  const data = hasHeader ? rows.slice(1) : rows;
  const seen = new Set<string>();
  const result: RosterEntry[] = [];
  for (const row of data) {
    const name = row[Math.max(0, nameIndex)]?.trim() || "";
    const code = codeIndex >= 0 ? row[codeIndex]?.trim() || "" : "";
    if (!name) continue;
    const key = code ? `code:${normalizeAnswer(code)}` : `name:${normalizeAnswer(name)}`;
    if (seen.has(key)) continue;
    seen.add(key); result.push({ name, code });
  }
  return result;
}
