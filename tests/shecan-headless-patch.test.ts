import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const patch = require("../scripts/shecan-vm/patch-official-runtime.cjs") as {
  prepareOfficialHeadlessRuntime(): Promise<{ patched: boolean; installed: boolean; root: string; backup: string }>;
  readVerifiedManifest(root: string): Promise<unknown>;
  rollbackHeadlessRuntime(transaction: { patched: boolean; backup: string; root: string }): void;
  commitHeadlessRuntime(transaction: { patched: boolean; backup: string; root: string }): void;
};
const required = [
  "glibc/lib/x86_64-linux-gnu/ld-2.27.so",
  "qemu/bin/qemu-system-x86_64",
  "guest/vmlinuz-virt",
  "guest/initramfs-official",
  "run-official.sh",
];

function pad(length: number): Buffer { return Buffer.alloc((4 - length % 4) % 4); }
function entry(name: string, body = Buffer.alloc(0), mode = 0o100644): Buffer {
  const encoded = Buffer.from(`${name}\0`);
  const fields = [0, mode, 0, 0, 1, 0, body.length, 0, 0, 0, 0, encoded.length, 0];
  const header = Buffer.from(`070701${fields.map((value) => value.toString(16).padStart(8, "0")).join("")}`);
  return Buffer.concat([header, encoded, pad(header.length + encoded.length), body, pad(body.length)]);
}

test("headless patch streams only init, hardlinks unchanged files, and supports rollback/commit", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nomreh-headless-patch-"));
  const root = path.join(directory, "official");
  const previousRoot = process.env.NOMREH_SHECAN_RUNTIME_DIR;
  try {
    for (const relative of required) {
      const target = path.join(root, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `verified ${relative}\n`, { mode: 0o755 });
    }
    const oldArchive = Buffer.concat([
      entry("usr", Buffer.alloc(0), 0o040755),
      entry("usr/bin", Buffer.alloc(0), 0o040755),
      entry("usr/bin/shecan-desktop", Buffer.from("OFFICIAL APPLICATION\n")),
      entry("init", Buffer.from("#!/bin/sh\necho OLD_INIT\n"), 0o100755),
      entry("TRAILER!!!"),
    ]);
    const compressed = spawnSync("xz", ["-1", "-c"], { input: oldArchive, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(compressed.status, 0, compressed.stderr?.toString());
    fs.writeFileSync(path.join(root, "guest/initramfs-official"), compressed.stdout);
    const manifest = {
      format: 1,
      officialRpmSha256: "a".repeat(64),
      files: Object.fromEntries(required.map((relative) => [relative, createHash("sha256").update(fs.readFileSync(path.join(root, relative))).digest("hex")])),
    };
    fs.writeFileSync(path.join(root, "runtime-manifest.json"), JSON.stringify(manifest));
    process.env.NOMREH_SHECAN_RUNTIME_DIR = root;

    const transaction = await patch.prepareOfficialHeadlessRuntime();
    assert.equal(transaction.patched, true);
    await patch.readVerifiedManifest(root);
    assert.equal(
      fs.statSync(path.join(transaction.backup, "qemu/bin/qemu-system-x86_64")).ino,
      fs.statSync(path.join(root, "qemu/bin/qemu-system-x86_64")).ino,
      "the large unchanged runtime must be hardlinked, not copied",
    );
    const decompressed = spawnSync("xz", ["-dc", path.join(root, "guest/initramfs-official")], { maxBuffer: 16 * 1024 * 1024 });
    assert.equal(decompressed.status, 0);
    assert.ok(decompressed.stdout.includes(Buffer.from("nomreh_control")));
    assert.ok(!decompressed.stdout.includes(Buffer.from("OLD_INIT")));

    patch.rollbackHeadlessRuntime(transaction);
    await patch.readVerifiedManifest(root);
    assert.equal(fs.existsSync(transaction.backup), false);
    const committed = await patch.prepareOfficialHeadlessRuntime();
    patch.commitHeadlessRuntime(committed);
    assert.equal(fs.existsSync(committed.backup), false);
    const idempotent = await patch.prepareOfficialHeadlessRuntime();
    assert.equal(idempotent.patched, false);
    assert.equal(idempotent.installed, true);
  } finally {
    if (previousRoot === undefined) delete process.env.NOMREH_SHECAN_RUNTIME_DIR;
    else process.env.NOMREH_SHECAN_RUNTIME_DIR = previousRoot;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
