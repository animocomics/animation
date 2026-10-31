import { z } from "zod";
import { cloudflareAll, cloudflareFirst, getCloudflareDb } from "./cloudflare";
import type { WorkspaceData } from "@/lib/types";

const workspaceSchema = z.object({
  exams: z.array(z.unknown()).max(5000),
  classes: z.array(z.unknown()).max(2000),
  settings: z.object({
    provider: z.enum(["openai", "gemini", "deepseek", "zai", "minimax", "inkling", "mistral"]),
    model: z.string().max(120),
    gradingMode: z.enum(["fast", "balanced", "precise"]),
    reviewThreshold: z.number().min(0).max(1),
    anonymize: z.boolean(),
    requireApproval: z.boolean(),
  }),
});

export class WorkspaceConflictError extends Error {}

const CLOUD_CHUNK_BYTES = 750_000;

function splitWorkspaceJson(value: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < value.length) {
    let low = start + 1;
    let high = Math.min(value.length, start + CLOUD_CHUNK_BYTES);
    let end = high;
    while (low <= high) {
      const candidate = Math.floor((low + high) / 2);
      if (Buffer.byteLength(value.slice(start, candidate), "utf8") <= CLOUD_CHUNK_BYTES) {
        end = candidate;
        low = candidate + 1;
      } else {
        high = candidate - 1;
      }
    }
    if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]) && /[\uDC00-\uDFFF]/.test(value[end])) end -= 1;
    chunks.push(value.slice(start, end));
    start = end;
  }
  return chunks.length ? chunks : [""];
}

export async function loadWorkspace(userId: string): Promise<{ data: WorkspaceData | null; revision: number; updatedAt?: string }> {
  const cloud = await getCloudflareDb();
  const row = cloud
    ? await cloudflareFirst<{ data_json: string; revision: number; updated_at: string }>(cloud, "SELECT data_json, revision, updated_at FROM workspaces WHERE user_id = ?", [userId])
    : (await import("./db")).getDb().prepare("SELECT data_json, revision, updated_at FROM workspaces WHERE user_id = ?").get(userId) as { data_json: string; revision: number; updated_at: string } | undefined;
  if (!row) return { data: null, revision: 0 };
  try {
    const serialized = cloud && !row.data_json
      ? (await cloudflareAll<{ data_chunk: string }>(cloud, "SELECT data_chunk FROM workspace_chunks WHERE user_id = ? ORDER BY chunk_index", [userId])).map((chunk) => chunk.data_chunk).join("")
      : row.data_json;
    return { data: workspaceSchema.parse(JSON.parse(serialized)) as WorkspaceData, revision: row.revision, updatedAt: row.updated_at };
  } catch {
    throw new Error("دادهٔ فضای کاری خوانده نشد؛ نسخهٔ پشتیبان پایگاه‌داده را بررسی کنید.");
  }
}

export async function saveWorkspace(userId: string, value: unknown, expectedRevision?: number): Promise<{ revision: number; updatedAt: string }> {
  const data = workspaceSchema.parse(value) as WorkspaceData;
  const serialized = JSON.stringify(data);
  if (Buffer.byteLength(serialized, "utf8") > 16 * 1024 * 1024) throw new Error("حجم دادهٔ متنی فضای کاری بیش از ۱۶ مگابایت است.");
  const cloud = await getCloudflareDb();
  if (cloud) {
    const existing = await cloudflareFirst<{ revision: number }>(cloud, "SELECT revision FROM workspaces WHERE user_id = ?", [userId]);
    const currentRevision = existing?.revision ?? 0;
    if (expectedRevision !== undefined && currentRevision !== expectedRevision) throw new WorkspaceConflictError();
    const revision = currentRevision + 1;
    const updatedAt = new Date().toISOString();
    const chunks = splitWorkspaceJson(serialized);
    const storedJson = chunks.length === 1 ? serialized : "";
    const firstStatement = existing
      ? cloud.prepare("UPDATE workspaces SET data_json = ?, revision = ?, updated_at = ? WHERE user_id = ? AND revision = ?").bind(storedJson, revision, updatedAt, userId, currentRevision)
      : cloud.prepare("INSERT INTO workspaces (user_id, data_json, revision, updated_at) VALUES (?, ?, ?, ?)").bind(userId, storedJson, revision, updatedAt);
    const statements = [
      firstStatement,
      cloud.prepare("DELETE FROM workspace_chunks WHERE user_id = ?").bind(userId),
      ...(chunks.length > 1 ? chunks.map((chunk, index) => cloud.prepare("INSERT INTO workspace_chunks (user_id, chunk_index, data_chunk) VALUES (?, ?, ?)").bind(userId, index, chunk)) : []),
    ];
    try {
      const results = await cloud.batch(statements);
      if (existing && Number(results[0]?.meta.changes || 0) !== 1) throw new WorkspaceConflictError();
    } catch (error) {
      if (error instanceof WorkspaceConflictError || expectedRevision !== undefined) throw new WorkspaceConflictError();
      throw error;
    }
    return { revision, updatedAt };
  }
  const db = (await import("./db")).getDb();
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
