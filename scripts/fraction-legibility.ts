import fs from "node:fs";
import path from "node:path";
import { renderPdfToVisionFiles } from "../lib/server/pdf-vision";

/**
 * How readable is a page at a given render size?
 *
 * Nobody can settle "is 3000 px better?" by looking at two pictures and nodding. The
 * question that decides it is concrete: at this size, does the thing the model has to
 * read — a numerator, a bar, a denominator — still consist of separable strokes, or
 * has it melted into one dark blob?
 *
 * This measures that. It builds a sheet with stacked fractions exactly as a printed
 * exam has them, renders it at each candidate size through the real code path, then
 * counts how many of the three elements of each fraction survive as distinct dark
 * runs on a scanline. A fraction where the bar and both digits merge is counted as
 * unreadable, because that is what a model sees too.
 *
 *   npx tsx scripts/fraction-legibility.ts
 */

const { createCanvas, DOMMatrix, ImageData, Path2D, loadImage } = require("@napi-rs/canvas");
for (const [name, value] of [["DOMMatrix", DOMMatrix], ["ImageData", ImageData], ["Path2D", Path2D]] as const) {
  if (!(name in globalThis)) Object.defineProperty(globalThis, name, { value, configurable: true });
}

const FRACTIONS: Array<[string, string]> = [["3", "4"], ["1", "2"], ["5", "8"], ["2", "3"]];

function buildSheet(): Buffer {
  const width = 1240;
  const height = 1754;
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#111";

  // Text at the size a real exam uses on A4 (about 12 pt).
  context.font = "22px DejaVu Sans";
  context.fillText("Persian exam sheet — fractions", 60, 60);
  FRACTIONS.forEach(([numerator, denominator], index) => {
    const x = 90 + index * 220;
    const y = 180;
    context.font = "26px DejaVu Sans";
    context.fillText(`${index + 1})`, x - 48, y + 22);
    context.fillText(numerator, x + 14, y);
    context.fillRect(x, y + 8, 46, 2.5); // the fraction bar
    context.fillText(denominator, x + 12, y + 46);
  });
  return canvas.toBuffer("image/png");
}

/**
 * Per-row ink counts inside one column window.
 *
 * A fraction is readable to a reader (and to a vision model) only when three things
 * stay physically apart: the numerator, the bar, and the denominator. So the honest
 * measurement is vertical, not horizontal: collect the dark-pixel count of every row
 * in the column, find the bar (the one row that is much darker than its neighbours
 * because it spans the whole width), and require at least one completely blank row
 * between the bar and each digit. Where those gaps close, a reader sees one blob —
 * and that is exactly where "۳/۴" comes back as "۳۴" or "۲۵۴۱".
 */
function rowInk(gray: Uint8Array, width: number, y: number, x0: number, x1: number, threshold = 128): number {
  let ink = 0;
  for (let x = x0; x < x1; x += 1) if (gray[y * width + x] < threshold) ink += 1;
  return ink;
}

function fractionSeparable(gray: Uint8Array, width: number, scaleFactor: number, column: number): boolean {
  const x0 = Math.round((70 + column * 220) * scaleFactor);
  const x1 = Math.round((70 + column * 220 + 130) * scaleFactor);
  const top = Math.round(150 * scaleFactor);
  const bottom = Math.round(260 * scaleFactor);
  const window = Math.max(4, Math.round(130 * scaleFactor));

  let barRow = -1;
  let barInk = 0;
  for (let y = top; y < bottom; y += 1) {
    const ink = rowInk(gray, width, y, x0, x1);
    if (ink > barInk) {
      barInk = ink;
      barRow = y;
    }
  }
  // The bar must be a real horizontal stroke, not just the darkest text row.
  if (barRow < 0 || barInk < window * 0.25) return false;

  let numeratorRows = 0;
  for (let y = top; y < barRow; y += 1) if (rowInk(gray, width, y, x0, x1) > 0) numeratorRows += 1;
  let denominatorRows = 0;
  for (let y = barRow + 1; y < bottom; y += 1) if (rowInk(gray, width, y, x0, x1) > 0) denominatorRows += 1;
  if (numeratorRows < 3 || denominatorRows < 3) return false;

  // The bar is a band, not a single row (a 2.5 px stroke lands on 2-3 rows at this
  // scale), so walk out of the band it occupies and then require the first row after
  // it to be completely blank. That blank row is the thing that separates numerator
  // from bar from denominator; where it closes up, the reader sees one blob.
  const isBarRow = (y: number) => rowInk(gray, width, y, x0, x1) > window * 0.25;
  let bandTop = barRow;
  let bandBottom = barRow;
  while (bandTop > top && isBarRow(bandTop - 1)) bandTop -= 1;
  while (bandBottom < bottom - 1 && isBarRow(bandBottom + 1)) bandBottom += 1;
  const blankAbove = bandTop > top && rowInk(gray, width, bandTop - 1, x0, x1) === 0;
  const blankBelow = bandBottom < bottom - 1 && rowInk(gray, width, bandBottom + 1, x0, x1) === 0;
  return blankAbove && blankBelow;
}

async function measure(pdf: Buffer, label: string) {
  const files = await renderPdfToVisionFiles({ name: "sheet.pdf", type: "application/pdf", data: pdf.toString("base64") }, 30);
  const image = await loadImage(Buffer.from(files[0].data, "base64"));
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  const gray = new Uint8Array(canvas.width * canvas.height);
  for (let index = 0; index < gray.length; index += 1) {
    gray[index] = Math.round(0.299 * data[index * 4] + 0.587 * data[index * 4 + 1] + 0.114 * data[index * 4 + 2]);
  }
  const scaleFactor = canvas.height / 1754;
  let separable = 0;
  for (let column = 0; column < 4; column += 1) {
    if (fractionSeparable(gray, canvas.width, scaleFactor, column)) separable += 1;
  }
  if (process.env.NOMREH_DUMP) fs.writeFileSync(path.join("/tmp", `fraction-${label.replace(/\s+/g, "")}.jpg`), Buffer.from(files[0].data, "base64"));
  return {
    label,
    renderedWidth: canvas.width,
    renderedHeight: canvas.height,
    pageKb: Math.round(Buffer.from(files[0].data, "base64").length / 1024),
    fractionsSeparable: `${separable}/4`,
  };
}

async function main() {
  const png = buildSheet();
  // Wrap the sheet in a one-page PDF by the same route the app receives it.
  const { createCanvas: create } = require("@napi-rs/canvas");
  const canvas = create(1240, 1754);
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, 1240, 1754);
  context.drawImage(await loadImage(png), 0, 0, 1240, 1754);
  const jpeg = canvas.toBuffer("image/jpeg", 92);

  const objects: string[] = [];
  objects.push(`<< /Type /Catalog /Pages 2 0 R >>`);
  objects.push(`<< /Type /Pages /Kids [3 0 R] /Count 1 >>`);
  objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1240 1754] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`);
  const content = "q 1240 0 0 1754 0 0 cm /Im0 Do Q";
  objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  objects.push(`<< /Type /XObject /Subtype /Image /Width 1240 /Height 1754 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);

  let out = Buffer.from("%PDF-1.4\n");
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out = Buffer.concat([out, Buffer.from(`${index + 1} 0 obj\n${body}\n`)]);
    out = Buffer.concat([out, index === 4 ? Buffer.concat([jpeg, Buffer.from("\nendstream\nendobj\n")]) : Buffer.from("endobj\n")]);
  });
  const xref = out.length;
  let table = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((offset) => {
    table += `${String(offset).padStart(10, "0")} 00000 n \n`;
  });
  table += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  out = Buffer.concat([out, Buffer.from(table)]);

  const results = [];
  for (const maxPx of ["2400", "3000", "3600"]) {
    process.env.NOMREH_PAGE_MAX_PX = maxPx;
    process.env.NOMREH_PAGE_JPEG_QUALITY = "88";
    results.push(await measure(out, `maxPx ${maxPx}`));
  }
  console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
