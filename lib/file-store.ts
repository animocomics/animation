"use client";

interface StoredFile {
  id: string;
  blob: Blob;
  name: string;
  type: string;
}

async function apiError(response: Response, fallback: string): Promise<Error> {
  try {
    const payload = await response.json() as { error?: string };
    return new Error(payload.error || fallback);
  } catch {
    return new Error(fallback);
  }
}

export async function storeFile(id: string, file: File): Promise<void> {
  const form = new FormData();
  form.set("id", id);
  form.set("file", file);
  const response = await fetch("/api/files", { method: "POST", body: form });
  if (!response.ok) throw await apiError(response, "بارگذاری فایل روی سرور ناموفق بود.");
}

export async function getStoredFile(id: string): Promise<StoredFile | undefined> {
  const response = await fetch(`/api/files/${encodeURIComponent(id)}`, { cache: "no-store" });
  if (response.status === 404) return undefined;
  if (!response.ok) throw await apiError(response, "خواندن فایل از سرور ناموفق بود.");
  const blob = await response.blob();
  const encodedName = response.headers.get("x-nomreh-file-name") || id;
  let name = id;
  try { name = decodeURIComponent(encodedName); } catch { name = encodedName; }
  return { id, blob, name, type: blob.type };
}

export async function deleteStoredFile(id: string): Promise<void> {
  const response = await fetch(`/api/files/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!response.ok) throw await apiError(response, "حذف فایل ناموفق بود.");
}

export async function clearStoredFiles(): Promise<void> {
  const response = await fetch("/api/files", { method: "DELETE" });
  if (!response.ok) throw await apiError(response, "پاک‌کردن فایل‌ها ناموفق بود.");
}

export async function readStoredFileAsBase64(id: string): Promise<{ name: string; type: string; data: string }> {
  const stored = await getStoredFile(id);
  if (!stored) throw new Error("فایل برگه روی سرور پیدا نشد؛ لطفاً دوباره بارگذاری کنید.");
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.includes(",") ? result.split(",")[1] : result);
    };
    reader.onerror = () => reject(new Error("خواندن فایل برگه ممکن نشد."));
    reader.readAsDataURL(stored.blob);
  });
  return { name: stored.name, type: stored.type, data };
}
