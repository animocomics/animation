import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import type { D1Database } from "@cloudflare/workers-types";
import { initialiseCloudflareDatabase } from "../lib/server/cloudflare";
import { hashPassword, verifyPassword } from "../lib/server/password";

class MockPrepared {
  private params: unknown[] = [];
  constructor(private readonly sqlite: Database.Database, private readonly sql: string) {}
  bind(...params: unknown[]) { this.params = params; return this; }
  async all<T>() { return { results: this.sqlite.prepare(this.sql).all(...(this.params as any[])) as T[] }; }
  async first<T>() { return (this.sqlite.prepare(this.sql).get(...(this.params as any[])) as T | undefined) ?? null; }
  runSync() { return this.sqlite.prepare(this.sql).run(...(this.params as any[])); }
  async run() { return this.runSync(); }
}

function mockD1() {
  const sqlite = new Database(":memory:");
  const database = {
    prepare: (sql: string) => new MockPrepared(sqlite, sql),
    batch: async (statements: MockPrepared[]) => {
      sqlite.transaction(() => statements.forEach((statement) => statement.runSync()))();
      return [];
    },
  } as unknown as D1Database;
  return { sqlite, database };
}

async function withEnv(values: Record<string, string | undefined>, run: () => Promise<void>) {
  const keys = Object.keys(values);
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  try { await run(); } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

interface UserRow {
  id: string;
  role: string;
  active: number;
  password_hash: string;
}

const credentials = {
  NOMREH_ADMIN_USERNAME: "nomreh_admin",
  NOMREH_ADMIN_PASSWORD: "AdminTest1405",
  NOMREH_TEACHER_USERNAME: "nomreh_teacher",
  NOMREH_TEACHER_PASSWORD: "TeacherTest1405",
};

test("Cloudflare first setup never leaves a partial admin-only seed", async () => {
  const { sqlite, database } = mockD1();
  try {
    await withEnv({ ...credentials, NOMREH_TEACHER_PASSWORD: undefined }, async () => {
      await assert.rejects(initialiseCloudflareDatabase(database), /NOMREH_TEACHER_PASSWORD/);
    });
    assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number }).count, 0);
    await withEnv(credentials, () => initialiseCloudflareDatabase(database));
    const rows = sqlite.prepare("SELECT * FROM users ORDER BY role").all() as UserRow[];
    assert.equal(rows.length, 2);
    assert.equal(verifyPassword(credentials.NOMREH_ADMIN_PASSWORD, rows.find((row) => row.role === "admin")!.password_hash), true);
    assert.equal(verifyPassword(credentials.NOMREH_TEACHER_PASSWORD, rows.find((row) => row.role === "teacher")!.password_hash), true);
  } finally { sqlite.close(); }
});

test("Cloudflare initialization repairs a missing teacher without changing the admin account", async () => {
  const { sqlite, database } = mockD1();
  try {
    await withEnv(credentials, () => initialiseCloudflareDatabase(database));
    const before = sqlite.prepare("SELECT * FROM users WHERE role = 'admin'").get() as UserRow;
    sqlite.prepare("DELETE FROM users WHERE role = 'teacher'").run();
    await withEnv(credentials, () => initialiseCloudflareDatabase(database));
    const admin = sqlite.prepare("SELECT * FROM users WHERE role = 'admin'").get() as UserRow;
    const teacher = sqlite.prepare("SELECT * FROM users WHERE role = 'teacher'").get() as UserRow;
    assert.equal(admin.id, before.id);
    assert.equal(admin.password_hash, before.password_hash);
    assert.equal(teacher.active, 1);
    assert.equal(verifyPassword(credentials.NOMREH_TEACHER_PASSWORD, teacher.password_hash), true);
  } finally { sqlite.close(); }
});

test("Cloudflare cold starts do not overwrite existing passwords or require seed secrets again", async () => {
  const { sqlite, database } = mockD1();
  try {
    await withEnv(credentials, () => initialiseCloudflareDatabase(database));
    const customHash = hashPassword("ChangedByAdmin1405");
    sqlite.prepare("UPDATE users SET password_hash = ? WHERE role = 'admin'").run(customHash);
    await withEnv({
      NOMREH_ADMIN_USERNAME: credentials.NOMREH_ADMIN_USERNAME,
      NOMREH_TEACHER_USERNAME: credentials.NOMREH_TEACHER_USERNAME,
      NOMREH_ADMIN_PASSWORD: undefined,
      NOMREH_TEACHER_PASSWORD: undefined,
    }, () => initialiseCloudflareDatabase(database));
    assert.equal((sqlite.prepare("SELECT password_hash FROM users WHERE role = 'admin'").get() as Pick<UserRow, "password_hash">).password_hash, customHash);
    assert.equal(verifyPassword("ChangedByAdmin1405", customHash), true);
  } finally { sqlite.close(); }
});
