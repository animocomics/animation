import test from "node:test";
import assert from "node:assert/strict";
import { imagePartBudgetPx, planImageParts, partLabel } from "../lib/server/image-parts";

/**
 * The operator's photo: 3024 x 3000, 9.1 megapixels of handwriting on one notebook
 * page. Sent as one image, Gemini's budget shrinks it to about 920 x 913 — each
 * handwritten line arrives ~61 px tall, and no model, however strong, can read strokes
 * that were discarded in transport. These tests pin the geometry of the fix: cut the
 * page into bands small enough that the model keeps them near full size.
 */

const PHOTO = { width: 3024, height: 3000 };

test("a 9 MP phone photo is cut into bands, not sent whole", () => {
  const parts = planImageParts(PHOTO.width, PHOTO.height);
  assert.ok(parts.length >= 4, `expected several bands, got ${parts.length}`);
  assert.ok(parts.length <= 6, "more bands than this costs latency without adding detail");
  for (const part of parts) {
    assert.ok(part.height < PHOTO.height, "no band may be the whole page");
    assert.ok(part.y0 >= 0 && part.y0 + part.height <= PHOTO.height, "bands stay inside the page");
  }
});

test("bands overlap, so a question on a seam is never cut in half", () => {
  const parts = planImageParts(PHOTO.width, PHOTO.height);
  for (let index = 1; index < parts.length; index += 1) {
    const previousEnd = parts[index - 1].y0 + parts[index - 1].height;
    assert.ok(parts[index].y0 < previousEnd, "consecutive bands must share some rows");
  }
  const last = parts[parts.length - 1];
  assert.equal(last.y0 + last.height, PHOTO.height, "the last band must reach the bottom edge");
});

test("an image that already fits the budget is left alone", () => {
  const parts = planImageParts(1200, 900);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].height, 900);
});

test("bands carry indices so a teacher can tell them apart from pages", () => {
  const parts = planImageParts(PHOTO.width, PHOTO.height);
  assert.deepEqual(parts.map((part) => part.index), parts.map((_, index) => index + 1));
  assert.equal(partLabel(2, 6), "بخش 2 از 6");
  assert.equal(partLabel(1, 1), "", "a single page needs no band label");
});

test("a very tall image is capped instead of becoming twenty requests", () => {
  const parts = planImageParts(1000, 20_000, { maxParts: 4 });
  assert.equal(parts.length, 4);
});

test("the budget can be tuned from the environment, with sane bounds", () => {
  assert.equal(imagePartBudgetPx(undefined), 1_500_000);
  assert.equal(imagePartBudgetPx(""), 1_500_000);
  assert.equal(imagePartBudgetPx("not-a-number"), 1_500_000);
  assert.equal(imagePartBudgetPx("2000000"), 2_000_000);
  assert.equal(imagePartBudgetPx("1"), 400_000, "absurdly small values are clamped");
  assert.equal(imagePartBudgetPx("999999999"), 4_000_000, "absurdly large values are clamped");
});

test("invalid dimensions never produce a broken plan", () => {
  assert.deepEqual(planImageParts(0, 0), [{ y0: 0, height: 0, index: 1, total: 1 }]);
  assert.deepEqual(planImageParts(Number.NaN, 3000), [{ y0: 0, height: 3000, index: 1, total: 1 }]);
});
