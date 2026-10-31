const SAFE_ID = /^[A-Za-z0-9_-]{1,180}$/;
export const ACCEPTED_FILE_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"] as const;

type StoredFile = { data: Buffer; name: string; type: string };

function assertUserId(userId: string): void {
  if (!SAFE_ID.test(userId)) throw new Error("شناسهٔ کاربر معتبر نیست.");
}

export function assertFileId(id: string): void {
  if (!SAFE_ID.test(id)) throw new Error("شناسهٔ فایل معتبر نیست.");
}

function validateFile(file: File): void {
  if (!(ACCEPTED_FILE_TYPES as readonly string[]).includes(file.type)) throw new Error("فرمت فایل پشتیبانی نمی‌شود.");
  if (file.size < 10 || file.size > 15 * 1024 * 1024) throw new Error("حجم فایل باید کمتر از ۱۵ مگابایت باشد.");
}

export async function saveUserFile(userId: string, id: string, file: File): Promise<void> {
  assertUserId(userId);
  assertFileId(id);
  validateFile(file);
  return (await import("./local-file-storage")).saveLocalUserFile(userId, id, file);
}

export async function readUserFile(userId: string, id: string): Promise<StoredFile | null> {
  assertUserId(userId);
  assertFileId(id);
  return (await import("./local-file-storage")).readLocalUserFile(userId, id);
}

export async function deleteUserFile(userId: string, id: string): Promise<void> {
  assertUserId(userId);
  assertFileId(id);
  return (await import("./local-file-storage")).deleteLocalUserFile(userId, id);
}

export async function clearUserFiles(userId: string): Promise<void> {
  assertUserId(userId);
  return (await import("./local-file-storage")).clearLocalUserFiles(userId);
}
