import { z } from "zod";
import { getDb } from "./db";
import type { WorkspaceData } from "@/lib/types";

const workspaceSchema = z.object({
  exams: z.array(z.unknown()).max(5000),
  classes: z.array(z.unknown()).max(2000),
  settings: z.object({
    provider: z.enum(["openai", "gemini", "deepseek"]),
    model: z.string().max(120),
    gradingMode: z.enum(["fast", "balanced", "precise"]),
    reviewThreshold: z.number().min(0).max(1),
    anonymize: z.boolean(),
    requireApproval: z.boolean(),
  }),
});

export class WorkspaceConflictError extends Error {}

export function loadWorkspace(userId: string): { data: WorkspaceData | null; revision: number; updatedAt?: string } {
  const row = getDb().prepare("SELECT data_json, revision, updated_at FROM workspaces WHERE user_id = ?").get(userId) as { data_json: string; revision: number; updated_at: string } | undefined;
  if (!row) return { data: null, revision: 0 };
  try {
    return { data: workspaceSchema.parse(JSON.parse(row.data_json)) as WorkspaceData, revision: row.revision, updatedAt: row.updated_at };
  } catch {
    throw new Error("دادهٔ فضای کاری خوانده نشد؛ نسخهٔ پشتیبان پایگاه‌داده را بررسی کنید.");
  }
}

export function saveWorkspace(userId: string, value: unknown, expectedRevision?: number): { revision: number; updatedAt: string } {
  const data = workspaceSchema.parse(value) as WorkspaceData;
  const serialized = JSON.stringify(data);
  if (Buffer.byteLength(serialized, "utf8") > 16 * 1024 * 1024) throw new Error("حجم دادهٔ متنی فضای کاری بیش از ۱۶ مگابایت است.");
  const db = getDb();
  return db.transaction(() => {
    const existing = db.prepare("SELECT revision FROM workspaces WHERE user_id = ?").get(userId) as { revision: number } | undefined;
    const currentRevision = existing?.revision ?? 0;
    if (expectedRevision !== undefined && currentRevision !== expectedRevision) throw new WorkspaceConflictError();
    const revision = currentRevision + 1;
    const updatedAt = new Date().toISOString();
    db.prepare(`INSERT INTO workspaces (user_id, data_json, revision, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET data_json=excluded.data_json, revision=excluded.revision, updated_at=excluded.updated_at`)
      .run(userId, serialized, revision, updatedAt);
    return { revision, updatedAt };
  })();
}
