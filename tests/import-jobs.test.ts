import test from "node:test";
import assert from "node:assert/strict";
import {
  describeImportJob,
  failImportJob,
  finishImportJob,
  getImportJob,
  resetImportJobs,
  setImportStep,
  startImportJob,
} from "../lib/server/import-jobs";

/**
 * The reported failure: "پیش‌نویس ساخته نشد — HTTP 504 از پروکسی هاست".
 *
 * A reverse proxy in front of the app gives up after about a minute. As long as the
 * POST itself waited for the model, every read that took longer than that arrived at
 * the browser as a proxy error page, with the draft lost even when the model had
 * finished. These tests pin the property that fixes it: the request that starts the
 * work returns immediately, and progress is read from a separate cheap request.
 */

test("starting a read answers immediately instead of waiting for the model", () => {
  resetImportJobs();
  const { job, created } = startImportJob("exam-1|file-a|gemini|2.5-flash");
  assert.equal(created, true);
  assert.equal(job.status, "working");
  assert.match(job.step, /آماده‌سازی/);
  // Nothing about the job requires the HTTP request that created it to stay open.
  assert.ok(getImportJob(job.id), "the job exists independently of the connection");
});

test("a second POST for the same pages returns the job already in flight, not a second bill", () => {
  resetImportJobs();
  const first = startImportJob("exam-1|file-a");
  const second = startImportJob("exam-1|file-a");
  assert.equal(second.created, false);
  assert.equal(second.job.id, first.job.id);
});

test("different pages are different work", () => {
  resetImportJobs();
  const first = startImportJob("exam-1|file-a");
  const second = startImportJob("exam-1|file-b");
  assert.equal(second.created, true);
  assert.notEqual(second.job.id, first.job.id);
});

test("polling reports the step and the elapsed seconds while work continues", () => {
  resetImportJobs();
  const started = Date.now();
  const { job } = startImportJob("k", started);
  setImportStep(job.id, "در حال خواندن برگه‌ها با مدل");
  const snapshot = describeImportJob(getImportJob(job.id)!, started + 42_000);
  assert.equal(snapshot.status, "working");
  assert.equal(snapshot.step, "در حال خواندن برگه‌ها با مدل");
  assert.equal(snapshot.elapsedSeconds, 42);
});

test("a finished job hands back the draft on a later poll, however long the model took", () => {
  resetImportJobs();
  const { job } = startImportJob("k", 1_000);
  finishImportJob(job.id, { questions: [{ number: 1 }], warnings: ["کلید سؤال ۱ خوانده نشد"] }, 1_000 + 185_000);
  const snapshot = describeImportJob(getImportJob(job.id)!, 1_000 + 200_000);
  assert.equal(snapshot.status, "done");
  assert.deepEqual(snapshot.questions, [{ number: 1 }]);
  assert.equal(snapshot.elapsedSeconds, 185);
});

test("a failed job carries the reason the teacher must read", () => {
  resetImportJobs();
  const { job } = startImportJob("k");
  failImportJob(job.id, { status: 400, message: "مدل انتخابی تصویر را نمی‌خواند.", code: "model-without-vision" });
  const snapshot = describeImportJob(getImportJob(job.id)!);
  assert.equal(snapshot.status, "failed");
  assert.equal(snapshot.code, "model-without-vision");
  assert.match(String(snapshot.error), /تصویر/);
});

test("a job that no longer exists is reported as missing, not as a hang", () => {
  resetImportJobs();
  assert.equal(getImportJob("import-does-not-exist"), undefined);
});

test("a grading job that is still running is reused, never started twice", () => {
  resetImportJobs();
  const first = startImportJob("grade:sub-1:gemini:2.5-flash", Date.now(), "grade");
  const second = startImportJob("grade:sub-1:gemini:2.5-flash", Date.now(), "grade");
  assert.equal(second.created, false);
  assert.equal(second.job.id, first.job.id);
  assert.equal(second.job.kind, "grade");
});

test("a grading job carries the finished result, not a draft", () => {
  resetImportJobs();
  const { job } = startImportJob("grade:sub-2", Date.now(), "grade");
  finishImportJob(job.id, { result: { totalScore: 18, verification: "verified" }, usage: { inputTokens: 10, outputTokens: 5 } });
  const snapshot = describeImportJob(getImportJob(job.id)!);
  assert.equal(snapshot.status, "done");
  assert.equal(snapshot.kind, "grade");
  assert.deepEqual(snapshot.result, { totalScore: 18, verification: "verified" });
});
