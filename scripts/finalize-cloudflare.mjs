import { readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

// OpenNext traces PDFium's browser fallback asset, but the Worker entry uses
// Wrangler's precompiled module instead. Do not ship a second, unreachable copy.
const assetDirectory = resolve(".open-next/server-functions/default/.next/server/assets");
try {
  for (const file of readdirSync(assetDirectory)) {
    if (/^pdfium\.esm\..*\.wasm$/.test(file)) rmSync(resolve(assetDirectory, file));
  }
} catch {
  // The directory is optional for adapters that do not trace WASM assets.
}
