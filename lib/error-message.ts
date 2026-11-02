export function isJsonParserErrorMessage(value: unknown): boolean {
  const message = value instanceof Error ? value.message : typeof value === "string" ? value : "";
  return /Unexpected token|not valid JSON|JSON\.parse|JSON parse|<!DOCTYPE/i.test(message);
}

export function invalidProviderJsonMessage(): string {
  return "سرویس‌دهنده یا میزبان پاسخ JSON معتبر نداد؛ ممکن است پاسخ HTML یا ناقص باشد. مسیر شبکه یا شکن را بررسی کنید و دوباره تلاش کنید.";
}
