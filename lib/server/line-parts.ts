/**
 * Splitting a photographed page by lines, not by equal bands.
 *
 * The band splitter (`planImageParts`) cuts the page into six equal strips. On the
 * operator's own notebook page that put fifteen handwritten lines into six strips, so
 * every line arrived about 143 px tall — enough to see there is ink, not enough to tell
 * «ضمان» from «بیان». The bands were the right idea with the wrong unit: the model reads
 * *lines*, so a line is what a part should contain.
 *
 * Finding the lines costs no model call, only a pixel pass:
 *   1. count dark pixels per row (the ruled lines are too faint to dominate),
 *   2. pick a threshold with Otsu over that profile,
 *   3. group consecutive rows above the threshold into a line,
 *   4. pack whole lines into parts until the pixel budget is reached.
 *
 * Because each part is built from whole lines, a question is never sliced in half by a
 * seam — the seam-aware split that the band splitter could only apologise for. The margin
 * above and below each line is kept so ascenders, descenders, and handwritten Persian
 * dots stay with their letter.
 */
export type LineBox = { y0: number; y1: number };

export type LinePart = { y0: number; height: number; index: number; total: number; lines: number };

/** A row group shorter than this is a dot, a tear, or phone noise — not a line of text. */
const MIN_LINE_HEIGHT = 14;

/** Margin kept above and below every line, as a fraction of that line's height. */
const LINE_MARGIN = 0.35;

/**
 * The per-row ink profile of a page, from a luminance buffer.
 *
 * `x0`/`x1` restrict the scan horizontally. The left third of a spiral notebook is
 * binding and desk, which is dark and constant, so counting it would flatten the profile
 * into one continuous block.
 */
export function rowInkProfile(luminance: Uint8Array | Uint8ClampedArray, width: number, height: number, options: { x0?: number; x1?: number; inkLevel?: number } = {}): Float64Array {
  const inkLevel = options.inkLevel ?? 150;
  const x0 = Math.max(0, Math.floor(options.x0 ?? 0));
  const x1 = Math.min(width, Math.ceil(options.x1 ?? width));
  const profile = new Float64Array(height);
  if (width <= 0 || height <= 0 || x1 <= x0) return profile;
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * width;
    let ink = 0;
    for (let x = x0; x < x1; x += 1) if (luminance[rowStart + x] < inkLevel) ink += 1;
    profile[y] = ink;
  }
  return profile;
}

/** Otsu's threshold over a set of values, or a fixed fallback when the split is degenerate. */
export function otsuThreshold(values: ArrayLike<number>): number {
  const length = values.length;
  if (!length) return 0;
  let max = 0;
  for (let index = 0; index < length; index += 1) if (values[index] > max) max = values[index];
  if (max <= 0) return 0;
  const histogram = new Float64Array(Math.ceil(max) + 1);
  for (let index = 0; index < length; index += 1) histogram[Math.round(values[index])] += 1;
  const total = length;
  let sum = 0;
  for (let level = 0; level < histogram.length; level += 1) sum += level * histogram[level];
  let sumBelow = 0;
  let weightBelow = 0;
  let best = -1;
  let threshold = Math.round(max * 0.3);
  for (let level = 0; level < histogram.length; level += 1) {
    weightBelow += histogram[level];
    if (weightBelow === 0) continue;
    const weightAbove = total - weightBelow;
    if (weightAbove === 0) break;
    sumBelow += level * histogram[level];
    const meanBelow = sumBelow / weightBelow;
    const meanAbove = (sum - sumBelow) / weightAbove;
    const between = weightBelow * weightAbove * (meanBelow - meanAbove) * (meanBelow - meanAbove);
    if (between > best) {
      best = between;
      threshold = level;
    }
  }
  return threshold;
}

/**
 * The rectangle that is actually paper.
 *
 * A phone photo of a notebook contains more than the page: desk, shadow, spiral binding.
 * Those are dark, and a row of desk counts as a row of ink, which is how the first version
 * of this splitter swallowed the title line into a "line" that started at the page edge.
 * Paper is bright and contiguous, so the widest bright run of rows and of columns is the
 * page, and everything outside it is ignored.
 */
export function detectPaperSpan(luminance: Uint8Array | Uint8ClampedArray, width: number, height: number, options: { brightLevel?: number; minFraction?: number } = {}): { y0: number; y1: number; x0: number; x1: number } {
  const brightLevel = options.brightLevel ?? 170;
  const minFraction = options.minFraction ?? 0.05;
  if (width <= 0 || height <= 0) return { y0: 0, y1: height, x0: 0, x1: width };
  const rowShare = new Float64Array(height);
  const colShare = new Float64Array(width);
  for (let y = 0; y < height; y += 1) {
    let bright = 0;
    for (let x = 0; x < width; x += 1) if (luminance[y * width + x] >= brightLevel) bright += 1;
    rowShare[y] = bright / width;
  }
  for (let x = 0; x < width; x += 1) {
    let bright = 0;
    for (let y = 0; y < height; y += 1) if (luminance[y * width + x] >= brightLevel) bright += 1;
    colShare[x] = bright / height;
  }
  // Longest run of rows/columns that contain paper. A row of handwriting is still a paper
  // row: its margins are bright, so the run is not broken by ink — which is exactly why
  // this is measured as "some bright pixels" and not as "a bright row".
  const longestRun = (share: Float64Array, length: number) => {
    let best = { start: 0, end: 0 };
    let start = -1;
    for (let index = 0; index < length; index += 1) {
      const paper = share[index] >= minFraction;
      if (paper && start < 0) start = index;
      if (!paper && start >= 0) {
        if (index - start > best.end - best.start) best = { start, end: index };
        start = -1;
      }
    }
    if (start >= 0 && length - start > best.end - best.start) best = { start, end: length };
    return best;
  };
  const rows = longestRun(rowShare, height);
  const cols = longestRun(colShare, width);
  const span = {
    y0: rows.end - rows.start >= height * 0.25 ? rows.start : 0,
    y1: rows.end - rows.start >= height * 0.25 ? rows.end : height,
    x0: cols.end - cols.start >= width * 0.25 ? cols.start : 0,
    x1: cols.end - cols.start >= width * 0.25 ? cols.end : width,
  };
  return span;
}

/**
 * Boxes around the lines of handwriting, top to bottom, inside the paper only.
 *
 * The threshold is deliberately low. A threshold tuned to "not miss a line" fails the
 * other way: on this page it fused the title, the printed calendar, and the first question
 * into one box, and parts built from that box left the title out of every part. Missing a
 * faint ruled line costs nothing (the packer just packs more lines together); missing a
 * line of the question costs the question.
 */
export function detectLineBoxes(luminance: Uint8Array | Uint8ClampedArray, width: number, height: number): LineBox[] {
  if (width <= 0 || height <= 0) return [];
  const paper = detectPaperSpan(luminance, width, height);
  // The binding and the page margin are narrow dark strips inside the paper span; scanning
  // from 4% to 92% of the paper width keeps them out without touching the text.
  const paperWidth = paper.x1 - paper.x0;
  const profile = rowInkProfile(luminance, width, height, {
    x0: Math.round(paper.x0 + paperWidth * 0.04),
    x1: Math.round(paper.x0 + paperWidth * 0.92),
  });
  const inner: number[] = [];
  for (let y = paper.y0; y < paper.y1; y += 1) inner.push(Math.round(profile[y]));
  if (!inner.length) return [];
  const sorted = [...inner].sort((a, b) => a - b);
  const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
  const threshold = Math.max(6, Math.round(p90 * 0.12));
  const lines: LineBox[] = [];
  let start = -1;
  let quiet = 0;
  for (let y = paper.y0; y < paper.y1; y += 1) {
    const on = profile[y] >= threshold;
    if (on) {
      if (start < 0) start = y;
      quiet = 0;
    } else if (start >= 0) {
      quiet += 1;
      // A three-pixel gap is the space between a word and its dot, not between lines.
      if (quiet >= 6) {
        if (y - quiet - start >= MIN_LINE_HEIGHT) lines.push({ y0: start, y1: y - quiet + 1 });
        start = -1;
        quiet = 0;
      }
    }
  }
  if (start >= 0 && paper.y1 - start >= MIN_LINE_HEIGHT) lines.push({ y0: start, y1: paper.y1 });
  return splitOvergrownBoxes(lines, profile);
}

/**
 * Splits "lines" that are clearly two or more lines.
 *
 * Ruled paper, a printed calendar block, and the shadow under the binding all put ink
 * between two real lines, so the gap test alone cannot separate them: it produced a
 * 400-pixel-tall box that held the calendar and the first question together, and a part
 * built from that box was resized down by the model until the question was small again.
 * A box much taller than the page's median line is cut at its darkest-quietest interior
 * row, which on this page is the blank band between the calendar and the handwriting.
 */
function splitOvergrownBoxes(boxes: LineBox[], profile: Float64Array | number[]): LineBox[] {
  if (boxes.length < 3) return boxes;
  const heights = boxes.map((box) => box.y1 - box.y0).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)];
  const limit = Math.max(MIN_LINE_HEIGHT * 2, median * 1.7);
  const result: LineBox[] = [];
  const queue = [...boxes];
  let guard = 0;
  while (queue.length && guard < 200) {
    guard += 1;
    const box = queue.shift() as LineBox;
    const height = box.y1 - box.y0;
    if (height <= limit) {
      result.push(box);
      continue;
    }
    let peak = 0;
    for (let y = box.y0; y < box.y1; y += 1) if (profile[y] > peak) peak = profile[y];
    // Only cut where there is a genuinely blank band: five consecutive rows with almost no
    // ink. Cutting at a merely "less dark" row would slice a word in half, and a half-word
    // in a part is worse than a tall part.
    const quietLevel = Math.max(4, peak * 0.15);
    const bandRows = 5;
    const from = Math.max(box.y0 + 8, Math.round(box.y0 + height * 0.18));
    const to = Math.min(box.y1 - 8, Math.round(box.y1 - height * 0.18));
    let cut = -1;
    let cutValue = Infinity;
    for (let y = from; y <= to - bandRows; y += 1) {
      let bandSum = 0;
      for (let index = 0; index < bandRows; index += 1) bandSum += profile[y + index];
      const bandMean = bandSum / bandRows;
      if (bandMean > quietLevel) continue;
      if (bandMean < cutValue) {
        cutValue = bandMean;
        cut = y + Math.floor(bandRows / 2);
      }
    }
    if (cut <= box.y0 || cut >= box.y1 - 1) {
      result.push(box);
      continue;
    }
    queue.unshift({ y0: box.y0, y1: cut });
    queue.unshift({ y0: cut + 1, y1: box.y1 });
  }
  return result.concat(queue).sort((a, b) => a.y0 - b.y0);
}

/**
 * Packs detected lines into as few parts as the pixel budget allows.
 *
 * Each part is widened by `LINE_MARGIN` so neighbouring dots and accents stay attached.
 * When the page has too few lines to split (a printed sheet), or the lines do not divide
 * evenly, the packer still returns whole-line parts — never a part that starts mid-line.
 */
export function planLineParts(lineBoxes: LineBox[], page: { width: number; height: number }, options: { budgetPx?: number; maxParts?: number } = {}): LinePart[] {
  const { width, height } = page;
  const budgetPx = options.budgetPx ?? 1_500_000;
  const maxParts = options.maxParts ?? 6;
  if (!lineBoxes.length || width <= 0 || height <= 0) return [];

  // Group the lines into bands of consecutive lines, then cut the groups where the
  // accumulated height would overflow the budget.
  const padded = lineBoxes.map((box) => {
    const slack = Math.max(6, Math.round((box.y1 - box.y0) * LINE_MARGIN));
    return { y0: Math.max(0, box.y0 - slack), y1: Math.min(height, box.y1 + slack) };
  });

  const targetHeight = budgetPx / width;
  const groups: Array<{ y0: number; y1: number; lines: number }> = [];
  let current: { y0: number; y1: number; lines: number } | null = null;
  for (const box of padded) {
    if (!current) {
      current = { y0: box.y0, y1: box.y1, lines: 1 };
      continue;
    }
    const mergedHeight = Math.max(current.y1, box.y1) - current.y0;
    if (mergedHeight > targetHeight) {
      groups.push(current);
      current = { y0: box.y0, y1: box.y1, lines: 1 };
    } else {
      current = { y0: current.y0, y1: Math.max(current.y1, box.y1), lines: current.lines + 1 };
    }
  }
  if (current) groups.push(current);

  // Too many groups: merge the smallest neighbours until the part count fits.
  while (groups.length > maxParts) {
    let bestIndex = 0;
    let bestHeight = Infinity;
    for (let index = 0; index < groups.length - 1; index += 1) {
      const combined = groups[index + 1].y1 - groups[index].y0;
      if (combined < bestHeight) {
        bestHeight = combined;
        bestIndex = index;
      }
    }
    const merged = { y0: groups[bestIndex].y0, y1: groups[bestIndex + 1].y1, lines: groups[bestIndex].lines + groups[bestIndex + 1].lines };
    groups.splice(bestIndex, 2, merged);
  }

  const kept = groups.filter((group) => group.y1 > group.y0);
  // A question is not always one line: on the operator's sheet question 2 runs over two
  // lines, and cutting between them would deliver half a question to one part and half to
  // the next. So each part reaches one line into its neighbour's territory. The overlap is
  // small — one line — and the importer already collapses a question that appears twice.
  const overlapped = kept.map((group, index) => {
    const above = index > 0 ? padded.filter((box) => box.y1 <= group.y0).pop() : undefined;
    const below = index < kept.length - 1 ? padded.find((box) => box.y0 >= group.y1) : undefined;
    return {
      y0: Math.max(0, above ? above.y0 : group.y0),
      y1: Math.min(height, below ? below.y1 : group.y1),
      lines: group.lines,
    };
  });
  return overlapped.map((group, index, all) => ({ y0: group.y0, height: group.y1 - group.y0, index: index + 1, total: all.length, lines: group.lines }));
}
