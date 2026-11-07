import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PROVIDER_IDS } from "../lib/provider-catalog";
import { saveWorkspace } from "../lib/server/workspace-store";

/**
 * A draft could not be created on a real deployment, and the panel said
 * "this exam was not found in your workspace".
 *
 * The cause was two steps away from that message:
 *   1. workspace-store carried its own hand-written provider list, which did not
 *      include the newly added GapGPT.
 *   2. The client attaches the *active* provider to every workspace save, so with
 *      GapGPT selected every save returned 400.
 *   3. Nothing was written, so the import that followed could not find the exam.
 *   4. The import's own error then named the exam instead of the failed save.
 *
 * These tests pin the first and last links, because a future provider must not be
 * able to break them again.
 */

const root = path.resolve(import.meta.dirname, "..");

test("a workspace can be saved with every provider in the table selected", async () => {
  // This is the exact payload shape the browser sends on every draft save.
  for (const provider of PROVIDER_IDS) {
    const data = {
      exams: [{ id: `exam-${provider}`, title: "پیش‌نویس", status: "draft", submissions: [], questions: [] }],
      classes: [],
      settings: {
        provider,
        model: "some-model",
        gradingMode: "fast",
        reviewThreshold: 0.7,
        anonymize: false,
        requireApproval: false,
      },
    };
    // No user id is passed on purpose: the schema is validated before the database is
    // touched, so a rejection here is a schema rejection and nothing else.
    await assert.rejects(
      () => saveWorkspace("00000000-0000-0000-0000-000000000000", data),
      (error: Error) => !("issues" in error),
      `the schema must accept provider "${provider}" before any database work`,
    );
  }
});

test("an unknown provider is still refused", async () => {
  const data = {
    exams: [],
    classes: [],
    settings: { provider: "not-a-provider", model: "x", gradingMode: "fast", reviewThreshold: 0.7, anonymize: false, requireApproval: false },
  };
  await assert.rejects(
    () => saveWorkspace("00000000-0000-0000-0000-000000000000", data),
    (error: Error) => "issues" in error,
    "a genuinely invalid provider must still be rejected by the schema",
  );
});

test("no source file carries its own provider list", async () => {
  // The guard that would have caught this. It scans everything rather than a list of
  // files I remembered to update.
  const offenders: string[] = [];
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) { walk(absolute); continue; }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      const body = fs.readFileSync(absolute, "utf8");
      if (/\[\s*"openai"\s*,\s*"gemini"/.test(body)) offenders.push(path.relative(root, absolute));
    }
  };
  for (const directory of ["lib", "app", "components"]) walk(path.join(root, directory));
  assert.deepEqual(offenders, [], `use PROVIDER_IDS instead of a local list: ${offenders.join(", ")}`);
});

test("a failed save is reported, not swallowed, and the import stops on it", () => {
  // persist() used to resolve whether or not anything was written. The caller then
  // sent an import for an exam the server had never received.
  const context = fs.readFileSync(path.join(root, "lib", "app-context.tsx"), "utf8");
  assert.match(context, /Promise<\{ ok: boolean; error\?: string \}>/, "persist must report its outcome");
  assert.match(context, /outcome = \{ ok: true \}/);
  assert.match(context, /return saveChain\.current\.then\(\(\) => outcome\)/, "each call resolves with its own result");

  const wizard = fs.readFileSync(path.join(root, "components", "grading", "grading-wizard.tsx"), "utf8");
  // The import must not be sent when the draft was never saved.
  assert.match(wizard, /if \(!saved\.ok\) \{\s*\n\s*\/\/ Stop here rather than sending the import/, "the importer must stop after a failed save");
  assert.match(wizard, /if \(!saved\.ok\) \{\s*\n\s*notify\(\{ title: "ذخیرهٔ آزمون انجام نشد"/, "starting a run must stop after a failed save");
});

test("the workspace 400 names the field that failed", () => {
  const route = fs.readFileSync(path.join(root, "app", "api", "workspace", "route.ts"), "utf8");
  // The old message said only "the structure is invalid", which is unactionable from
  // the browser console where the operator actually sees it.
  assert.match(route, /error\.issues\[0\]\?\.path/, "the failing field path must be reported");
  assert.match(route, /field: path/, "the field must be machine-readable too");
});
