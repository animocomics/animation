import test from "node:test";
import assert from "node:assert/strict";
import { detectLineBoxes, detectPaperSpan, otsuThreshold, planLineParts, rowInkProfile } from "../lib/server/line-parts";

/**
 * A synthetic notebook page: a dark desk around a bright sheet, ruled lines, and four
 * "lines of handwriting" at known rows. The tests use the same functions the importer
 * uses, so a change that breaks the real sheet breaks these first.
 */
function page(options: { width?: number; height?: number; lines: Array<[number, number]>; desk?: number; ruled?: number[] }) {
  const width = options.width ?? 600;
  const height = options.height ?? 1200;
  const desk = options.desk ?? 0;
  const luminance = new Uint8Array(width * height).fill(245);
  // Desk: a dark frame around the paper.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (y < desk || y >= height - desk || x < desk || x >= width - desk) luminance[y * width + x] = 20;
    }
  }
  for (const [y0, y1] of options.lines) {
    for (let y = y0; y < y1; y += 1) for (let x = 60; x < width - 40; x += 1) luminance[y * width + x] = 30;
  }
  for (const y of options.ruled ?? []) {
    for (let x = 60; x < width - 40; x += 7) luminance[y * width + x] = 210;
  }
  return { luminance, width, height };
}



test("finds the paper and ignores the dark desk around it", () => {
    const { luminance, width, height } = page({ lines: [[300, 340]], desk: 90 });
    const span = detectPaperSpan(luminance, width, height);
    assert.ok(span.y0 > 60);
    assert.ok(span.y1 < height - 60);
    assert.ok(span.x0 > 60);
  });


test("finds every line of handwriting, not one block", () => {
    const { luminance, width, height } = page({ lines: [[300, 340], [420, 460], [540, 580], [660, 700]] });
    const lines = detectLineBoxes(luminance, width, height);
    assert.equal(lines.length, 4);
    assert.ok(lines[0].y0 <= 300);
    assert.ok(lines[3].y1 >= 700);
  });


test("does not mistake faint ruled lines for handwriting", () => {
    const { luminance, width, height } = page({ lines: [[300, 340], [420, 460], [540, 580], [660, 700]], ruled: [380, 500, 620] });
    const lines = detectLineBoxes(luminance, width, height);
    assert.equal(lines.length, 4);
  });


test("splits a box that clearly holds two lines", () => {
    // One tall dark block with a blank band in the middle: the ringer case that made the
    // importer put two questions in a part too tall for the model to keep at full detail.
    const { luminance, width, height } = page({ lines: [[200, 300], [340, 440], [600, 640], [700, 740]] });
    const lines = detectLineBoxes(luminance, width, height);
    assert.ok(lines.length >= 4);
    const tall = lines.filter((line) => line.y1 - line.y0 > 150);
    assert.equal(tall.length, 0);
  });


test("packs whole lines into parts that never start mid-line", () => {
    const { luminance, width, height } = page({ lines: [[300, 340], [420, 460], [540, 580], [660, 700]] });
    const lines = detectLineBoxes(luminance, width, height);
    const parts = planLineParts(lines, { width, height }, { budgetPx: 220_000, maxParts: 8 });
    assert.ok(parts.length > 1);
    for (const part of parts) {
      const covers = lines.some((line) => line.y0 >= part.y0 && line.y1 <= part.y0 + part.height);
      assert.ok(covers);
    }
    // Every line belongs to at least one part.
    for (const line of lines) {
      assert.ok(parts.some((part) => line.y0 >= part.y0 && line.y1 <= part.y0 + part.height));
    }
  });


test("keeps the part list inside the requested maximum", () => {
    const { luminance, width, height } = page({ lines: [[300, 340], [420, 460], [540, 580], [660, 700], [780, 820], [900, 940]] });
    const lines = detectLineBoxes(luminance, width, height);
    const parts = planLineParts(lines, { width, height }, { budgetPx: 100_000, maxParts: 3 });
    assert.ok(parts.length <= 3);
  });


test("measures ink rows only inside the given columns", () => {
    const { luminance, width, height } = page({ lines: [[300, 340]], desk: 90 });
    const restricted = rowInkProfile(luminance, width, height, { x0: 200, x1: 400, inkLevel: 150 });
    const wide = rowInkProfile(luminance, width, height, { x0: 0, x1: width, inkLevel: 150 });
    assert.ok(restricted[320] > 0);
    assert.ok(wide[10] > restricted[10]);
  });


test("puts the Otsu threshold between the two populations", () => {
    const values = [...new Array(50).fill(3), ...new Array(50).fill(60)];
    const threshold = otsuThreshold(values);
    assert.ok(threshold >= 3);
    assert.ok(threshold < 60);
  });

test("each part reaches one line into its neighbour so a two-line question stays whole", () => {
  // Question 2 on the operator's sheet is two lines. The part that holds its first line
  // must also show its second line, otherwise the reader is handed half a question.
  const lines = [
    { y0: 100, y1: 140 },
    { y0: 200, y1: 240 },
    { y0: 300, y1: 340 },
    { y0: 400, y1: 440 },
  ];
  const parts = planLineParts(lines, { width: 600, height: 1000 }, { budgetPx: 600 * 90, maxParts: 8 });
  assert.ok(parts.length >= 2, `expected several parts, got ${parts.length}`);
  for (let index = 0; index < parts.length - 1; index += 1) {
    const current = parts[index];
    const next = parts[index + 1];
    // The next part begins before the current one ends: they share at least one line.
    assert.ok(next.y0 < current.y0 + current.height, "adjacent parts must overlap");
  }
});
