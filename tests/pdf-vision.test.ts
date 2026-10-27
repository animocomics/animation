import assert from "node:assert/strict";
import test from "node:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { prepareProviderFiles, renderPdfToVisionFiles } from "../lib/server/pdf-vision";
import { callProvider, ProviderError } from "../lib/server/providers";
import type { GradeApiRequest } from "../lib/types";

async function makePdf(pageCount: number, scanned = false): Promise<GradeApiRequest["files"][number]> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const page = document.addPage([612, 792]);
    page.drawText(`Nomreh exam - page ${pageNumber}`, { x: 70, y: 700, size: 24, font });
    page.drawText("1) Mitochondria   2) Cell   3) ATP = 36", { x: 70, y: 640, size: 16, font });
    if (scanned) {
      const canvas = createCanvas(900, 420);
      const context = canvas.getContext("2d");
      context.fillStyle = "#eef7f5"; context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#146c64"; context.fillRect(40, 40, 820, 120);
      context.fillStyle = "#1d3557"; context.fillRect(40, 210, 600, 24); context.fillRect(40, 270, 760, 24);
      const image = await document.embedJpg(canvas.toBuffer("image/jpeg", 90));
      page.drawImage(image, { x: 55, y: 160, width: 500, height: 233 });
    }
  }
  return { name: "exam.pdf", type: "application/pdf", data: Buffer.from(await document.save()).toString("base64") };
}

test("DeepSeek PDF preprocessing renders scanned/image and vector pages to readable high-resolution JPEGs", async () => {
  const output = await renderPdfToVisionFiles(await makePdf(2, true), 30);
  assert.equal(output.length, 2);
  assert.deepEqual(output.map((file) => file.type), ["image/jpeg", "image/jpeg"]);
  assert.match(output[0].name, /صفحه 1/);
  assert.match(output[1].name, /صفحه 2/);
  for (const file of output) {
    const bytes = Buffer.from(file.data, "base64");
    assert.equal(bytes[0], 0xff); assert.equal(bytes[1], 0xd8); assert.equal(bytes[2], 0xff);
    const image = await loadImage(bytes);
    assert.ok(image.width >= 1200 && image.height >= 1500, `${image.width}x${image.height}`);
    assert.ok(bytes.length > 10_000);
  }
});

test("authenticated page preview can render one requested page without converting the whole PDF", async () => {
  const output = await renderPdfToVisionFiles(await makePdf(2), 1, 2);
  assert.equal(output.length, 1);
  assert.match(output[0].name, /صفحه 2/);
  assert.equal(output[0].type, "image/jpeg");
});

test("only DeepSeek changes PDF input; original images and other providers stay untouched", async () => {
  const image: GradeApiRequest["files"][number] = { name: "page.png", type: "image/png", data: "cG5nLXRlc3QtZGF0YQ==" };
  const input = [image, await makePdf(1)];
  const deepseek = await prepareProviderFiles(input, "deepseek");
  assert.equal(deepseek.length, 2);
  assert.equal(deepseek[0], image);
  assert.equal(deepseek[1].type, "image/jpeg");
  assert.equal(await prepareProviderFiles(input, "openai"), input);
  assert.equal(await prepareProviderFiles(input, "gemini"), input);
});

test("converted PDF reaches the DeepSeek adapter as JPEG images, never as input_file", async () => {
  const originalFetch = globalThis.fetch;
  let attachmentCount = 0;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const content = body.input[0].content as Array<{ type: string; image_url?: string }>;
    const images = content.filter((part) => part.type === "input_image");
    attachmentCount = images.length;
    assert.equal(images.length, 2);
    assert.ok(images.every((part) => part.image_url?.startsWith("data:image/jpeg;base64,")));
    assert.equal(content.filter((part) => part.type === "input_file").length, 0);
    return Response.json({ output_text: JSON.stringify({ detectedStudentName: "", detectedClassName: "", identityConfidence: 0, summary: "آزمون اتصال", strengths: [], improvements: [], overallConfidence: 0.9, questions: [], flags: [] }) });
  }) as typeof fetch;
  try {
    const converted = await prepareProviderFiles([await makePdf(2)], "deepseek");
    await callProvider({ provider: "deepseek", model: "deepseek-flash", apiKey: "test-deepseek-key", prompt: "prompt", files: converted });
    assert.equal(attachmentCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("invalid PDF content fails clearly before any model call", async () => {
  await assert.rejects(
    renderPdfToVisionFiles({ name: "broken.pdf", type: "application/pdf", data: Buffer.from("this is not a pdf").toString("base64") }, 30),
    (error: unknown) => error instanceof ProviderError && error.status === 400 && /ساختار معتبر PDF/.test(error.message),
  );
});

test("page count and total vision-file limits stop oversized PDF jobs", async () => {
  const tooManyPages = await makePdf(21);
  await assert.rejects(renderPdfToVisionFiles(tooManyPages, 30), (error: unknown) => error instanceof ProviderError && error.status === 413);
  const twoPages = await makePdf(2);
  await assert.rejects(renderPdfToVisionFiles(twoPages, 1), (error: unknown) => error instanceof ProviderError && error.status === 413);
});
