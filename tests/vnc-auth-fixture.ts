import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export function createVncAuthFixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "nomreh-vnc-auth-"));
  const database = new DatabaseSync(path.join(directory, "nomreh.db"));
  database.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT NOT NULL, active INTEGER NOT NULL);
    CREATE TABLE sessions (token_hash TEXT NOT NULL, user_id TEXT NOT NULL, expires_at TEXT NOT NULL);
    INSERT INTO users VALUES ('admin-id', 'admin', 1), ('teacher-id', 'teacher', 1);
  `);
  const insert = database.prepare("INSERT INTO sessions VALUES (?, ?, ?)");
  for (const [token, userId] of [["valid-admin", "admin-id"], ["valid-teacher", "teacher-id"]]) {
    insert.run(createHash("sha256").update(token).digest("hex"), userId, "2999-01-01T00:00:00.000Z");
  }
  database.close();
  const previous = process.env.NOMREH_DATA_DIR;
  process.env.NOMREH_DATA_DIR = directory;
  return () => {
    if (previous === undefined) delete process.env.NOMREH_DATA_DIR;
    else process.env.NOMREH_DATA_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  };
}
