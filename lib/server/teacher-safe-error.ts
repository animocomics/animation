// Keeps provider internals away from teachers.
//
// The grading and import routes used to hand ProviderError.message straight to the
// browser. Those messages name the vendor ("Kaya AI"), the model, HTTP statuses and
// socket codes. A teacher needs to know what to do; how the platform is wired is
// not their business, and a raw "UND_ERR_CONNECT_TIMEOUT" on a grading sheet looks
// like data corruption rather than an outage.
//
// The full message is still stored on the job row for the administrator, so
// nothing is lost for diagnosis.

export interface TeacherSafeError {
  error: string;
  /** True when retrying the same action may succeed (outage, quota, busy). */
  retryable: boolean;
  code: string;
}

const OUTAGE = "سرویس هوش مصنوعی موقتاً در دسترس نیست. برگه شما ذخیره شده است؛ چند دقیقهٔ دیگر دوباره تلاش کنید.";
const GREETING = "تنظیم سرویس هوش مصنوعی سامانه کامل نیست. به مدیر سامانه اطلاع دهید.";
const CREDIT = "سهمیهٔ سرویس هوش مصنوعی سامانه به پایان رسیده است. به مدیر سامانه اطلاع دهید.";
const BUSY = "سرویس هوش مصنوعی شلوغ است. چند لحظهٔ دیگر دوباره تلاش کنید.";
const AUTH = "دسترسی سرویس هوش مصنوعی سامانه معتبر نیست. به مدیر سامانه اطلاع دهید.";

function codeOf(error: unknown): string {
  const value = error as { code?: string; cause?: { code?: string }; status?: number; name?: string } | undefined;
  if (value?.cause?.code) return String(value.cause.code);
  if (value?.code) return String(value.code);
  if (value?.name === "TimeoutError") return "ETIMEDOUT";
  if (value?.status) return `HTTP_${value.status}`;
  return "";
}

const NETWORK_CODES = /^(UND_ERR_|ECONN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|ENOTFOUND|EPIPE|ECONNRESET|EACCES)/;

/** Maps any error thrown by a provider call to something safe for a teacher. */
export function teacherSafeError(error: unknown): TeacherSafeError {
  const code = codeOf(error);
  const message = error instanceof Error ? error.message : "";

  // Size and content limits are actionable for the teacher: they concern their own
  // upload and contain no provider detail.
  if (/بزرگ‌تر از ۱۰۰ مگابایت/.test(message)) {
    return { error: message, retryable: false, code: "file-too-large" };
  }
  if (/حجم تصاویر صفحات پس از آماده‌سازی/.test(message)) {
    return { error: message, retryable: false, code: "prepared-too-large" };
  }
  if (/PDF/.test(message) && /تبدیل/.test(message)) {
    return { error: "این فایل PDF در سامانه قابل تبدیل به تصویر نبود. فایل را دوباره بسازید یا به‌صورت تصویر بفرستید.", retryable: false, code: "pdf-convert" };
  }

  if (NETWORK_CODES.test(code) || /برقرار نشد|timeout|فتیله|ارتباط/.test(message)) {
    return { error: OUTAGE, retryable: true, code: code || "network" };
  }
  if (code === "HTTP_402" || /اعتبار/.test(message)) return { error: CREDIT, retryable: false, code: "credit" };
  if (code === "HTTP_401" || code === "HTTP_403" || /کلید/.test(message)) return { error: AUTH, retryable: false, code: "auth" };
  if (code === "HTTP_429" || /سقف درخواست/.test(message)) return { error: BUSY, retryable: true, code: "busy" };
  if (code.startsWith("HTTP_4") || code === "HTTP_400" || code === "HTTP_404") {
    return { error: GREETING, retryable: false, code: code };
  }
  if (code.startsWith("HTTP_5") || /HTTP 5\d\d/.test(message)) return { error: OUTAGE, retryable: true, code: code };

  // Anything else that smells like a provider or transport failure.
  if (/Kaya|Gemini|DeepSeek|OpenAI|Z\.AI|MiniMax|Inkling|Mistral|مدل /.test(message)) {
    return { error: GREETING, retryable: false, code: code || "provider" };
  }
  return { error: message || "این عملیات کامل نشد. لطفاً دوباره تلاش کنید.", retryable: true, code: code || "unknown" };
}

/** True when the caller is the administrator, who may see the full message. */
export function isAdminRole(role: string | undefined): boolean {
  return role === "admin";
}
