/**
 * Does this model actually accept images?
 *
 * The importer and the grader send page images. A text-only model either rejects the
 * request or silently ignores the pictures and invents an answer, which the app then
 * reports as "the draft structure is incomplete". The operator sees a failed import
 * and, because nothing said "this model cannot see", changes the key, then the file,
 * then tries a single page — every attempt billed.
 *
 * The list below is deliberately conservative: only model families whose public API
 * carries no image input at all. Anything uncertain stays allowed, because a false
 * "cannot see" would block a working setup.
 */
const TEXT_ONLY_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /deepseek/i, reason: "مدل‌های DeepSeek ورودی تصویر را قبول نمی‌کنند" },
  { pattern: /gpt-oss/i, reason: "مدل gpt-oss ورودی تصویر ندارد" },
  { pattern: /llama-3(?:\.3)?-(?:70b|8b)/i, reason: "این مدل Llama ورودی تصویر ندارد" },
];

/** A short Persian reason when the model cannot read a page image, otherwise null. */
export function textOnlyReason(model: string): string | null {
  const name = String(model || "").trim();
  if (!name) return null;
  for (const { pattern, reason } of TEXT_ONLY_PATTERNS) {
    if (pattern.test(name)) return reason;
  }
  return null;
}

/** True when a vision-capable model must be selected for this work. */
export function taskNeedsVision(task: string | undefined, hasFiles: boolean): boolean {
  if (!hasFiles) return false;
  return task === "grading" || task === "question-import" || task === "answer-key-import";
}

export function textOnlyMessage(model: string, reason: string): string {
  return `مدل «${model}» برای این کار مناسب نیست: ${reason}. خواندن برگه و تصحیح به مدلی نیاز دارد که تصویر را ببیند؛ `
    + `در پنل ادمین مدلی با پشتیبانی تصویر (مثل gemini-2.5-flash، gpt-4o یا claude-sonnet) انتخاب کنید. `
    + `این درخواست پیش از تماس با سرویس متوقف شد تا هزینه‌ای پرداخت نشود.`;
}

/**
 * A three-way verdict for the operator panel.
 *
 * "no" is only returned for a model on the known text-only list — the same list the
 * request path enforces, so the panel and the refusal can never disagree. "unknown"
 * means the id carries no vision naming and is not known to be blind: the operator
 * should look twice, but nothing is blocked.
 */
export function visionVerdict(model: string): "yes" | "unknown" | "no" {
  const name = String(model || "").trim();
  if (!name) return "unknown";
  if (textOnlyReason(name)) return "no";
  const id = name.toLowerCase();
  // Naming that means the model sees, or that says nothing either way.
  if (/(4o|vision|vl\b|gemini|claude-3\.5|claude-3\.7|claude-sonnet-4|claude-sonnet-5|omni|llava|internvl|gpt-4\.1|gpt-5)/.test(id)) return "yes";
  return "unknown";
}
