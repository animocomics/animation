import { randomUUID } from "crypto";
import { mkdirSync } from "fs";
import path from "path";
import Database from "better-sqlite3";
import { hashPassword } from "./password";

export const DATA_DIRECTORY = process.env.NOMREH_DATA_DIR || path.join(process.cwd(), "data");
mkdirSync(DATA_DIRECTORY, { recursive: true });

interface NomrehGlobal {
  __nomrehDatabase?: Database.Database;
}
const globalStore = globalThis as typeof globalThis & NomrehGlobal;

function createDatabase(): Database.Database {
  const database = new Database(path.join(DATA_DIRECTORY, "nomreh.db"));
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  database.exec(`
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
    CREATE TABLE IF NOT EXISTS api_network_settings (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      plan TEXT NOT NULL CHECK(plan IN ('free', 'pro')),
      dns_primary TEXT NOT NULL,
      dns_secondary TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      encrypted_update_url TEXT NOT NULL DEFAULT '',
      last_test_status TEXT NOT NULL DEFAULT 'idle',
      last_test_message TEXT NOT NULL DEFAULT '',
      last_tested_at TEXT,
      last_test_latency_ms INTEGER,
      last_activated_at TEXT,
      updated_at TEXT NOT NULL,
      updated_by TEXT REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS workspaces (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data_json TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
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
  `);
  const workspaceColumns = database.prepare("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>;
  if (!workspaceColumns.some((column) => column.name === "revision")) {
    database.exec("ALTER TABLE workspaces ADD COLUMN revision INTEGER NOT NULL DEFAULT 0");
  }
  database.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(new Date().toISOString());

  const userCount = database.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number };
  if (userCount.count === 0) {
    const now = new Date().toISOString();
    const seed = database.transaction(() => {
      database.prepare(`INSERT INTO users (id, username, display_name, password_hash, role, active, created_at)
        VALUES (?, ?, ?, ?, 'admin', 1, ?)`).run(
        randomUUID(),
        process.env.NOMREH_ADMIN_USERNAME || "admin",
        "مدیر سامانه",
        hashPassword(process.env.NOMREH_ADMIN_PASSWORD || "Admin@1405"),
        now,
      );
      database.prepare(`INSERT INTO users (id, username, display_name, password_hash, role, active, created_at)
        VALUES (?, ?, ?, ?, 'teacher', 1, ?)`).run(
        randomUUID(),
        process.env.NOMREH_TEACHER_USERNAME || "teacher",
        "معلم نمونه",
        hashPassword(process.env.NOMREH_TEACHER_PASSWORD || "Teacher@1405"),
        now,
      );
    });
    seed();
  }
  return database;
}

export function getDb(): Database.Database {
  if (!globalStore.__nomrehDatabase) globalStore.__nomrehDatabase = createDatabase();
  return globalStore.__nomrehDatabase;
}

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
