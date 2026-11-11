import path from "path";
import type { GradeApiRequest, ProviderId } from "../types";
import { planImageParts } from "./image-parts";
import { ProviderError } from "./providers";
import { providerNeedsPdfRaster } from "./provider-traits";

const MAX_PDF_PAGES = 20;
const MAX_TOTAL_VISION_FILES = 30;

/**
 * How large a page is rendered before it is sent to the model.
 *
 * This is the single biggest lever on whether a model reads the sheet or guesses at
 * it. The operator reported answers containing fractions coming back wrong — a
 * stacked numerator over a bar over a denominator is only a few pixels of ink, and at
 * the old 2400 px ceiling a `۳/۴` collapsed into something that looked like `۲۵۴۱`.
 * Raising the default to 3000 px makes the bar and the digits separable, at roughly
 * 1.6x the image bytes of the old default.
 *
 * The pixel ceiling scales with the square of that, otherwise the dimension cap is
 * quietly undone by the pixel cap and the setting appears to do nothing.
 */
const DEFAULT_PAGE_MAX_PX = 3000;
const PAGE_MAX_PX_FLOOR = 1200;
const PAGE_MAX_PX_CEILING = 4000;
const MAX_PAGE_PIXELS = 20_000_000;
const RENDER_SCALE = 2;
const DEFAULT_JPEG_QUALITY = 88;

/**
 * Reads a numeric setting, treating "not set" and "set to nothing" as the same thing.
 *
 * `Number("")` is 0, not NaN, so `Number(process.env.X || "")` quietly turned an
 * empty variable into the minimum value instead of the default. That is how a page
 * defaulting to 3000 px rendered at 1200 — the exact opposite of the detail the
 * operator asked for — and it would have shipped looking like the setting was ignored.
 */
function numberSetting(raw: string | undefined, fallback: number, min: number, max: number): number {
  const text = String(raw ?? "").trim();
  if (!text) return fallback;
  const value = Number(text);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function pageMaxPx(): number {
  return numberSetting(process.env.NOMREH_PAGE_MAX_PX, DEFAULT_PAGE_MAX_PX, PAGE_MAX_PX_FLOOR, PAGE_MAX_PX_CEILING);
}

/**
 * The render settings in one place, so the diagnostics panel can report the exact
 * numbers the request path will use instead of a second copy that drifts.
 * `estimatedPageBytes` is measured, not guessed. A dense A4 page of text at quality
 * 88 comes out at about 106 KB at 2400 px, 147 KB at 3000 px and 158 KB at 3600 px;
 * the curve flattens because anti-aliasing, not detail, dominates the extra pixels.
 * The linear-in-area estimate here is deliberately conservative (it over-states at the
 * top end) so the page-count advice errs on the side of fewer pages per request.
 */
export function pageRenderSettings(): { maxPx: number; jpegQuality: number; estimatedPageBytes: number } {
  const maxPx = pageMaxPx();
  const quality = jpegQuality();
  const baselineKb = 147;
  const qualityFactor = Math.max(0.7, Math.min(1.3, quality / 88));
  return {
    maxPx,
    jpegQuality: quality,
    estimatedPageBytes: Math.round(baselineKb * 1024 * (maxPx / 3000) ** 2 * qualityFactor),
  };
}

function jpegQuality(): number {
  return numberSetting(process.env.NOMREH_PAGE_JPEG_QUALITY, DEFAULT_JPEG_QUALITY, 60, 95);
}

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
      const maxPx = pageMaxPx();
      const dimensionScale = Math.min(maxPx / baseViewport.width, maxPx / baseViewport.height);
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
        const jpeg = canvas.toBuffer("image/jpeg", jpegQuality());
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

/**
 * Cuts a large photo into overlapping bands before it is sent.
 *
 * A phone picture is 9 megapixels; the model's image budget is under one. Sending the
 * photo whole does not fail — it silently shrinks the handwriting until the model is
 * guessing. Splitting it keeps each band near the detail ceiling, and because the API
 * bills per token of image rather than per request, the cost is a few thousand tokens,
 * not a second page.
 *
 * Only images are touched, and only images that are genuinely oversized: a screenshot
 * or a scan that already fits the budget passes through untouched.
 */
/**
 * Makes a phone photo of a page easier to read before anyone tries to read it.
 *
 * The operator's notebook photo has three problems that cost accuracy before the model
 * is even involved: the paper is blue-tinted, the ink is a similar dark blue, and the
 * lighting darkens one side. Turned to grey and stretched, the same photo reads plainly
 * where it was guesswork — the strokes separate from the paper instead of blending into
 * it.
 *
 * The rule is deliberately narrow. A photographed page is recognised by its ink being
 * *less red* than its paper, which is what a blue or black pen on paper looks like.
 * A printed scan, a photocopy, or a coloured form does not match that signature and is
 * passed through untouched: enhancing it would only add artefacts.
 */
export function looksLikeInkOnPaper(samples: { red: number; green: number; blue: number }[]): boolean {
  if (samples.length < 100) return false;
  let bluishInk = 0;
  let paperish = 0;
  for (const sample of samples) {
    const paperLevel = Math.max(sample.green, sample.blue);
    if (paperLevel - sample.red > 35) bluishInk += 1;
    if (paperLevel > 190) paperish += 1;
  }
  // Enough light paper to be a page, and enough blue-dark ink to be handwriting on it.
  return paperish / samples.length > 0.35 && bluishInk / samples.length > 0.01;
}

export async function enhancePhoto(file: VisionFile): Promise<VisionFile> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return file;
  let canvasModule: typeof import("@napi-rs/canvas") | undefined;
  try {
    canvasModule = await import("@napi-rs/canvas");
    const buffer = Buffer.from(file.data, "base64");
    const image = await canvasModule.loadImage(buffer);
    // Sampling every 17th pixel is enough to tell ink-on-paper from anything else, and
    // avoids a second full-resolution pass over a nine-megapixel photo.
    const width = image.width;
    const height = image.height;
    const canvas = canvasModule.createCanvas(width, height);
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, width, height);
    const samples: { red: number; green: number; blue: number }[] = [];
    for (let index = 0; index < data.length; index += 4 * 17) {
      samples.push({ red: data[index], green: data[index + 1], blue: data[index + 2] });
    }
    if (!looksLikeInkOnPaper(samples)) {
      canvas.width = 1;
      canvas.height = 1;
      return file;
    }
    const out = new canvasModule.ImageData(width, height);
    // Two separate mistakes are avoided here, both of which were measured on the
    // operator's photo rather than guessed at:
    //  - without a floor, paper texture and shadow become grey specks that look like
    //    ink and cost the model attention;
    //  - with too brutal a stretch, thin pen strokes go pale and break up.
    // So everything below the floor is forced to clean white, and above it the stroke
    // is ramped rather than crushed.
    const INK_FLOOR = 0.32;
    const INK_RANGE = 85;
    for (let index = 0; index < data.length; index += 4) {
      const red = data[index];
      const paperLevel = Math.max(data[index + 1], data[index + 2]);
      const inkness = (paperLevel - red) / INK_RANGE;
      let value = 255;
      if (inkness > INK_FLOOR) {
        const strength = Math.min(1, (inkness - INK_FLOOR) / (1 - INK_FLOOR));
        value = Math.round(255 * (1 - Math.pow(strength, 0.55)));
      }
      out.data[index] = value;
      out.data[index + 1] = value;
      out.data[index + 2] = value;
      out.data[index + 3] = 255;
    }
    context.putImageData(out, 0, 0);
    const jpeg = canvas.toBuffer("image/jpeg", jpegQuality());
    canvas.width = 1;
    canvas.height = 1;
    return { name: file.name.replace(/\.(jpe?g|png|webp)$/i, "") + ".jpg", type: "image/jpeg", data: jpeg.toString("base64") };
  } catch {
    return file;
  }
}

export async function splitLargeImages(files: VisionFile[], budgetPx?: number, maxParts = 6): Promise<VisionFile[]> {
  const output: VisionFile[] = [];
  for (const file of files) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
      output.push(file);
      continue;
    }
    const buffer = Buffer.from(file.data, "base64");
    let width = 0;
    let height = 0;
    let canvasModule: typeof import("@napi-rs/canvas") | undefined;
    try {
      canvasModule = await import("@napi-rs/canvas");
      const image = await canvasModule.loadImage(buffer);
      width = image.width;
      height = image.height;
      const parts = planImageParts(width, height, { budgetPx, maxParts });
      if (parts.length === 1) {
        output.push(file);
        continue;
      }
      const baseName = file.name.replace(/\.(jpe?g|png|webp)$/i, "").slice(0, 200) || "برگه";
      for (const part of parts) {
        const canvas = canvasModule.createCanvas(width, part.height);
        const context = canvas.getContext("2d");
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, width, part.height);
        context.drawImage(image, 0, part.y0, width, part.height, 0, 0, width, part.height);
        const jpeg = canvas.toBuffer("image/jpeg", jpegQuality());
        output.push({
          name: `${baseName} — بخش ${part.index} از ${part.total}.jpg`,
          type: "image/jpeg",
          data: jpeg.toString("base64"),
        });
        canvas.width = 1;
        canvas.height = 1;
      }
    } catch {
      // A photo that cannot be decoded is passed through unchanged: failing the whole
      // import over an unusual image format would be worse than a lower-detail attempt.
      output.push(file);
    }
  }
  return output;
}

export async function prepareProviderFiles(files: GradeApiRequest["files"], provider: ProviderId, options: { convertAllPdfs?: boolean } = {}): Promise<GradeApiRequest["files"]> {
  const shouldConvertPdfs = options.convertAllPdfs || providerNeedsPdfRaster(provider);
  if (!shouldConvertPdfs || !files.some((file) => file.type === "application/pdf")) return files;
  const output: VisionFile[] = [];
  for (const file of files) {
    const converted = await renderPdfToVisionFiles(file, MAX_TOTAL_VISION_FILES - output.length);
    output.push(...converted);
  }
  return output;
}
