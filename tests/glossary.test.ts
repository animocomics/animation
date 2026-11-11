import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { glossaryPromptHint, loadGlossaryTerms } from "../lib/server/glossary";

test("the subject vocabulary reaches the reader as a preference, never as a command to invent", () => {
  const hint = glossaryPromptHint();
  assert.ok(hint.includes("لنگرودی"));
  assert.ok(hint.includes("ضمان"));
  // The rule the hint must not overwrite: an unreadable shape is still reported, not filled.
  assert.ok(hint.includes("ناخوانا"));
  assert.ok(hint.includes("حدس نزن"));
});

test("a teacher can add terms to their own course without touching code", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "glossary-"));
  fs.writeFileSync(path.join(directory, "course.txt"), "# comment\nقاعدهٔ لاضرر\nمبحث الفاظ\n");
  const previous = process.env.NOMREH_GLOSSARY;
  process.env.NOMREH_GLOSSARY = directory;
  try {
    const terms = loadGlossaryTerms();
    assert.ok(terms.includes("قاعدهٔ لاضرر"));
    assert.ok(terms.includes("مبحث الفاظ"));
    assert.ok(terms.includes("لنگرودی"), "built-in terms stay even with a custom folder");
    assert.ok(!terms.includes("# comment"));
  } finally {
    if (previous === undefined) delete process.env.NOMREH_GLOSSARY;
    else process.env.NOMREH_GLOSSARY = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a missing glossary folder is not an error", () => {
  const previous = process.env.NOMREH_GLOSSARY;
  process.env.NOMREH_GLOSSARY = path.join(os.tmpdir(), "definitely-not-here-" + Date.now());
  try {
    assert.ok(loadGlossaryTerms().includes("کاتوزیان"));
  } finally {
    if (previous === undefined) delete process.env.NOMREH_GLOSSARY;
    else process.env.NOMREH_GLOSSARY = previous;
  }
});
