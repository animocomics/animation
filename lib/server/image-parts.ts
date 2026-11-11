/**
 * A phone photo of a page is far too much paper for one look.
 *
 * The operator photographed a notebook page: 3024 x 3000, 9.1 megapixels of handwriting
 * packed into ten lines. Gemini does not receive that image — it receives a tokenised
 * version of it, and the budget is a token count, not a pixel count: about 1120 tokens
 * at "high", which is roughly 0.84 megapixels. So a 9.1 MP photo is shrunk to about
 * 920 x 913 before the model ever sees it, and each handwritten line arrives about
 * 61 pixels tall. That is why a stronger model did not help: no model can read strokes
 * that were thrown away in transport.
 *
 * The fix is not a better model. It is sending the page in several parts, each small
 * enough that the model keeps it near full resolution. Six parts of this photo arrive
 * at roughly 200 px per line — three times the detail — for a few thousand extra input
 * tokens, which is a fraction of a cent.
 */
export type ImagePart = { y0: number; height: number; index: number; total: number };

/**
 * The pixel area one part may occupy.
 *
 * 1.5 MP sits just under the "ultra_high" image budget (~1.68 MP), which is the most
 * detail the API will take from one image. Above this, the API starts throwing pixels
 * away again, so splitting further buys nothing.
 */
const DEFAULT_PART_BUDGET_PX = 1_500_000;

/** More parts than this is not worth the latency or the money; upscale-instead. */
const MAX_PARTS = 6;

/** Bands overlap so a line of handwriting is never cut in half by the seam. */
const OVERLAP_FRACTION = 0.08;

export function imagePartBudgetPx(raw = process.env.NOMREH_IMAGE_PART_BUDGET_PX): number {
  const text = String(raw ?? "").trim();
  if (!text) return DEFAULT_PART_BUDGET_PX;
  const value = Number(text);
  if (!Number.isFinite(value)) return DEFAULT_PART_BUDGET_PX;
  return Math.min(4_000_000, Math.max(400_000, Math.round(value)));
}

/**
 * How to cut one image into bands the model can actually read.
 *
 * Rows only, never columns: Persian reads right to left, so a vertical cut slices
 * through words, while a horizontal cut lands between lines. The overlap makes sure a
 * question sitting on the seam still appears whole in one of its two bands.
 */
export function planImageParts(width: number, height: number, options: { budgetPx?: number; maxParts?: number } = {}): ImagePart[] {
  const budgetPx = options.budgetPx ?? imagePartBudgetPx();
  const maxParts = options.maxParts ?? MAX_PARTS;
  const whole: ImagePart = { y0: 0, height, index: 1, total: 1 };
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return [whole];

  const area = width * height;
  // A part may exceed the budget slightly before it is worth another request; a page
  // that is 10% over does not lose the detail that matters.
  if (area <= budgetPx * 1.15) return [whole];

  const wanted = Math.ceil(area / budgetPx);
  const total = Math.max(2, Math.min(maxParts, wanted));
  // Bands overlap, so they must be taller than an exact division for the last band to
  // reach the bottom edge without duplicating the whole page.
  const height_ = Math.ceil((height / total) * (1 + OVERLAP_FRACTION));
  if (height_ >= height) return [whole];

  const parts: ImagePart[] = [];
  for (let index = 0; index < total; index += 1) {
    const y0 = Math.round((index * (height - height_)) / (total - 1));
    parts.push({ y0, height: height_, index: index + 1, total });
  }
  return parts;
}

/** The label a teacher sees on the manifest, so a band is never mistaken for a page. */
export function partLabel(index: number, total: number): string {
  return total > 1 ? `بخش ${index} از ${total}` : "";
}
