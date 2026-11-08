import test from "node:test";
import assert from "node:assert/strict";
import { answerKey, sameAnswer } from "../lib/answer-key";

test("the same fraction written two ways normalises to one key", () => {
  assert.equal(answerKey("4/6"), answerKey("2/3"));
  assert.equal(answerKey("۴/۶"), answerKey("2/3"));
  assert.equal(answerKey(" 2 / 3 "), answerKey("2/3"));
  assert.equal(answerKey("۲⁄۳"), answerKey("2/3"));
});

test("different fractions stay different", () => {
  assert.notEqual(answerKey("3/4"), answerKey("2/3"));
  assert.notEqual(answerKey("1/2"), answerKey("2/1"));
  assert.notEqual(answerKey("2/3"), answerKey("23"));
});

test("a key matches the option it was read from, in any digit form", () => {
  assert.ok(sameAnswer("ب", "ب"));
  assert.ok(sameAnswer("4/6", "2/3"));
  assert.ok(sameAnswer("۷/۸", "7/8"));
  assert.equal(sameAnswer("", ""), false, "empty must never count as a match");
});

test("numbers that are not fractions are only digit-normalised", () => {
  assert.equal(answerKey("۱۲٫۵"), "12٫5");
  assert.equal(answerKey("۲۵"), "25");
});

test("a mixed number is one value, however it was written", () => {
  assert.equal(answerKey("1 1/2"), answerKey("3/2"));
  assert.equal(answerKey("۲ ۱/۲"), answerKey("5/2"));
  assert.equal(answerKey("1 2/4"), answerKey("3/2"));
});
