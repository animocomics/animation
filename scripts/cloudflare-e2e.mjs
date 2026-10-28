import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { PDFDocument, StandardFonts } from "pdf-lib";

const baseUrl = (process.env.NOMREH_BASE_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const adminUsername = required("NOMREH_ADMIN_USERNAME");
const adminPassword = required("NOMREH_ADMIN_PASSWORD");
const teacherUsername = required("NOMREH_TEACHER_USERNAME");
const teacherPassword = required("NOMREH_TEACHER_PASSWORD");
const checks = [];

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the deployment smoke test.`);
  return value;
}

function jar() {
  return { cookie: "" };
}

async function request(path, options = {}, cookieJar) {
  const headers = new Headers(options.headers || {});
  if (cookieJar?.cookie) headers.set("cookie", cookieJar.cookie);
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers, redirect: "manual" });
  const setCookie = response.headers.get("set-cookie");
  if (cookieJar && setCookie) cookieJar.cookie = setCookie.split(";")[0];
  const data = await response.arrayBuffer();
  const text = Buffer.from(data).toString("utf8");
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { response, body, bytes: Buffer.from(data) };
}

function expectStatus(result, status, label) {
  assert.equal(result.response.status, status, `${label}: expected ${status}, received ${result.response.status} (${JSON.stringify(result.body).slice(0, 300)})`);
  checks.push(label);
}

async function login(username, password) {
  const cookieJar = jar();
  const result = await request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  }, cookieJar);
  expectStatus(result, 200, `login ${username}`);
  assert.ok(cookieJar.cookie.startsWith("nomreh_session="));
  return { cookieJar, user: result.body.user };
}

const emptyWorkspace = {
  exams: [],
  classes: [],
  settings: { provider: "openai", model: "gpt-4.1-mini", gradingMode: "balanced", reviewThreshold: 0.7, anonymize: true, requireApproval: true },
};

const now = new Date().toISOString();
const populatedWorkspace = {
  ...emptyWorkspace,
  classes: [{
    id: "cf_class_e2e", name: "کلاس آزمون ابری", grade: "یازدهم", subject: "زیست‌شناسی", academicYear: "1405",
    students: [{ id: "cf_student_e2e", name: "دانش‌آموز آزمایشی", code: "CF-001", active: true }],
    createdAt: now, updatedAt: now,
  }],
  exams: [{
    id: "cf_exam_e2e", title: "آزمون سلامت سامانه", code: "CF-E2E", subject: "زیست‌شناسی", classId: "cf_class_e2e", className: "کلاس آزمون ابری", date: "1405/08/06", passScore: 50, duration: 60, status: "ready",
    questions: [{ id: "cf_question_e2e", number: 1, type: "short_answer", prompt: "پاسخ کوتاه را بنویسید.", maxScore: 5, answer: "پاسخ معیار", options: [], acceptedAnswers: ["پاسخ معیار"], partialCredit: false, errorCarriedForward: false, rubric: [] }],
    settings: { gradingMode: "balanced", reviewThreshold: 0.7, anonymize: true, requireApproval: true, instructions: "پاسخ‌های ناخوانا را برای بازبینی علامت بزن." },
    submissions: [], createdAt: now, updatedAt: now,
  }],
};

const loginPage = await request("/login");
expectStatus(loginPage, 200, "public login page");
const admin = await login(adminUsername, adminPassword);
assert.equal(admin.user.role, "admin");
const adminMe = await request("/api/auth/me", {}, admin.cookieJar);
expectStatus(adminMe, 200, "admin session");
assert.equal(adminMe.body.user.role, "admin");

const qaUsername = `cf-e2e-${randomUUID().slice(0, 10)}`;
const qaPassword = `Qa1_${randomBytes(18).toString("base64url")}`;
const created = await request("/api/admin/users", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: qaUsername, displayName: "معلم آزمون ابری", password: qaPassword, role: "teacher" }),
}, admin.cookieJar);
expectStatus(created, 201, "admin creates teacher");
assert.ok(created.body.users.some((user) => user.username === qaUsername));
const teacher = await login(qaUsername, qaPassword);
const forbidden = await request("/api/admin/users", {}, teacher.cookieJar);
expectStatus(forbidden, 403, "teacher cannot read admin users");
const teacherProvider = await request("/api/provider", {}, teacher.cookieJar);
expectStatus(teacherProvider, 200, "teacher provider status");
assert.equal(Object.hasOwn(teacherProvider.body.status, "keyHint"), false);
assert.equal(JSON.stringify(teacherProvider.body).includes(qaPassword), false);

const saved = await request("/api/workspace", {
  method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: populatedWorkspace, expectedRevision: 0 }),
}, teacher.cookieJar);
expectStatus(saved, 200, "teacher saves class roster and exam");
assert.equal(saved.body.revision, 1);
const loaded = await request("/api/workspace", {}, teacher.cookieJar);
expectStatus(loaded, 200, "teacher reads persistent workspace");
assert.equal(loaded.body.data.classes[0].students[0].code, "CF-001");
assert.equal(loaded.body.data.exams[0].code, "CF-E2E");
const conflict = await request("/api/workspace", {
  method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: emptyWorkspace, expectedRevision: 0 }),
}, teacher.cookieJar);
expectStatus(conflict, 409, "stale workspace revision is rejected");
const adminWorkspace = await request("/api/workspace", {}, admin.cookieJar);
expectStatus(adminWorkspace, 200, "admin workspace remains isolated");
assert.equal(adminWorkspace.body.data?.exams?.some((exam) => exam.id === "cf_exam_e2e") || false, false);

const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
for (const text of ["Nomreh Cloudflare page one", "Nomreh Cloudflare page two"]) {
  const page = pdf.addPage([612, 792]);
  page.drawText(text, { x: 70, y: 700, size: 24, font });
}
const pdfBytes = Buffer.from(await pdf.save());
const form = new FormData();
form.append("id", "cf_e2e_pdf");
form.append("file", new File([pdfBytes], "cloudflare-e2e.pdf", { type: "application/pdf" }));
const uploaded = await request("/api/files", { method: "POST", body: form }, teacher.cookieJar);
expectStatus(uploaded, 201, "teacher uploads PDF");
const original = await request("/api/files/cf_e2e_pdf", {}, teacher.cookieJar);
expectStatus(original, 200, "owner downloads original PDF");
assert.deepEqual(original.bytes, pdfBytes);
const preview = await request("/api/files/cf_e2e_pdf/preview?page=2", {}, teacher.cookieJar);
expectStatus(preview, 200, "authenticated PDF page preview");
assert.match(preview.response.headers.get("content-type") || "", /^image\/jpeg/);
assert.equal(preview.bytes.subarray(0, 3).toString("hex"), "ffd8ff");
assert.ok(preview.bytes.length > 10_000);
const unauthenticatedFile = await request("/api/files/cf_e2e_pdf");
expectStatus(unauthenticatedFile, 401, "file requires authentication");
const crossOwnerFile = await request("/api/files/cf_e2e_pdf", {}, admin.cookieJar);
expectStatus(crossOwnerFile, 404, "file is isolated by owner");

// Leave the public deployment clean after proving persistence and ownership.
const clearedFiles = await request("/api/files", { method: "DELETE" }, teacher.cookieJar);
expectStatus(clearedFiles, 200, "QA files cleared");
const cleanedWorkspace = await request("/api/workspace", {
  method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: emptyWorkspace, expectedRevision: 1 }),
}, teacher.cookieJar);
expectStatus(cleanedWorkspace, 200, "QA workspace cleared");
const deactivated = await request("/api/admin/users", {
  method: "PATCH", headers: { "content-type": "application/json" },
  body: JSON.stringify({ id: created.body.users.find((user) => user.username === qaUsername).id, active: false }),
}, admin.cookieJar);
expectStatus(deactivated, 200, "QA teacher deactivated");

console.log(JSON.stringify({ ok: true, baseUrl, checks: checks.length, qaUsername, details: checks }, null, 2));
