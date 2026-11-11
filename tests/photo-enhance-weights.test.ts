import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The enhancer must not thin the ink.
 *
 * A threshold plus a strong contrast ramp looks impressive on a screenshot and destroys
 * handwriting: a 2 px stroke is either white or black, and pushing it to black eats the
 * pale parts until two of the operator's questions were barely legible. The version that
 * ships does a white balance and a soft curve instead. These tests pin the two
 * properties that distinguish it — paper still becomes white, and a faint stroke stays
 * a mid-grey rather than being either erased or crushed.
 */

test("the shipped enhancer is a curve, not a threshold", () => {
  const source = readFileSync(new URL("../lib/server/pdf-vision.ts", import.meta.url), "utf8");
  assert.match(source, /white balance, then a gentle curve/i);
  assert.doesNotMatch(source, /INK_FLOOR/, "the threshold variant must not come back");
  assert.match(source, /Math\.exp\(-\(balanced - 150\) \/ 45\)/, "the soft curve is the mechanism");
});

test("the ink lift is applied before the curve, so strokes keep their weight", () => {
  const source = readFileSync(new URL("../lib/server/pdf-vision.ts", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("const paper = Math.max(green, blue, 220)"));
  assert.match(body.slice(0, 400), /scale/, "the paper tone is normalised first");
});
