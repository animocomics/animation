// Wrangler compiles this import before the Worker starts. PDFium must never
// compile bytes fetched at request time in workerd.
import pdfiumModule from "./pdfium.esm.wasm";
import nomrehWorker from "../.open-next/worker.js";

globalThis.__NOMREH_PDFIUM_MODULE__ = pdfiumModule;

export default nomrehWorker;
export { DOQueueHandler, DOShardedTagCache, BucketCachePurge } from "../.open-next/worker.js";
