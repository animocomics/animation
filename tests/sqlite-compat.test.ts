import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../lib/server/sqlite";

test("built-in SQLite persists data and preserves transaction rollback semantics", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nomreh-sqlite-compat-"));
  const filename = path.join(directory, "nomreh.db");
  let database: Database | undefined;
  try {
    database = new Database(filename);
    database.pragma("foreign_keys = ON");
    database.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    database.transaction((value: string) => {
      database!.prepare("INSERT INTO entries VALUES (?, ?)").run(1, value);
    })("committed");
    assert.throws(() => database!.transaction(() => {
      database!.prepare("INSERT INTO entries VALUES (?, ?)").run(2, "rolled back");
      throw new Error("rollback test");
    })());
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM entries").get().count, 1);
    database.close();
    database = new Database(filename);
    assert.equal(database.prepare("SELECT value FROM entries WHERE id = 1").get().value, "committed");
    database.close();
    database = undefined;
  } finally {
    database?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
