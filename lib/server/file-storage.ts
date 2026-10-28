import { getCloudflareBindings, isCloudflareRuntime } from "./cloudflare";

const SAFE_ID = /^[A-Za-z0-9_-]{1,180}$/;
export const ACCEPTED_FILE_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"] as const;

type StoredFile = { data: Buffer; name: string; type: string };
type FileMetadata = { name: string; type: string; size: number };

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

function keys(userId: string, id: string) {
  return { data: `uploads/${userId}/${id}.bin`, metadata: `uploads/${userId}/${id}.json` };
}

export async function saveUserFile(userId: string, id: string, file: File): Promise<void> {
  assertUserId(userId);
  assertFileId(id);
  validateFile(file);
  const bindings = getCloudflareBindings();
  if (bindings?.UPLOADS) {
    const key = keys(userId, id);
    const metadata: FileMetadata = { name: file.name.slice(0, 300), type: file.type, size: file.size };
    await bindings.UPLOADS.put(key.data, await file.arrayBuffer(), {
      httpMetadata: { contentType: file.type },
      customMetadata: { name: metadata.name, type: metadata.type, size: String(metadata.size) },
    });
    return;
  }
  if (bindings?.UPLOADS_KV) {
    const key = keys(userId, id);
    const metadata: FileMetadata = { name: file.name.slice(0, 300), type: file.type, size: file.size };
    await bindings.UPLOADS_KV.put(key.data, await file.arrayBuffer());
    await bindings.UPLOADS_KV.put(key.metadata, JSON.stringify(metadata));
    return;
  }
  if (isCloudflareRuntime()) throw new Error("فضای ذخیره‌سازی فایل در Cloudflare پیکربندی نشده است.");
  return (await import("./local-file-storage")).saveLocalUserFile(userId, id, file);
}

export async function readUserFile(userId: string, id: string): Promise<StoredFile | null> {
  assertUserId(userId);
  assertFileId(id);
  const bindings = getCloudflareBindings();
  if (bindings?.UPLOADS) {
    const object = await bindings.UPLOADS.get(keys(userId, id).data);
    if (!object) return null;
    const metadata = object.customMetadata;
    return { data: Buffer.from(await object.arrayBuffer()), name: metadata?.name || "فایل", type: metadata?.type || object.httpMetadata?.contentType || "application/octet-stream" };
  }
  if (bindings?.UPLOADS_KV) {
    const key = keys(userId, id);
    const [data, rawMetadata] = await Promise.all([
      bindings.UPLOADS_KV.get(key.data, "arrayBuffer"),
      bindings.UPLOADS_KV.get(key.metadata, "text"),
    ]);
    if (!data || !rawMetadata) return null;
    try {
      const metadata = JSON.parse(rawMetadata) as FileMetadata;
      return { data: Buffer.from(data), name: metadata.name, type: metadata.type };
    } catch {
      return null;
    }
  }
  if (isCloudflareRuntime()) throw new Error("فضای ذخیره‌سازی فایل در Cloudflare پیکربندی نشده است.");
  return (await import("./local-file-storage")).readLocalUserFile(userId, id);
}

export async function deleteUserFile(userId: string, id: string): Promise<void> {
  assertUserId(userId);
  assertFileId(id);
  const bindings = getCloudflareBindings();
  if (bindings?.UPLOADS) {
    await bindings.UPLOADS.delete(keys(userId, id).data);
    return;
  }
  if (bindings?.UPLOADS_KV) {
    const key = keys(userId, id);
    await Promise.all([bindings.UPLOADS_KV.delete(key.data), bindings.UPLOADS_KV.delete(key.metadata)]);
    return;
  }
  if (isCloudflareRuntime()) throw new Error("فضای ذخیره‌سازی فایل در Cloudflare پیکربندی نشده است.");
  return (await import("./local-file-storage")).deleteLocalUserFile(userId, id);
}

export async function clearUserFiles(userId: string): Promise<void> {
  assertUserId(userId);
  const bindings = getCloudflareBindings();
  const prefix = `uploads/${userId}/`;
  if (bindings?.UPLOADS) {
    let cursor: string | undefined;
    do {
      const listed = await bindings.UPLOADS.list({ prefix, cursor });
      if (listed.objects.length) await bindings.UPLOADS.delete(listed.objects.map((object) => object.key));
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
    return;
  }
  if (bindings?.UPLOADS_KV) {
    let cursor: string | undefined;
    do {
      const listed = await bindings.UPLOADS_KV.list({ prefix, cursor });
      await Promise.all(listed.keys.map((key) => bindings.UPLOADS_KV!.delete(key.name)));
      cursor = listed.list_complete ? undefined : listed.cursor;
    } while (cursor);
    return;
  }
  if (isCloudflareRuntime()) throw new Error("فضای ذخیره‌سازی فایل در Cloudflare پیکربندی نشده است.");
  return (await import("./local-file-storage")).clearLocalUserFiles(userId);
}
