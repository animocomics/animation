import assert from "node:assert/strict";
import { PDFDocument, StandardFonts } from "pdf-lib";

const phase = process.argv[2];
const baseUrl = (process.env.NOMREH_BASE_URL || "").replace(/\/$/, "");
if (!baseUrl || !["write", "verify"].includes(phase)) throw new Error("Use NOMREH_BASE_URL and write|verify.");
const username = process.env.NOMREH_TEACHER_USERNAME;
const password = process.env.NOMREH_TEACHER_PASSWORD;
if (!username || !password) throw new Error("Teacher credentials are required.");
let cookie = "";

async function call(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (cookie) headers.set("cookie", cookie);
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const bytes = Buffer.from(await response.arrayBuffer());
  let body;
  try { body = JSON.parse(bytes.toString("utf8")); } catch { body = bytes.toString("utf8"); }
  return { response, body, bytes };
}

const login = await call("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }) });
assert.equal(login.response.status, 200, "teacher login");
const now = new Date().toISOString();
const data = {
  exams: [],
  classes: [{ id: "cf_persistence_class", name: "کلاس ماندگاری", grade: "دهم", subject: "آزمون", academicYear: "1405", students: [{ id: "cf_persistence_student", name: "دانش‌آموز ماندگاری", code: "PERSIST-1", active: true }], createdAt: now, updatedAt: now }],
  settings: { provider: "openai", model: "gpt-4.1-mini", gradingMode: "balanced", reviewThreshold: 0.7, anonymize: true, requireApproval: true },
};
const empty = { ...data, classes: [] };
const current = await call("/api/workspace");
assert.equal(current.response.status, 200, "read workspace");

if (phase === "write") {
  assert.equal(current.body.data, null, "seeded teacher starts with a clean workspace");
  const saved = await call("/api/workspace", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ data, expectedRevision: 0 }) });
  assert.equal(saved.response.status, 200, "write persistent workspace");
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);
  page.drawText("Nomreh persistent file", { x: 70, y: 700, size: 24, font });
  const form = new FormData();
  form.append("id", "cf_persistence_pdf");
  form.append("file", new File([Buffer.from(await pdf.save())], "persistent.pdf", { type: "application/pdf" }));
  const uploaded = await call("/api/files", { method: "POST", body: form });
  assert.equal(uploaded.response.status, 201, "write persistent file");
  console.log("Persistence fixture written; ready for a second Worker deployment.");
} else {
  assert.equal(current.body.data.classes[0].students[0].code, "PERSIST-1", "workspace survived redeploy");
  const file = await call("/api/files/cf_persistence_pdf");
  assert.equal(file.response.status, 200, "file survived redeploy");
  assert.equal(file.bytes.subarray(0, 5).toString(), "%PDF-");
  const preview = await call("/api/files/cf_persistence_pdf/preview?page=1");
  assert.equal(preview.response.status, 200, "PDF rendering survived redeploy");
  assert.equal(preview.bytes.subarray(0, 3).toString("hex"), "ffd8ff");
  const deleted = await call("/api/files", { method: "DELETE" });
  assert.equal(deleted.response.status, 200, "persistent file cleanup");
  const cleaned = await call("/api/workspace", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: empty, expectedRevision: current.body.revision }) });
  assert.equal(cleaned.response.status, 200, "persistent workspace cleanup");
  console.log("D1 workspace and KV file survived a second deployment; QA data cleaned.");
}
