import { randomUUID } from "crypto";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { D1Database, KVNamespace, R2Bucket } from "@cloudflare/workers-types";
import { hashPassword } from "./password";

export interface CloudflareBindings {
  DB?: D1Database;
  UPLOADS_KV?: KVNamespace;
  UPLOADS?: R2Bucket;
}

export function isCloudflareRuntime(): boolean {
  return process.env.NOMREH_CLOUDFLARE === "1";
}

export function getCloudflareBindings(): CloudflareBindings | null {
  if (!isCloudflareRuntime()) return null;
  const context = getCloudflareContext();
  return context.env as unknown as CloudflareBindings;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin', 'teacher', 'reviewer')),
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    last_login_at TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS provider_settings (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    encrypted_api_key TEXT NOT NULL,
    key_hint TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    updated_by TEXT REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS workspaces (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    data_json TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS workspace_chunks (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    data_chunk TEXT NOT NULL,
    PRIMARY KEY(user_id, chunk_index)
  );
  CREATE TABLE IF NOT EXISTS ai_jobs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    submission_id TEXT,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    status TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ai_jobs_user ON ai_jobs(user_id);
  CREATE INDEX IF NOT EXISTS idx_ai_jobs_created ON ai_jobs(created_at);
`;

let schemaPromise: Promise<void> | undefined;

export async function initialiseCloudflareDatabase(database: D1Database): Promise<void> {
  const schemaStatements = SCHEMA.split(";").map((statement) => statement.trim()).filter(Boolean);
  await database.batch(schemaStatements.map((statement) => database.prepare(statement)));
  const adminUsername = process.env.NOMREH_ADMIN_USERNAME || "admin";
  const teacherUsername = process.env.NOMREH_TEACHER_USERNAME || "teacher";
  const existing = await database.prepare("SELECT username FROM users WHERE username IN (?, ?)").bind(adminUsername, teacherUsername).all<{ username: string }>();
  const usernames = new Set((existing.results ?? []).map((row) => row.username.toLowerCase()));
  const now = new Date().toISOString();
  const statements = [];
  if (!usernames.has(adminUsername.toLowerCase())) {
    const password = process.env.NOMREH_ADMIN_PASSWORD;
    if (!password) throw new Error("NOMREH_ADMIN_PASSWORD برای ساخت حساب مدیر در Cloudflare تنظیم نشده است.");
    statements.push(database.prepare(`INSERT OR IGNORE INTO users (id, username, display_name, password_hash, role, active, created_at)
      VALUES (?, ?, ?, ?, 'admin', 1, ?)`).bind(randomUUID(), adminUsername, "مدیر سامانه", hashPassword(password), now));
  }
  if (!usernames.has(teacherUsername.toLowerCase())) {
    const password = process.env.NOMREH_TEACHER_PASSWORD;
    if (!password) throw new Error("NOMREH_TEACHER_PASSWORD برای ساخت حساب معلم در Cloudflare تنظیم نشده است.");
    statements.push(database.prepare(`INSERT OR IGNORE INTO users (id, username, display_name, password_hash, role, active, created_at)
      VALUES (?, ?, ?, ?, 'teacher', 1, ?)`).bind(randomUUID(), teacherUsername, "معلم نمونه", hashPassword(password), now));
  }
  if (statements.length) await database.batch(statements);
}

export async function getCloudflareDb(): Promise<D1Database | null> {
  const database = getCloudflareBindings()?.DB;
  if (!database) {
    if (isCloudflareRuntime()) throw new Error("D1 binding DB در Cloudflare پیکربندی نشده است.");
    return null;
  }
  if (!schemaPromise) {
    schemaPromise = initialiseCloudflareDatabase(database).catch((error) => {
      schemaPromise = undefined;
      throw error;
    });
  }
  await schemaPromise;
  return database;
}

export async function cloudflareAll<T>(database: D1Database, sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await database.prepare(sql).bind(...params).all<T>();
  return result.results;
}

export async function cloudflareFirst<T>(database: D1Database, sql: string, params: unknown[] = []): Promise<T | undefined> {
  const row = await database.prepare(sql).bind(...params).first<T>();
  return row ?? undefined;
}

export async function cloudflareRun(database: D1Database, sql: string, params: unknown[] = []) {
  return database.prepare(sql).bind(...params).run();
}
