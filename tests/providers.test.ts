import assert from "node:assert/strict";
import test from "node:test";
import { buildGradingPrompt, callProvider, ProviderError } from "../lib/server/providers";
import type { GradeApiRequest, ProviderId } from "../lib/types";

const modelResult = {
  detectedStudentName: "سارا محمدی", detectedClassName: "یازدهم تجربی", identityConfidence: 0.94,
  summary: "پاسخ‌ها بررسی شد.", strengths: [], improvements: [], overallConfidence: 0.9, questions: [], flags: [],
};
const files: GradeApiRequest["files"] = [
  { name: "page.png", type: "image/png", data: "cG5nLXRlc3QtZGF0YQ==" },
  { name: "pages.pdf", type: "application/pdf", data: "cGRmLXRlc3QtZGF0YQ==" },
];

async function mockFetch(handler: (url: string, init: RequestInit) => Promise<Response> | Response, run: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init || {})) as typeof fetch;
  try { await run(); } finally { globalThis.fetch = original; }
}

test("OpenAI adapter sends multimodal Responses input, strict schema and parses usage", async () => {
  await mockFetch((url, init) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    assert.equal((init.headers as Record<string, string>).Authorization, "Bearer secret-openai");
    const body = JSON.parse(String(init.body));
    assert.equal(body.store, false);
    assert.equal(body.text.format.strict, true);
    const content = body.input[0].content;
    assert.ok(content.some((part: { type: string }) => part.type === "input_image"));
    assert.ok(content.some((part: { type: string }) => part.type === "input_file"));
    return Response.json({ output_text: JSON.stringify(modelResult), usage: { input_tokens: 120, output_tokens: 30 } });
  }, async () => {
    const response = await callProvider({ provider: "openai", model: "gpt-4.1", apiKey: "secret-openai", prompt: "prompt", files });
    assert.equal(response.result.detectedStudentName, "سارا محمدی");
    assert.deepEqual(response.usage, { inputTokens: 120, outputTokens: 30 });
  });
});

test("DeepSeek adapter uses its Responses endpoint and accepts image content", async () => {
  await mockFetch((url, init) => {
    assert.equal(url, "https://api.deepseek.com/responses");
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, "deepseek-flash");
    assert.ok(!("store" in body));
    return Response.json({ output: [{ content: [{ text: JSON.stringify(modelResult) }] }] });
  }, async () => {
    const response = await callProvider({ provider: "deepseek", model: "deepseek-flash", apiKey: "secret-deepseek", prompt: "prompt", files: files.slice(0, 1) });
    assert.equal(response.result.identityConfidence, 0.94);
  });
});

test("Gemini adapter sends inline PDF/image data and parses fenced JSON", async () => {
  await mockFetch((url, init) => {
    assert.match(url, /gemini-2\.5-pro:generateContent$/);
    assert.equal((init.headers as Record<string, string>)["x-goog-api-key"], "secret-gemini");
    const body = JSON.parse(String(init.body));
    assert.equal(body.generationConfig.responseMimeType, "application/json");
    assert.equal(body.contents[0].parts.filter((part: { inline_data?: unknown }) => part.inline_data).length, 2);
    return Response.json({ candidates: [{ content: { parts: [{ text: `\`\`\`json\n${JSON.stringify(modelResult)}\n\`\`\`` }] } }], usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 20 } });
  }, async () => {
    const response = await callProvider({ provider: "gemini", model: "gemini-2.5-pro", apiKey: "secret-gemini", prompt: "prompt", files });
    assert.deepEqual(response.usage, { inputTokens: 80, outputTokens: 20 });
  });
});

test("provider errors and malformed model output never become grades", async () => {
  for (const [provider, payload] of [["openai", { error: { message: "bad key" } }], ["gemini", { candidates: [{ content: { parts: [{ text: "not-json" }] } }] }]] as Array<[ProviderId, unknown]>) {
    await mockFetch(() => Response.json(payload, { status: provider === "openai" ? 401 : 200 }), async () => {
      await assert.rejects(callProvider({ provider, model: "test", apiKey: "bad", prompt: "prompt", files: files.slice(0, 1) }), ProviderError);
    });
  }
});

test("anonymous prompt excludes roster identity while non-anonymous mode labels it for matching only", () => {
  const request: GradeApiRequest = {
    examId: "exam_1",
    exam: { title: "آزمون", subject: "زیست", passScore: 10, settings: { gradingMode: "fast", reviewThreshold: 0.8, anonymize: true, requireApproval: true, instructions: "" }, questions: [{ id: "q1", number: 1, type: "short_answer", prompt: "سؤال", maxScore: 2, answer: "پاسخ", options: [], acceptedAnswers: [], partialCredit: true, errorCarriedForward: false, rubric: [] }] },
    student: { name: "نام محرمانه دانش‌آموز", code: "123" }, files: files.slice(0, 1),
  };
  assert.ok(!buildGradingPrompt(request).includes("نام محرمانه دانش‌آموز"));
  request.exam.settings.anonymize = false;
  const visible = buildGradingPrompt(request);
  assert.ok(visible.includes("نام محرمانه دانش‌آموز"));
  assert.match(visible, /فقط برای تطبیق/);
});
