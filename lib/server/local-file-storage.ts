import { mkdir, readFile, rm, writeFile } from "fs/promises";
import path from "path";
import { DATA_DIRECTORY } from "./db";

const SAFE_ID = /^[A-Za-z0-9_-]{1,180}$/;

function userDirectory(userId: string): string {
  if (!SAFE_ID.test(userId)) throw new Error("شناسهٔ کاربر معتبر نیست.");
  return path.join(DATA_DIRECTORY, "uploads", userId);
}

export async function saveLocalUserFile(userId: string, id: string, file: File): Promise<void> {
  const directory = userDirectory(userId);
  await mkdir(directory, { recursive: true });
  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(path.join(directory, `${id}.bin`), buffer, { mode: 0o600 });
  await writeFile(path.join(directory, `${id}.json`), JSON.stringify({ name: file.name.slice(0, 300), type: file.type, size: file.size }), { mode: 0o600 });
}

export async function readLocalUserFile(userId: string, id: string): Promise<{ data: Buffer; name: string; type: string } | null> {
  const directory = userDirectory(userId);
  try {
    const [data, metadata] = await Promise.all([
      readFile(path.join(directory, `${id}.bin`)),
      readFile(path.join(directory, `${id}.json`), "utf8"),
    ]);
    const parsed = JSON.parse(metadata) as { name: string; type: string };
    return { data, name: parsed.name, type: parsed.type };
  } catch {
    return null;
  }
}

export async function deleteLocalUserFile(userId: string, id: string): Promise<void> {
  const directory = userDirectory(userId);
  await Promise.all([rm(path.join(directory, `${id}.bin`), { force: true }), rm(path.join(directory, `${id}.json`), { force: true })]);
}

export async function clearLocalUserFiles(userId: string): Promise<void> {
  await rm(userDirectory(userId), { recursive: true, force: true });
}
