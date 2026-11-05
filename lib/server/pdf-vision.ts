import path from "path";
import type { GradeApiRequest, ProviderId } from "../types";
import { ProviderError } from "./providers";

const MAX_PDF_PAGES = 20;
const MAX_TOTAL_VISION_FILES = 30;
const MAX_PAGE_PIXELS = 12_000_000;
const MAX_PAGE_DIMENSION = 2400;
const RENDER_SCALE = 2;
const JPEG_QUALITY = 88;

type VisionFile = GradeApiRequest["files"][number];

/** Convert PDF pages locally; no OCR or external conversion service is involved. */
export async function renderPdfToVisionFiles(file: VisionFile, availableSlots: number, onlyPage?: number): Promise<VisionFile[]> {
  if (availableSlots < 1) throw new ProviderError("تعداد صفحات و فایل‌های این دانش‌آموز بیش از حد مجاز است؛ برگه را به دسته‌های کوچک‌تر تقسیم کنید.", 413);
  if (file.type !== "application/pdf") return [file];
  const data = Buffer.from(file.data, "base64");
  if (data.length < 10 || !data.subarray(0, 5).toString("ascii").startsWith("%PDF-")) {
    throw new ProviderError(`فایل «${file.name}» با وجود پسوند PDF، ساختار معتبر PDF ندارد.`, 400);
  }
  let loadingTask: { promise: Promise<{
    numPages: number;
    getPage: (pageNumber: number) => Promise<{
      getViewport: (options: { scale: number }) => { width: number; height: number };
      render: (options: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }) => { promise: Promise<void> };
      cleanup: () => void;
    }>;
  }>; destroy: () => Promise<void> } | undefined;

  try {
    // Load Canvas first and keep it deduped with PDF.js's optional dependency.
    // Two native Canvas copies can crash while rendering image-based/scanned PDFs.
    const canvasModule = await import("@napi-rs/canvas");
    for (const [name, value] of [["DOMMatrix", canvasModule.DOMMatrix], ["ImageData", canvasModule.ImageData], ["Path2D", canvasModule.Path2D]] as const) {
      if (!(name in globalThis)) Object.defineProperty(globalThis, name, { value, configurable: true });
    }
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const pdfjsRoot = path.join(process.cwd(), "node_modules", "pdfjs-dist");
    loadingTask = getDocument({
      data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      useSystemFonts: true,
      isEvalSupported: false,
      cMapUrl: `${path.join(pdfjsRoot, "cmaps")}${path.sep}`,
      cMapPacked: true,
      standardFontDataUrl: `${path.join(pdfjsRoot, "standard_fonts")}${path.sep}`,
      verbosity: 0,
    }) as unknown as NonNullable<typeof loadingTask>;
    const document = await loadingTask.promise;
    if (onlyPage === undefined && (document.numPages > MAX_PDF_PAGES || document.numPages > availableSlots)) {
      throw new ProviderError(`PDF «${file.name}» ${document.numPages} صفحه دارد. حداکثر ${MAX_PDF_PAGES} صفحه برای هر PDF و ۳۰ صفحه/فایل در هر تصحیح پشتیبانی می‌شود؛ آن را به دسته‌های کوچک‌تر تقسیم کنید.`, 413);
    }
    if (onlyPage !== undefined && (!Number.isInteger(onlyPage) || onlyPage < 1 || onlyPage > document.numPages)) {
      throw new ProviderError(`صفحهٔ درخواست‌شده در PDF «${file.name}» وجود ندارد.`, 400);
    }
    const baseName = file.name.replace(/\.pdf$/i, "").slice(0, 220) || "برگه";
    const output: VisionFile[] = [];
    const firstPage = onlyPage ?? 1;
    const lastPage = onlyPage ?? document.numPages;
    for (let pageNumber = firstPage; pageNumber <= lastPage; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const dimensionScale = Math.min(MAX_PAGE_DIMENSION / baseViewport.width, MAX_PAGE_DIMENSION / baseViewport.height);
      const pixelScale = Math.sqrt(MAX_PAGE_PIXELS / (baseViewport.width * baseViewport.height));
      const scale = Math.min(RENDER_SCALE, dimensionScale, pixelScale);
      if (!Number.isFinite(scale) || scale < 0.25) throw new ProviderError(`ابعاد صفحهٔ ${pageNumber} PDF «${file.name}» برای پردازش امن نامعتبر است.`, 400);
      const viewport = page.getViewport({ scale });
      const canvas = canvasModule.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const context = canvas.getContext("2d");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      try {
        await page.render({ canvasContext: context as unknown as CanvasRenderingContext2D, viewport }).promise;
        const jpeg = canvas.toBuffer("image/jpeg", JPEG_QUALITY);
        output.push({ name: `${baseName} — صفحه ${pageNumber}.jpg`, type: "image/jpeg", data: jpeg.toString("base64") });
      } finally {
        page.cleanup();
        canvas.width = 1;
        canvas.height = 1;
      }
    }
    return output;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(`تبدیل PDF «${file.name}» به تصویر انجام نشد. فایل رمزدار، خراب یا غیراستاندارد است؛ نسخهٔ سالم و بدون رمز را دوباره بارگذاری کنید.`, 400);
  } finally {
    if (loadingTask) await loadingTask.destroy().catch(() => undefined);
  }
}

export async function prepareProviderFiles(files: GradeApiRequest["files"], provider: ProviderId, options: { convertAllPdfs?: boolean } = {}): Promise<GradeApiRequest["files"]> {
  const shouldConvertPdfs = options.convertAllPdfs || ["deepseek", "zai", "minimax", "inkling", "mistral"].includes(provider);
  if (!shouldConvertPdfs || !files.some((file) => file.type === "application/pdf")) return files;
  const output: VisionFile[] = [];
  for (const file of files) {
    const converted = await renderPdfToVisionFiles(file, MAX_TOTAL_VISION_FILES - output.length);
    output.push(...converted);
  }
  return output;
}
