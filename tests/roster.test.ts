import assert from "node:assert/strict";
import test from "node:test";
import { applyIdentityMatch, matchStudentIdentity, parseRosterCsv, populateRosterSubmissions } from "../lib/roster";
import type { Exam, GradingResult, SchoolClass, Submission } from "../lib/types";

const schoolClass: SchoolClass = {
  id: "class_1", name: "یازدهم تجربی · گروه الف", grade: "یازدهم", subject: "زیست", academicYear: "۱۴۰۵",
  students: [
    { id: "student_1", name: "سارا محمدی", code: "۹۸۱۲۴", active: true },
    { id: "student_2", name: "علی رضایی", code: "۹۸۱۲۵", active: true },
  ],
  createdAt: "2026-01-01", updatedAt: "2026-01-01",
};

function identity(name: string, className = "یازدهم تجربی", confidence = 0.95) {
  return { detectedStudentName: name, detectedClassName: className, identityConfidence: confidence };
}

function result(name: string): GradingResult {
  return {
    ...identity(name), totalScore: 15, maxScore: 20, percentage: 75, overallConfidence: 0.9,
    summary: "", strengths: [], improvements: [], questions: [], flags: [], provider: "openai", model: "test",
    gradedAt: "2026-01-01", verification: "not_requested", usage: { inputTokens: 0, outputTokens: 0 },
  };
}

function submission(patch: Partial<Submission> = {}): Submission {
  return { id: "submission_1", studentName: "", studentCode: "", files: [], status: "processing", audit: [], ...patch };
}

test("exact Persian identity matching fills canonical roster name and code", () => {
  const match = matchStudentIdentity(identity("سارا  محمدی"), schoolClass);
  assert.equal(match.status, "matched");
  assert.equal(match.student?.id, "student_1");
  const updated = applyIdentityMatch(submission(), result("سارا محمدی"), schoolClass);
  assert.equal(updated.studentCode, "۹۸۱۲۴");
  assert.equal(updated.studentId, "student_1");
  assert.equal(updated.status, "graded");
});

test("a contradictory class label blocks otherwise exact automatic matching", () => {
  const match = matchStudentIdentity(identity("سارا محمدی", "دهم ریاضی"), schoolClass);
  assert.equal(match.status, "ambiguous");
  assert.equal(match.student, undefined);
});

test("duplicate roster names and low-confidence reads are never silently assigned", () => {
  const duplicates = { ...schoolClass, students: [...schoolClass.students, { id: "student_3", name: "سارا محمدی", code: "۹۸۱۲۶", active: true }] };
  assert.equal(matchStudentIdentity(identity("سارا محمدی"), duplicates).status, "ambiguous");
  assert.equal(matchStudentIdentity(identity("سارا محمدی", "یازدهم", 0.4), schoolClass).status, "ambiguous");
});

test("an AI name conflicting with a previous assignment requires teacher review", () => {
  const updated = applyIdentityMatch(submission({ studentId: "student_2", studentName: "علی رضایی", studentCode: "۹۸۱۲۵" }), result("سارا محمدی"), schoolClass);
  assert.equal(updated.status, "needs_review");
  assert.equal(updated.identityStatus, "ambiguous");
  assert.equal(updated.studentId, "student_2");
  assert.equal(updated.studentName, "علی رضایی");
  assert.equal(updated.studentCode, "۹۸۱۲۵");
});

test("a class mismatch never silently removes an existing roster assignment", () => {
  const updated = applyIdentityMatch(
    submission({ studentId: "student_1", studentName: "سارا محمدی", studentCode: "۹۸۱۲۴" }),
    { ...result("سارا محمدی"), detectedClassName: "دهم ریاضی" },
    schoolClass,
  );
  assert.equal(updated.identityStatus, "ambiguous");
  assert.equal(updated.status, "needs_review");
  assert.equal(updated.studentId, "student_1");
  assert.equal(updated.studentCode, "۹۸۱۲۴");
});

test("roster population preserves results and creates visible missing rows", () => {
  const exam: Exam = {
    id: "exam_1", title: "آزمون", code: "BIO-1", subject: "زیست", classId: "class_1", className: schoolClass.name,
    date: "2026-01-01", passScore: 10, duration: 60, status: "ready", questions: [],
    settings: { gradingMode: "fast", reviewThreshold: 0.8, anonymize: true, requireApproval: true, instructions: "" },
    createdAt: "2026-01-01", updatedAt: "2026-01-01",
    submissions: [submission({ studentId: "student_1", studentName: "سارا محمدی", studentCode: "۹۸۱۲۴", status: "graded", result: result("سارا محمدی") })],
  };
  const rows = populateRosterSubmissions(exam, schoolClass);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.studentId === "student_1")?.result?.totalScore, 15);
  const missing = rows.find((row) => row.studentId === "student_2");
  assert.equal(missing?.identityStatus, "missing");
  assert.equal(missing?.files.length, 0);
});

test("CSV roster import supports Persian headers, quoted delimiters and duplicates", () => {
  const rows = parseRosterCsv("\uFEFFنام و نام خانوادگی,کد دانش‌آموزی\r\n\"احمدی، سارا\",۱۲۳\r\nعلی رضایی,۱۲۴\r\nعلی رضایی,۱۲۴\r\n");
  assert.deepEqual(rows, [{ name: "احمدی، سارا", code: "۱۲۳" }, { name: "علی رضایی", code: "۱۲۴" }]);
});
