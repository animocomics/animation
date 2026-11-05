import assert from "node:assert/strict";
import test from "node:test";
import { createCsv, csvCell } from "../lib/csv";

test("CSV export quotes Persian text and embedded delimiters", () => {
  assert.equal(createCsv([["نام", "کد"], ["احمدی، سارا", "۱۲۳"], ["علی \"رضایی\"", 124]]),
    '"نام","کد"\r\n"احمدی، سارا","۱۲۳"\r\n"علی ""رضایی""","124"');
});

test("CSV export neutralizes spreadsheet formulas without changing numeric scores", () => {
  assert.equal(csvCell("=HYPERLINK(\"bad\")"), '"\'=HYPERLINK(""bad"")"');
  assert.equal(csvCell("  @SUM(A1:A2)"), '"\'  @SUM(A1:A2)"');
  assert.equal(csvCell(-2), '"-2"');
});
