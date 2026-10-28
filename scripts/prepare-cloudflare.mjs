import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const source = resolve("node_modules/clawpdf/dist/vendor/pdfium.esm.wasm");
const destination = resolve("cloudflare/pdfium.esm.wasm");
mkdirSync(resolve("cloudflare"), { recursive: true });
copyFileSync(source, destination);
console.log("PDFium WASM module prepared for the Cloudflare Worker.");
