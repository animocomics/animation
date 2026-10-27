"use client";

const DB_NAME = "nomreh-files";
const STORE_NAME = "submission-files";
const DB_VERSION = 1;

interface StoredFile {
  id: string;
  blob: Blob;
  name: string;
  type: string;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("ذخیره‌سازی فایل در این مرورگر پشتیبانی نمی‌شود."));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("باز کردن فضای ذخیره‌سازی ممکن نشد."));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const request = action(transaction.objectStore(STORE_NAME));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("عملیات روی فایل ناموفق بود."));
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("تراکنش فایل ناموفق بود."));
    };
  });
}

export async function storeFile(id: string, file: File): Promise<void> {
  await withStore("readwrite", (store) => store.put({ id, blob: file, name: file.name, type: file.type } satisfies StoredFile));
}

export async function getStoredFile(id: string): Promise<StoredFile | undefined> {
  return withStore("readonly", (store) => store.get(id) as IDBRequest<StoredFile | undefined>);
}

export async function deleteStoredFile(id: string): Promise<void> {
  await withStore("readwrite", (store) => store.delete(id) as unknown as IDBRequest<void>);
}

export async function clearStoredFiles(): Promise<void> {
  await withStore("readwrite", (store) => store.clear() as unknown as IDBRequest<void>);
}

export async function readStoredFileAsBase64(id: string): Promise<{ name: string; type: string; data: string }> {
  const stored = await getStoredFile(id);
  if (!stored) throw new Error("فایل برگه در حافظهٔ مرورگر پیدا نشد؛ لطفاً دوباره بارگذاری کنید.");
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
