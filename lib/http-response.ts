import { invalidProviderJsonMessage, isJsonParserErrorMessage } from "./error-message";

function persianStatus(status: number) {
  return status > 0 ? status.toLocaleString("fa-IR") : "نامشخص";
}

/**
 * Reads an API response without exposing JSON parser errors or HTML documents to users.
 * Valid JSON is returned even for non-2xx responses so callers can preserve the server's
 * own sanitized provider error. Non-JSON responses retain the meaningful HTTP status.
 */
export async function readJsonResponse<T>(response: Response, actionLabel: string): Promise<T> {
  const body = await response.text();

  try {
    const payload = JSON.parse(body) as T;
    if (payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string" && isJsonParserErrorMessage(payload.error)) {
      return { ...payload, error: `${invalidProviderJsonMessage()} (کد ${persianStatus(response.status)})` } as T;
    }
    return payload;
  } catch {
    const status = persianStatus(response.status);
    const isHtml = /^\s*(?:<!doctype\s+html|<html[\s>])/i.test(body);
    const responseDescription = isHtml ? "یک صفحه HTML" : body.trim() ? "یک پاسخ غیر JSON" : "یک پاسخ خالی";

    if (response.status === 401) {
      throw new Error(`${actionLabel} انجام نشد؛ نشست کاربری معتبر نیست. صفحه را تازه‌سازی کنید و دوباره وارد شوید. (کد ${status})`);
    }
    if (response.status === 403) {
      throw new Error(`${actionLabel} انجام نشد؛ دسترسی به سرویس رد شد. محدودیت حساب یا میزبان را بررسی کنید. (کد ${status})`);
    }
    if (response.status === 404) {
      throw new Error(`${actionLabel} انجام نشد؛ مسیر سرویس روی سرور پیدا نشد. صفحه را تازه‌سازی کنید و دوباره تلاش کنید. (کد ${status})`);
    }
    if (response.status === 413) {
      throw new Error(`${actionLabel} انجام نشد؛ حجم درخواست بیش از حد مجاز سرور است. (کد ${status})`);
    }
    if (response.status === 429) {
      throw new Error(`${actionLabel} انجام نشد؛ محدودیت تعداد درخواست فعال شده است. کمی بعد دوباره تلاش کنید. (کد ${status})`);
    }
    if (response.status >= 500) {
      throw new Error(`${actionLabel} انجام نشد؛ سرور یا میزبان ${responseDescription} با خطا بازگرداند. (کد ${status})`);
    }

    throw new Error(`${actionLabel} با پاسخ نامعتبر سرور مواجه شد؛ سرور ${responseDescription} بازگرداند. صفحه را تازه‌سازی کنید و وضعیت عملیات را بررسی کنید. (کد ${status})`);
  }
}
