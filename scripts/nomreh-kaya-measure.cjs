#!/usr/bin/env node
"use strict";

// Measures the size of the request Nomreh actually sends for one sheet.
//
//   npm run kaya:measure             # describe the last graded file
//   npm run kaya:measure -- <file>   # describe one of your own files
//
// The only difference between a grading run that succeeded and one that does not
// is the bytes in the body. Kaya, like every gateway, has a ceiling, and a
// photographed sheet at full resolution can cross it. When it does, the reply is
// either a 413 or no reply at all, and the panel only says "connection failed".
//
// This reports the size before sending, so a failure can be predicted instead of
// guessed. Nothing leaves the machine, nothing is written, no key is read.

const path = require("node:path");
const { ensureNode22 } = require("./lib/plesk-node-delegate.cjs");

if (!ensureNode22(__filename)) process.exit(2);

const fs = require("node:fs");

// Mirrors lib/server/pdf-vision.ts, which is where these numbers are set.
const MAX_PDF_PAGES = 20;
const MAX_PAGE_PIXELS = 12_000_000;
const MAX_PAGE_DIMENSION = 2400;
const RENDER_SCALE = 2;
const JPEG_QUALITY = 88;
// Provider ceilings from app/api/grade/route.ts.
const LIMITS = { kaya: 24, gemini: 14, default: 40 };

function megabytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function head(title) {
  console.log(`\n== ${title}`);
}

function report(label, encodedBytes, limitMb) {
  const raw = Math.floor(encodedBytes * 0.75);
  const limit = limitMb * 1024 * 1024;
  const percent = Math.round((raw / limit) * 100);
  console.log(`  ${String(label).padEnd(16)} ${megabytes(raw).padStart(9)}  ${String(percent).padStart(3)}% of a ${limitMb} MB ceiling`);
  return raw;
}

function measureImage(file) {
  let NapiCanvas = null;
  try {
    NapiCanvas = require("@napi-rs/canvas");
  } catch {
    NapiCanvas = null;
  }
  const original = fs.statSync(file).size;
  if (!NapiCanvas) {
    console.log(`  ${path.basename(file)} is ${megabytes(original)} on disk; the canvas module is missing so the re-encode cannot be measured.`);
    return original;
  }
  const { loadImage, createCanvas } = NapiCanvas;
  return loadImage(file).then((image) => {
    const scale = Math.min(RENDER_SCALE, MAX_PAGE_DIMENSION / image.width, MAX_PAGE_DIMENSION / image.height, Math.sqrt(MAX_PAGE_PIXELS / (image.width * image.height)));
    const canvas = createCanvas(Math.round(image.width * scale), Math.round(image.height * scale));
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
    const encoded = canvas.toBuffer("image/jpeg", JPEG_QUALITY);
    console.log(`  ${path.basename(file)}: ${image.width}x${image.height} → ${canvas.width}x${canvas.height} JPEG, ${megabytes(encoded.length)} (${megabytes(original)} on disk)`);
    return encoded.length;
  });
}

async function renderPdf(file) {
  let pdfjs;
  try {
    pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  } catch {
    return { pages: 0, bytes: 0, note: "pdfjs-dist was not loadable here" };
  }
  const data = new Uint8Array(fs.readFileSync(file));
  const document = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise;
  const pages = Math.min(document.numPages, MAX_PDF_PAGES);
  let NapiCanvas = null;
  try {
    NapiCanvas = require("@napi-rs/canvas");
  } catch {
    NapiCanvas = null;
  }
  if (!NapiCanvas) return { pages: document.numPages, bytes: 0, note: "the canvas module is missing" };
  let total = 0;
  for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(RENDER_SCALE, MAX_PAGE_DIMENSION / base.width, MAX_PAGE_DIMENSION / base.height, Math.sqrt(MAX_PAGE_PIXELS / (base.width * base.height)));
    const viewport = page.getViewport({ scale });
    const canvas = NapiCanvas.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvasContext: canvas.getContext("2d"), viewport, canvas }).promise;
    total += canvas.toBuffer("image/jpeg", JPEG_QUALITY).length;
  }
  return { pages: document.numPages, rendered: pages, bytes: total, note: "" };
}

async function main() {
  console.log(`Nomreh request size — node ${process.version}`);

  const argument = process.argv.slice(2).find((value) => !value.startsWith("-"));
  head("which file");
  let file = argument || "";
  if (!file) {
    // The most recent graded sheet is the one worth measuring: it is the real
    // case, with the real scanner, and the real size.
    const dataDir = process.env.NOMREH_DATA_DIR || path.resolve(__dirname, "..", "..", "nomreh-data");
    let DatabaseSync = null;
    try {
      ({ DatabaseSync } = require("node:sqlite"));
    } catch {
      DatabaseSync = null;
    }
    if (!DatabaseSync) {
      console.log("  No file given, and node:sqlite is missing, so the last graded sheet cannot be found.");
      console.log("  Run: npm run kaya:measure -- path/to/sheet.pdf");
      return;
    }
    const dbFile = path.join(dataDir, "nomreh.db");
    if (!fs.existsSync(dbFile)) {
      console.log(`  No database at ${dbFile}; pass a file instead.`);
      return;
    }
    const db = new DatabaseSync(dbFile, { readOnly: true });
    let row = null;
    for (const table of ["grading_files", "files", "uploads"]) {
      try {
        row = db.prepare(`SELECT * FROM ${table} ORDER BY rowid DESC LIMIT 1`).get();
        if (row) break;
      } catch {
        /* table not present */
      }
    }
    db.close();
    if (!row) {
      console.log("  No stored file was found; pass a file instead: npm run kaya:measure -- sheet.pdf");
      return;
    }
    const candidate = row.stored_name || row.path || row.storage_path || row.name;
    console.log(`  Last stored file: ${candidate}`);
    file = candidate && fs.existsSync(candidate) ? candidate : "";
    if (!file) {
      console.log("  The stored file is not on this path; pass it directly: npm run kaya:measure -- <file>");
      return;
    }
  }
  if (!fs.existsSync(file)) {
    console.log(`  File not found: ${file}`);
    return;
  }
  console.log(`  ${file} (${megabytes(fs.statSync(file).size)})`);

  const extension = path.extname(file).toLowerCase();
  let base64Bytes = 0;

  if (extension === ".pdf") {
    head("PDF, rendered the way the app renders it");
    const result = await renderPdf(file);
    if (result.note) console.log(`  ${result.note}`);
    console.log(`  ${result.pages} page(s)${result.rendered ? `, ${result.rendered} rendered` : ""}`);
    if (result.pages > MAX_PDF_PAGES) console.log(`  More than ${MAX_PDF_PAGES} pages: the app converts and splits this automatically.`);
    base64Bytes = Math.ceil(result.bytes / 3) * 4;
  } else if (/\.(jpe?g|png)$/.test(extension)) {
    head("image, re-encoded the way the app sends it");
    const bytes = await measureImage(file);
    base64Bytes = Math.ceil(bytes / 3) * 4;
  } else {
    console.log(`  ${extension} is not an image or a PDF; the app sends it as-is.`);
    base64Bytes = Math.ceil(fs.statSync(file).size / 3) * 4;
  }

  head("what that means per provider");
  const raw = report("base64 body", base64Bytes, LIMITS.kaya);
  report("same, Gemini", base64Bytes, LIMITS.gemini);
  report("same, others", base64Bytes, LIMITS.default);

  console.log("");
  if (raw > LIMITS.kaya * 1024 * 1024) {
    console.log("  VERDICT: this sheet is above Kaya's ceiling. Grading it will fail before the model is reached,");
    console.log("  and the panel can only report a connection error. Split the sheet, or grade it with a");
    console.log("  lower-resolution scan.");
    console.log("\nKAYA_MEASURE_OVER_LIMIT");
  } else if (raw > LIMITS.kaya * 1024 * 1024 * 0.8) {
    console.log("  VERDICT: close to Kaya's ceiling. One extra page or a sharper scan will cross it.");
    console.log("\nKAYA_MEASURE_NEAR_LIMIT");
  } else {
    console.log("  VERDICT: comfortably inside the ceiling, so the payload is not what is failing.");
    console.log("\nKAYA_MEASURE_OK");
  }
}

main().catch((error) => {
  console.log(`\nmeasurement aborted: ${(error && error.message) || error}`);
  console.log("\nKAYA_MEASURE_ABORTED");
});
