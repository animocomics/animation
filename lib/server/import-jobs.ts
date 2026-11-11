/**
 * Reading a sheet is slow; a host's reverse proxy is not patient.
 *
 * The failure this fixes, reported verbatim: "پیش‌نویس ساخته نشد — سرور تا پاسخ مدل
 * صبر نکرد (HTTP 504 از پروکسی هاست)". A single POST held the connection open for
 * the whole model call, so the proxy in front of the app — 60 seconds by default in
 * Plesk, and not something the app can change from inside — answered first with its
 * own error page. The work may even have finished on the model's side; the browser
 * had already given up, so the teacher saw a failure and the tokens were spent.
 *
 * The fix is to stop making a slow call look like a slow page load. The POST starts a
 * job and returns in milliseconds; the browser then asks "how is it going?" on a short
 * request that no proxy will ever time out. If a poll is cut, the next one simply
 * asks again — the job is unaffected, because it never belonged to the connection.
 *
 * This state is in-process on purpose: the app runs as one Node process on the host,
 * and a job is worthless without that process. A restart drops running jobs, and the
 * poll answers "این کار پس از راه‌اندازی مجدد سرور از بین رفت" rather than pretending.
 */

export type ImportJobStatus = "working" | "done" | "failed";

export type ImportJobResult = {
  questions?: unknown[];
  warnings?: string[];
  usage?: unknown;
  /** Grading returns a finished result instead of a draft; one reader, both shapes. */
  result?: unknown;
};

export type ImportJobError = {
  message: string;
  issues?: string[];
  status: number;
  code?: string;
};

export type ImportJob = {
  id: string;
  key: string;
  /** "import" reads a sheet into a draft; "grade" scores a student's pages. */
  kind: "import" | "grade";
  status: ImportJobStatus;
  startedAt: number;
  finishedAt?: number;
  /** What the job is doing right now, in the teacher's language. */
  step: string;
  result?: ImportJobResult;
  error?: ImportJobError;
};

const jobs = new Map<string, ImportJob>();
let counter = 0;

/** A finished job is kept long enough to be collected twice; a stuck one is reaped. */
const KEEP_FINISHED_MS = 30 * 60 * 1000;
const STALE_RUNNING_MS = 60 * 60 * 1000;

function newId(now: number): string {
  counter = (counter + 1) % 1_000_000;
  return `import-${now.toString(36)}-${counter.toString(36)}`;
}

export function resetImportJobs(): void {
  jobs.clear();
  counter = 0;
}

/**
 * Start a job, or hand back the one already doing this exact work.
 *
 * The dedupe is the money guard, not a UX nicety: the same exam, the same pages and
 * the same model is the same paid request. Returning the running job instead of a
 * second one means a double click, a refreshed tab or a retried POST after a proxy
 * error all wait for one bill.
 */
export function startImportJob(key: string, now = Date.now(), kind: ImportJob["kind"] = "import"): { job: ImportJob; created: boolean } {
  prune(now);
  for (const job of jobs.values()) {
    if (job.key === key && job.status === "working") return { job, created: false };
  }
  const job: ImportJob = {
    id: newId(now),
    key,
    kind,
    status: "working",
    startedAt: now,
    step: kind === "grade" ? "در حال آماده‌سازی برگه‌ها" : "در حال آماده‌سازی برگه‌ها",
  };
  jobs.set(job.id, job);
  return { job, created: true };
}

/**
 * The job already running for this work, if there is one.
 *
 * A teacher who loses the poll (a reload, a dead network, a phone that went to sleep)
 * has no job id to resume with, and re-sending would buy the same reading twice. This
 * lets the panel say "this is still running" and simply keep polling the work that has
 * already been paid for.
 */
export function findRunningImportJob(key: string): ImportJob | undefined {
  for (const job of jobs.values()) {
    if (job.key === key && job.status === "working") return job;
  }
  return undefined;
}

export function findRunningImportJobByPrefix(prefix: string): ImportJob | undefined {
  for (const job of jobs.values()) {
    if (job.status === "working" && job.key.startsWith(prefix)) return job;
  }
  return undefined;
}

export function getImportJob(id: string): ImportJob | undefined {
  return jobs.get(id);
}

export function setImportStep(id: string, step: string): void {
  const job = jobs.get(id);
  if (job && job.status === "working") job.step = step;
}

export function finishImportJob(id: string, result: ImportJobResult, now = Date.now()): void {
  const job = jobs.get(id);
  if (!job) return;
  job.status = "done";
  job.step = "پایان یافت";
  job.result = result;
  job.finishedAt = now;
}

export function failImportJob(id: string, error: ImportJobError, now = Date.now()): void {
  const job = jobs.get(id);
  if (!job) return;
  job.status = "failed";
  job.step = "متوقف شد";
  job.error = error;
  job.finishedAt = now;
}

/**
 * What the browser is allowed to see. The paid request may take minutes, and a poll
 * must be cheap and honest: elapsed seconds, the current step, and — once finished —
 * either the draft or the reason it stopped.
 */
export function describeImportJob(job: ImportJob, now = Date.now()): Record<string, unknown> {
  const elapsedSeconds = Math.max(0, Math.round(((job.finishedAt ?? now) - job.startedAt) / 1000));
  return {
    jobId: job.id,
    status: job.status,
    step: job.step,
    elapsedSeconds,
    kind: job.kind,
    questions: job.result?.questions,
    warnings: job.result?.warnings,
    usage: job.result?.usage,
    result: job.result?.result,
    error: job.error?.message,
    issues: job.error?.issues,
    code: job.error?.code,
  };
}

function prune(now: number): void {
  for (const [id, job] of jobs) {
    const age = now - (job.finishedAt ?? job.startedAt);
    if (job.status !== "working" && age > KEEP_FINISHED_MS) jobs.delete(id);
    else if (job.status === "working" && age > STALE_RUNNING_MS) jobs.delete(id);
  }
}
