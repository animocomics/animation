import test from "node:test";
import assert from "node:assert/strict";
import { looksLikeInkOnPaper } from "../lib/server/pdf-vision";

/**
 * The operator's notebook photo: blue-black pen on blue-tinted paper, lit from one
 * side. Ink is distinguished by being *less red* than its paper — which is also
 * exactly how a printed scan does not look. Getting this wrong in either direction
 * costs accuracy: enhancing a clean scan adds artefacts, and skipping a photo leaves
 * the model squinting at a grey page.
 */
function sample(red: number, green: number, blue: number) {
  return { red, green, blue };
}

test("a photographed handwritten page is recognised as ink on paper", () => {
  const page = [
    ...Array.from({ length: 700 }, () => sample(238, 244, 250)), // paper
    ...Array.from({ length: 300 }, () => sample(120, 140, 190)), // blue ink
  ];
  assert.equal(looksLikeInkOnPaper(page), true);
});

test("a printed black-on-white scan is not touched", () => {
  // Black text has all three channels equally low: no blue excess, so no enhancement.
  const scan = [
    ...Array.from({ length: 800 }, () => sample(252, 252, 252)),
    ...Array.from({ length: 200 }, () => sample(20, 20, 20)),
  ];
  assert.equal(looksLikeInkOnPaper(scan), false);
});

test("a dark photo of a dark surface is not mistaken for a page", () => {
  const dark = Array.from({ length: 1000 }, () => sample(30, 34, 90));
  assert.equal(looksLikeInkOnPaper(dark), false);
});

test("too little data means no decision, and no change to the file", () => {
  assert.equal(looksLikeInkOnPaper([sample(240, 245, 250)]), false);
});
